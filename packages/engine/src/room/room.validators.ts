// SPDX-License-Identifier: AGPL-3.0-or-later

import { z } from "zod";

export const upsertRoomSchema = z.object({
  enabled: z.boolean().optional(),
  prompt: z.string().optional(),
  outboundChannel: z.string().nullable().optional(),
  outboundTarget: z.string().nullable().optional(),
});

export const createEventSourceSchema = z.object({
  name: z.string().min(1),
  sourceType: z.string().min(1),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().optional(),
});

export const updateEventSourceSchema = z.object({
  name: z.string().min(1).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
});

export const createDefinitionSchema = z.object({
  name: z.string().min(1),
  matchingPrompt: z.string().min(1),
  interpretationPrompt: z.string().min(1),
  enabled: z.boolean().optional(),
});

export const updateDefinitionSchema = z.object({
  name: z.string().min(1).optional(),
  matchingPrompt: z.string().min(1).optional(),
  interpretationPrompt: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
});
