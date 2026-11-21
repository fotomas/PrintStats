<template>
	<v-dialog :model-value="modelValue" max-width="600" scrollable @update:model-value="close">
		<v-card>
			<v-card-title class="d-flex align-center ga-2">
				<v-icon icon="mdi-chart-areaspline" size="small" />
				<span class="flex-grow-1">{{ tt(firstRun ? "titleFirst" : "title") }}</span>
				<v-btn icon="mdi-close" variant="text" density="comfortable" :aria-label="tt('close')" @click="close(false)" />
			</v-card-title>
			<v-divider />

			<v-card-text class="ps-dialog">
				<!-- event logging -->
				<section>
					<div class="ps-label">{{ tt("logging.title") }}</div>
					<div v-if="!loggingKnown" class="d-flex align-center ga-2 ps-muted">
						<v-progress-circular indeterminate size="16" width="2" />{{ tt("logging.checking") }}
					</div>
					<template v-else-if="level === 'off'">
						<v-alert type="warning" variant="tonal" density="compact" :title="tt('logging.offTitle')">
							{{ tt("logging.offText") }}
						</v-alert>
						<v-btn class="mt-3" variant="tonal" prepend-icon="mdi-play" :loading="turningOn" @click="turnOn">
							{{ tt("logging.turnOn") }}
						</v-btn>
						<div class="ps-muted mt-2">{{ tt("logging.turnOnNote") }}</div>
						<div class="ps-code">
							<code>{{ configLine }}</code>
							<v-btn icon="mdi-content-copy" size="small" variant="text" :aria-label="tt('copy')" @click="copy" />
						</div>
						<div class="ps-muted mt-2">{{ tt("logging.neverConfig") }}</div>
					</template>
					<template v-else>
						<v-alert type="success" variant="tonal" density="compact"
								 :title="tt(`logging.on.${level}`, { file: fileName })">
							{{ logSize === null ? tt("logging.fromPrinter") : tt("logging.size", { size: mb(logSize) }) }}
						</v-alert>
						<v-alert v-if="level !== 'warn'" type="info" variant="tonal" density="compact" class="mt-2">
							{{ tt(`logging.${level}Note`) }}
						</v-alert>
					</template>
				</section>

				<!-- log handling -->
				<section>
					<div class="ps-label">{{ tt("mode.title") }}</div>
					<v-radio-group v-model="mode" hide-details>
						<v-radio value="readOnly" class="ps-option">
							<template #label>
								<div>
									<div class="ps-option-title">{{ tt("mode.readOnly") }} <v-chip size="x-small" class="ml-1">{{ tt("mode.default") }}</v-chip></div>
									<div class="ps-muted">{{ tt("mode.readOnlyText") }}</div>
								</div>
							</template>
						</v-radio>
						<v-radio value="manage" class="ps-option">
							<template #label>
								<div>
									<div class="ps-option-title">{{ tt("mode.manage") }}</div>
									<div class="ps-muted">{{ tt("mode.manageText") }}</div>
								</div>
							</template>
						</v-radio>
					</v-radio-group>
					<!-- full warning while choosing manage mode; once saved, one line is enough -->
				<div v-if="mode === 'manage' && savedMode === 'manage'" class="ps-muted ps-small mt-1 d-flex align-center ga-1">
					<v-icon icon="mdi-information-outline" size="x-small" />{{ tt("mode.lossShort") }}
				</div>
				<v-alert v-else-if="mode === 'manage'" type="warning" variant="tonal" density="compact" class="mt-2" :title="tt('mode.lossTitle')">
						<div>{{ tt("mode.lossText") }}</div>
						<ul class="ps-list">
							<li>{{ tt("mode.loss1") }}</li>
							<li>{{ tt("mode.loss2") }}</li>
							<li>{{ tt("mode.loss3") }}</li>
						</ul>
						<div class="mt-1">{{ tt("mode.lossHint") }}</div>
					</v-alert>
				</section>

				<v-expansion-panels v-if="!firstRun" variant="accordion" multiple class="ps-panels">
					<!-- older logs: the collapsed header says whether anything needs importing -->
					<v-expansion-panel value="import">
						<v-expansion-panel-title>
							<span class="flex-grow-1 ps-option-title">{{ tt("import.title") }}</span>
							<span v-if="!olderLogs.length" class="ps-muted mr-2">{{ tt("import.noneShort") }}</span>
							<span v-else-if="pendingImports.length" class="ps-summary text-warning mr-2">
								<v-icon icon="mdi-alert-circle-outline" size="small" />{{ pendingSummary }}
							</span>
							<span v-else class="ps-summary text-success mr-2">
								<v-icon icon="mdi-check-circle-outline" size="small" />{{ tt("import.allImported") }}
							</span>
						</v-expansion-panel-title>
						<v-expansion-panel-text>
							<div v-for="log in olderLogs" :key="log.name" class="ps-log">
								<v-icon :icon="STATUS_ICON[log.status]" :color="STATUS_COLOR[log.status]" size="small" />
								<div class="ps-log-name">
									<span class="ps-mono">{{ log.name }}</span>
									<span v-if="log.status !== 'new'" :class="`text-${STATUS_COLOR[log.status]}`"> [{{ tt(`import.status.${log.status}`) }}]</span>
									<span class="ps-muted"> · {{ mb(log.size) }}</span>
									<div v-if="log.record" class="ps-muted ps-small">
										{{ tt(log.record.added ? "import.recorded" : "import.recordedNothing", { n: log.record.added, day: shortDay(log.record.at) }) }}
									</div>
								</div>
								<v-btn :variant="log.status === 'imported' ? 'text' : 'tonal'" size="small" :loading="importing === log.name"
									   :disabled="busy && importing !== log.name" @click="runImport(log.name)">
									{{ tt(log.status === "new" ? "import.button" : "import.again") }}
								</v-btn>
							</div>
							<div v-if="!olderLogs.length" class="ps-muted">{{ tt("import.none") }}</div>
							<div class="ps-muted ps-small mt-2">{{ importResult ?? tt("import.text") }}</div>
						</v-expansion-panel-text>
					</v-expansion-panel>

					<!-- history -->
					<v-expansion-panel value="history">
						<v-expansion-panel-title>
							<span class="flex-grow-1 ps-option-title">{{ tt("history.title") }}</span>
							<span class="ps-muted mr-2">{{ historySummary }}</span>
						</v-expansion-panel-title>
						<v-expansion-panel-text>
						<div class="ps-kv">
							<span class="ps-muted">{{ tt("history.covers") }}</span>
							<span>{{ parsed && parsed.first ? `${day(parsed.first)} – ${day(parsed.last)}` : tt("none") }}</span>
							<span class="ps-muted">{{ tt("history.stored") }}</span>
							<span>{{ tt("history.storedValue", { dir: historyPath, n: historyYears, size: kb(historyBytes) }) }}</span>
							<span class="ps-muted">{{ tt("history.lastUpdate") }}</span>
							<span>{{ lastUpdate }}</span>
						</div>
						<div class="d-flex align-center ga-3 mt-3">
							<v-btn variant="tonal" prepend-icon="mdi-text-search" :loading="rechecking" :disabled="busy || !savedMode" @click="runRecheck">
								{{ tt("history.recheck") }}
							</v-btn>
							<span class="ps-muted">{{ tt("history.recheckText") }}</span>
						</div>
						</v-expansion-panel-text>
					</v-expansion-panel>
				</v-expansion-panels>

				<v-alert v-if="saveError" type="error" variant="tonal" density="compact">{{ saveError }}</v-alert>
			</v-card-text>

			<v-divider />
			<v-card-actions>
				<v-spacer />
				<v-btn v-if="firstRun" variant="text" @click="close(false)">{{ tt("later") }}</v-btn>
				<v-btn color="primary" variant="flat" :loading="saving" :disabled="!loggingKnown" @click="save">
					{{ tt(firstRun ? (level === "off" ? "save" : "saveAndRead") : "done") }}
				</v-btn>
			</v-card-actions>
		</v-card>
	</v-dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";

