<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { UsageSnapshot } from "../../shared/data-statistics.ts";
import { dateKey, shiftDate, formatTokens, usageStreak } from "../../domain/usage-statistics.ts";
import { createLogger } from "../../shared/logger.ts";
import { UIcon, UTooltip } from "../ui.ts";
import UsageCharts from "./UsageCharts.vue";

defineProps<{ dark: boolean }>();
const logger = createLogger("usage-statistics");
const snapshot = ref<UsageSnapshot | null>(null);
const busy = ref(false);
const error = ref("");
const mode = ref<"daily" | "weekly" | "cumulative">("daily");
const days = ref(7);
const streak = computed(() => usageStreak(snapshot.value?.activityDates ?? []));
const heatmap = computed(() => {
	const now = new Date();
	const start = shiftDate(now, -364 - shiftDate(now, -364).getDay());
	const totals = new Map<string, number>();
	const turns = new Map(snapshot.value?.dailyTurns.map((day) => [day.date, day.turns]) ?? []);
	for (const day of snapshot.value?.daily ?? []) totals.set(day.date, (totals.get(day.date) ?? 0) + day.tokens);
	let cumulative = 0;
	let cumulativeTurns = 0;
	const weeks = Array.from(
		{
			length:
				Math.floor(
					(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) -
						Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
						86400000 /
						7,
				) + 1,
		},
		(_, week) => {
			const weekDays = Array.from({ length: 7 }, (_, index) => shiftDate(start, week * 7 + index));
			const weekly = weekDays.reduce((sum, day) => sum + (totals.get(dateKey(day)) ?? 0), 0);
			const weeklyTurns = weekDays.reduce((sum, day) => sum + (turns.get(dateKey(day)) ?? 0), 0);
			return weekDays.map((day) => {
				const date = dateKey(day);
				const daily = totals.get(date) ?? 0;
				cumulative += daily;
				cumulativeTurns += turns.get(date) ?? 0;
				return {
					date,
					future: day > now,
					value: mode.value === "weekly" ? weekly : mode.value === "cumulative" ? cumulative : daily,
					daily,
					turns:
						mode.value === "weekly"
							? weeklyTurns
							: mode.value === "cumulative"
								? cumulativeTurns
								: (turns.get(date) ?? 0),
				};
			});
		},
	);
	const max = Math.max(1, ...weeks.flatMap((week) => week.map((day) => day.value)));
	return weeks.map((week) =>
		week.map((day) => ({ ...day, level: day.value === 0 ? 0 : Math.min(4, Math.ceil((day.value / max) * 4)) })),
	);
});
const months = computed(() => {
	const result: { label: string; column: number }[] = [];
	let previous = -1;
	for (const [index, week] of heatmap.value.entries()) {
		const date = new Date(`${week[0].date}T12:00:00`);
		if (date.getMonth() !== previous) {
			result.push({ label: `${date.getMonth() + 1}月`, column: index + 1 });
			previous = date.getMonth();
		}
	}
	return result.length > 12 ? result.slice(1) : result;
});

/*
 * ========================================================================
 * 步骤1：读取真实应用用量并保留失败重试
 * ========================================================================
 * 数据源：只读统计桥，不调用模型和外部账号接口。
 * 操作：1) 刷新时保留已有图表；2) 未报告用量时展示真实零值。
 */
async function refresh(): Promise<void> {
	if (busy.value) return;
	logger.info("开始刷新使用统计");
	busy.value = true;
	error.value = "";
	try {
		snapshot.value = await window.piDesktop.getUsageStatistics();
	} catch (reason) {
		error.value = reason instanceof Error ? reason.message : "使用统计读取失败";
	} finally {
		busy.value = false;
		logger.info("使用统计刷新结束");
	}
}
onMounted(refresh);
</script>

