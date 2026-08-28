// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Live smoke test for the AI SDK 7 migration. Exercises the paths the bump
// actually risks, against the real Anthropic API and the COMPILED dist.
//
//   ANTHROPIC_SMOKE_KEY=sk-ant-... node packages/engine/scripts/smoke/ai-sdk-7.mjs
//
// Run `npm run build:engine` first. Costs a few tenths of a cent on Haiku.
// The key is read from the environment and never written anywhere.

import { fileURLToPath } from "node:url";
import path from "node:path";

const DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../dist") + "/";
const KEY = process.env.ANTHROPIC_SMOKE_KEY;
if (!KEY) {
  console.error("ANTHROPIC_SMOKE_KEY is not set.");
  process.exit(2);
}

const { initAIGateway, chat, chatStream, shutdown } = await import(DIST + "ai-gateway/index.js");
const { estimateCost } = await import(DIST + "ai-gateway/config.js");

const MODEL = "claude-haiku-4-5-20251001";
const base = { tier: "fast", provider: "anthropic", model: MODEL, apiKeys: { anthropic: KEY } };

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? " — " + detail : ""}`);
  if (ok) pass++;
  else fail++;
};
const u = (r) => JSON.stringify(r?.usage ?? null);

const section = async (title, body) => {
  console.log(`\n--- ${title} ---`);
  try {
    await body();
  } catch (err) {
    check(`la sezione non deve lanciare`, false, `${err?.constructor?.name}: ${String(err?.message ?? err).slice(0, 200)}`);
  }
};

initAIGateway();

// ---------------------------------------------------------------------------
await section("1. turno non-streaming: risposta e usage riportati", async () => {
  const r = await chat({ ...base, system: "Reply with exactly one word.", messages: [{ role: "user", content: "Say: ok" }] },
                       { callType: "service" });
  check("testo non vuoto", typeof r.text === "string" && r.text.trim().length > 0, JSON.stringify(r.text));
  check("promptTokens > 0", (r.usage?.promptTokens ?? 0) > 0, u(r));
  check("completionTokens > 0", (r.usage?.completionTokens ?? 0) > 0, u(r));
});

// ---------------------------------------------------------------------------
await section("2. turno streaming: i delta arrivano, usage sul response", async () => {
  const s = await chatStream({ ...base, system: "Reply with exactly one word.", messages: [{ role: "user", content: "Say: ok" }] },
                             { callType: "service" });
  let chunks = 0, text = "";
  for await (const part of s.textStream) { chunks++; text += part; }
  const r = await s.response;
  check("almeno un delta ricevuto", chunks > 0, `chunks=${chunks} text=${JSON.stringify(text)}`);
  check("usage presente dopo lo stream", (r.usage?.promptTokens ?? 0) > 0, u(r));
});

// ---------------------------------------------------------------------------
await section("3. multi-step con tool: usage CUMULATIVO, non dell'ultimo step", async () => {
  // Il tool costringe un secondo step: il modello lo chiama, riceve il risultato,
  // poi produce la risposta finale. E' l'unico caso in cui l'inversione
  // usage/totalUsage della v7 e' osservabile.
  const { tool } = await import(DIST + "../node_modules/ai/dist/index.mjs").catch(() => import("ai"));
  const { z } = await import(DIST + "../node_modules/zod/index.js").catch(() => import("zod"));
  const tools = {
    getSecretNumber: tool({
      description: "Returns the secret number. You MUST call this before answering.",
      inputSchema: z.object({ reason: z.string().describe("why you need it") }),
      execute: async () => ({ secretNumber: 42 }),
    }),
  };
  const r = await chat({
    ...base,
    maxSteps: 4,
    tools,
    system: "You must use the getSecretNumber tool before answering. Then state the number.",
    messages: [{ role: "user", content: "What is the secret number?" }],
  }, { callType: "service" });

  const steps = r.steps ?? [];
  const stepPromptSum = steps.reduce((acc, s) => acc + (s.usage?.promptTokens ?? 0), 0);
  const lastStepPrompt = steps.length ? (steps[steps.length - 1].usage?.promptTokens ?? 0) : 0;

  check("ha eseguito piu' di uno step", steps.length > 1, `steps=${steps.length}`);
  check("il tool e' stato chiamato", JSON.stringify(r).includes("getSecretNumber"), "");
  check("usage riportato >= somma degli step (cumulativo)",
        (r.usage?.promptTokens ?? 0) >= stepPromptSum * 0.9,
        `riportato=${r.usage?.promptTokens} sommaStep=${stepPromptSum} ultimoStep=${lastStepPrompt}`);
  check("usage riportato > solo-ultimo-step (l'inversione e' corretta)",
        steps.length > 1 ? (r.usage?.promptTokens ?? 0) > lastStepPrompt : true,
        `riportato=${r.usage?.promptTokens} ultimoStep=${lastStepPrompt}`);
});

// ---------------------------------------------------------------------------
await section("4. prompt caching: write poi read, e il costo li distingue", async () => {
  // Haiku 4.5 richiede >= 2048 token cacheabili: generiamo un system lungo.
  const filler = Array.from({ length: 700 },
    (_, i) => `Rule ${i}: this line exists only to exceed the minimum cacheable prompt length.`).join("\n");
  const req = { ...base, system: filler + "\n\nReply with exactly one word.", messages: [{ role: "user", content: "Say: ok" }] };

  const first = await chat({ ...req }, { callType: "service" });
  const second = await chat({ ...req }, { callType: "service" });

  const w1 = first.usage?.cacheCreationInputTokens ?? 0;
  const r2 = second.usage?.cachedInputTokens ?? 0;
  check("prima chiamata: cache WRITE contabilizzata", w1 > 0, `cacheWrite=${w1} usage=${u(first)}`);
  check("seconda chiamata: cache READ contabilizzata", r2 > 0, `cacheRead=${r2} usage=${u(second)}`);

  const c1 = estimateCost("anthropic", MODEL, first.usage);
  const c2 = estimateCost("anthropic", MODEL, second.usage);
  const cost = (c) => (typeof c === "number" ? c : c?.total);
  check("il costo della seconda e' inferiore alla prima (la cache paga)",
        cost(c2) < cost(c1), `primo=${cost(c1)} secondo=${cost(c2)}`);
  console.log("      breakdown 1:", JSON.stringify(c1), "\n      breakdown 2:", JSON.stringify(c2));
});

// ---------------------------------------------------------------------------
await section("5. reasoning attivo: i blocchi di ragionamento sono catturati", async () => {
  const r = await chat({
    ...base, thinking: true, thinkingLevel: "low",
    messages: [{ role: "user", content: "A farmer has 17 sheep and all but 9 run away. How many remain? Answer with the number only." }],
  }, { callType: "service" });
  const reasoningChars = JSON.stringify(r.reasoning ?? r.steps ?? "").length;
  check("risposta prodotta con thinking attivo", typeof r.text === "string" && r.text.length > 0, JSON.stringify(r.text));
  check("tracce di reasoning presenti", reasoningChars > 20, `chars≈${reasoningChars}`);
});

// ---------------------------------------------------------------------------
await section("6. percorso d'errore: responseBody del provider ancora popolato", async () => {
  // base.ts legge `responseBody` dagli errori del provider per il debug payload.
  // v7 esclude i body dai RISULTATI: questo verifica che gli ERRORI li portino ancora.
  let captured = null;
  try {
    await chat({ ...base, apiKeys: { anthropic: "sk-ant-api03-deliberately-invalid-key-for-smoke" },
                 messages: [{ role: "user", content: "hi" }] }, { callType: "service" });
  } catch (err) { captured = err; }
  check("una chiave non valida lancia", captured !== null, captured ? captured.constructor.name : "non ha lanciato");
  const chain = JSON.stringify(captured, Object.getOwnPropertyNames(captured ?? {}));
  check("l'errore riporta il corpo/motivo del provider",
        /authentication|invalid|api key|401/i.test(String(captured?.message ?? "") + chain),
        String(captured?.message ?? "").slice(0, 160));
});

console.log(`\n=== RISULTATO: ${pass} pass, ${fail} fail ===`);
await shutdown().catch(() => undefined);
process.exit(fail === 0 ? 0 : 1);
