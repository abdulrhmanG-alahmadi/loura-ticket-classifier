import { beforeEach, describe, expect, test } from "bun:test";
import { openDb } from "../src/db";
import { ModelError } from "../src/model";
import { type Classification, TicketRepo } from "../src/tickets";
import { Worker, type WorkerOptions } from "../src/worker";

const classification: Classification = {
  category: "billing",
  priority: "high",
  summary: "Charged twice.",
};
const opts: WorkerOptions = { concurrency: 1, maxAttempts: 3, backoffMs: 0, pollMs: 1 };
const ok = async () => classification;
const boom = async () => {
  throw new Error("model down");
};

let repo: TicketRepo;
let db: ReturnType<typeof openDb>;
beforeEach(() => {
  db = openDb(":memory:");
  repo = new TicketRepo(db);
});

const submit = (id: string) =>
  repo.insertIfAbsent({ id, subject: `subject ${id}`, body: `body ${id}` });
/** Milliseconds until the ticket is due again. */
const dueIn = (id: string) =>
  db
    .query<{ ms: number }, [string]>(
      "SELECT (julianday(nextAttemptAt) - julianday('now')) * 86400000 AS ms FROM tickets WHERE id = ?",
    )
    .get(id)?.ms ?? Number.NaN;

describe("ingest", () => {
  test("same id twice does not duplicate or overwrite", () => {
    expect(submit("t-1").created).toBe(true);
    const second = repo.insertIfAbsent({ id: "t-1", subject: "changed", body: "changed" });
    expect(second.created).toBe(false);
    expect(second.ticket.subject).toBe("subject t-1");
    expect(repo.list({}).total).toBe(1);
  });

  test("resubmitting a classified ticket does not re-run classification", () => {
    submit("t-1");
    repo.claimNext();
    repo.storeClassification("t-1", classification);
    const { ticket, created } = submit("t-1");
    expect(created).toBe(false);
    expect(ticket).toMatchObject({ status: "classified", classification, attempts: 0 });
    expect(repo.claimNext()).toBeNull();
  });

  test("new tickets are pending with no classification", () => {
    const { ticket } = submit("t-1");
    expect(ticket).toMatchObject({
      status: "pending",
      classification: null,
      attempts: 0,
      error: null,
    });
  });
});

describe("queue", () => {
  test("claims in arrival order, each ticket exactly once", () => {
    submit("t-1");
    submit("t-2");
    expect(repo.claimNext()?.id).toBe("t-1");
    expect(repo.claimNext()?.id).toBe("t-2");
    expect(repo.claimNext()).toBeNull();
    expect(repo.get("t-1")?.status).toBe("classifying");
  });

  test("a stale worker cannot complete a ticket that is no longer in flight", () => {
    submit("t-1");
    repo.claimNext();
    repo.requeueInFlight();
    repo.storeClassification("t-1", classification);
    expect(repo.get("t-1")).toMatchObject({ status: "pending", classification: null });
  });

  test("restart puts in-flight tickets back in the queue", () => {
    submit("t-1");
    submit("t-2");
    repo.claimNext();
    expect(repo.requeueInFlight()).toBe(1);
    expect(repo.claimNext()?.id).toBe("t-1");
  });

  test("the store itself refuses values outside the allowed sets", () => {
    submit("t-1");
    expect(() => db.exec("UPDATE tickets SET category = 'refunds' WHERE id = 't-1'")).toThrow(
      /CHECK/,
    );
    expect(() => db.exec("UPDATE tickets SET status = 'done' WHERE id = 't-1'")).toThrow(/CHECK/);
  });
});

