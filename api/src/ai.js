import OpenAI from "openai";

let openaiClient;

export function provider() {
  if (process.env.AI_PROVIDER) return process.env.AI_PROVIDER.toLowerCase();
  if (process.env.GEMINI_API_KEY) return "gemini";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "none";
}

export function hasAI() {
  return provider() !== "none";
}

function geminiModel() {
  return process.env.GEMINI_MODEL || "gemini-3.8-flash";
}

function openaiModel() {
  return process.env.OPENAI_MODEL || "gpt-5.4-mini";
}

async function generateGeminiJson({ system, user, schema }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    const e = new Error("GEMINI_API_KEY is not configured on the server.");
    e.statusCode = 503;
    throw e;
  }

  const model = geminiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key
    },
    body: JSON.stringify({
      contents: [{
        role: "user",
        parts: [{
          text: `${system}\n\nUSER INPUT:\n${user}`
        }]
      }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: schema
      }
    })
  });

  const data = await response.json();
  if (!response.ok) {
    const msg = data?.error?.message || `Gemini API error (${response.status})`;
    const e = new Error(msg);
    e.statusCode = response.status === 429 ? 429 : 502;
    throw e;
  }

  const text = (data?.candidates?.[0]?.content?.parts || [])
    .map(p => p?.text || "")
    .join("")
    .trim();

  if (!text) {
    const e = new Error("Gemini returned an empty response.");
    e.statusCode = 502;
    throw e;
  }

  return JSON.parse(text);
}

async function generateOpenAIJson({ system, user, schema, name }) {
  if (!process.env.OPENAI_API_KEY) {
    const e = new Error("OPENAI_API_KEY is not configured on the server.");
    e.statusCode = 503;
    throw e;
  }
  if (!openaiClient) openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const response = await openaiClient.responses.create({
    model: openaiModel(),
    input: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    text: {
      format: {
        type: "json_schema",
        name: name || "memorycast_json",
        strict: true,
        schema
      }
    }
  });

  return JSON.parse(response.output_text);
}

export async function generateStructured({ system, user, schema, name }) {
  const p = provider();
  if (p === "gemini") return generateGeminiJson({ system, user, schema });
  if (p === "openai") return generateOpenAIJson({ system, user, schema, name });

  const e = new Error("No AI provider is configured.");
  e.statusCode = 503;
  throw e;
}

export function aiInfo() {
  const p = provider();
  return {
    enabled: p !== "none",
    provider: p,
    model: p === "gemini" ? geminiModel() : p === "openai" ? openaiModel() : null
  };
}
