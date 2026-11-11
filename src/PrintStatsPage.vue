<template>
	<div class="print-stats">
		<!-- header -->
		<header class="ps-header">
			<div class="ps-heading">
				<h1>{{ tt("title") }}</h1>
				<div v-if="parsed" class="ps-muted">
					{{ tt("source", { file: parsed.source.file, lines: int(parsed.lines), from: day(parsed.first), to: day(parsed.last) }) }}
				</div>
			</div>
			<v-btn-toggle v-model="range" mandatory divided density="comfortable" variant="outlined" color="primary" :aria-label="tt('rangeLabel')">
				<v-btn v-for="r in TIME_RANGES" :key="r" :value="r">{{ tt(`ranges.${r}`) }}</v-btn>
			</v-btn-toggle>
			<v-select v-if="logFiles.length > 1" :model-value="logFile" :items="logFiles" :label="tt('logFile')" density="compact"
					  variant="outlined" hide-details class="ps-file" @update:model-value="selectLogFile" />
			<div class="ps-refresh">
				<span class="ps-muted ps-small">{{ statusText }}</span>
				<v-btn variant="tonal" prepend-icon="mdi-refresh" :loading="busy" :disabled="!connected" @click="refresh">
					{{ tt("refresh") }}
				</v-btn>
			</div>
		</header>

		<!-- thin download progress line, between the header and the content -->
		<v-progress-linear v-if="progress" :model-value="progressPct" :indeterminate="!progress.total" color="primary" height="3"
						   rounded :aria-label="statusText" class="ps-progress" />

		<v-alert v-if="!connected" type="info" variant="tonal" density="compact">{{ tt("notConnected") }}</v-alert>
		<v-alert v-else-if="noLogFile" type="warning" variant="tonal" density="compact">{{ tt("noLogFile", { dir: sysDir }) }}</v-alert>
		<v-alert v-if="error" type="error" variant="tonal" density="compact">{{ error }}</v-alert>
		<v-alert v-if="!parsed && busy" type="info" variant="tonal" density="compact">{{ tt("loadingFirst") }}</v-alert>

		<template v-if="s">
			<v-alert v-if="s.totals.started + s.totals.finished + s.totals.cancelled === 0" type="info" variant="tonal" density="compact">
				{{ tt("noJobs") }}
			</v-alert>

			<!-- totals -->
			<section class="ps-kpis">
				<v-card v-for="k in kpis" :key="k.key" class="ps-card ps-kpi">
					<div class="ps-kpi-label">{{ k.label }}</div>
					<div class="ps-kpi-value" :style="{ color: k.color }">{{ k.value }}</div>
					<div class="ps-muted ps-small">{{ k.sub }}</div>
				</v-card>
			</section>

			<!-- periods + success by length -->
			<section class="ps-row ps-wide">
				<v-card class="ps-card">
					<h2>{{ tt(s.groupBy === "month" ? "periods.titleMonth" : "periods.titleDay") }}</h2>
					<PeriodChart :periods="s.periods" :group-by="s.groupBy" :labels="periodLabels" :format-hours="hoursText" />
				</v-card>
				<v-card class="ps-card">
					<h2>{{ tt("byLength.title") }}</h2>
					<div class="ps-muted ps-small mb-4">{{ tt("byLength.sub") }}</div>
					<div class="ps-length">
						<div v-for="b in s.byLength" :key="b.label" class="ps-length-row" :title="`${b.finished} / ${b.cancelled}`">
							<span>{{ b.label }}</span>
							<div class="ps-split">
								<div :style="{ width: `${b.pct}%`, background: COLORS.finished }" />
								<div :style="{ width: `${b.finished + b.cancelled ? 100 - b.pct : 0}%`, background: COLORS.cancelled }" />
							</div>
							<span class="ps-num">{{ b.finished + b.cancelled ? `${Math.round(b.pct)}%` : tt("none") }}</span>
						</div>
					</div>
				</v-card>
			</section>

			<!-- calendar + records -->
			<section class="ps-row ps-wide">
				<v-card class="ps-card">
					<div class="ps-title-row">
						<h2>{{ tt("calendar.title") }}</h2>
						<span class="ps-muted ps-small">{{ tt("calendar.sub", { n: int(s.totals.activeDays) }) }}</span>
					</div>
					<CalendarHeatmap :days="cal" :less="tt('calendar.less')" :more="tt('calendar.more')" :describe="describeDay" />
				</v-card>
				<v-card class="ps-card">
					<h2>{{ tt("records.title") }}</h2>
					<div class="ps-records">
						<div v-for="r in records" :key="r.key">
							<div class="ps-record-value">{{ r.value }}</div>
							<div class="ps-muted ps-small">{{ r.label }}</div>
						</div>
					</div>
				</v-card>
			</section>

			<!-- habits -->
			<section class="ps-row ps-thirds">
				<v-card class="ps-card">
					<h2>{{ tt("hourWeek.title") }}</h2>
					<div class="ps-muted ps-small mb-3">{{ busiestSlot }}</div>
					<HourHeatmap :matrix="s.hourWeek" />
				</v-card>
				<v-card class="ps-card">
					<h2>{{ tt("cancelAt.title") }}</h2>
					<div class="ps-muted ps-small mb-3">{{ tt("cancelAt.sub", { n: int(s.cancelMinutes[0].value) }) }}</div>
					<MiniBars :items="cancelBars" :color="COLORS.cancelled" :axis="[tt('cancelAt.axisStart'), '5', tt('cancelAt.axisEnd')]" />
				</v-card>
				<v-card class="ps-card">
					<h2>{{ tt("estimate.title") }}</h2>
					<template v-if="s.estimate.n">
						<div class="ps-muted ps-small mb-3">
							{{ tt("estimate.sub", { n: int(s.estimate.n), median: (s.estimate.median ?? 1).toFixed(2) }) }}
							<strong>{{ estimateVerdict }}</strong>
						</div>
						<MiniBars :items="estimateBars" :axis="['0.6×', '1.0×', '1.5×', '2×+']" />
					</template>
					<div v-else class="ps-muted ps-small">{{ tt("estimate.none") }}</div>
				</v-card>
			</section>

			<!-- files -->
			<section class="ps-row ps-quarters">
				<v-card class="ps-card">
					<h2>{{ tt("materials.title") }}</h2>
					<div v-if="s.materials.length" class="ps-donut-row">
						<div class="ps-donut" :style="{ background: donut }"><div /></div>
						<div class="ps-legend">
							<div v-for="(m, i) in s.materials" :key="m.name">
								<span class="ps-swatch" :style="{ background: MATERIAL_COLORS[i] }" />
								<span class="ps-legend-name">{{ m.name }}</span>
								<span class="ps-num ps-muted">{{ hoursText(m.value) }}</span>
							</div>
						</div>
					</div>
					<div v-else class="ps-muted ps-small">{{ tt("materials.none") }}</div>
					<div class="ps-muted ps-tiny mt-3">{{ tt("materials.note") }}</div>
				</v-card>
				<v-card class="ps-card">
					<h2>{{ tt("layers.title") }}</h2>
					<BarList v-if="s.layers.length" :items="layerItems" />
					<div v-else class="ps-muted ps-small">{{ tt("layers.none") }}</div>
				</v-card>
				<v-card class="ps-card">
					<h2>{{ tt("top.title") }}</h2>
					<BarList stacked :color="COLORS.hours" :items="topItems" />
				</v-card>
				<v-card class="ps-card">
					<h2>{{ tt("milestones.title") }}</h2>
					<div class="ps-muted ps-small mb-3">{{ tt("milestones.sub") }}</div>
					<div class="ps-milestones">
						<div v-for="m in miles" :key="m.n">
							<span class="ps-milestone-n">#{{ int(m.n) }}</span>
							<span>{{ m.name }} <span class="ps-muted">· {{ dayText(m.day) }}</span></span>
						</div>
					</div>
				</v-card>
			</section>

			<!-- machine -->
			<v-card class="ps-card">
				<div class="ps-title-row">
					<h2>{{ tt("machine.title") }}</h2>
					<span class="ps-muted ps-small">
						{{ tt("machine.sub", { powerUps: int(s.powerUps), uv: int(s.underVoltage), faults: int(faultCount) }) }}
					</span>
				</div>
				<div class="ps-muted ps-small mb-2">{{ tt("machine.firmware") }}</div>
				<div class="ps-firmware">
					<div v-for="(f, i) in firmware" :key="i">
						<div class="ps-fw-line"><span class="ps-fw-dot" /><span class="ps-fw-rule" /></div>
						<span class="ps-fw-version">{{ f.version }}</span>
						<span class="ps-muted ps-tiny">{{ f.date }}</span>
					</div>
				</div>
				<div class="ps-row ps-halves mt-6">
					<div>
						<div class="ps-muted ps-small mb-2">{{ tt("machine.leveling") }}</div>
						<MiniBars :items="levelBars" :color="COLORS.hours" :height="80" :axis="levelAxis" />
					</div>
					<div>
						<div class="ps-muted ps-small mb-2">{{ tt("machine.faults") }}</div>
						<div v-for="f in s.faults" :key="f.name" class="ps-fault">
							<span>{{ f.name }}</span><span class="ps-num" :style="{ color: COLORS.cancelled }">{{ f.value }}</span>
						</div>
						<div v-if="!s.faults.length" class="ps-muted ps-small">{{ tt("machine.noFaults") }}</div>
					</div>
				</div>
			</v-card>
		</template>
	</div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import i18n from "@/i18n";
