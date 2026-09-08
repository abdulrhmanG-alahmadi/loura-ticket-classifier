import type { Database } from "bun:sqlite";
import { t } from "elysia";

const CATEGORIES = ["billing", "technical", "account", "other"] as const;
const PRIORITIES = ["low", "medium", "high"] as const;
const STATUSES = ["pending", "classifying", "classified", "failed"] as const;

type Category = (typeof CATEGORIES)[number];
type Priority = (typeof PRIORITIES)[number];
type Status = (typeof STATUSES)[number];

/**
 * A union of literals rather than Elysia's `t.UnionEnum`: the latter, when optional in a query,
 * silently defaults an absent param to its first value (so every list was filtered to "billing").
 */
const oneOf = <const T extends readonly string[]>(values: T) =>
  t.Union(
    values.map((v) => t.Literal<T[number]>(v)),
    { error: `must be one of: ${values.join(", ")}` },
  );

/** What the model must produce. Also the only shape that may reach the store. */
export const Classification = t.Object({
  category: oneOf(CATEGORIES),
  priority: oneOf(PRIORITIES),
  summary: t.String({ minLength: 1, maxLength: 500 }),
});
export type Classification = typeof Classification.static;

/** Starts alphanumeric so "." and ".." cannot be ids; no whitespace or slashes so ids survive URLs. */
const ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:@-]*$";

export const NewTicket = t.Object({
  id: t.String({
    minLength: 1,
    maxLength: 100,
    pattern: ID_PATTERN,
    error: "must be 1-100 characters: letters, digits, . _ : @ -, starting with a letter or digit",
  }),
  subject: t.String({ maxLength: 500 }),
  body: t.String({ maxLength: 20_000 }),
});
export type NewTicket = typeof NewTicket.static;

const DEFAULT_LIMIT = 20;
export const ListQuery = t.Object({
  category: t.Optional(oneOf(CATEGORIES)),
  priority: t.Optional(oneOf(PRIORITIES)),
  status: t.Optional(oneOf(STATUSES)),
  limit: t.Optional(
    t.Integer({
      minimum: 1,
      maximum: 100,
      default: DEFAULT_LIMIT,
      error: "must be an integer from 1 to 100",
    }),
  ),
  offset: t.Optional(
    t.Integer({
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
      default: 0,
      error: "must be an integer >= 0",
    }),
  ),
});
export type ListQuery = typeof ListQuery.static;

export type Ticket = NewTicket & {
  status: Status;
  classification: Classification | null;
  attempts: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type Page<T> = { items: T[]; total: number; limit: number; offset: number };

type Row = NewTicket & {
  status: Status;
  category: Category | null;
  priority: Priority | null;
  summary: string | null;
  attempts: number;
  error: string | null;
  nextAttemptAt: string;
  createdAt: string;
  updatedAt: string;
};

const toTicket = ({ category, priority, summary, nextAttemptAt: _, ...row }: Row): Ticket => ({
  ...row,
  classification: category && priority && summary ? { category, priority, summary } : null,
});

const now = () => new Date().toISOString();

export class TicketRepo {
  constructor(private db: Database) {}

  /** Idempotent: a second submission with the same id returns the original, untouched. */
  insertIfAbsent(input: NewTicket): { ticket: Ticket; created: boolean } {
    const ts = now();
    const { changes } = this.db
      .query(
        `INSERT OR IGNORE INTO tickets (id, subject, body, nextAttemptAt, createdAt, updatedAt)
         VALUES ($id, $subject, $body, $ts, $ts, $ts)`,
      )
      .run({ ...input, ts });
    const ticket = this.get(input.id);
    if (!ticket) throw new Error(`ticket ${input.id} vanished after insert`);
    return { ticket, created: changes === 1 };
  }

  get(id: string): Ticket | null {
    const row = this.db
      .query<Row, { id: string }>("SELECT * FROM tickets WHERE id = $id")
      .get({ id });
    return row && toTicket(row);
  }

  list({ category, priority, status, limit = DEFAULT_LIMIT, offset = 0 }: ListQuery): Page<Ticket> {
    const where = `WHERE ($category IS NULL OR category = $category)
                     AND ($priority IS NULL OR priority = $priority)
                     AND ($status IS NULL OR status = $status)`;
    const filters = {
      category: category ?? null,
      priority: priority ?? null,
      status: status ?? null,
    };
    const { total } = this.db
      .query<{ total: number }, typeof filters>(`SELECT COUNT(*) AS total FROM tickets ${where}`)
      .get(filters) ?? { total: 0 };
    const rows = this.db
      .query<Row, typeof filters & { limit: number; offset: number }>(
        `SELECT * FROM tickets ${where} ORDER BY createdAt DESC, rowid DESC LIMIT $limit OFFSET $offset`,
      )
      .all({ ...filters, limit, offset });
    return { items: rows.map(toTicket), total, limit, offset };
  }

  /**
   * Atomically move the longest-due pending ticket to `classifying`. Null when the queue is empty.
   * Ordering by nextAttemptAt (not createdAt) means a retry queues behind tickets that arrived while
   * it was backing off, and the (status, nextAttemptAt) index serves the whole lookup.
   */
  claimNext(): Ticket | null {
    const row = this.db
      .query<Row, { ts: string }>(
        `UPDATE tickets SET status = 'classifying', updatedAt = $ts
         WHERE id = (SELECT id FROM tickets WHERE status = 'pending' AND nextAttemptAt <= $ts
                     ORDER BY nextAttemptAt, rowid LIMIT 1)
         RETURNING *`,
      )
      .get({ ts: now() });
    return row && toTicket(row);
  }

  /** Only a ticket still in `classifying` can be completed; a stale worker cannot overwrite a reset. */
  storeClassification(id: string, c: Classification): void {
    this.db
      .query(
        `UPDATE tickets SET status = 'classified', category = $category, priority = $priority,
                            summary = $summary, error = NULL, updatedAt = $ts
         WHERE id = $id AND status = 'classifying'`,
      )
      .run({ id, ...c, ts: now() });
  }

  /** Record a failed attempt. With `retryAt` the ticket re-enters the queue; without it, it is `failed`. */
  recordFailure(id: string, error: string, retryAt: Date | null): void {
    this.db
      .query(
        `UPDATE tickets SET status = $status, attempts = attempts + 1, error = $error,
                            nextAttemptAt = COALESCE($retryAt, nextAttemptAt), updatedAt = $ts
         WHERE id = $id AND status = 'classifying'`,
      )
      .run({
        id,
        error,
        status: retryAt ? "pending" : "failed",
        retryAt: retryAt?.toISOString() ?? null,
        ts: now(),
      });
  }

  /**
   * Hand `classifying` tickets back to the queue: all of them on boot (the previous process died
   * holding them), or one by id when a worker could not record its outcome.
   */
  requeueInFlight(id: string | null = null): number {
    return this.db
      .query(
        `UPDATE tickets SET status = 'pending', updatedAt = $ts
         WHERE status = 'classifying' AND ($id IS NULL OR id = $id)`,
      )
      .run({ id, ts: now() }).changes;
  }
}
