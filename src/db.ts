import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Enum columns carry CHECK constraints: even if application validation regressed,
 * the store itself refuses values outside the allowed sets.
 */
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tickets (
    id            TEXT PRIMARY KEY,
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'classifying', 'classified', 'failed')),
    category      TEXT CHECK (category IN ('billing', 'technical', 'account', 'other')),
    priority      TEXT CHECK (priority IN ('low', 'medium', 'high')),
    summary       TEXT,
    attempts      INTEGER NOT NULL DEFAULT 0,
    error         TEXT,
    nextAttemptAt TEXT NOT NULL,
    createdAt     TEXT NOT NULL,
    updatedAt     TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS tickets_queue ON tickets (status, nextAttemptAt);
`;

export function openDb(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL"); // a 201 means the ticket survives a power cut, not just a crash
  db.exec("PRAGMA busy_timeout = 5000"); // wait for a concurrent writer instead of failing at once
  db.exec(SCHEMA);
  return db;
}
