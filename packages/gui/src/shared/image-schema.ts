import { z } from "zod";
import { IMAGE_BASE64_LIMIT, IMAGE_COUNT_LIMIT } from "./images.ts";

export const imageIdSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const imageIdsSchema = z
	.array(imageIdSchema)
	.max(IMAGE_COUNT_LIMIT)
	.refine((ids) => new Set(ids).size === ids.length);
export const imageDataSchema = z
	.string()
	.min(4)
	.max(IMAGE_BASE64_LIMIT)
	.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const imageBatchSchema = z.array(imageDataSchema).min(1).max(IMAGE_COUNT_LIMIT);
export const imageUrlSchema = z
	.string()
	.max(IMAGE_BASE64_LIMIT + 22)
	.regex(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
