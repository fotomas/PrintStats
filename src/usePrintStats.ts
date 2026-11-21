/**
 * Loading, history and background refresh.
 *
 * The print history lives on the printer in 0:/sys/PrintStats/ (see model/history.ts): index.json plus one
 * file per year. A copy is kept in the browser, so opening the page shows the statistics at once with no
 * network traffic. Then, in the background:
 *   1. index.json is read (about 1 kB); only year files whose generation changed are downloaded
 *   2. the event log's size and date are compared with the index's mark
 *   3. if the log changed, it is downloaded, only the lines after the mark are parsed, and the changed
 *      year file(s) and the index are written back
 * When a print ends while the page is open, it is added at once from the object model and confirmed by the
 * log a few seconds later.
 *
 * State is module-level, so it survives leaving and re-entering the page.
 */
import { ref, shallowRef } from "vue";

import { useCacheStore } from "@/stores/cache";
import { useMachineStore } from "@/stores/machine";

import { PLUGIN_ID } from "./id";
import {
	emptyIndex, foldLog, isHistoryIndex, isYearFile, mergeYears, splitByYear,
	type HistoryIndex, type YearFile,
} from "./model/history";
import { baseName, emptyLog, isParsedLog, type JobStatus, type ParsedLog, type SourceInfo } from "./model/logParser";
import { localNow } from "./model/stats";

/** Written by version 1.0.0; shown while the history is built for the first time */
export const OLD_CACHE_FILE = "printstats-cache.json";
export const HISTORY_DIR = "PrintStats";
const INDEX_FILE = "index.json";
const BROWSER_KEY = "PrintStats.history";

export type Status = "idle" | "loadingCache" | "checking" | "downloading" | "saving";

const parsed = shallowRef<ParsedLog | null>(null);
const status = ref<Status>("idle");
const error = ref<string | null>(null);
const noLogFile = ref(false);
const logFiles = ref<string[]>([]);
const logFile = ref<string>("");
/** Bytes read so far while downloading the log, null otherwise */
const progress = ref<{ loaded: number; total: number } | null>(null);
/** Timings of the last update, for the console and for tuning */
const timings = ref<Record<string, number>>({});

/** The history as last read from or written to the printer */
let index: HistoryIndex | null = null;
let years = new Map<number, YearFile>();
let base: ParsedLog | null = null;
let busy: Promise<void> | null = null;
let browserTried = "";

function sysDir(): string {
	const dir = String((useMachineStore().model as any).directories?.system ?? "0:/sys/");
	return dir.endsWith("/") ? dir : `${dir}/`;
}
const historyDir = () => `${sysDir()}${HISTORY_DIR}/`;

