<template>
	<div class="hour-heatmap">
		<div v-for="(row, d) in matrix" :key="d" class="row">
			<span class="day">{{ dayNames[d] }}</span>
			<div v-for="(v, h) in row" :key="h" class="cell" :title="`${dayNames[d]} ${String(h).padStart(2, '0')}:00 – ${v}`"
				 :style="{ background: color(v) }" />
		</div>
		<div class="row axis">
			<span class="day" />
			<span v-for="h in [0, 6, 12, 18]" :key="h" :style="{ gridColumn: `${h + 2} / span 6` }">{{ String(h).padStart(2, "0") }}</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = defineProps<{ matrix: number[][] }>();

const dayNames = computed(() => {
	// Monday first, in the browser's language
	const monday = Date.UTC(2024, 0, 1);
	return Array.from({ length: 7 }, (_, i) => new Date(monday + i * 86400000).toLocaleDateString(undefined, { weekday: "short", timeZone: "UTC" }));
});

const max = computed(() => Math.max(1, ...props.matrix.flat()));

function color(v: number): string {
	if (v === 0) {
		return "rgba(var(--v-theme-on-surface), 0.08)";
	}
	return `rgba(66, 165, 245, ${(0.2 + 0.8 * (v / max.value)).toFixed(2)})`;
}
</script>

<style scoped>
.hour-heatmap {
	display: flex;
	flex-direction: column;
	gap: 3px;
	overflow-x: auto;
}

.row {
	display: grid;
	grid-template-columns: 34px repeat(24, minmax(9px, 1fr));
	gap: 3px;
	align-items: center;
}

.day, .axis span {
	font-size: 11px;
	color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}

.cell {
	height: 14px;
	border-radius: 2px;
}
</style>
