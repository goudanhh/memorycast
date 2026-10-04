import OpenAI from "openai";

let client;
export function hasAI() {
  return Boolean(process.env.OPENAI_API_KEY);
}
export function openai() {
  if (!hasAI()) {
    const e = new Error("OPENAI_API_KEY is not configured on the server.");
    e.statusCode = 503;
    throw e;
  }
  if (!client) client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return client;
}
export function model() {
  return process.env.OPENAI_MODEL || "gpt-5.4-mini";
}