function hostKey(): string {
	return `${BROWSER_KEY}:${String((useMachineStore().connector as any)?.hostname ?? location.host)}`;
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

function sourceOf(): SourceInfo {
	const m = index?.mark;
	return { file: m?.file ?? logFile.value, size: m?.size ?? 0, lastModified: m?.lastModified ?? null };
}

/** Rebuild the shown statistics from the year files */
function show(): void {
	if (!index) {
		return;
	}
	base = mergeYears([...years.values()], index, sourceOf());
	parsed.value = base;
}

// ---- browser copy -----------------------------------------------------------------------------------

function loadBrowserCopy(): void {
	const key = hostKey();
	if (browserTried === key) {
		return;
	}
	browserTried = key;
	try {
		const raw = localStorage.getItem(key);
		if (!raw) {
			return;
		}
		const data = JSON.parse(raw);
		if (isHistoryIndex(data?.index) && Array.isArray(data?.years) && data.years.every(isYearFile)) {
			index = data.index;
			years = new Map((data.years as YearFile[]).map(y => [y.year, y]));
			show();
		}
	} catch (e) {
		console.warn("[PrintStats] could not read the browser copy", e);
	}
}

function saveBrowserCopy(): void {
	if (!index) {
		return;
	}
	try {
		localStorage.setItem(hostKey(), JSON.stringify({ index, years: [...years.values()] }));
	} catch (e) {
		// storage full or disabled: the page still works, it just reads the history from the printer
		console.warn("[PrintStats] could not save the browser copy", e);
	}
}

// ---- printer files ------------------------------------------------------------------------------------

async function downloadJson(path: string): Promise<unknown | null> {
	try {
		const text = await useMachineStore().download({ filename: path, type: "text" }, false, false, false);
		return JSON.parse(typeof text === "string" ? text : String(text));
	} catch {
		return null;
	}
}

async function readRemoteIndex(): Promise<HistoryIndex | null> {
	const data = await downloadJson(historyDir() + INDEX_FILE);
	return isHistoryIndex(data) ? data : null;
}

/** Bring the in-memory history up to date with the printer's, fetching only year files that changed */
async function syncFromPrinter(): Promise<boolean> {
	const t0 = performance.now();
	const remote = await readRemoteIndex();
	timings.value.index = performance.now() - t0;
	if (!remote) {
		return false;
	}
	if (index && remote.gen === index.gen && Object.keys(remote.years).length === years.size) {
		index = remote;
		return true;
	}
	const wanted = Object.entries(remote.years)
		.filter(([y, gen]) => years.get(+y)?.gen !== gen)
		.map(([y]) => +y);
	const t1 = performance.now();
	const fetched = await Promise.all(wanted.map(y => downloadJson(`${historyDir()}${y}.json`)));
	timings.value.years = performance.now() - t1;
	const next = new Map(years);
	for (const y of [...next.keys()]) {
		if (!(String(y) in remote.years)) {
			next.delete(y);
		}
	}
	for (const [i, data] of fetched.entries()) {
		if (!isYearFile(data)) {
			// a year file is missing or unreadable: the history has to be rebuilt from the log
			console.warn(`[PrintStats] ${wanted[i]}.json is missing or unreadable, rebuilding the history`);
			return false;
		}
		next.set(data.year, data);
	}
	index = remote;
	years = next;
	show();
	saveBrowserCopy();
	return true;
}

/** Show 1.0.0's single cache file while the history is built for the first time */
async function showOldCache(): Promise<void> {
	if (parsed.value) {
		return;
	}
	const data = await downloadJson(sysDir() + OLD_CACHE_FILE);
	if (isParsedLog(data) && !parsed.value) {
		parsed.value = data;
	}
}

/**
 * Write the changed year files, then the index. The index is written last, so a write that stops half-way
 * leaves the old index in charge (mergeYears ignores entries a newer year file has beyond the index's mark).
 * Gives up if another browser updated the history since it was read.
 */
async function writeHistory(next: HistoryIndex, log: ParsedLog, changed: Set<number>, rebuild: boolean): Promise<boolean> {
	const machineStore = useMachineStore();
	const remote = await readRemoteIndex();
	if ((remote?.gen ?? 0) !== (index?.gen ?? 0) && !rebuild) {
		console.info("[PrintStats] the history was updated elsewhere meanwhile, reloading it");
		return false;
	}
	const gen = Math.max(remote?.gen ?? 0, index?.gen ?? 0) + 1;
	const written = splitByYear(log, gen, rebuild ? undefined : changed);
	const nextYears = new Map(rebuild ? [] : years);
	const yearGens: Record<string, number> = rebuild ? {} : { ...next.years };
	for (const [y, file] of written) {
		nextYears.set(y, file);
		yearGens[y] = gen;
	}
	const newIndex: HistoryIndex = { ...next, gen, years: yearGens };

	if (rebuild) {
		try {
			await machineStore.makeDirectory(historyDir().slice(0, -1));
		} catch {
			// it exists already
		}
	}
	const t0 = performance.now();
	if (written.size) {
		await machineStore.upload([...written.values()].map(y => ({
			filename: `${historyDir()}${y.year}.json`,
			content: new Blob([JSON.stringify(y)], { type: "application/json" }),
		})), false, false, false);
	}
	await machineStore.upload({
		filename: historyDir() + INDEX_FILE,
		content: new Blob([JSON.stringify(newIndex)], { type: "application/json" }),
	}, false, false, false);
	timings.value.write = performance.now() - t0;

	index = newIndex;
	years = nextYears;
	show();
	saveBrowserCopy();
	return true;
}

// ---- the event log ------------------------------------------------------------------------------------

/** The event log to use: the remembered one, else the one RRF logs to, else any *eventlog*, else the first */
function pickLogFile(names: string[]): string {
	const remembered = String(useCacheStore().plugins[PLUGIN_ID]?.logFile ?? "");
	if (names.includes(remembered)) {
		return remembered;
	}
	const active = String((useMachineStore().model as any).state?.logFile ?? "").split("/").pop() ?? "";
	return (active && names.find(n => n === active))
		?? names.find(n => n.toLowerCase() === "eventlog.txt")
		?? names.find(n => n.toLowerCase().includes("eventlog"))
		?? names[0] ?? "";
}

async function downloadLog(item: { name: string; size: number }): Promise<string> {
	status.value = "downloading";
	progress.value = { loaded: 0, total: item.size };
	const t0 = performance.now();
	try {
		const text = await useMachineStore().download({ filename: sysDir() + item.name, type: "text" }, false, false, true, true,
			(loaded, total) => { progress.value = { loaded, total: total > 0 ? total : item.size }; });
		return typeof text === "string" ? text : String(text ?? "");
	} finally {
		timings.value.log = performance.now() - t0;
		progress.value = null;
	}
}

/** Sync with the printer's history, then add the log's new lines if it changed (or always, with force) */
async function update(force: boolean, attempt = 0): Promise<void> {
	const machineStore = useMachineStore();
	if (!machineStore.isConnected) {
		return;
	}
	timings.value = {};
	status.value = "checking";
	const haveHistory = await syncFromPrinter();
	if (!haveHistory) {
		await showOldCache();
	}

	const t0 = performance.now();
	const items = (await machineStore.getFileList(sysDir()))
		.filter((f: any) => !f.isDirectory && /\.(txt|log)$/i.test(String(f.name)));
	timings.value.list = performance.now() - t0;
	logFiles.value = items.map((f: any) => String(f.name)).sort((a, b) => a.localeCompare(b));
	if (!logFiles.value.includes(logFile.value)) {
		logFile.value = pickLogFile(logFiles.value);
	}
	const item = items.find((f: any) => f.name === logFile.value) as any;
	// a list taken while DWC reconnects can come back incomplete: only warn when there is no history either
	noLogFile.value = !item && !index?.mark;
	if (!item) {
		return;
	}
	const size = Number(item.size ?? 0);
	const lastModified = item.lastModified ? new Date(item.lastModified).toISOString() : null;
	const mark = haveHistory ? index?.mark : null;
	if (!force && mark && mark.file === item.name && mark.size === size && mark.lastModified === lastModified) {
		return;
	}

	const text = await downloadLog({ name: item.name, size });
	const t1 = performance.now();
	const source: SourceInfo = { file: item.name, size, lastModified };
	// force re-reads the whole log into a fresh history (e.g. after a parser change)
	const rebuild = !haveHistory || force;
	const from = rebuild ? emptyIndex() : index!;
	const result = foldLog(rebuild ? emptyLog(source) : (base ?? emptyLog(source)), from, text, source);
	timings.value.parse = performance.now() - t1;

	if (!rebuild && result.changed.size === 0) {
		// nothing new to count (e.g. only a connect message): just move the mark
		parsed.value = result.log;
	}
	status.value = "saving";
	try {
		if (!await writeHistory(result.index, result.log, result.changed, rebuild) && attempt < 1) {
			return update(false, attempt + 1);
		}
	} catch (e) {
		// the statistics are still shown; the new lines are read again next time
		parsed.value = result.log;
		console.warn("[PrintStats] could not write the history", e);
	}
}

function run(task: () => Promise<void>): Promise<void> {
	if (busy) {
		return busy;
	}
	error.value = null;
	busy = (async () => {
		const t0 = performance.now();
		try {
			await task();
		} catch (e) {
			console.warn("[PrintStats]", e);
			error.value = message(e);
		} finally {
			timings.value.total = performance.now() - t0;
			console.debug("[PrintStats] update (ms)", Object.fromEntries(Object.entries(timings.value).map(([k, v]) => [k, Math.round(v)])));
			status.value = "idle";
			busy = null;
		}
	})();
	return busy;
}

/**
 * Add the print that just ended, from the object model, so it shows before the log is read.
 * It is replaced when the log is folded in.
 */
function addEndedJob(): void {
	const job = (useMachineStore().model as any).job;
	if (!parsed.value || !job?.lastFileName || job.lastFileSimulated) {
		return;
	}
	const end = localNow();
	const seconds = Number(job.lastDuration ?? 0);
	const log = parsed.value;
	const name = baseName(String(job.lastFileName));
	let id = log.files.indexOf(name);
	const files = id < 0 ? [...log.files, name] : log.files;
	if (id < 0) {
		id = files.length - 1;
	}
	const ended: JobStatus = job.lastFileCancelled ? "c" : job.lastFileAborted ? "i" : "f";
	parsed.value = {
		...log,
		files,
		jobs: [...log.jobs, [Math.round(end - seconds), end, ended, Math.round(seconds / 60), id, 0]],
		last: Math.max(log.last, end),
	};
}

export function usePrintStats() {
	return {
		parsed,
		status,
		error,
		noLogFile,
		logFiles,
		logFile,
		progress,
		timings,

		/** Show the browser copy (if any), then sync with the printer in the background */
		start: () => {
			loadBrowserCopy();
			return run(() => update(false));
		},

		/** Re-read the whole log and rebuild the history */
		refresh: () => run(() => update(true)),

		/** Check the log for changes, e.g. after a print ended */
		checkForChanges: () => run(() => update(false)),

		/** A print just ended: show it now, then read the log */
		jobEnded: () => {
			addEndedJob();
			return run(() => update(false));
		},

		/** Switch to another log file and read it */
		selectLogFile: (name: string) => {
			logFile.value = name;
			useCacheStore().setPluginData(PLUGIN_ID, "logFile", name);
			return run(() => update(false));
		},
	};
}
