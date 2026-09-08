import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import samples from "../data/tickets.json";

/** The real entry point: boot, ingest, classify with the fake, drain on SIGTERM, recover on restart. */
const root = `${import.meta.dir}/..`;
const dbPath = `${tmpdir()}/loura-service-${process.pid}.db`;
const port = 3900 + (process.pid % 100);
const base = `http://localhost:${port}/v1/tickets`;
afterAll(() => {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
});

const start = () =>
  Bun.spawn(["bun", "src/index.ts"], {
    cwd: root,
    env: {
      ...process.env,
      OPENROUTER_API_KEY: "",
      DB_PATH: dbPath,
      PORT: String(port),
      CLASSIFY_POLL_MS: "20",
      CLASSIFY_BACKOFF_MS: "10",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

const until = async (ready: () => Promise<boolean>, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await ready().catch(() => false)) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
};
const classifiedCount = async () =>
  ((await (await fetch(`${base}?status=classified`)).json()) as { total: number }).total;

test("boot, ingest, classify, drain, restart", async () => {
  let proc = start();
  await until(async () => (await fetch(base)).ok);
  for (const t of samples.slice(0, 3)) {
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(t),
    });
    expect(res.status).toBe(201);
  }
  await until(async () => (await classifiedCount()) === 3);

  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
  let log = await new Response(proc.stdout).text();
  expect(log).toContain("model: fake");
  expect(log).toContain("SIGTERM: draining");
  expect(log.trim().endsWith("stopped")).toBe(true);

  // Simulate a crash that left one ticket in flight, then boot again.
  const db = new Database(dbPath);
  db.exec("UPDATE tickets SET status = 'classifying', category = NULL WHERE id = 't-1001'");
  db.close();
  proc = start();
  await until(async () => (await classifiedCount()) === 3);
  proc.kill("SIGTERM");
  expect(await proc.exited).toBe(0);
  log = await new Response(proc.stdout).text();
  expect(log).toContain("requeued 1 ticket(s)");
  expect(log).toContain("classified t-1001");
}, 20_000);
