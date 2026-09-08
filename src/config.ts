const MAX = 2 ** 31 - 1; // largest delay setTimeout and AbortSignal.timeout honour
const int = (name: string, fallback: number, min = 0): number => {
  const raw = process.env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > MAX)
    throw new Error(`${name} must be an integer from ${min} to ${MAX}`);
  return value;
};

export const config = {
  port: int("PORT", 3000),
  shutdownDeadlineMs: int("SHUTDOWN_DEADLINE_MS", 60_000, 1),
  dbPath: process.env.DB_PATH ?? "data/tickets.db",
  openRouter: {
    apiKey: process.env.OPENROUTER_API_KEY,
    model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
    timeoutMs: int("LLM_TIMEOUT_MS", 30_000, 1),
  },
  worker: {
    concurrency: int("CLASSIFY_CONCURRENCY", 2, 1),
    maxAttempts: int("CLASSIFY_MAX_ATTEMPTS", 3, 1),
    backoffMs: int("CLASSIFY_BACKOFF_MS", 1_000),
    pollMs: int("CLASSIFY_POLL_MS", 250, 1),
  },
};