import i18n from "@/i18n";

import { DEFAULT_LOG_FILE, LEVEL_S, historyDir, saveSettings, turnOnLogging, useLogging, useSettings, type LogMode } from "../settings";
import { usePrintStats } from "../usePrintStats";

const props = defineProps<{ modelValue: boolean; firstRun: boolean }>();
const emit = defineEmits<{ (e: "update:modelValue", value: boolean): void; (e: "saved"): void }>();

const tt = (key: string, args?: Record<string, unknown>) => i18n.global.t(`plugins.printStats.setup.${key}`, args ?? {});

const { known: loggingKnown, level, fileName } = useLogging();
const { settings } = useSettings();
const { parsed, status, logSize, historyBytes, historyYears, timings, recheck, importFile, olderLogs, pendingImports, scanSysDir } = usePrintStats();

const STATUS_ICON = { new: "mdi-circle-outline", imported: "mdi-check-circle-outline", changed: "mdi-alert-circle-outline" } as const;
const STATUS_COLOR = { new: "medium-emphasis", imported: "success", changed: "warning" } as const;

const busy = computed(() => status.value !== "idle");
const savedMode = computed(() => (settings.value ? settings.value.mode : null));
const mode = ref<LogMode>("readOnly");
const saving = ref(false);
const saveError = ref<string | null>(null);
const turningOn = ref(false);
const rechecking = ref(false);
/** Name of the log being imported, or null */
const importing = ref<string | null>(null);
const importResult = ref<string | null>(null);

