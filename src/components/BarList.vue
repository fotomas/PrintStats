<template>
	<div class="bar-list">
		<div v-for="item in items" :key="item.name" class="row" :class="{ stacked }">
			<span class="name" :title="item.name">{{ item.name }}</span>
			<div class="track"><div class="fill" :style="{ width: `${(item.value / max) * 100}%`, background: color }" /></div>
			<span class="value">{{ item.display ?? item.value }}</span>
		</div>
	</div>
</template>

<script setup lang="ts">
import { computed } from "vue";

const props = withDefaults(defineProps<{
	items: { name: string; value: number; display?: string }[];
	color?: string;
	/** name and value on one line above a thin bar (for long names) */
	stacked?: boolean;
}>(), { color: "#42A5F5", stacked: false });

const max = computed(() => Math.max(1, ...props.items.map(i => i.value)));
</script>

<style scoped>
.bar-list {
	display: flex;
	flex-direction: column;
	gap: 10px;
	font-size: 13px;
}

.row {
	display: grid;
	grid-template-columns: 64px 1fr 48px;
	gap: 10px;
	align-items: center;
}

.row.stacked {
	grid-template-columns: 1fr auto;
	grid-template-areas: "name value" "track track";
	row-gap: 4px;
}

.row.stacked .name { grid-area: name; }
.row.stacked .value { grid-area: value; }
.row.stacked .track { grid-area: track; height: 4px; }
.row.stacked .fill { height: 4px; }

.name {
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	color: rgba(var(--v-theme-on-surface), var(--v-high-emphasis-opacity));
}

.track {
	height: 10px;
	border-radius: 5px;
	background: rgba(var(--v-theme-on-surface), 0.08);
	overflow: hidden;
}

.fill {
	height: 10px;
	border-radius: 5px;
}

.value {
	text-align: right;
	font-variant-numeric: tabular-nums;
	color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
</style>
