<script setup lang="ts">
import type { AuthenticationState } from "../../shared/interactions.ts";
import { UButton } from "../ui.ts";
import SafeLink from "./SafeLink.vue";

defineProps<{ flow: AuthenticationState["flow"]; cancel?: boolean }>();
const emit = defineEmits<{ cancel: [] }>();
</script>

<template>
	<div v-if="flow" class="settings-form" aria-label="登录进度">
		<p role="status">{{ flow.message }}</p>
		<code v-if="flow.phase === 'working' && flow.userCode">{{ flow.userCode }}</code>
		<div v-if="flow.phase === 'working'" class="queue-actions">
			<SafeLink v-if="flow.url" :href="flow.url">在浏览器登录</SafeLink>
			<UButton v-if="cancel" color="neutral" variant="ghost" @click="emit('cancel')">取消登录</UButton>
		</div>
	</div>
</template>
