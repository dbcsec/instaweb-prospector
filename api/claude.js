// Multi-provider fallback chain: Groq -> Cerebras -> Google Gemini
// If one provider is rate-limited, automatically tries the next.
// All three have free tiers (no credit card) as of mid-2026.

async function tryGroq(system, messages, max_tokens) {
  if (!process.env.GROQ_API_KEY) throw new Error("GROQ_API_KEY not set");
  const groqMessages = [];
  if (system) groqMessages.push({ role: "system", content: system });
  groqMessages.push(...messages);

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-120b",
      messages: groqMessages,
      max_tokens: max_tokens || 1000,
      temperature: 0.7,
    }),
  });
  const data = await response.json();
  if (data.error) {
    const err = new Error(data.error.message || "Groq error");
    err.isRateLimit = /rate limit/i.test(data.error.message || "");
    throw err;
  }
  return data.choices?.[0]?.message?.content || "";
}

async function tryCerebras(system, messages, max_tokens) {
  if (!process.env.CEREBRAS_API_KEY) throw new Error("CEREBRAS_API_KEY not set");
  const cbMessages = [];
  if (system) cbMessages.push({ role: "system", content: system });
  cbMessages.push(...messages);

  const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.CEREBRAS_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.3-70b",
      messages: cbMessages,
      max_tokens: max_tokens || 1000,
      temperature: 0.7,
    }),
  });
  const data = await response.json();
  if (data.error) {
    const err = new Error(data.error.message || "Cerebras error");
    err.isRateLimit = /rate limit/i.test(data.error.message || "");
    throw err;
  }
  return data.choices?.[0]?.message?.content || "";
}

async function tryGemini(system, messages, max_tokens) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set");
  const userText = messages.map(m => m.content).join("\n");
  const fullPrompt = system ? `${system}\n\n${userText}` : userText;

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: fullPrompt }] }],
        generationConfig: {
          maxOutputTokens: max_tokens || 1000,
          temperature: 0.7,
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
    }
  );
  const data = await response.json();
  if (data.error) {
    const err = new Error(data.error.message || "Gemini error");
    err.isRateLimit = /rate limit|quota/i.test(data.error.message || "");
    throw err;
  }
  const candidate = data.candidates?.[0];
  if (candidate?.finishReason === "MAX_TOKENS" && !candidate?.content?.parts?.[0]?.text) {
    throw new Error("Gemini hit MAX_TOKENS with no output — increase max_tokens");
  }
  return candidate?.content?.parts?.[0]?.text || "";
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { system, messages, max_tokens } = req.body;

    const providers = [
      { name: "groq", fn: tryGroq },
      { name: "cerebras", fn: tryCerebras },
      { name: "gemini", fn: tryGemini },
    ];

    let lastError = null;
    for (const provider of providers) {
      try {
        const text = await provider.fn(system, messages, max_tokens);
        if (!text || !text.trim()) {
          throw new Error(`${provider.name} returned empty response`);
        }
        return res.status(200).json({
          content: [{ type: "text", text }],
          provider: provider.name,
        });
      } catch (err) {
        lastError = err;
        // Only fall through to next provider on rate limit, missing key, or empty response;
        // other errors (bad request, etc.) should surface immediately.
        const isEmptyResponse = /returned empty response/.test(err.message);
        if (!err.isRateLimit && !err.message.includes("not set") && !isEmptyResponse) {
          return res.status(400).json({ error: `${provider.name}: ${err.message}` });
        }
        // else continue to next provider
      }
    }

    return res.status(429).json({ error: `All providers exhausted. Last error: ${lastError?.message}` });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
