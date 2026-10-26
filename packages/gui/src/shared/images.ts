import type { ProjectFileSelection } from "./project-files.ts";

// PNG 与 JPEG 输入统一保存为 PNG；原图与解码尺寸均有界，草稿只保存内容身份。
export const IMAGE_INPUT_EXTENSIONS = ["png", "jpg", "jpeg"];
export const IMAGE_INPUT_MIME_TYPES = ["image/png", "image/jpeg"];
export const IMAGE_COUNT_LIMIT = 4;
export const IMAGE_BYTES_LIMIT = 3 * 1024 * 1024;
export const IMAGE_BASE64_LIMIT = Math.ceil(IMAGE_BYTES_LIMIT / 3) * 4;
export const IMAGE_DIMENSION_LIMIT = 8192;
export const IMAGE_PIXEL_LIMIT = 16_000_000;

export interface ImageRead extends ProjectFileSelection {
	imageId: string;
	source: "draft" | "message";
}

export interface ImageImport extends ProjectFileSelection {
	data: string[];
}

export interface ImagesPort {
	selectImages(selection: ProjectFileSelection): Promise<string[]>;
	importImages(input: ImageImport): Promise<string[]>;
	readImage(input: ImageRead): Promise<string>;
}