/** "1 new, 1 changed" */
const pendingSummary = computed(() => {
	const n = pendingImports.value.filter(l => l.status === "new").length;
	const c = pendingImports.value.length - n;
	return [n ? tt("import.newCount", { n }) : "", c ? tt("import.changedCount", { n: c }) : ""].filter(Boolean).join(", ");
});
const shortDay = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const month = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
const historySummary = computed(() => (parsed.value?.first
	? `${month(parsed.value.first)} – ${month(parsed.value.last)} · ${kb(historyBytes.value)}`
	: tt("none")));

const configLine = `M929 P"${DEFAULT_LOG_FILE}" S${LEVEL_S.warn} ; log warnings (Print Stats)`;
const historyPath = computed(() => historyDir());

const mb = (bytes: number) => (bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} kB` : `${(bytes / 1048576).toFixed(1)} MB`);
const kb = (bytes: number) => `${Math.round(bytes / 1024)} kB`;
const day = (t: number) => new Date(t * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const lastUpdate = computed(() => {
	if (!parsed.value?.parsedAt) {
		return tt("none");
	}
	const when = new Date(parsed.value.parsedAt).toLocaleString();
	return timings.value.total ? `${when} · ${(timings.value.total / 1000).toFixed(1)} s` : when;
});

watch(() => props.modelValue, async open => {
	if (!open) {
		return;
	}
	mode.value = savedMode.value ?? "readOnly";
	saveError.value = null;
	importResult.value = null;
	// fresh log size and import status (one directory listing)
	scanSysDir().catch(() => undefined);
}, { immediate: true });

function close(value: boolean) {
	emit("update:modelValue", value);
}

async function turnOn() {
	turningOn.value = true;
	try {
		await turnOnLogging();
	} catch (e) {
		saveError.value = e instanceof Error ? e.message : String(e);
	} finally {
		turningOn.value = false;
	}
}

async function copy() {
	try {
		await navigator.clipboard.writeText(configLine);
	} catch {
		// clipboard not available (e.g. plain http): the line is still shown for copying by hand
	}
}

async function save() {
	saving.value = true;
	saveError.value = null;
	try {
		if (mode.value !== savedMode.value) {
			await saveSettings(mode.value);
		}
		emit("saved");
		close(false);
	} catch (e) {
		saveError.value = tt("saveFailed", { error: e instanceof Error ? e.message : String(e) });
	} finally {
		saving.value = false;
	}
}

async function runRecheck() {
	rechecking.value = true;
	try {
		await recheck();
	} finally {
		rechecking.value = false;
	}
}

async function runImport(name: string) {
	importing.value = name;
	importResult.value = null;
	try {
		const added = await importFile(name);
		importResult.value = added === undefined ? null : tt(added ? "import.done" : "import.doneNothing", { n: added, file: name });
	} finally {
		importing.value = null;
	}
}
</script>

<style scoped>
.ps-dialog { display: flex; flex-direction: column; gap: 20px; }
.ps-label { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 8px;
	color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.ps-muted { font-size: 0.85rem; color: rgba(var(--v-theme-on-surface), var(--v-medium-emphasis-opacity)); }
.ps-code { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 8px; padding: 4px 4px 4px 12px;
	border-radius: 4px; background: rgba(var(--v-theme-on-surface), 0.06); font-size: 0.85rem; }
.ps-option { align-items: flex-start; margin-bottom: 8px; }
.ps-option :deep(.v-label) { opacity: 1; }
.ps-option-title { font-weight: 500; }
.ps-list { margin: 4px 0 0; padding-left: 18px; }
.ps-dialog :deep(.v-alert-title) { font-size: 0.95rem; font-weight: 500; line-height: 1.4; }
.ps-kv { display: grid; grid-template-columns: 120px 1fr; gap: 4px 12px; font-size: 0.9rem; }
.ps-panels { margin-top: -4px; }
.ps-summary { display: inline-flex; align-items: center; gap: 4px; font-size: 0.85rem; }
.ps-log { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.ps-log + .ps-log { border-top: 1px solid rgba(var(--v-theme-on-surface), 0.08); }
.ps-log-name { flex: 1; min-width: 0; font-size: 0.9rem; }
.ps-mono { font-family: monospace; font-size: 0.85rem; }
.ps-small { font-size: 0.78rem; }
</style>
