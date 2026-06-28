// Shared Anthropic Messages API helper. Keeps the planner/routines code from
// duplicating the fetch boilerplate that already lives in summarizer.js.
// Everything degrades gracefully: callers check hasLLM() and supply their own
// deterministic fallback when no key is configured.

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

export function llmModel() {
  return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
}

export function hasLLM() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Call Claude with either a single `prompt` (turned into one user turn) or a
// full `messages` array. Returns the concatenated text content.
export async function callLLM({ system, prompt, messages, maxTokens = 1500 }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const msgs = messages || [{ role: "user", content: prompt }];
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: llmModel(),
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: msgs,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const data = await res.json();
  return (data.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}
