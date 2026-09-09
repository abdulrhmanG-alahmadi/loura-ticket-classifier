# Ticket classifier

A Bun + Elysia + SQLite service that ingests support tickets, classifies them asynchronously,
and exposes the results through an HTTP API.

## Run

Requires [Bun](https://bun.sh) 1.2 or newer; built and tested on 1.4. No Docker or external services required.

```sh
bun install
bun run dev          # http://localhost:3000; creates data/tickets.db
bun run seed         # in another terminal: loads the 10 appendix tickets
bun test
bun run check        # Biome and TypeScript
```

Without `OPENROUTER_API_KEY`, the service uses a keyword-based fake that returns plausible
classifications and a broken response every fourth call. This exercises retries without credentials.
It is deliberately steerable by ticket keywords, so its behavior is not evidence about live-model safety.

For a real model, copy [.env.example](.env.example) to `.env` and set the key.
`OPENROUTER_API_KEY= bun run dev` forces the fake. Set `CLASSIFY_MAX_ATTEMPTS=1` to see its broken
responses become failed tickets. `bun run seed [baseUrl]` can target another host.

Interactive docs: [/openapi](http://localhost:3000/openapi); specification: `/openapi/json`.
Both use the same schemas as request and response validation.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/v1/tickets` | Accepts `{ id, subject, body }`. Returns `201` + `Location` for a new ticket, or `200` with the original for an existing ID. Duplicates never rerun classification. |
| GET | `/v1/tickets/:id` | Returns the ticket, or `404` if unknown. |
| GET | `/v1/tickets` | Filters by `category`, `priority`, and/or `status`. Returns `{ items, total, limit, offset }`, newest first. |

IDs are 1–100 ASCII letters, digits, or `._:@-`, starting with a letter or digit. Subject and body
may be empty, must be well-formed Unicode, and are limited to 500 and 20,000 characters respectively.
Pagination uses `limit` (1–100, default 20) and `offset` (default 0).

```sh
curl -X POST localhost:3000/v1/tickets -H 'content-type: application/json' \
  -d '{"id":"demo-1","subject":"Charged twice","body":"Two charges appeared for one subscription."}'
curl localhost:3000/v1/tickets/demo-1
curl 'localhost:3000/v1/tickets?category=billing&priority=high&limit=10'
```

A classified ticket looks like:

```json
{
  "id": "demo-1",
  "subject": "Charged twice",
  "body": "Two charges appeared for one subscription.",
  "status": "classified",
  "classification": {
    "category": "billing",
    "priority": "high",
    "summary": "The customer reports two charges for one subscription."
  },
  "attempts": 0,
  "error": null,
  "createdAt": "2026-09-08T12:00:00.000Z",
  "updatedAt": "2026-09-08T12:00:03.000Z"
}
```

Categories: `billing`, `technical`, `account`, `other`. Priorities: `low`, `medium`, `high`.
Status moves `pending → classifying → classified | failed`; retries return to `pending`.
`classifying` distinguishes queued from active work and identifies interrupted work on restart.
`classification` is null until success. `attempts` counts recorded failures; `error` holds the last
failure while retrying or failed and is cleared on success.

Errors use `{ "error": { "code": "validation", "message": "invalid request", "details": [...] } }`.
Validation details identify the offending fields. Codes are `bad_request` (400, malformed JSON),
`validation` (422), `not_found` (404), and `internal` (500, generic message). Response-schema failures
are server errors. Bodies over 64 KB receive Bun's bare `413`, outside the JSON error handler.

**API choices:** `201` means the ticket already exists, although classification is pending.
The ID doubles as the idempotency key, so duplicates return the original. Limit/offset is simple
for a small dataset; `/v1` leaves room for future breaking changes.

## Design decisions

**Storage:** one SQLite table via `bun:sqlite`, using WAL and `synchronous=FULL` for persistence.
The table also serves as the queue through `status` and `nextAttemptAt`; enum constraints provide
a second check. This avoids operating a separate database or queue, at the cost of a single-process design.

**Async work and concurrency:** worker loops poll every 250 ms and atomically claim a ticket with
`UPDATE … RETURNING`. Each loop awaits one classification. `CLASSIFY_CONCURRENCY` defaults to 2
to limit provider load; claims are ordered by when work becomes due so retries do not jump the queue.

**Restart:** startup returns all `classifying` tickets to `pending`. This is at-least-once processing:
a crash after a model response but before saving it can repeat the call. Interrupted attempts are
not counted, so a repeatedly crashing job can loop. This recovery assumes only one service process.

**Failures and retries:** three attempts by default, a 30-second model timeout, and exponential
backoff (1 s, then 2 s, ±50% jitter; capped at 5 minutes). Provider 4xx errors other than 408/429
fail immediately because repeating the same request is unlikely to help. Other failures, including
invalid output, retry before becoming `failed`.

`Retry-After` accepts seconds or an HTTP date, including on an error inside an HTTP 200 response.
The longer of backoff and the provider delay wins. Provider delays are capped at one day to prevent
absurd headers from overflowing the retry date or leaving work queued indefinitely. Retrying invalid
output may help, but its benefit has not been measured. Failed tickets remain queryable with
`?status=failed`; there is no replay endpoint.

**Model validation:** the provider returns text. The classifier extracts JSON, trims and lowercases
enums, drops unknown fields, and validates before storage. Summaries are limited to 500 characters;
malformed Unicode, unsafe controls, and invisible-only text are rejected. Sentence detection is a
heuristic (see weaknesses). Provider errors are flattened and capped at 500 characters before logging/storage.

**Prompt injection:** the system prompt marks ticket text as untrusted, and the ticket is JSON-encoded
in a separate user message. Output validation restricts the stored fields; the model has no tools or
authority to perform actions. Input size limits bound each request's size, not total API usage.
Validation proves shape, not truth: an attacker can still influence valid categories, priorities,
or summaries. Downstream systems must treat summaries as untrusted content, never instructions or approvals.

The [red-team report and evidence](docs/redteam/README.md) cover 100 calls across two models and a
34-call prompt comparison. No full override was observed in the 100-call batch, but two GPT-4o-mini
attacks shifted priority versus their controls. A later prompt adjustment reduced some overrating
without eliminating it. The report records commit provenance and differing model settings; these
small experiments do not establish immunity.

**Graceful shutdown — selected optional extra:** SIGINT/SIGTERM stops new claims and HTTP acceptance,
then drains active work before closing SQLite. A 60-second `SHUTDOWN_DEADLINE_MS` bounds stalled
requests; expiry exits non-zero, and a second signal kills immediately. Forced exits use restart recovery.

## Code and tests

`src/app.ts` holds HTTP routes; `tickets.ts` schemas and SQL; `db.ts` the database schema;
`worker.ts` scheduling; `classifier.ts` the model boundary; `model.ts` the provider and fake;
`config.ts` configuration; `index.ts` startup/shutdown. Samples and their loader are in
`data/tickets.json` and `scripts/seed.ts`.

The tests cover HTTP validation/idempotency/filtering, model parsing and provider failures, retries,
concurrency, restart recovery, Unicode boundaries, and shutdown. Repository/worker tests use in-memory
SQLite; service tests spawn real processes. `config.ts` has no committed tests. Console output is
silenced during tests. No live model is required.

## Weaknesses and next steps

- **Production storage.** I would use PostgreSQL in production for a shared database across service
  instances, with atomic worker claims using `FOR UPDATE SKIP LOCKED` and per-job leases for recovery.
  SQLite keeps this take-home easy to run without external services.
- **Single process and local SQLite.** A failed write after a successful model call can cause another
  call. If even failure recording and requeueing fail, restart recovers the stranded ticket.
- **Sentence heuristic.** Abbreviations can cause false rejection; missing spaces or quoted sentence
  endings can let multiple sentences through. Stricter punctuation rules would reject valid summaries too.
- **Small-dataset queries.** Optional-filter SQL scans the table, and offset pages can shift as data
  changes. Use indexed queries and cursors if scale requires them; wake workers on inserts to reduce polling.
- **Private-network assumption.** No authentication or inbound rate limiting. Ticket errors expose provider
  diagnostics intended for operators. Add access controls and request IDs before wider deployment.
- **Future functionality.** Add explicit reclassification with a prompt version and a labelled accuracy
  evaluation, especially for ambiguous or multi-topic tickets.
