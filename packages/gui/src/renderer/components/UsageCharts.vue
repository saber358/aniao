<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
	Chart,
	CategoryScale,
	LinearScale,
	PointElement,
	LineElement,
	LineController,
	DoughnutController,
	ArcElement,
	Tooltip,
} from "chart.js";
import type { UsageSnapshot } from "../../shared/data-statistics.ts";
import { formatTokens, usageSeries } from "../../domain/usage-statistics.ts";
import { createLogger } from "../../shared/logger.ts";

Chart.register(
	CategoryScale,
	LinearScale,
	PointElement,
	LineElement,
	LineController,
	DoughnutController,
	ArcElement,
	Tooltip,
);
const props = defineProps<{ snapshot: UsageSnapshot; days: number; dark: boolean }>();
const logger = createLogger("usage-charts");
const trend = ref<HTMLCanvasElement | null>(null);
const ring = ref<HTMLCanvasElement | null>(null);
const series = computed(() => usageSeries(props.snapshot, props.days));
const colors = ["#4478ff", "#248b3f", "#a474e8", "#e4a545", "#db6a86", "#3b9eb7"];
const total = computed(() => series.value.models.reduce((sum, model) => sum + model.tokens, 0));
let lineChart: Chart<"line"> | undefined;
let ringChart: Chart<"doughnut"> | undefined;

/*
 * ========================================================================
 * 步骤1：从同一份真实日期序列绘制趋势和模型占比
 * ========================================================================
 * 数据源：主进程统计快照与用户时间范围。
 * 操作：1) 切换范围和主题时更新图表；2) 离开页面时释放 Canvas 资源。
 */
function renderCharts(): void {
	if (!trend.value || !ring.value) return;
	logger.info("开始绘制用量图表");
	try {
		lineChart?.destroy();
		ringChart?.destroy();
		const text = props.dark ? "#a9a9ab" : "#808080";
		const grid = props.dark ? "#ffffff12" : "#0000000a";
		const textStyle = getComputedStyle(trend.value);
		const labelFont = {
			size: Number.parseFloat(textStyle.getPropertyValue("--settings-caption-size")),
			family: textStyle.fontFamily,
		};
		const bodyFont = {
			size: Number.parseFloat(textStyle.getPropertyValue("--settings-body-size")),
			family: textStyle.fontFamily,
		};
		lineChart = new Chart(trend.value, {
			type: "line",
			data: {
				labels: series.value.dates.map((day) => `${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`),
				datasets: series.value.models.map((model, index) => ({
					label: model.label,
					data: model.values,
					borderColor: colors[index % colors.length],
					borderWidth: 2,
					pointRadius: 0,
					pointHitRadius: 12,
					tension: 0.35,
					cubicInterpolationMode: "monotone",
				})),
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				interaction: { intersect: false, mode: "index" },
				plugins: {
					tooltip: {
						bodyFont,
						titleFont: bodyFont,
						filter: (item) => (item.parsed.y ?? 0) > 0,
						callbacks: { label: (item) => `${item.dataset.label}: ${formatTokens(item.parsed.y ?? 0)} tokens` },
					},
				},
				scales: {
					x: {
						grid: { display: false },
						border: { display: false },
						ticks: { color: text, maxRotation: 0, maxTicksLimit: 8, font: labelFont },
					},
					y: {
						beginAtZero: true,
						ticks: { display: false, count: 5 },
						border: { display: false, dash: [4, 4] },
						grid: { color: grid },
					},
				},
			},
		});
		ringChart = new Chart(ring.value, {
			type: "doughnut",
			data: {
				labels: series.value.models.map((model) => model.label),
				datasets: [
					{
						data: series.value.models.map((model) => model.tokens),
						backgroundColor: series.value.models.map((_, index) => colors[index % colors.length]),
						borderColor: props.dark ? "#232324" : "#f0f0f0",
						borderWidth: 3,
					},
				],
			},
			options: {
				responsive: true,
				maintainAspectRatio: false,
				animation: false,
				cutout: "66%",
				rotation: 90,
				plugins: {
					tooltip: {
						bodyFont,
						titleFont: bodyFont,
						callbacks: { label: (item) => `${formatTokens(item.parsed)} tokens` },
					},
				},
			},
		});
	} finally {
		logger.info("用量图表绘制结束");
	}
}
onMounted(renderCharts);
watch(
	() => [props.snapshot, props.days, props.dark],
	() => void nextTick(renderCharts),
);
onBeforeUnmount(() => {
	lineChart?.destroy();
	ringChart?.destroy();
});
</script>

