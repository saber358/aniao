<script setup lang="ts">
import type { ExtensionState } from "../../shared/interactions.ts";
import { UButton } from "../ui.ts";

defineProps<{ state: ExtensionState; placement: "aboveEditor" | "belowEditor" }>();
const emit = defineEmits<{ dismiss: [id: string] }>();
</script>

<template>
	<section
		v-if="
			state.widgets.some((widget) => widget.placement === placement) ||
			(placement === 'aboveEditor' && (state.notices.length || state.statuses.length))
		"
		aria-label="扩展信息"
		class="max-h-40 overflow-y-auto text-xs"
	>
		<template v-if="placement === 'aboveEditor'">
			<div
				v-for="notice in state.notices"
				:key="notice.id"
				class="flex items-start justify-between gap-3 py-1"
				:role="notice.level === 'error' ? 'alert' : 'status'"
			>
				<span class="whitespace-pre-wrap break-words">{{ notice.message }}</span>
				<UButton
					icon="i-lucide-x"
					color="neutral"
					variant="ghost"
					size="xs"
					aria-label="关闭扩展通知"
					@click="emit('dismiss', notice.id)"
				/>
			</div>
			<p v-for="status in state.statuses" :key="status.key" class="muted whitespace-pre-wrap break-words">
				{{ status.text }}
			</p>
		</template>
		<template v-for="widget in state.widgets" :key="widget.key">
			<p v-if="widget.placement === placement" class="whitespace-pre-wrap break-words py-1">
				{{ widget.lines.join("\n") }}
			</p>
		</template>
	</section>
</template>