describe("worker", () => {
  test("pending → classified on success", async () => {
    submit("t-1");
    expect(await new Worker(repo, ok, opts).tick()).toBe(true);
    expect(repo.get("t-1")).toMatchObject({
      status: "classified",
      classification,
      attempts: 0,
      error: null,
    });
  });

  test("tick reports an empty queue", async () => {
    expect(await new Worker(repo, ok, opts).tick()).toBe(false);
  });

  test("a failure re-queues with backoff, then fails after maxAttempts", async () => {
    submit("t-1");
    const worker = new Worker(repo, boom, { ...opts, backoffMs: 60_000 });

    await worker.tick();
    expect(repo.get("t-1")).toMatchObject({ status: "pending", attempts: 1, error: "model down" });
    expect(repo.claimNext()).toBeNull(); // not due yet

    const eager = new Worker(repo, boom, opts);
    expect(await eager.tick()).toBe(false); // still not due: nothing to do

    db.exec("UPDATE tickets SET nextAttemptAt = createdAt"); // fast-forward the clock
    await eager.tick();
    await eager.tick();
    expect(repo.get("t-1")).toMatchObject({ status: "failed", attempts: 3, classification: null });
    expect(await eager.tick()).toBe(false);
  });

  test("a permanent provider error fails at once; Retry-After sets the next attempt", async () => {
    submit("t-1");
    const rejected = async () => {
      throw new ModelError("openrouter 401: bad key", true);
    };
    await new Worker(repo, rejected, opts).tick();
    expect(repo.get("t-1")).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "openrouter 401: bad key",
    });

    submit("t-2");
    const throttled = async () => {
      throw new ModelError("openrouter 429: slow down", false, 60_000);
    };
    await new Worker(repo, throttled, opts).tick(); // backoffMs is 0: only Retry-After can delay it
    expect(repo.get("t-2")).toMatchObject({ status: "pending", attempts: 1 });
    expect(dueIn("t-2")).toBeGreaterThan(55_000);
  });

  test("backoff is jittered around the base delay", async () => {
    submit("t-1");
    await new Worker(repo, boom, { ...opts, backoffMs: 10_000 }).tick();
    expect(dueIn("t-1")).toBeGreaterThan(4_000);
    expect(dueIn("t-1")).toBeLessThan(15_000);
  });

  test("provider error text is flattened so it cannot forge log lines", async () => {
    submit("t-1");
    const hostile = async () => {
      throw new Error(
        "openrouter 502: gateway\nclassified victim\n\u001b[2J\u2028FORGED\u202eREVERSED",
      );
    };
    await new Worker(repo, hostile, { ...opts, maxAttempts: 1 }).tick();
    const stored = repo.get("t-1")?.error ?? "";
    expect(stored).not.toMatch(/[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u);
    expect(stored).toContain("classified victim"); // still readable, just not on its own line
  });

  test("invalid model output never reaches the store", async () => {
    submit("t-1");
    const bad = async () =>
      ({ category: "refunds", priority: "high", summary: "x" }) as unknown as Classification;
    await new Worker(repo, bad, { ...opts, maxAttempts: 1 }).tick();
    expect(repo.get("t-1")).toMatchObject({ status: "failed", classification: null });
    expect(repo.get("t-1")?.error).toMatch(/CHECK/);
  });

  test("stop() drains in-flight work and start() processes concurrently without duplicates", async () => {
    for (const id of ["t-1", "t-2", "t-3"]) submit(id);
    const seen: string[] = [];
    const gate = Promise.withResolvers<void>();
    const blocked = async (t: { id: string }) => {
      seen.push(t.id);
      await gate.promise;
      return classification;
    };
    const worker = new Worker(repo, blocked, { ...opts, concurrency: 2 });
    worker.start(); // both loops claim synchronously, then block on the gate
    expect(seen.sort()).toEqual(["t-1", "t-2"]);

    const stopped = worker.stop();
    gate.resolve();
    await stopped;
    expect(repo.list({ status: "classified" }).total).toBe(2);
    expect(repo.get("t-3")?.status).toBe("pending");
  });

  test("a thrown claim costs one poll, not the loop", async () => {
    submit("t-1");
    const original = repo.claimNext.bind(repo);
    let failOnce = true;
    repo.claimNext = () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return original();
    };
    const classified = Promise.withResolvers<void>();
    const worker = new Worker(
      repo,
      async () => {
        classified.resolve();
        return classification;
      },
      opts,
    );
    worker.start();
    await classified.promise;
    await worker.stop();
    expect(repo.get("t-1")?.status).toBe("classified");
  });

  test("a ticket whose outcome could not be recorded goes back to the queue, not limbo", async () => {
    submit("t-1");
    const original = repo.recordFailure.bind(repo);
    repo.recordFailure = () => {
      repo.recordFailure = original; // fail exactly once
      throw new Error("SQLITE_BUSY: database is locked");
    };
    const worker = new Worker(repo, boom, opts);
    expect(await worker.tick()).toBe(true);
    expect(repo.get("t-1")).toMatchObject({ status: "pending", attempts: 0 });
    await worker.tick();
    expect(repo.get("t-1")).toMatchObject({ status: "pending", attempts: 1, error: "model down" });
  });
});