<template>
	<div class="usage-chart-card trend-card">
		<h4>每日 Token 趋势图</h4>
		<div class="usage-legend">
			<span v-for="(model, index) in series.models" :key="model.key"
				><i :style="{ background: colors[index % colors.length] }"></i>{{ model.label }}</span
			>
		</div>
		<div class="trend-canvas"><canvas ref="trend" role="img" aria-label="每日各模型 Token 用量趋势"></canvas></div>
		<p v-if="!series.models.length" class="chart-empty">所选时间范围暂无使用记录</p>
	</div>
	<div class="usage-chart-card models-card">
		<h4>模型用量</h4>
		<div class="models-content">
			<div class="ring-canvas">
				<canvas ref="ring" role="img" aria-label="模型 Token 用量占比"></canvas>
				<div class="ring-label">
					<strong>{{ formatTokens(total) }}</strong
					><span>tokens</span>
				</div>
			</div>
			<div class="model-usage-list">
				<div v-for="(model, index) in series.models" :key="model.key">
					<i :style="{ background: colors[index % colors.length] }"></i>
					<div>
						<strong>{{ model.label }}</strong
						><span>{{ formatTokens(model.tokens) }} tokens</span>
					</div>
					<span
						>{{
							total ? ((model.tokens / total) * 100).toLocaleString("zh-CN", { maximumFractionDigits: 1 }) : 0
						}}%</span
					>
				</div>
				<p v-if="!series.models.length" class="data-muted">暂无模型用量</p>
			</div>
		</div>
	</div>
</template>

<style scoped>
.usage-chart-card {
	position: relative;
	background: var(--data-card);
	border-radius: 16px;
	padding: 16px;
}
h4 {
	margin: 0;
	font-size: var(--settings-section-heading-size);
	font-weight: 550;
}
.usage-legend {
	display: flex;
	flex-wrap: wrap;
	gap: 18px;
	margin-top: 16px;
	color: var(--data-muted);
	font-size: var(--settings-body-size);
}
.usage-legend > span {
	display: inline-flex;
	align-items: center;
	gap: 8px;
}
i {
	display: inline-block;
	width: 14px;
	height: 14px;
	border-radius: 4px;
	flex: none;
}
.trend-canvas {
	height: 200px;
	min-width: 0;
	margin: 12px 8px 0;
}
.chart-empty {
	position: absolute;
	top: 55%;
	left: 0;
	width: 100%;
	text-align: center;
	color: var(--data-muted);
	font-size: var(--settings-caption-size);
}
.models-content {
	display: grid;
	grid-template-columns: repeat(2, minmax(0, 1fr));
	align-items: center;
	gap: 24px;
	padding: 16px 8px 8px;
}
.ring-canvas {
	position: relative;
	width: min(100%, 180px);
	aspect-ratio: 1;
	justify-self: center;
}
.ring-canvas canvas {
	position: absolute;
	inset: 0;
}
.ring-label {
	position: absolute;
	inset: 0;
	display: grid;
	place-content: center;
	gap: 2px;
	text-align: center;
	pointer-events: none;
}
.ring-label strong {
	font-size: var(--settings-metric-size);
	font-weight: 550;
}
.ring-label span,
.data-muted {
	color: var(--data-muted);
	font-size: var(--settings-caption-size);
}
.model-usage-list > div {
	display: flex;
	gap: 9px;
	align-items: baseline;
	padding: 8px 0;
	border-bottom: 1px solid var(--data-line);
}
.model-usage-list > div:last-child {
	border: 0;
}
.model-usage-list > div > div {
	display: grid;
	flex: 1;
	min-width: 0;
	gap: 6px;
}
.model-usage-list strong {
	font-size: var(--settings-body-size);
	font-weight: 500;
	overflow-wrap: anywhere;
}
.model-usage-list span {
	font-size: var(--settings-caption-size);
	color: var(--data-muted);
}
@media (max-width: 1200px) {
	.models-content {
		gap: 22px;
	}
	.ring-canvas {
		width: min(100%, 160px);
	}
}
</style>
