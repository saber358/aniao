<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import type { AuthenticationState, DialogReply, DialogRequest } from "../../shared/interactions.ts";
import { createLogger } from "../../shared/logger.ts";
import { UButton, UInput, UModal, USelectMenu, UTextarea } from "../ui.ts";
import OAuthProgress from "./OAuthProgress.vue";

const props = defineProps<{
	request: DialogRequest;
	login?: AuthenticationState["flow"];
	respond: (reply: DialogReply) => Promise<boolean>;
}>();
const logger = createLogger("interaction-dialog");
const text = ref(props.request.prefill ?? "");
const selected = ref("");
const busy = ref(false);
const error = ref("");
const seconds = ref(Math.max(0, Math.ceil((props.request.expiresAt - Date.now()) / 1000)));
const timer = setInterval(() => {
	seconds.value = Math.max(0, Math.ceil((props.request.expiresAt - Date.now()) / 1000));
}, 1000);
onBeforeUnmount(() => {
	clearInterval(timer);
	text.value = "";
});

/*
 * ========================================================================
 * 步骤1：只回复当前交互，不把输入混入聊天草稿
 * ========================================================================
 * 数据源：经校验的宿主请求与用户本次选择。
 * 操作：
 *   1) 回复携带独立请求 ID，取消、超时和旧代次由宿主核对
 *   2) 复用 Modal 的焦点管理，敏感输入在销毁时清理
 */
async function reply(cancelled: boolean, confirmed = true) {
	if (busy.value) return;
	logger.info("开始回复界面交互");
	busy.value = true;
	error.value = "";
	try {
		// 1.1 空间内按请求类型取值；按钮确认不经过聊天发送入口。
		const value =
			props.request.kind === "confirm" ? confirmed : props.request.kind === "select" ? selected.value : text.value;
		if (!(await props.respond({ id: props.request.id, cancelled, ...(cancelled ? {} : { value }) })))
			error.value = "回复失败，请重试或取消";
	} finally {
		busy.value = false;
		logger.info("界面交互回复结束");
	}
}
</script>

<template>
	<UModal
		:open="true"
		:title="request.title"
		:description="request.message || (request.scope === 'oauth' ? '完成登录验证。' : '扩展请求输入。')"
		@update:open="(value) => !value && reply(true)"
	>
		<template #body>
			<div class="settings-form">
				<OAuthProgress v-if="request.scope === 'oauth'" :flow="login ?? null" />
				<p v-if="error" class="workspace-error" role="alert">{{ error }}</p>
				<USelectMenu
					v-if="request.kind === 'select'"
					v-model="selected"
					:items="request.options"
					value-key="value"
					aria-label="交互选项"
					:disabled="busy"
					class="w-full"
				/>
				<UTextarea
					v-else-if="request.kind === 'editor'"
					v-model="text"
					aria-label="编辑内容"
					:rows="8"
					:maxrows="12"
					:maxlength="1000000"
					:disabled="busy"
					class="w-full"
				/>
				<UInput
					v-else-if="request.kind === 'input'"
					v-model="text"
					:type="request.secret ? 'password' : 'text'"
					aria-label="交互输入"
					:placeholder="request.placeholder"
					:maxlength="request.scope === 'oauth' ? 16384 : 1000000"
					autocomplete="off"
					:disabled="busy"
					class="w-full"
				/>
				<p class="muted" role="status">剩余 {{ seconds }} 秒</p>
				<div class="queue-actions">
					<UButton color="neutral" variant="ghost" :disabled="busy" @click="reply(true)">取消</UButton>
					<UButton
						v-if="request.kind === 'confirm'"
						color="neutral"
						variant="outline"
						:disabled="busy"
						@click="reply(false, false)"
						>否</UButton
					>
					<UButton
						:disabled="
							busy ||
							(request.kind === 'select' && !selected) ||
							(request.kind === 'input' && request.allowEmpty === false && !text.trim())
						"
						:loading="busy"
						@click="reply(false)"
						>确定</UButton
					>
				</div>
			</div>
		</template>
	</UModal>
</template>