import { useCacheStore } from "@/stores/cache";
import { useMachineStore } from "@/stores/machine";

import BarList from "./components/BarList.vue";
import CalendarHeatmap from "./components/CalendarHeatmap.vue";
import HourHeatmap from "./components/HourHeatmap.vue";
import MiniBars from "./components/MiniBars.vue";
import type { MiniBar } from "./components/types";
import PeriodChart from "./components/PeriodChart.vue";
import { COLORS, MATERIAL_COLORS } from "./colors";
import { PLUGIN_ID } from "./id";
import { TIME_RANGES, calendar, computeStats, formatMinutes, levelingByQuarter, milestones, type TimeRange } from "./model/stats";
import { usePrintStats } from "./usePrintStats";

const tt = (key: string, args?: Record<string, unknown>) => i18n.global.t(`plugins.printStats.${key}`, args ?? {});

const machineStore = useMachineStore();
const cacheStore = useCacheStore();
const { parsed, status, error, noLogFile, logFiles, logFile, progress, start, refresh, checkForChanges, selectLogFile } = usePrintStats();

const connected = computed(() => machineStore.isConnected);
const sysDir = computed(() => String((machineStore.model as any).directories?.system ?? "0:/sys/"));
const busy = computed(() => status.value !== "idle");

const storedRange = cacheStore.plugins[PLUGIN_ID]?.range as TimeRange | undefined;
const range = ref<TimeRange>(storedRange && TIME_RANGES.includes(storedRange) ? storedRange : "all");
watch(range, r => cacheStore.setPluginData(PLUGIN_ID, "range", r));

