import { afterEach, describe, expect, test } from "bun:test";
import { InvalidModelOutput, parseClassification } from "../src/classifier";
import { fakeModel, openRouterModel } from "../src/model";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
let lastInit: RequestInit | undefined;
const respond = (status: number, body: unknown) => {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    lastInit = init;
    return typeof body === "string"
      ? new Response(body, { status })
      : Response.json(body, { status });
  }) as unknown as typeof fetch;
};
const model = openRouterModel({ apiKey: "k", model: "m", timeoutMs: 1000 });
const messages = [{ role: "user" as const, content: "hi" }];

describe("openRouterModel", () => {
  test("returns the text of the first choice, with a timeout on the call", async () => {
    respond(200, { choices: [{ message: { content: "{}" } }] });
    expect(await model(messages)).toBe("{}");
    expect(lastInit?.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ["a non-2xx status", 429, { error: { message: "rate limited" } }, /openrouter 429/],
    [
      "an error inside a 200",
      200,
      { error: { code: 502, message: "provider down" } },
      /provider down/,
    ],
    [
      "a choice-level error",
      200,
      { choices: [{ error: { message: "moderation" }, message: { content: "" } }] },
      /moderation/,
    ],
    ["empty content", 200, { choices: [{ message: { content: "" } }] }, /empty response/],
    ["a missing envelope", 200, { unexpected: true }, /empty response/],
    ["a non-JSON body", 200, "<html>gateway timeout</html>", /not JSON/],
  ])("rejects %s", async (_name, status, body, pattern) => {
    respond(status, body);
    await expect(model(messages)).rejects.toThrow(pattern);
  });
});

describe("fakeModel", () => {
  test("classifies by keyword and breaks on a fixed cadence", async () => {
    const fake = fakeModel({ brokenEvery: 3 });
    const ask = (body: string) => fake([{ role: "user", content: body }]);
    expect(JSON.parse(await ask("please refund the double charge"))).toMatchObject({
      category: "billing",
    });
    expect(JSON.parse(await ask("cannot log in"))).toMatchObject({ category: "account" });
    const fresh = fakeModel();
    const t1006 = await fresh([
      { role: "user", content: "Would love a dark mode option. Not urgent, just a nice to have." },
    ]);
    expect(JSON.parse(t1006)).toMatchObject({ category: "other", priority: "low" });
    const third = await ask("anything"); // 3rd call is deliberately broken
    expect(() => parseClassification(third)).toThrow(InvalidModelOutput);
  });
});
