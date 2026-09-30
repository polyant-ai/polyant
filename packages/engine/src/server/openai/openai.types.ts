// SPDX-License-Identifier: AGPL-3.0-or-later

export interface ChatCompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  /** Client-provided conversation ID for stable session tracking (e.g. Open WebUI chat_id). */
  chat_id?: string;
  /**
   * Call context (e.g. the caller's phone and contact ids): projected onto the
   * conversation state through the agent's `webContextFieldMapping` before the
   * turn. Requires `chat_id` and the agent's API key.
   */
  context?: unknown;
}

export interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: "assistant"; content: string };
      finish_reason: "stop";
    },
  ];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface ChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      delta: { role?: string; content?: string };
      finish_reason: string | null;
    },
  ];
}

export interface ModelObject {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

export interface ModelsListResponse {
  object: "list";
  data: ModelObject[];
}