const s = computed(() => (parsed.value ? computeStats(parsed.value, range.value) : null));
const cal = computed(() => (parsed.value ? calendar(parsed.value) : []));
const miles = computed(() => (parsed.value ? milestones(parsed.value) : []));
const levels = computed(() => (parsed.value ? levelingByQuarter(parsed.value) : []));

// ---- formatting -----------------------------------------------------------------------------------

const int = (n: number) => Math.round(n).toLocaleString();
const day = (t: number) => (t ? new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "—");
const dayText = (d: string) => day(Date.parse(`${d}T00:00:00Z`) / 1000);
const monthText = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
const hoursText = (h: number) => (h >= 100 ? `${int(h)} h` : `${h.toFixed(1)} h`);

// "updated 4 min ago", re-evaluated every 30 s
const tick = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const mb = (bytes: number) => (bytes / 1048576).toFixed(1);
const progressPct = computed(() => (progress.value?.total ? Math.min(100, (progress.value.loaded / progress.value.total) * 100) : 0));
const statusText = computed(() => {
	if (status.value === "downloading" && progress.value?.total) {
		return tt("status.downloadingProgress", { file: logFile.value, loaded: mb(progress.value.loaded), total: mb(progress.value.total) });
	}
	if (status.value !== "idle") {
		return tt(`status.${status.value}`, { file: logFile.value });
	}
	if (!parsed.value) {
		return "";
	}
	const seconds = Math.round((Date.parse(parsed.value.parsedAt) - tick.value) / 1000);
	if (seconds > -60) {
		return tt("updated", { ago: tt("justNow") });
	}
	const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	const ago = seconds > -3600 ? rtf.format(Math.round(seconds / 60), "minute")
		: seconds > -86400 ? rtf.format(Math.round(seconds / 3600), "hour")
		: rtf.format(Math.round(seconds / 86400), "day");
	return tt("updated", { ago });
});

