<template>
	<div class="period-chart">
		<canvas ref="canvas" />
	</div>
</template>

<script setup lang="ts">
import { BarController, BarElement, CategoryScale, Chart, Legend, LinearScale, LineController, LineElement, PointElement, Tooltip } from "chart.js";
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

import { useSettingsStore } from "@/stores/settings";

import type { Period } from "../model/stats";
import { COLORS } from "../colors";

Chart.register(BarController, BarElement, LineController, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Legend);

const props = defineProps<{
	periods: Period[];
	groupBy: "day" | "month";
	labels: { finished: string; cancelled: string; interrupted: string; hours: string; prints: string };
	formatHours: (h: number) => string;
}>();

const settingsStore = useSettingsStore();
const canvas = ref<HTMLCanvasElement | null>(null);
let chart: Chart | null = null;

function axisLabel(key: string): string {
	const d = new Date(`${props.groupBy === "month" ? `${key}-01` : key}T00:00:00Z`);
	return props.groupBy === "month"
		? d.toLocaleDateString(undefined, { month: "short", year: "2-digit", timeZone: "UTC" })
		: d.toLocaleDateString(undefined, { day: "numeric", month: "short", timeZone: "UTC" });
}

function themeColors() {
	const dark = settingsStore.darkTheme;
	return { text: dark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.6)", grid: dark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)" };
}

function buildData() {
	return {
		labels: props.periods.map(p => axisLabel(p.key)),
		datasets: [
			{ type: "line", label: props.labels.hours, data: props.periods.map(p => +p.hours.toFixed(2)), yAxisID: "hours",
			  borderColor: COLORS.hours, backgroundColor: COLORS.hours, borderWidth: 2.5, pointRadius: 0, pointHitRadius: 8, tension: 0.3, order: 0 },
			{ type: "bar", label: props.labels.finished, data: props.periods.map(p => p.finished), stack: "jobs", yAxisID: "prints",
			  backgroundColor: COLORS.finished, borderRadius: 2, order: 1 },
			{ type: "bar", label: props.labels.cancelled, data: props.periods.map(p => p.cancelled), stack: "jobs", yAxisID: "prints",
			  backgroundColor: COLORS.cancelled, borderRadius: 2, order: 1 },
			{ type: "bar", label: props.labels.interrupted, data: props.periods.map(p => p.interrupted), stack: "jobs", yAxisID: "prints",
			  backgroundColor: COLORS.interrupted, borderRadius: 2, order: 1 },
		],
	};
}

function create() {
	const { text, grid } = themeColors();
	chart = new Chart(canvas.value!, {
		type: "bar",
		data: buildData() as any,
		options: {
			responsive: true,
			maintainAspectRatio: false,
			animation: { duration: 300 },
			interaction: { mode: "index", intersect: false },
			plugins: {
				legend: { position: "top", align: "end", labels: { color: text, boxWidth: 10, boxHeight: 10 } },
				tooltip: {
					callbacks: {
						label: (ctx: any) => ctx.dataset.yAxisID === "hours"
							? `${ctx.dataset.label}: ${props.formatHours(ctx.parsed.y ?? 0)}`
							: `${ctx.dataset.label}: ${ctx.parsed.y}`,
					},
				},
			},
			scales: {
				x: { stacked: true, grid: { display: false }, ticks: { color: text, autoSkip: true, maxRotation: 0 } },
				prints: {
					type: "linear", position: "left", stacked: true, beginAtZero: true,
					grid: { color: grid }, ticks: { color: text, precision: 0 },
					title: { display: true, text: props.labels.prints, color: text },
				},
				hours: {
					type: "linear", position: "right", beginAtZero: true,
					grid: { drawOnChartArea: false }, ticks: { color: text },
					title: { display: true, text: props.labels.hours, color: text },
				},
			},
		} as any,
	});
}

function applyTheme() {
	if (!chart) {
		return;
	}
	const { text, grid } = themeColors();
	const o = chart.options as any;
	o.plugins.legend.labels.color = text;
	for (const id of ["x", "prints", "hours"]) {
		o.scales[id].ticks.color = text;
		if (o.scales[id].title) {
			o.scales[id].title.color = text;
		}
	}
	o.scales.prints.grid.color = grid;
	chart.update();
}

watch(() => [props.periods, props.groupBy], () => {
	if (chart) {
		chart.data = buildData() as any;
		chart.update();
	}
});
watch(() => settingsStore.darkTheme, applyTheme);

onMounted(create);
onBeforeUnmount(() => {
	chart?.destroy();
	chart = null;
});
</script>

<style scoped>
.period-chart {
	position: relative;
	height: 240px;
}
</style>
