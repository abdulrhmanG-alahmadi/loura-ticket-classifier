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
    if (calls % brokenEvery === 0) return BROKEN[(calls / brokenEvery) % BROKEN.length] ?? "";

    const { subject, body } = ticketIn(messages);
    const text = `${subject}\n${body}`.toLowerCase();
    const category = earliestMatch(text, CATEGORY_HINTS) ?? "other";
    const priority = /not urgent|nice to have|feature request/.test(text)
      ? "low"
      : /urgent|blocking|production|outage|500/.test(text)
        ? "high"
        : "medium";
    const topic = (subject || body)
      .replace(/\p{Cc}/gu, " ")
      .split(/[.!?]\s|[.!?]$/)[0]
      ?.trim()
      .slice(0, MAX_TOPIC);
    return JSON.stringify({
      category,
      priority,
      summary: `${SUMMARY_PREFIX}${topic || "nothing in particular"}.`,
    });
  };
}

const SUMMARY_PREFIX = "Customer writes about ";
/** The validator allows 500 characters; leave room for the prefix and the final period. */
const MAX_TOPIC = 500 - SUMMARY_PREFIX.length - 1;

/** The fake reads the ticket the way the prompt presents it: a JSON object after the instruction. */
function ticketIn(messages: Message[]): { subject: string; body: string } {
  const content = messages.at(-1)?.content ?? "";
  try {
    return JSON.parse(content.slice(content.indexOf("{")));
  } catch {
    return { subject: "", body: content };
  }
}

const CATEGORY_HINTS: [RegExp, string][] = [
  [/charge|refund|invoice|billing|overcharg/, "billing"],
  [/log ?in|password|email|account|profile/, "account"],
  [/error|500|timeout|api|upload|export|broken|bug/, "technical"],
];

/** Earliest hit wins, so the subject line outweighs an aside in the body. */
function earliestMatch(text: string, hints: [RegExp, string][]): string | undefined {
  let best: { at: number; value: string } | undefined;
  for (const [pattern, value] of hints) {
    const at = text.search(pattern);
    if (at !== -1 && (!best || at < best.at)) best = { at, value };
  }
  return best?.value;
}

const BROKEN = [
  "I'm sorry, but I can't help with classifying this ticket.",
  '{"category": "refunds", "priority": "urgent", "summary": "Customer wants money back"}',
  '{"category": "billing", "priority": "high", "summary": ',
];
