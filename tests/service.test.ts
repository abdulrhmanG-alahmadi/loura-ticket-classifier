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
const children: ReturnType<typeof Bun.spawn>[] = [];
afterAll(async () => {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited.catch(() => {});
  }
  for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
});

const start = () => {
  const child = Bun.spawn(["bun", "src/index.ts"], {
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
  children.push(child);
  return child;
};

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

test("a second signal of either kind kills a stalled drain", async () => {
  const proc = start();
  await until(async () => (await fetch(base)).ok);
  // A request that declares a body and never sends it holds the HTTP drain open.
  const stalled = await Bun.connect({
    hostname: "localhost",
    port,
    socket: {
      data() {},
      open(s) {
        s.write(
          "POST /v1/tickets HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n",
        );
      },
    },
  });
  await Bun.sleep(100); // let the server read the partial request
  proc.kill("SIGTERM");
  await Bun.sleep(300);
  expect(proc.exitCode).toBeNull(); // still draining
  proc.kill("SIGINT");
  await proc.exited;
  stalled.end();
  expect(proc.signalCode).toBe("SIGINT");
  const log = await new Response(proc.stdout).text();
  expect(log).toContain("SIGTERM: draining");
  expect(log).not.toContain("SIGINT: draining");
}, 20_000);
