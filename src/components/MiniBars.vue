<template>
	<div class="mini-bars">
		<div class="bars" :style="{ height: `${height}px` }">
			<div v-for="(b, i) in items" :key="i" class="bar" :title="b.title ?? `${b.label}: ${b.value}`"
				 :style="{ height: `${scale(b.value)}%`, background: b.color ?? color }" />
		</div>
		<div v-if="axis.length" class="axis">
			<span v-for="(a, i) in axis" :key="i">{{ a }}</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";

import type { MiniBar } from "./types";

const props = withDefaults(defineProps<{
	items: MiniBar[];
	color?: string;
	height?: number;
	/** labels shown under the bars, spread evenly (first, middle..., last) */
	axis?: string[];
}>(), { color: "#42A5F5", height: 120, axis: () => [] });

const max = computed(() => Math.max(1, ...props.items.map(b => b.value)));
const scale = (v: number) => (v > 0 ? Math.max(2, (v / max.value) * 100) : 0);
</script>

<style scoped>
.bars {
	display: flex;
	align-items: flex-end;
	gap: 4px;
}

.bar {
	flex: 1;
	min-width: 0;
	border-radius: 3px 3px 0 0;
}

.axis {
	display: flex;
	justify-content: space-between;
	margin-top: 6px;
	font-size: 11px;
	color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
</style>
