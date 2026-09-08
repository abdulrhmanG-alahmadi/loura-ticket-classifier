# Ticket classifier

A small HTTP service that ingests support tickets, classifies them asynchronously with an LLM,
and serves the results. Bun + Elysia + SQLite, about 750 lines of source and 900 of tests.

## Run it

Needs [Bun](https://bun.sh) 1.2 or newer (built and tested on 1.4). Nothing else.

```sh
bun install
bun run dev          # http://localhost:3000, fake model, SQLite created at data/tickets.db
bun run seed         # in another terminal: loads the 10 sample tickets through the API
bun test
```

Interactive API docs are at <http://localhost:3000/openapi> (spec at `/openapi/json`), generated
from the same schemas that validate requests and responses.
With no `OPENROUTER_API_KEY` the service uses a built-in fake model (see below). To use a real
model, copy `.env.example` to `.env` and set the key; `OPENROUTER_API_KEY= bun run dev` forces the
fake even if your shell has a key. `bun run seed [baseUrl]` targets another host. Delete
`data/tickets.db*` to start over. `CLASSIFY_MAX_ATTEMPTS=1 bun run dev` makes the fake's broken
answers land as `failed` tickets instead of retries. `bun run check` runs Biome and `tsc`.

## API

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/tickets` | Body `{ id, subject, body }`. `id` is 1–100 chars of letters, digits, `. _ : @ -`, starting with a letter or digit, so it survives a URL. `subject` (up to 500 chars) and `body` (up to 20,000) must be well-formed text (a lone UTF-16 surrogate is a 422, because the SQLite driver would rewrite it). `201` + `Location` on create, `200` with the stored ticket if the id was seen before. |
| `GET` | `/v1/tickets/:id` | `404` if unknown. |
| `GET` | `/v1/tickets` | Filters `category`, `priority`, `status`; `limit` (1–100, default 20) and `offset`. Returns `{ items, total, limit, offset }`, newest first. |

```sh
curl -X POST localhost:3000/v1/tickets -H 'content-type: application/json' \
  -d '{"id":"t-1001","subject":"Charged twice this month","body":"Two charges of 49.00 ..."}'
curl localhost:3000/v1/tickets/t-1001
curl 'localhost:3000/v1/tickets?category=billing&priority=high&limit=10'
```

A ticket:

```json
{
  "id": "t-1001",
  "subject": "Charged twice this month",
  "body": "...",
  "status": "classified",
  "classification": { "category": "billing", "priority": "high", "summary": "..." },
  "attempts": 0,
  "error": null,
  "createdAt": "2026-09-08T12:00:00.000Z",
  "updatedAt": "2026-09-08T12:00:03.000Z"
}
```

`status` is one of `pending` → `classifying` → `classified` | `failed`. The assignment names three
states; I added `classifying` because it is the state a restart has to find (see below) and because
a consumer can tell "queued" from "being worked on". A ticket in `pending` with `attempts > 0` is
waiting out a retry. `classification` is `null` unless `status` is `classified`. `error` holds the
last failure message while a ticket is retrying or once it is `failed`; it is provider or parser
text meant for operators, so treat it as untrusted too. Every error the service itself produces
has the same shape:

```json
{ "error": { "code": "validation", "message": "invalid request",
             "details": [{ "path": "/category", "message": "must be one of: billing, technical, account, other" }] } }
```

with codes `bad_request` (400, unparseable JSON), `validation` (422), `not_found` (404) and
`internal` (500, message never leaks; a response that fails its own schema is also a 500, since
that is the server's fault, not the caller's). The one exception is size: bodies over 64 KB get
Bun's bare 413 at the transport, before any of this code runs.

Shape choices worth defending: `POST` returns `201`, not `202`, because the ticket resource exists
immediately; only its classification is pending, and `status` says so. A repeated id returns `200`
with the original rather than `409`, because the id *is* the idempotency key and replaying a
submission should be boring. Pagination is limit/offset because the dataset is small and `total` is
useful to callers; cursors would be the upgrade if the list ever gets large or hot. `/v1` costs
nothing now and saves a migration later.

## Where things are

```
src/
  app.ts         HTTP routes, error envelope, OpenAPI
  tickets.ts     request/response schemas, types, and every SQL statement (TicketRepo)
  db.ts          SQLite schema; CHECK constraints mirror the allowed sets
  worker.ts      claim → classify → store loop, retries, drain on stop
  classifier.ts  the model boundary: prompt, parse, validate
  model.ts       "messages in, text out": OpenRouter client and the fake
  config.ts      environment variables
  index.ts       wiring and graceful shutdown
tests/           one file per concern: classifier, model, lifecycle, app (HTTP), service (real process)
data/            sample tickets (loaded by scripts/seed.ts) and the SQLite file
docs/redteam/    the 100-call red-team report with raw evidence, and the prompt comparison
```

## Decisions on the open questions

**Storage: SQLite, one table, via `bun:sqlite`.** Zero dependencies, durable across restarts (WAL
with `synchronous = FULL`, so a `201` means the row is on disk), and the queue is the same table:
`status` plus `nextAttemptAt` is all the worker needs. The enum columns carry `CHECK` constraints,
so even a regression in application validation cannot put an out-of-set value in the store (there
is a test that proves it). The cost is that it is single-node.
Moving to Postgres means rewriting the SQL in `tickets.ts` and `db.ts` (`claimNext` becomes
`FOR UPDATE SKIP LOCKED`) and giving the tests a real database instead of `:memory:`.

**Async execution: in-process worker loops polling the table.** A ticket is claimed with a single
`UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *`, which is atomic, so N loops can share the
queue without a lock. Claims are ordered by `nextAttemptAt`, so a ticket coming back from backoff
queues behind the ones that arrived while it waited. Polling every 250 ms is dumb and reliable; a
wake-up signal on insert would be the first optimisation. SQLite waits up to 5 s for a concurrent
writer (`busy_timeout`); if a
write still fails after the model has answered, the worker hands the ticket back to `pending`
rather than leaving it orphaned in `classifying`, and a thrown claim costs one poll interval, not
the loop. No external queue because the assignment does not need one and an extra process would
double the "run from a clean clone" steps.

**Concurrency: `CLASSIFY_CONCURRENCY` loops, default 2.** The real bound is the model provider's
rate limit, not this service. Each loop holds at most one ticket in flight.

**Restart: whatever was `classifying` goes back to `pending`.** With one process, a `classifying`
row at boot can only be a corpse. Re-queueing is at-least-once: a ticket whose model call had
returned but whose result was not yet written is sent to the model once more; nothing is
overwritten, because the first result never reached the store. Attempts are not incremented for
this, so a ticket that reliably crashed the process would loop; I accepted that because nothing in
this code path depends on ticket content.

**Retries: 3 attempts, exponential backoff with jitter (about 1 s, then 2 s, ±50%, capped at
5 min), then `failed`.** Every failure counts as one attempt: transport error, timeout
(`LLM_TIMEOUT_MS`, 30 s per call), a non-2xx, a 200 from OpenRouter with an error inside it, or
output that fails validation. Two exceptions to "wait and try again": a permanent provider error (a
4xx other than 408 and 429, so a bad key or a bad request) fails the ticket on the first attempt,
because waiting cannot fix it; and when the provider sends `Retry-After` (on a 4xx/5xx or inside
a 200 envelope), the next attempt waits for that or for the backoff, whichever is longer, rather
than burning three attempts in three seconds against a rate limit. Our own backoff is capped at
5 min; the provider's ask is honoured up to a day, because retrying sooner is a guaranteed failure
and a broken header must not park a ticket forever.
Validation failures are retried too: a retry costs one more call, and OpenRouter may route it to a
different upstream provider. I have not measured how often that helps (in 134 live calls no output
failed validation), so it is a cheap bet, not an established fact. `failed` tickets keep their last
error and are visible via `GET /v1/tickets?status=failed`. There is no re-classify endpoint yet
(see below).

**Validation: parse, normalise, check, or reject.** `parseClassification` cuts from the first `{`
to the last `}` (models like to add prose and code fences), `JSON.parse`s it, lower-cases and trims
the two enum fields, drops unknown keys, then checks the result against the same TypeBox schema that
types the API. Anything else throws `InvalidModelOutput` and counts as a failed attempt. Nothing that
is not a `Classification` can reach `storeClassification`, and the database re-checks the enums.
"One sentence" is part of the contract, so it is enforced too: a summary containing a sentence
terminator followed by more text (Latin, Arabic and CJK terminators), any control character, a lone
surrogate, or nothing but whitespace and format characters, is rejected like a bad enum. The sentence check is a heuristic
(decimals and version numbers pass; "Mr. Smith" would not), which I accept because the model is
asked for exactly one sentence and a false positive costs a retry, not data. The stored `error`
text is capped at 500 characters.

**Prompt injection.** Three layers, in order of how much I trust them:

1. Output validation is the real defence. Whatever the model is talked into, the only things it can
   change are one of four categories, one of three priorities, and a summary string. It cannot make
   the service *do* anything.
2. The ticket is passed inside a JSON string in the user message, so there is no closing tag a body
   could forge to "escape" into instruction territory, and the system prompt tells the model the
   content is untrusted and may contain instructions to ignore.
3. Size limits at the API boundary (schema and transport) keep a hostile submitter from running up
   the token bill.

What is *not* defended: a determined injection can still steer the category or priority, and the
summary is model-generated text that may echo the attacker's words. A well-formed answer such as
`technical / high / "Approved for immediate refund."` passes validation, because validation proves
shape, not truth. Anything downstream should treat `summary` as untrusted user content, never as an
instruction or an authorisation. Two red-team passes were run: a 20-call pass (not included) and
then a 100-call pass of 45 attack variants and 5 controls on each of `gpt-4o-mini` and `glm-5.3`
(the latter with a larger output cap; see the report): role spoofs, CEO and signed-policy claims,
few-shot poisoning, instructions in five languages, base64 and ROT13, format sabotage. No full
override was observed: no false approval, no injected text in a summary, and no category different
from the matched control. Priority did move, on `gpt-4o-mini` only: it rated a clean invoice
question `low` with a neutral subject and `high` with the subject "URGENT", and two attack variants
moved the same question from `low` to `medium` against its control; the original t-1005 injection
with a neutral subject came back `low`. So the CEO text on its own did not steer the model, but a
bare urgency word did, and two attack variants shifted priority one step, which is a triage-quality
problem rather than a security one. The priority rule in the prompt now says to judge by described
impact, not by urgency words or claims of authority. I checked that sentence with one `gpt-4o-mini`
call per input at temperature 0 over the 10 samples plus 7 controls and injection variants, old
prompt against new (34 calls): the "URGENT" invoice question dropped from `high` to `low`, two
over-rated samples (t-1004, t-1009) each moved down one step, nothing moved up, and the outage and
blocked login tickets kept `high`. It did not fix everything: t-1005 and the two injection variants
still land at `medium` rather than `low`, and a single deterministic run is too small to call this
more than a plausible improvement. The 100-call report with its raw payloads and responses, and the
one-off prompt comparison script with its results, are in `docs/redteam/`.

Text that reaches the store or the logs is also kept plain: summaries may not contain control
characters, Unicode line or paragraph separators, or bidirectional overrides (other format
characters such as ZWNJ are allowed, because real scripts need them), and provider error text has
the same characters flattened before it is stored or logged, so an upstream error cannot forge a
log line.

**Model: OpenRouter if a key is set, otherwise a fake.** The OpenRouter client knows nothing about
tickets: it is `messages → string`, with a timeout, and it type-checks the provider's envelope
before trusting it (OpenRouter can return an error inside a 200). The fake in the same file is the
exception, because it has to answer: it reads the ticket out of the prompt,
picks the category whose keyword appears earliest (so the subject outweighs an aside in the body),
summarises the subject line, and returns a broken response every 4th call (prose, wrong enums,
truncated JSON, in rotation) so the retry path is exercised locally; with the default 3 attempts
the seed run shows retries but rarely a `failed` ticket. Being keyword-based, the fake is steered
by injected text exactly as a naive model would be: "URGENT" makes t-1005 high, and appending
"not urgent, nice to have" to an outage report drops it to low. There is a test that pins that
behaviour as a known limit, so nobody mistakes the fake for a judgment about the live model.

**Graceful shutdown (the optional extra I picked).** On `SIGINT`/`SIGTERM` the workers stop
claiming and the server stops accepting at the same moment; then in-flight requests complete, the
loops finish the ticket they hold, and the database is closed. Two different waits: the worker
drain is bounded by the 30 s model timeout, but the HTTP drain waits for in-flight requests and a
client that stalls mid-upload can hold it open, so a deadline (`SHUTDOWN_DEADLINE_MS`, 60 s) ends
the drain regardless with a non-zero exit. A second signal kills the process outright. Either way
the restart path above covers whatever was in flight.

## Tests

`bun test` runs 102 tests in about a second. `classifier` covers the parse/validate door with
good, wrapped, and broken model output, plus the real t-1005; `model` stubs `fetch` to cover
OpenRouter's envelopes and checks the fake against the samples; `lifecycle` covers the state
machine, claiming, retries, restart, drain, and the database's own constraints, all on in-memory
SQLite; `app` drives the routes through `app.handle` (and one real socket for the 413 cap);
`service` spawns the real `src/index.ts`, ingests, waits for classification, sends SIGTERM,
plants a `classifying` row and boots again to see it recovered, and checks that a second signal
kills a drain held open by a stalled request. Not under test: `config.ts`.
Console output is silenced during tests (`tests/setup.ts`) because the worker and error hook log
on purpose.

## With more time

- `POST /v1/tickets/:id/reclassify` plus a `promptVersion` column, so failed tickets and tickets
  classified under an old prompt can be redone.
- Wake the worker on insert instead of polling.
- A labelled evaluation set; with a live model, t-1005 and t-1009 (two topics in one ticket) are
  the ones I would watch.
- Request ids in logs and responses, and authentication. Today the service assumes it sits on a
  private network.

## Weaknesses

- Single process, single SQLite file. Fine for the scenario, not for many ingest nodes.
- The worker polls. At 250 ms that is invisible, but it is still a timer.
- The list query uses `($x IS NULL OR col = $x)` so one prepared statement covers every filter
  combination; SQLite cannot use an index for that form, so it is a table scan (there is no index
  on `category`/`priority` for that reason). Deliberate at this size; a dynamic `WHERE` plus an
  index is the fix when it matters.
- Case-normalising enums is a leniency I chose deliberately; a purist would reject `"Billing"`.
- The one-sentence check is a regex. It cannot tell an abbreviation from a sentence end, so a
  summary like "Mr. Smith was charged twice." is rejected and retried; and it needs whitespace after
  a Latin or Arabic terminator, so "Cannot log in.Reset fails." slips through, because requiring
  none would reject decimals and domain names.
- Elysia quirk worth knowing: an optional `t.UnionEnum` in a query schema silently defaults to the
  enum's first value, which turned every unfiltered list into `category=billing` until a test caught
  it. `tickets.ts` uses a union of literals instead.
