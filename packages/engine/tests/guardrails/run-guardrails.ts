/**
 * Guardrail validation test runner.
 *
 * Sends test conversations to the running engine API (streaming mode)
 * and checks whether updateSoul / updateUserProfile tool calls are
 * triggered correctly.
 *
 * Usage:
 *   npx tsx tests/guardrails/run-guardrails.ts [--api-url http://localhost:4000] [--api-key <agent key>]
 *
 * The target is the agent whose slug is the `model` below. Its Web channel must be
 * on (Channels > Web, or `PUT /api/instances/:slug/channels/web`), and when its
 * authentication is on, pass the agent's API key with --api-key. An agent with Web
 * off answers 404 and the run stops at the first request with that explanation.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Config ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_PATH = resolve(__dirname, "test-cases.json");
const REPORT_PATH = resolve(__dirname, "report.json");

const API_URL = process.argv.includes("--api-url")
  ? process.argv[process.argv.indexOf("--api-url") + 1]
  : "http://localhost:4000";

const API_KEY = process.argv.includes("--api-key")
  ? process.argv[process.argv.indexOf("--api-key") + 1]
  : undefined;

const WATCHED_TOOLS = ["updateSoul", "updateUserProfile"];
const CONCURRENT = 3; // max parallel requests
const TIMEOUT_MS = 120_000; // 2 minutes per request

// ─── Types ───────────────────────────────────────────────────────────────────

interface Message {
  role: string;
  content: string;
}

interface TestCase {
  id: string;
  category: string;
  description: string;
  messages: Message[];
  expectedTools: string[];
}

interface TestResult {
  id: string;
  category: string;
  description: string;
  expectedTools: string[];
  actualTools: string[];
  pass: boolean;
  responsePreview: string;
  error?: string;
  durationMs: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Parse an SSE stream and extract tool names from ⏳ markers inside <think> blocks */
async function runConversation(
  messages: Message[],
  chatId: string,
): Promise<{ tools: string[]; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${API_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: "polyant",
        messages,
        stream: true,
        chat_id: chatId,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text();
      const hint =
        res.status === 404
          ? " (the agent \"polyant\" does not exist or its Web channel is off: switch it on in Channels > Web)"
          : res.status === 401
            ? " (the agent requires its API key: pass --api-key)"
            : "";
      throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}${hint}`);
    }

    const tools: string[] = [];
    let textParts: string[] = [];
    let inThink = false;

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!; // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;

        try {
          const chunk = JSON.parse(data);
          const content = chunk?.choices?.[0]?.delta?.content ?? "";
          if (!content) continue;

          // Track <think> blocks
          if (content.includes("<think>")) {
            inThink = true;
          }
          if (content.includes("</think>")) {
            inThink = false;
          }

          // Detect tool calls: ⏳ toolName...
          const toolMatch = content.match(/⏳\s+(\w+)\.\.\./);
          if (toolMatch && WATCHED_TOOLS.includes(toolMatch[1])) {
            tools.push(toolMatch[1]);
          }

          // Collect visible text (outside <think>)
          if (!inThink && !content.includes("<think>") && !content.includes("</think>")) {
            textParts.push(content);
          }
        } catch {
          // ignore parse errors on non-JSON lines
        }
      }
    }

    return { tools: [...new Set(tools)], text: textParts.join("") };
  } finally {
    clearTimeout(timer);
  }
}

/** Run a batch of promises with concurrency limit */
async function pMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔬 Soul/Identity Guardrail Validation\n`);
  console.log(`   API: ${API_URL}`);
  console.log(`   Cases: ${CASES_PATH}\n`);

  // Verify API is reachable
  try {
    const healthCheck = await fetch(`${API_URL}/v1/models`);
    if (!healthCheck.ok) throw new Error(`HTTP ${healthCheck.status}`);
    console.log("   ✅ API reachable\n");
  } catch (e) {
    console.error(`   ❌ API not reachable at ${API_URL}`);
    console.error(`   Start the engine with: npm run dev\n`);
    process.exit(1);
  }

  const testFile = JSON.parse(readFileSync(CASES_PATH, "utf-8"));
  const cases: TestCase[] = testFile.cases;
  console.log(`   Running ${cases.length} test cases (concurrency: ${CONCURRENT})\n`);
  console.log("─".repeat(80));

  const results = await pMap(
    cases,
    async (tc, idx) => {
      const start = Date.now();
      const chatId = `guardrail-test-${tc.id}-${Date.now()}`;

      try {
        const { tools, text } = await runConversation(tc.messages, chatId);

        // Evaluate: for "should_NOT_trigger", expectedTools is empty → actualTools should also be empty
        // For positive cases, expectedTools lists what MUST be called
        let pass: boolean;
        if (tc.expectedTools.length === 0) {
          // Negative case: no watched tools should be called
          pass = tools.length === 0;
        } else {
          // Positive case: all expected tools must be called
          pass = tc.expectedTools.every((t) => tools.includes(t));
        }

        const result: TestResult = {
          id: tc.id,
          category: tc.category,
          description: tc.description,
          expectedTools: tc.expectedTools,
          actualTools: tools,
          pass,
          responsePreview: text.slice(0, 200),
          durationMs: Date.now() - start,
        };

        const icon = pass ? "✅" : "❌";
        const toolsStr = tools.length > 0 ? tools.join(", ") : "(none)";
        const expectedStr = tc.expectedTools.length > 0 ? tc.expectedTools.join(", ") : "(none)";
        console.log(
          `${icon} [${tc.id}] ${tc.description}` +
            `\n   expected: ${expectedStr} | actual: ${toolsStr} | ${result.durationMs}ms`,
        );

        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`❌ [${tc.id}] ${tc.description}\n   ERROR: ${message}`);
        return {
          id: tc.id,
          category: tc.category,
          description: tc.description,
          expectedTools: tc.expectedTools,
          actualTools: [],
          pass: false,
          responsePreview: "",
          error: message,
          durationMs: Date.now() - start,
        } satisfies TestResult;
      }
    },
    CONCURRENT,
  );

  // ─── Summary ───────────────────────────────────────────────────────────────

  console.log("\n" + "═".repeat(80));
  console.log("SUMMARY\n");

  const byCategory = new Map<string, TestResult[]>();
  for (const r of results) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }

  let totalPass = 0;
  let totalFail = 0;

  for (const [cat, catResults] of byCategory) {
    const passed = catResults.filter((r) => r.pass).length;
    const failed = catResults.length - passed;
    totalPass += passed;
    totalFail += failed;
    console.log(`  ${cat}: ${passed}/${catResults.length} passed`);
    for (const r of catResults.filter((r) => !r.pass)) {
      const expected = r.expectedTools.length > 0 ? r.expectedTools.join(", ") : "(none)";
      const actual = r.actualTools.length > 0 ? r.actualTools.join(", ") : "(none)";
      console.log(`    ❌ ${r.id}: expected [${expected}] got [${actual}]`);
    }
  }

  console.log(`\n  TOTAL: ${totalPass}/${results.length} passed, ${totalFail} failed`);
  console.log("═".repeat(80));

  // Save report
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(
    REPORT_PATH,
    JSON.stringify({ timestamp: new Date().toISOString(), results, summary: { totalPass, totalFail, total: results.length } }, null, 2),
  );
  console.log(`\n📄 Full report: ${REPORT_PATH}\n`);

  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(2);
});
