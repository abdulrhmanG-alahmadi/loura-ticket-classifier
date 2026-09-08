/**
 * The model is an unreliable dependency that returns text.
 * Nothing in this file knows what a valid classification looks like.
 */
export type Message = { role: "system" | "user"; content: string };
export type LlmModel = (messages: Message[]) => Promise<string>;

/** The parts of OpenRouter's envelope we look at. Everything else is ignored. */
type Envelope = {
  error?: { code?: unknown; message?: unknown };
  choices?: { error?: { message?: unknown }; message?: { content?: unknown } }[];
};

export function openRouterModel(opts: {
  apiKey: string;
  model: string;
  timeoutMs: number;
}): LlmModel {
  return async (messages) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: opts.model, messages, temperature: 0, max_tokens: 300 }),
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    if (!res.ok) throw new Error(`openrouter ${res.status}: ${(await res.text()).slice(0, 200)}`);

    // The envelope is untrusted too: OpenRouter can answer 200 with an error inside it.
    const data = (await res.json().catch(() => {
      throw new Error("openrouter: response is not JSON");
    })) as Envelope;
    const failure = data?.error ?? data?.choices?.[0]?.error;
    if (failure) throw new Error(`openrouter: ${String(failure.message ?? "unknown error")}`);
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text === "") throw new Error("openrouter: empty response");
    return text;
  };
}

/**
 * Keyword heuristics plus a deterministic sprinkle of broken output (every 4th call), so the
 * retry path is exercised without a live model. Run with CLASSIFY_MAX_ATTEMPTS=1 to see `failed`.
 */
export function fakeModel({ brokenEvery = 4 } = {}): LlmModel {
  let calls = 0;
  return async (messages) => {
    calls += 1;
    const text = messages.at(-1)?.content.toLowerCase() ?? "";
    if (calls % brokenEvery === 0) return BROKEN[(calls / brokenEvery) % BROKEN.length] ?? "";

    const category = /charge|refund|invoice|billing|overcharg/.test(text)
      ? "billing"
      : /log ?in|password|email|account|profile/.test(text)
        ? "account"
        : /error|500|timeout|api|upload|export|broken|bug/.test(text)
          ? "technical"
          : "other";
    const priority = /not urgent|nice to have|feature request/.test(text)
      ? "low"
      : /urgent|blocking|production|outage|500/.test(text)
        ? "high"
        : "medium";
    return JSON.stringify({ category, priority, summary: `Customer reports a ${category} issue.` });
  };
}

const BROKEN = [
  "I'm sorry, but I can't help with classifying this ticket.",
  '{"category": "refunds", "priority": "urgent", "summary": "Customer wants money back"}',
  '{"category": "billing", "priority": "high", "summary": ',
];