// ---- view data ------------------------------------------------------------------------------------

const kpis = computed(() => {
	const t = s.value!.totals;
	const span = Math.max(1, Math.round((s.value!.to - s.value!.from) / 86400));
	return [
		{ key: "started", label: tt("kpi.started"), value: int(t.started), sub: tt("kpi.startedSub", { days: int(span) }) },
		{ key: "finished", label: tt("kpi.finished"), value: int(t.finished), color: COLORS.finished,
		  sub: tt("kpi.finishedSub", { median: formatMinutes(t.medianMinutes), p90: formatMinutes(t.p90Minutes) }) },
		{ key: "cancelled", label: tt("kpi.cancelled"), value: int(t.cancelled), color: COLORS.cancelled, sub: tt("kpi.cancelledSub", { n: int(t.earlyCancels) }) },
		{ key: "interrupted", label: tt("kpi.interrupted"), value: int(t.interrupted), sub: tt("kpi.interruptedSub") },
		{ key: "hours", label: tt("kpi.hours"), value: hoursText(t.hours), color: COLORS.hours,
		  sub: tt("kpi.hoursSub", { days: int(t.hours / 24), busy: t.busyPct.toFixed(1) }) },
		{ key: "success", label: tt("kpi.success"), value: `${Math.round(t.successPct)} %`, sub: tt("kpi.successSub", { pct: Math.round(t.successAfter5Pct) }) },
	];
});

const periodLabels = computed(() => ({
	finished: tt("periods.finished"), cancelled: tt("periods.cancelled"), interrupted: tt("periods.interrupted"),
	hours: tt("periods.hours"), prints: tt("periods.prints"),
}));

const describeDay = (d: { day: string; hours: number; prints: number }) =>
	tt("calendar.day", { day: dayText(d.day), prints: d.prints, hours: hoursText(d.hours) });

const records = computed(() => {
	const r = s.value!.records;
	const none = tt("none");
	return [
		{ key: "longest", value: r.longest ? formatMinutes(r.longest.minutes) : none,
		  label: tt("records.longest", { name: r.longest?.name ?? none, day: r.longest ? dayText(r.longest.day) : none }) },
		{ key: "prints", value: r.mostPrintsDay ? int(r.mostPrintsDay.value) : none,
		  label: tt("records.mostPrints", { day: r.mostPrintsDay ? dayText(r.mostPrintsDay.day) : none }) },
		{ key: "hours", value: r.mostHoursDay ? hoursText(r.mostHoursDay.value) : none,
		  label: tt("records.mostHours", { day: r.mostHoursDay ? dayText(r.mostHoursDay.day) : none }) },
		{ key: "streak", value: r.streak ? tt("records.daysValue", { n: r.streak.days }) : none,
		  label: tt("records.streak", { from: r.streak ? dayText(r.streak.from) : none, to: r.streak ? dayText(r.streak.to) : none }) },
		{ key: "break", value: r.longestBreak ? tt("records.daysValue", { n: r.longestBreak.days }) : none,
		  label: tt("records.break", { from: r.longestBreak ? dayText(r.longestBreak.from) : none, to: r.longestBreak ? dayText(r.longestBreak.to) : none }) },
		{ key: "month", value: r.busiestMonth ? hoursText(r.busiestMonth.hours) : none,
		  label: tt("records.busiestMonth", { month: r.busiestMonth ? monthText(r.busiestMonth.month) : none }) },
	];
});

