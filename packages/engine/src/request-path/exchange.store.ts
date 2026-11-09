// SPDX-License-Identifier: AGPL-3.0-or-later

import { BufferedInsertQueue } from "../utils/buffered-insert-queue.js";
import type { ModelExchange } from "../ai-gateway/providers/call-trace.js";
import { modelExchanges } from "./exchanges.schema.js";

type ExchangeRow = typeof modelExchanges.$inferInsert;

// Started with every other log queue at boot (initializeBufferedInsertQueues).
const queue = new BufferedInsertQueue<ExchangeRow>({
  table: modelExchanges,
  label: "model exchanges",
  // Bodies are large: a smaller buffer, written as soon as a turn's few rows arrive.
  maxBuffer: 200,
  batchAt: 4,
});

/** Record the exchanges of one gateway call, under its ai_logs row. */
export function recordExchanges(
  aiLogId: string,
  call: { messageId?: string; conversationId?: string; instanceId?: string },
  exchanges: readonly ModelExchange[],
): void {
  for (const ex of exchanges) {
    queue.push({
      aiLogId,
      messageId: call.messageId ?? null,
      conversationId: call.conversationId ?? null,
      instanceId: call.instanceId ?? null,
      stepIndex: ex.stepIndex,
      attempt: ex.attempt,
      status: ex.status,
      request: ex.request ?? null,
      response: ex.response ?? null,
    });
  }
}
