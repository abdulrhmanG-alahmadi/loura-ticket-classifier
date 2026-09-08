import { beforeEach, describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import { openDb } from "../src/db";
import { TicketRepo } from "../src/tickets";

let repo: TicketRepo;
let app: ReturnType<typeof createApp>;
beforeEach(() => {
  repo = new TicketRepo(openDb(":memory:"));
  app = createApp(repo);
});

const post = (body: unknown) =>
  app.handle(
    new Request("http://localhost/v1/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
const get = (path: string) => app.handle(new Request(`http://localhost/v1${path}`));
// biome-ignore lint/suspicious/noExplicitAny: test-only, shapes are asserted below
const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

const sample = { id: "t-1", subject: "Charged twice", body: "Two charges of 49.00" };

describe("POST /tickets", () => {
  test("creates a pending ticket and points at it", async () => {
    const res = await post(sample);
    expect(res.status).toBe(201);
    expect(res.headers.get("location")).toBe("/v1/tickets/t-1");
    expect(await json(res)).toMatchObject({ ...sample, status: "pending", classification: null });
  });

  test("is idempotent on id", async () => {
    await post(sample);
    const res = await post({ ...sample, subject: "different" });
    expect(res.status).toBe(200);
    expect((await json(res)).subject).toBe("Charged twice");
  });

  test.each([
    ["missing body", { id: "t-1", subject: "s" }],
    ["empty id", { ...sample, id: "" }],
    ["oversized body", { ...sample, body: "x".repeat(20_001) }],
    ["wrong type", { ...sample, subject: 42 }],
  ])("rejects %s with 422 and field-level details", async (_name, body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    const { error } = await json(res);
    expect(error.code).toBe("validation");
    expect(error.details.length).toBeGreaterThan(0);
    expect(error.details[0]).toMatchObject({
      path: expect.any(String),
      message: expect.any(String),
    });
  });
});

test("malformed JSON is the client's fault, not a 500", async () => {
  const res = await app.handle(
    new Request("http://localhost/v1/tickets", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{oops",
    }),
  );
  expect(res.status).toBe(400);
  expect((await json(res)).error.code).toBe("bad_request");
});

test("bodies over the transport cap are refused before parsing", async () => {
  const live = createApp(repo).listen(0);
  const res = await fetch(`http://localhost:${live.server?.port}/v1/tickets`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...sample, body: "x".repeat(65 * 1024) }),
  });
  expect(res.status).toBe(413);
  await live.stop();
});

describe("GET /tickets/:id", () => {
  test("returns the ticket", async () => {
    await post(sample);
    const res = await get("/tickets/t-1");
    expect(res.status).toBe(200);
    expect((await json(res)).id).toBe("t-1");
  });

  test("404 for unknown id", async () => {
    const res = await get("/tickets/nope");
    expect(res.status).toBe(404);
    expect(await json(res)).toEqual({ error: { code: "not_found", message: "ticket not found" } });
  });
});

test("unknown routes and internal errors use the same error envelope", async () => {
  const missing = await get("/nope");
  expect(missing.status).toBe(404);
  expect(await json(missing)).toEqual({ error: { code: "not_found", message: "not found" } });
  repo.get = () => {
    throw new Error("disk on fire");
  };
  const res = await get("/tickets/t-1");
  expect(res.status).toBe(500);
  expect(await json(res)).toEqual({ error: { code: "internal", message: "internal error" } });
});

test("serves an OpenAPI description of the routes", async () => {
  const spec = await json(app.handle(new Request("http://localhost/openapi/json")));
  expect(Object.keys(spec.paths).sort()).toEqual(["/v1/tickets", "/v1/tickets/{id}"]);
});

describe("GET /tickets", () => {
  const classify = (id: string, category: string, priority: string) => {
    repo.claimNext();
    repo.storeClassification(id, { category, priority, summary: "s" } as never);
  };

  beforeEach(async () => {
    await post({ id: "t-1", subject: "a", body: "a" });
    await post({ id: "t-2", subject: "b", body: "b" });
    await post({ id: "t-3", subject: "c", body: "c" });
    classify("t-1", "billing", "high");
    classify("t-2", "billing", "low");
  });

  test("lists everything newest first with default pagination", async () => {
    const page = await json(get("/tickets"));
    expect(page).toMatchObject({ total: 3, limit: 20, offset: 0 });
    expect(page.items.map((t: { id: string }) => t.id)).toEqual(["t-3", "t-2", "t-1"]);
  });

  test("filters by category alone", async () => {
    const page = await json(get("/tickets?category=billing"));
    expect(page.total).toBe(2);
    expect(page.items.map((t: { id: string }) => t.id).sort()).toEqual(["t-1", "t-2"]);
  });

  test("filters by category and priority together", async () => {
    const page = await json(get("/tickets?category=billing&priority=low"));
    expect(page.total).toBe(1);
    expect(page.items[0].id).toBe("t-2");
  });

  test("filters by status", async () => {
    const page = await json(get("/tickets?status=pending"));
    expect(page.items.map((t: { id: string }) => t.id)).toEqual(["t-3"]);
  });

  test("paginates", async () => {
    const first = await json(get("/tickets?limit=2&offset=0"));
    const second = await json(get("/tickets?limit=2&offset=2"));
    expect(first.items).toHaveLength(2);
    expect(second.items).toHaveLength(1);
    expect(second).toMatchObject({ total: 3, limit: 2, offset: 2 });
  });

  test.each(["category=refunds", "priority=urgent", "limit=0", "limit=101", "offset=-1"])(
    "rejects ?%s with 422",
    async (query) => {
      expect((await get(`/tickets?${query}`)).status).toBe(422);
    },
  );

  test("names the allowed values when a filter is wrong", async () => {
    const { error } = await json(get("/tickets?category=refunds"));
    expect(error.details).toEqual([
      { path: "/category", message: "must be one of: billing, technical, account, other" },
    ]);
    const limit = await json(get("/tickets?limit=101"));
    expect(limit.error.details[0].message).toBe("must be an integer from 1 to 100");
  });
});
