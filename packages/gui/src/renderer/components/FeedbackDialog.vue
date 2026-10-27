<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { createLogger } from "../../shared/logger.ts";
import { sendAnonymousFeedback } from "../feedback-client.ts";
import { UButton, UIcon, UModal, UTextarea } from "../ui.ts";

interface PickedImage {
	file: File;
	preview: string;
}
const logger = createLogger("feedback-dialog");
const open = defineModel<boolean>({ default: false });
const content = ref("");
const images = ref<PickedImage[]>([]);
const fileInput = ref<HTMLInputElement | null>(null);
const submitting = ref(false);
const error = ref("");
const success = ref("");
let submission: AbortController | undefined;
const canSubmit = computed(() => content.value.trim().length > 0 && !submitting.value);

/*
 * ========================================================================
 * 步骤1：维护反馈图片与预览生命周期
 * ========================================================================
 * 数据源：用户选择的本地图片，不访问账户或读取令牌。
 * 操作：1) 校验格式和大小；2) 移除和卸载时释放对象 URL。
 */
function chooseImages(): void {
	if (!submitting.value) fileInput.value?.click();
}
function addImages(event: Event): void {
	logger.info("开始添加反馈图片");
	try {
		// 1.1 提交期间锁定表单，避免成功回调清除新选图片。
		const input = event.target as HTMLInputElement;
		const selected = Array.from(input.files ?? []);
		input.value = "";
		if (submitting.value) return;
		error.value = "";
		for (const file of selected) {
			if (images.value.length >= 4) {
				error.value = "最多上传 4 张图片";
				break;
			}
			if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type)) {
				error.value = "仅支持 PNG、JPEG、WebP 或 GIF 图片";
				continue;
			}
			if (!file.size || file.size > 5 * 1024 * 1024) {
				error.value = "图片不能为空，且单张不能超过 5MB";
				continue;
			}
			images.value.push({ file, preview: URL.createObjectURL(file) });
		}
	} finally {
		logger.info("反馈图片添加结束");
	}
}
function removeImage(index: number): void {
	if (submitting.value) return;
	const [removed] = images.value.splice(index, 1);
	if (removed) URL.revokeObjectURL(removed.preview);
}
function clearImages(): void {
	for (const image of images.value) URL.revokeObjectURL(image.preview);
	images.value = [];
}

/*
 * ========================================================================
 * 步骤2：用户点击后匿名提交，失败保留表单
 * ========================================================================
 * 数据源：当前正文和已选图片。
 * 操作：1) 阻止连点；2) 仅成功响应后清空，关闭弹窗也不丢失失败输入。
 */
async function submitFeedback(): Promise<void> {
	if (submitting.value) return;
	logger.info("开始处理反馈提交");
	error.value = "";
	success.value = "";
	submitting.value = true;
	submission = new AbortController();
	try {
		// 2.1 请求不携带账号信息，内容与图片都由同一次 multipart 提交。
		await sendAnonymousFeedback(
			content.value,
			images.value.map((image) => image.file),
			submission.signal,
		);
		content.value = "";
		clearImages();
		success.value = "反馈已提交";
	} catch (exception) {
		error.value =
			exception instanceof DOMException && exception.name === "TimeoutError"
				? "提交超时，请稍后核对或重试"
				: exception instanceof Error
					? exception.message
					: "提交失败，请重试";
	} finally {
		submitting.value = false;
		submission = undefined;
		logger.info("反馈提交处理结束");
	}
}
watch(open, (value) => {
	if (!value || submitting.value) return;
	error.value = "";
	success.value = "";
});
onBeforeUnmount(() => {
	submission?.abort();
	clearImages();
});
</script>

