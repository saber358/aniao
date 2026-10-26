import { z } from "zod";

export const updatePhaseSchema = z.enum([
	"disabled",
	"idle",
	"checking",
	"available",
	"downloading",
	"downloaded",
	"error",
]);

export const updateStateSchema = z.object({
	phase: updatePhaseSchema,
	currentVersion: z.string().max(128),
	availableVersion: z.string().max(128).optional(),
	progress: z.number().min(0).max(100).optional(),
	message: z.string().max(8192).optional(),
	releaseNotes: z.string().max(20000).optional(),
});

export type UpdateState = z.infer<typeof updateStateSchema>;

export interface UpdatePort {
	getUpdateState(): Promise<UpdateState>;
	checkForUpdates(): Promise<UpdateState>;
	downloadUpdate(): Promise<UpdateState>;
	installUpdate(): Promise<void>;
	subscribeUpdate(listener: (state: UpdateState) => void): () => void;
}