const busiestSlot = computed(() => {
	const m = s.value!.hourWeek;
	let best = { d: 0, h: 0, v: -1 };
	m.forEach((row, d) => row.forEach((v, h) => { if (v > best.v) best = { d, h, v }; }));
	const dayName = new Date(Date.UTC(2024, 0, 1 + best.d)).toLocaleDateString(undefined, { weekday: "long", timeZone: "UTC" });
	return tt("hourWeek.sub", { day: dayName, hour: String(best.h).padStart(2, "0") });
});

const cancelBars = computed<MiniBar[]>(() => s.value!.cancelMinutes.map(b => ({ label: b.label, value: b.value, title: `${b.label} min: ${b.value}` })));

const estimateBars = computed<MiniBar[]>(() => s.value!.estimate.buckets.map(b => ({
	label: b.label, value: b.value, title: `${b.label}×: ${b.value}`,
	color: parseFloat(b.label) > 1.05 ? COLORS.cancelled : COLORS.finished,
})));

const estimateVerdict = computed(() => {
	const m = s.value!.estimate.median ?? 1;
	const pct = Math.round(Math.abs(m - 1) * 100);
	return m >= 1 ? tt("estimate.slower", { pct }) : tt("estimate.faster", { pct });
});

const layerItems = computed(() => s.value!.layers.map(l => ({ name: `${l.name} mm`, value: l.value, display: int(l.value) })));
const topItems = computed(() => s.value!.topParts.map(p => ({ name: p.name, value: p.value, display: `×${p.value}` })));

const donut = computed(() => {
	const mats = s.value!.materials;
	const total = mats.reduce((a, m) => a + m.value, 0) || 1;
	let at = 0;
	const stops = mats.map((m, i) => {
		const from = at;
		at += (m.value / total) * 100;
		return `${MATERIAL_COLORS[i]} ${from.toFixed(1)}% ${at.toFixed(1)}%`;
	});
	return `conic-gradient(${stops.join(", ")})`;
});

const faultCount = computed(() => s.value!.faults.reduce((a, f) => a + f.value, 0));

const firmware = computed(() => (parsed.value?.firmware ?? []).map(([t, version]) => ({
	version,
	date: new Date(t * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" }),
})));

const levelBars = computed<MiniBar[]>(() => levels.value.map(q => ({ label: q.quarter, value: q.microns, title: `${q.quarter}: ${q.microns} µm (${q.n})` })));
const levelAxis = computed(() => {
	const q = levels.value;
	return q.length ? [q[0].quarter, q[Math.floor(q.length / 2)].quarter, q[q.length - 1].quarter] : [];
});

// ---- lifecycle ------------------------------------------------------------------------------------

// look for new log entries a few seconds after a print ends
const RUNNING = ["processing", "simulating", "paused", "pausing", "resuming", "cancelling"];
let afterJob: ReturnType<typeof setTimeout> | undefined;
watch(() => String((machineStore.model as any).state?.status ?? ""), (to, from) => {
	if (to === "idle" && RUNNING.includes(from)) {
		clearTimeout(afterJob);
		afterJob = setTimeout(() => checkForChanges(), 5000);
	}
});

watch(connected, to => {
	if (to) {
		start();
	}
});

onMounted(() => {
	timer = setInterval(() => (tick.value = Date.now()), 30000);
	start();
});

onBeforeUnmount(() => {
	clearInterval(timer);
	clearTimeout(afterJob);
});
</script>

<style scoped>
.print-stats {
	display: flex;
	flex-direction: column;
	gap: 16px;
	max-width: 1440px;
	margin: 0 auto;
}

h1 { font-size: 1.6rem; font-weight: 500; margin: 0; }
h2 { font-size: 1rem; font-weight: 500; margin: 0 0 12px; }

.ps-header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 16px;
}