<template>
	<UModal
		v-model:open="open"
		title="帮助与反馈"
		description="无需登录，可直接提交反馈。"
		:ui="{ overlay: 'feedback-overlay', content: 'feedback-modal' }"
	>
		<template #content>
			<div class="feedback-panel">
				<header class="feedback-header">
					<div class="feedback-heading">
						<UIcon name="i-lucide-message-square" aria-hidden="true" />
						<div>
							<strong>帮助与反馈</strong>
							<span>遇到问题或想要新功能，可以直接告诉我们</span>
						</div>
					</div>
					<UButton
						icon="i-lucide-x"
						color="neutral"
						variant="ghost"
						size="sm"
						aria-label="关闭反馈"
						title="关闭反馈"
						@click="open = false"
					/>
				</header>

				<div class="feedback-body">
					<p class="feedback-anonymous-note">无需登录，可直接提交反馈。</p>
					<label class="feedback-label" for="feedback-content">反馈内容</label>
					<UTextarea
						id="feedback-content"
						v-model="content"
						:rows="6"
						maxlength="5000"
						placeholder="描述你遇到的问题、复现步骤，或者希望增加的功能…"
						class="feedback-textarea"
						:disabled="submitting"
					/>
					<div class="feedback-counter">{{ content.length }} / 5000</div>

					<div class="feedback-attachments">
						<div class="feedback-attachments-head">
							<span>图片（可选，最多 4 张）</span>
							<UButton
								color="neutral"
								variant="ghost"
								size="xs"
								icon="i-lucide-image-plus"
								:disabled="images.length >= 4 || submitting"
								@click="chooseImages"
							>
								添加图片
							</UButton>
						</div>
						<input
							ref="fileInput"
							type="file"
							accept="image/png,image/jpeg,image/webp,image/gif"
							multiple
							hidden
							@change="addImages"
						/>
						<div v-if="images.length" class="feedback-previews">
							<div v-for="(image, index) in images" :key="image.preview" class="feedback-preview">
								<img :src="image.preview" :alt="image.file.name" />
								<button type="button" :disabled="submitting" aria-label="移除图片" @click="removeImage(index)">
									<UIcon name="i-lucide-x" aria-hidden="true" />
								</button>
							</div>
						</div>
					</div>

					<p v-if="error" class="feedback-error" role="alert">{{ error }}</p>
					<p v-if="success" class="feedback-success" role="status">{{ success }}</p>

					<div class="feedback-footer">
						<span>提交后管理员可以在后台查看并处理</span>
						<UButton
							color="neutral"
							icon="i-lucide-send"
							:loading="submitting"
							:disabled="!canSubmit"
							@click="submitFeedback"
						>
							提交反馈
						</UButton>
					</div>
				</div>
			</div>
		</template>
	</UModal>
</template>

<style scoped>
:global(.feedback-overlay) {
	z-index: 40;
}
:global(.feedback-modal) {
	z-index: 41;
	width: min(600px, calc(100vw - 40px));
	max-width: 600px !important;
	max-height: calc(100vh - 48px);
	padding: 0 !important;
	overflow: hidden;
	border-radius: 14px;
	background: var(--surface);
}
.feedback-panel {
	display: flex;
	max-height: calc(100vh - 48px);
	flex-direction: column;
}
.feedback-header {
	display: flex;
	align-items: center;
	justify-content: space-between;
	flex: none;
	padding: 14px 14px 12px 18px;
	border-bottom: 1px solid var(--line-soft);
	background: var(--sidebar);
}
.feedback-heading {
	display: flex;
	align-items: flex-start;
	gap: 10px;
	min-width: 0;
}
.feedback-heading > svg {
	flex: none;
	margin-top: 2px;
	color: var(--accent);
	font-size: 18px;
}
.feedback-heading div {
	display: grid;
	gap: 2px;
	min-width: 0;
}
.feedback-heading strong {
	color: var(--ink);
	font-size: 14px;
	font-weight: 600;
}
.feedback-heading span {
	color: var(--faint);
	font-size: 11px;
}
.feedback-body {
	display: grid;
	gap: 10px;
	overflow-y: auto;
	padding: 16px 18px 18px;
}
.feedback-anonymous-note {
	margin: 0;
	color: var(--faint);
	font-size: 11px;
}
.feedback-label {
	color: var(--muted);
	font-size: 11px;
	font-weight: 550;
}
.feedback-textarea {
	width: 100%;
}
.feedback-counter {
	margin-top: -7px;
	color: var(--faint);
	font-size: 9px;
	text-align: right;
}
.feedback-attachments {
	display: grid;
	gap: 7px;
	padding-top: 2px;
}
.feedback-attachments-head {
	display: flex;
	align-items: center;
	justify-content: space-between;
	color: var(--muted);
	font-size: 11px;
}
.feedback-previews {
	display: flex;
	flex-wrap: wrap;
	gap: 7px;
}
.feedback-preview {
	position: relative;
	width: 62px;
	height: 62px;
	overflow: hidden;
	border: 1px solid var(--line-soft);
	border-radius: 8px;
	background: var(--surface-raised);
}
.feedback-preview img {
	width: 100%;
	height: 100%;
	object-fit: cover;
}
.feedback-preview button {
	position: absolute;
	top: 3px;
	right: 3px;
	display: grid;
	width: 18px;
	height: 18px;
	place-items: center;
	border: 0;
	border-radius: 50%;
	background: rgb(0 0 0 / 55%);
	color: white;
	cursor: pointer;
	font-size: 11px;
}
.feedback-error,
.feedback-success {
	margin: 0;
	font-size: 11px;
	line-height: 1.5;
}
.feedback-error {
	color: #b64949;
}
.feedback-success {
	color: var(--sage);
}
.feedback-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
	padding-top: 4px;
}
.feedback-footer > span {
	color: var(--faint);
	font-size: 10px;
}
</style>
