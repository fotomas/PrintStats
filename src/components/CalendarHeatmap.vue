<template>
	<div class="calendar">
		<div class="scroll">
			<div class="months">
				<span v-for="m in monthLabels" :key="m.key" :style="{ gridColumn: `${m.col + 1}` }">{{ m.label }}</span>
			</div>
			<div class="grid">
				<div v-for="(c, i) in cells" :key="i" class="cell" :title="c.title" :style="{ background: c.color }" />
			</div>
		</div>
		<div class="legend">
			<span>{{ less }}</span>
			<span v-for="(c, i) in LEVELS" :key="i" class="cell" :style="{ background: c }" />
			<span>{{ more }}</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{
	days: { day: string; hours: number; prints: number }[];
	less: string;
	more: string;
	/** tooltip text for one day */
	describe: (d: { day: string; hours: number; prints: number }) => string;
}>();

const LEVELS = [
	"rgba(var(--v-theme-on-surface), 0.08)",
	"rgba(66, 165, 245, 0.30)",
	"rgba(66, 165, 245, 0.50)",
	"rgba(66, 165, 245, 0.75)",
	"#42A5F5",
];

function level(hours: number, prints: number): number {
	if (prints === 0) return 0;
	if (hours < 1) return 1;
	if (hours < 3) return 2;
	if (hours < 6) return 3;
	return 4;
}

const cells = computed(() => props.days.map(d => ({ color: LEVELS[level(d.hours, d.prints)], title: props.describe(d) })));

const monthLabels = computed(() => {
	const out: { key: string; label: string; col: number }[] = [];
	props.days.forEach((d, i) => {
		if (d.day.endsWith("-01") || i === 0) {
			const date = new Date(`${d.day}T00:00:00Z`);
			const col = Math.floor(i / 7);
			if (!out.length || col - out[out.length - 1].col >= 3) {
				out.push({ key: d.day, col, label: date.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" }) });
			}
		}
	});
	return out;
});
</script>

<style scoped>
.scroll {
	overflow-x: auto;
	padding-bottom: 4px;
}

.months, .grid {
	display: grid;
	grid-auto-columns: 13px;
	column-gap: 3px;
}

.months {
	grid-auto-flow: column;
	height: 16px;
	font-size: 11px;
	color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
	white-space: nowrap;
}

.grid {
	grid-template-rows: repeat(7, 13px);
	grid-auto-flow: column;
	row-gap: 3px;
}

.cell {
	width: 13px;
	height: 13px;
	border-radius: 3px;
	display: inline-block;
}

.legend {
	display: flex;
	align-items: center;
	gap: 5px;
	margin-top: 10px;
	font-size: 11px;
	color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
</style>
