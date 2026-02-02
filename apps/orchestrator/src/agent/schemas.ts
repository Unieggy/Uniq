/**
 * Action schemas using Zod
 */

import { z } from 'zod';
const zOptString = z.string().optional().nullable().transform(v => v ?? undefined);

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('VISION_CLICK'),
    regionId: z.string(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('DOM_CLICK'),
    // NEW: Allow regionId as a fallback method to click specific elements instantly
    regionId: zOptString, 
    selector: zOptString,
    name: zOptString,
    description: zOptString,
    role: z.enum(['button', 'link', 'textbox', 'checkbox', 'radio']).optional(),
  }),

  // UPDATE THIS BLOCK:
  z.object({
    type: z.literal('DOM_FILL'),
    // NEW: Allow regionId here too
    regionId: zOptString,
    selector: zOptString,
    name: zOptString,
    description: zOptString,
    value: z.string(),
    role: z.enum(['textbox']).optional(),
  }),
  z.object({
    type: z.literal('WAIT'),
    duration: z.number().optional(),
    until: zOptString,
    description: zOptString,

  }),
  z.object({
    type: z.literal('ASK_USER'),
    message: z.string(),
    actionId: z.string().optional(),
  }),
  z.object({
    type: z.literal('CONFIRM'),
    message: z.string(),
    actionId: z.string().optional(),
  }),
  z.object({
    type: z.literal('DONE'),
    reason: z.string().optional(),
  }),
  z.object({
    type:z.literal('VISION_FILL'),
    regionId:z.string(),
    value:z.string(),
    description:z.string().optional(),
  }),
  z.object({
    type: z.literal('KEY_PRESS'),
    key: z.string(), // e.g. "Enter"
    regionId: z.string().optional(),
    description: z.string().optional(),
  }),
  z.object({
    type: z.literal('SCROLL'),
    direction: z.enum(['up', 'down']),
    amount: z.number().optional(), // pixels, defaults to 600
    description: z.string().optional(),
  }),

]);
export type Action = z.infer<typeof ActionSchema>;

export const DecisionSchema=z.object({
  action: ActionSchema,
  reasoning: z.string(),
  confidence: z.number().min(0).max(1),
});
// In src/agent/schemas.ts

export const PlanSchema = z.object({
  // 1. The Strategy: The AI's high-level analysis (Mental Simulation)
  strategy: z.string().describe("High-level reasoning and mental simulation of the workflow (e.g. 'This site requires SSO login...')."),
  
  // 2. The Steps: Rich objects instead of just strings
  steps: z.array(z.object({
    id: z.number(),
    title: z.string().describe("Short objective (e.g. 'Search for chatgpt')"),
    description: z.string().describe("Detailed guidance on what to look for (e.g. 'Find the search bar at the top center')."),
    needsAuth: z.boolean().describe("True if this step involves login/MFA."),
  })).max(15)
});

export type PlanResult=z.infer<typeof PlanSchema>;


export type Decision = z.infer<typeof DecisionSchema>;

