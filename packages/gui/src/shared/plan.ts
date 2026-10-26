import { z } from "zod";

export const planPhaseSchema = z.enum(["off", "drafting", "awaiting", "executing", "completed", "interrupted"]);

export const planStateSchema = z.object({
	phase: planPhaseSchema,
	text: z.string().max(200_000),
	reason: z.string().max(8192).optional(),
});

export type PlanState = z.infer<typeof planStateSchema>;