.ps-heading { flex: 1 1 340px; display: flex; flex-direction: column; gap: 4px; }
.ps-file { max-width: 240px; }
.ps-refresh { display: flex; align-items: center; gap: 12px; }
.ps-progress { margin: -8px 0 -4px; }

.ps-muted { color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.ps-small { font-size: 0.8rem; }
.ps-tiny { font-size: 0.7rem; }
.ps-num { font-variant-numeric: tabular-nums; }

.ps-card { padding: 20px; min-width: 0; }

.ps-kpis {
	display: grid;
	grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
	gap: 16px;
}

.ps-kpi { display: flex; flex-direction: column; gap: 6px; }
.ps-kpi-label {
	font-size: 0.72rem;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity));
}
.ps-kpi-value { font-size: 2.2rem; font-weight: 700; line-height: 1.05; font-variant-numeric: tabular-nums; }

.ps-row { display: grid; gap: 16px; }
.ps-wide { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); }
.ps-thirds { grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); }
.ps-quarters { grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
.ps-halves { grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 24px; }

@media (max-width: 1100px) {
	.ps-wide { grid-template-columns: minmax(0, 1fr); }
}

.ps-title-row {
	display: flex;
	flex-wrap: wrap;
	justify-content: space-between;
	align-items: baseline;
	gap: 8px;
	margin-bottom: 4px;
}

.ps-length { display: flex; flex-direction: column; gap: 12px; }
.ps-length-row {
	display: grid;
	grid-template-columns: 64px 1fr 44px;
	gap: 10px;
	align-items: center;
	font-size: 0.85rem;
}
.ps-split { display: flex; height: 18px; border-radius: 4px; overflow: hidden; background: rgba(var(--v-theme-on-surface), 0.08); }
.ps-length-row .ps-num { text-align: right; }

.ps-records { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.ps-record-value { font-size: 1.5rem; font-weight: 700; font-variant-numeric: tabular-nums; }

.ps-donut-row { display: flex; align-items: center; gap: 20px; }
.ps-donut {
	width: 120px;
	height: 120px;
	border-radius: 50%;
	flex-shrink: 0;
	display: flex;
	align-items: center;
	justify-content: center;
}
.ps-donut > div { width: 76px; height: 76px; border-radius: 50%; background: rgb(var(--v-theme-surface)); }
.ps-legend { display: flex; flex-direction: column; gap: 8px; font-size: 0.85rem; }
.ps-legend > div { display: flex; align-items: center; gap: 8px; }
.ps-legend-name { min-width: 44px; }
.ps-swatch { width: 10px; height: 10px; border-radius: 2px; }

.ps-milestones { display: flex; flex-direction: column; gap: 10px; font-size: 0.85rem; }
.ps-milestones > div { display: grid; grid-template-columns: 64px 1fr; gap: 10px; align-items: baseline; }
.ps-milestone-n { font-size: 1rem; font-weight: 700; color: #42A5F5; }

.ps-firmware { display: flex; overflow-x: auto; padding-bottom: 4px; }
.ps-firmware > div { flex: 1 0 104px; display: flex; flex-direction: column; gap: 4px; }
.ps-fw-line { display: flex; align-items: center; }
.ps-fw-dot { width: 12px; height: 12px; border-radius: 50%; background: #42A5F5; flex-shrink: 0; }
.ps-fw-rule { flex: 1; height: 2px; background: rgba(var(--v-theme-on-surface), 0.15); }
.ps-firmware > div:last-child .ps-fw-rule { visibility: hidden; }
.ps-fw-version { font-size: 0.8rem; font-weight: 500; font-variant-numeric: tabular-nums; }

.ps-fault {
	display: flex;
	justify-content: space-between;
	gap: 12px;
	font-size: 0.85rem;
	padding: 6px 0;
	border-bottom: 1px solid rgba(var(--v-theme-on-surface), 0.08);
}
</style>
