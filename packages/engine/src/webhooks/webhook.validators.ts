// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";
import type { ChannelType } from "../instances/channels.store.js";

// Channels an event can be sent out on: `web` has no outbound adapter.
const OUTBOUND_CHANNEL_TYPES = ["telegram", "slack", "whatsapp", "agent"] as const satisfies readonly ChannelType[];

export const createEventSourceSchema = z.object({
  name: z.string().min(1),
  sourceType: z.string().min(1),
  config: z.record(z.unknown()).default({}),
  enabled: z.boolean().optional(),
});

export const updateEventSourceSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export const createDefinitionSchema = z.object({
  name: z.string().min(1),
  matchingPrompt: z.string().min(1),
  interpretationPrompt: z.string().default(""),
  action: z.enum(["backlog", "conversation"]).default("backlog"),
  contextPrompt: z.string().min(1).optional(),
  outboundChannel: z.enum(OUTBOUND_CHANNEL_TYPES).optional(),
  outboundTarget: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
}).refine(
  (data) => {
    if (data.action === "conversation") {
      return !!data.contextPrompt;
    }
    // backlog requires interpretationPrompt
    return !!data.interpretationPrompt;
  },
  { message: "action 'backlog' requires interpretationPrompt; action 'conversation' requires contextPrompt" },
).refine(
  (data) => {
    // outboundChannel and outboundTarget must be set together (or both absent)
    const hasChannel = !!data.outboundChannel;
    const hasTarget = !!data.outboundTarget;
    return hasChannel === hasTarget;
  },
  { message: "outboundChannel and outboundTarget must both be provided or both omitted" },
);

export const updateDefinitionSchema = z.object({
  name: z.string().min(1).optional(),
  matchingPrompt: z.string().min(1).optional(),
  interpretationPrompt: z.string().optional(),
  action: z.enum(["backlog", "conversation"]).optional(),
  contextPrompt: z.string().nullable().optional(),
  outboundChannel: z.enum(OUTBOUND_CHANNEL_TYPES).nullable().optional(),
  outboundTarget: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
}).refine(
  (data) => {
    // When both fields are present in the patch, they must be coherent
    // (both set or both null/empty). Partial patches that touch only one
    // of the two are intentionally allowed — coherence is re-checked in
    // webhook-sources.store.ts#updateDefinition against the merged row
    // (patch + persisted current value) before the write happens.
    if (data.outboundChannel === undefined && data.outboundTarget === undefined) return true;
    if (data.outboundChannel === undefined || data.outboundTarget === undefined) return true;
    const hasChannel = !!data.outboundChannel;
    const hasTarget = !!data.outboundTarget;
    return hasChannel === hasTarget;
  },
  { message: "outboundChannel and outboundTarget must both be provided or both null/omitted" },
);