<template>
	<section class="data-settings usage-statistics" :aria-busy="busy">
		<header class="data-heading">
			<h2>使用统计</h2>
			<span class="usage-badge">应用用量</span>
		</header>
		<p v-if="error" class="data-error" role="alert">{{ error }}</p>
		<p v-if="!snapshot && busy" class="data-muted">正在读取本机使用记录…</p>
		<template v-if="snapshot">
			<div class="usage-metrics">
				<div>
					<strong>{{ formatTokens(snapshot.totalTokens) }}</strong
					><span>累计 Token 数</span>
				</div>
				<div>
					<strong>{{ formatTokens(snapshot.peakTokens) }}</strong
					><span>峰值 Token 数</span>
				</div>
				<div>
					<strong>{{ Math.floor(snapshot.longestChatMs / 60000) }} 分钟</strong><span>最长聊天时长</span>
				</div>
				<div>
					<strong>{{ streak.current }} 天</strong><span>当前连续天数</span>
				</div>
				<div>
					<strong>{{ streak.longest }} 天</strong><span>最长连续天数</span>
				</div>
			</div>
			<div class="heatmap-card">
				<div class="data-row">
					<h4>Token 活动</h4>
					<div class="data-segmented" aria-label="Token 活动统计方式">
						<button
							v-for="option in [
								{ id: 'daily', label: '每日' },
								{ id: 'weekly', label: '每周' },
								{ id: 'cumulative', label: '累计' },
							]"
							:key="option.id"
							type="button"
							:class="{ active: mode === option.id }"
							:aria-pressed="mode === option.id"
							@click="mode = option.id as typeof mode"
						>
							{{ option.label }}
						</button>
					</div>
				</div>
				<div
					class="heatmap"
					:style="{ '--weeks': heatmap.length }"
					role="group"
					aria-label="最近一年 Token 活动热力图"
				>
					<div v-for="(week, index) in heatmap" :key="index" class="heatmap-week">
						<UTooltip
							v-for="day in week"
							:key="day.date"
							:delay-duration="0"
							:disabled="day.future"
							disable-hoverable-content
							:content="{ side: 'top', sideOffset: 6, collisionPadding: 8 }"
							:ui="{ content: 'heatmap-tooltip' }"
						>
							<button
								type="button"
								class="heatmap-cell"
								:data-date="day.date"
								:data-level="day.level"
								:class="{ future: day.future }"
								:disabled="day.future"
								:aria-label="`${day.date}，${formatTokens(day.value)} tokens，${day.turns} 轮消息`"
							></button>
							<template #content
								><div class="heatmap-tooltip-copy">
									<span>{{
										new Date(`${day.date}T12:00:00`).toLocaleDateString("zh-CN", {
											year: "numeric",
											month: "long",
											day: "numeric",
										})
									}}</span
									><span>{{ formatTokens(day.value) }} tokens · {{ day.turns }} 轮消息</span>
								</div></template
							>
						</UTooltip>
					</div>
				</div>
				<div class="heatmap-months" :style="{ gridTemplateColumns: `repeat(${heatmap.length}, minmax(0, 1fr))` }">
					<span v-for="(month, index) in months" :key="index" :style="{ gridColumn: month.column }">{{
						month.label
					}}</span>
				</div>
			</div>
			<div class="data-row range-row">
				<span>时间范围</span>
				<div class="data-segmented" aria-label="用量时间范围">
					<button
						v-for="count in [7, 30]"
						:key="count"
						type="button"
						:class="{ active: days === count }"
						:aria-pressed="days === count"
						@click="days = count"
					>
						近 {{ count }} 日
					</button>
				</div>
			</div>
			<UsageCharts :snapshot="snapshot" :days="days" :dark="dark" />
			<p v-if="snapshot.skippedSessions" class="data-muted">
				{{ snapshot.skippedSessions }} 个历史文件暂未计入，部分统计可能不完整。
			</p>
		</template>
		<footer class="data-footer">
			<button class="data-button" type="button" :disabled="busy" @click="refresh">
				<UIcon name="i-lucide-refresh-cw" />{{ busy ? "刷新中…" : "刷新" }}
			</button>
		</footer>
	</section>
</template>

<style scoped>
.usage-badge {
	background: var(--data-control);
	padding: 5px 14px;
	border-radius: 24px;
	font-size: var(--settings-caption-size);
}
.usage-metrics {
	display: grid;
	grid-template-columns: repeat(5, minmax(0, 1fr));
	border-radius: 16px;
	background: var(--data-card);
	padding: 19px 0;
	margin-top: 15px;
}
.usage-metrics > div {
	display: grid;
	gap: 6px;
	position: relative;
	text-align: center;
}
.usage-metrics > div + div::before {
	content: "";
	position: absolute;
	left: 0;
	top: 9px;
	bottom: 9px;
	width: 1px;
	background: var(--data-line);
}
.usage-metrics strong {
	font-size: var(--settings-metric-size);
	font-weight: 550;
}
.usage-metrics span {
	color: var(--data-muted);
	font-size: var(--settings-metric-caption-size);
}
.heatmap-card {
	background: var(--data-card);
	padding: 15px 15px 20px;
	border-radius: 16px;
}
h4 {
	margin: 0;
	font-size: var(--settings-section-heading-size);
	font-weight: 550;
}
.heatmap {
	display: grid;
	grid-template-columns: repeat(var(--weeks), minmax(0, 1fr));
	gap: 3px;
	margin-top: 16px;
}
.heatmap-week {
	display: grid;
	grid-template-rows: repeat(7, 1fr);
	gap: 6px;
}
.heatmap-cell {
	display: block;
	width: 100%;
	padding: 0;
	aspect-ratio: 1;
	border-radius: 4px;
	background: var(--data-cell);
}
.heatmap-cell[data-level="1"] {
	background: #ced8ef;
}
.heatmap-cell[data-level="2"] {
	background: #9eb6e9;
}
.heatmap-cell[data-level="3"] {
	background: #7798e5;
}
.heatmap-cell[data-level="4"] {
	background: #557bdf;
}
.heatmap-cell.future {
	opacity: 0.35;
}
.heatmap-cell:hover:not(:disabled),
.heatmap-cell:focus-visible {
	outline: 1px solid color-mix(in srgb, var(--accent) 40%, transparent);
	outline-offset: 0;
}
:global(.heatmap-tooltip) {
	display: block;
	height: auto;
	padding: 8px 12px;
	border: 1px solid var(--line);
	border-radius: 10px;
	background: #f0f0f0;
	color: var(--ink);
	box-shadow: 0 2px 6px #00000008;
	font-family: inherit;
	font-size: 11px;
	line-height: 1.5;
	animation: none !important;
	transition: none !important;
}
:global(.dark .heatmap-tooltip) {
	background: #232324;
}
.heatmap-tooltip-copy {
	display: grid;
	gap: 1px;
	white-space: nowrap;
}
.heatmap-months {
	display: grid;
	font-size: var(--settings-caption-size);
	color: var(--data-muted);
	margin-top: 17px;
	padding-bottom: 1px;
	overflow: hidden;
}
.heatmap-months > span {
	white-space: nowrap;
}
.range-row {
	margin: -20px 0;
	padding: 0;
	font-size: var(--settings-body-size);
}
@media (max-width: 1200px) {
	.heatmap {
		gap: 2px;
	}
	.heatmap-week {
		gap: 2px;
	}
	.heatmap-cell {
		border-radius: 3px;
	}
}
</style>
