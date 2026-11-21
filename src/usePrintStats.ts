/**
 * Loading, history and background refresh.
 *
 * The print history lives on the printer in 0:/sys/PrintStats/ (see model/history.ts): index.json plus one
 * file per year. A copy is kept in the browser, so opening the page shows the statistics at once with no
 * network traffic. Then, in the background:
 *   1. settings.json and index.json are read; only year files whose generation changed are downloaded
 *   2. the event log (the one RRF is logging to, from the object model) is compared with the index's mark
 *   3. if the log changed, it is downloaded, only the lines after the mark are parsed, and the changed
 *      year file(s) and the index are written back
 *   4. in "manage the log" mode, a log over ROTATE_AT is then moved away while the printer is idle and
 *      logging restarts, so the next update downloads only a few kB
 * Until the setup dialog has been saved (no settings.json), the log is not read.
 *
 * The history is never replaced by what the log holds: after a rotation the log has only the newest lines,
 * and imported logs aren't in it at all. Re-checking and repairs merge the log in and only ever add.
 *
 * State is module-level, so it survives leaving and re-entering the page.
 */
import { computed, ref, shallowRef } from "vue";

import i18n from "@/i18n";
import { useMachineStore } from "@/stores/machine";
import Events from "@/utils/events";

import {
	foldLog, importLog, importStatus, isHistoryIndex, isYearFile, mergeYears, sameTime, splitByYear, emptyIndex,
	type HistoryIndex, type ImportRecord, type ImportStatus, type YearFile,
} from "./model/history";
import { ROTATED_MARKER, baseName, emptyLog, isParsedLog, parseLog, type JobStatus, type ParsedLog, type SourceInfo } from "./model/logParser";
import { localNow } from "./model/stats";
import { HISTORY_DIR, LEVEL_S, historyDir, loadSettings, resetLogging, resolveLogging, sysDir, useLogging, useSettings, type LogLevel } from "./settings";

/** Written by version 1.0.0; shown while the history is built for the first time */
export const OLD_CACHE_FILE = "printstats-cache.json";
const INDEX_FILE = "index.json";
const ARCHIVE_DIR = "archive";
const BROWSER_KEY = "PrintStats.history";
/** In "manage the log" mode, rotate the log once it is bigger than this */
export const ROTATE_AT = 256 * 1024;
/**
 * Keep rotated logs in PrintStats/archive/ instead of deleting them once read in. Off in releases (the
 * history is what is kept); set to true while developing to have the raw logs to test against.
 */
const KEEP_ARCHIVES = false;

export type Status = "idle" | "loadingCache" | "checking" | "downloading" | "saving" | "rotating" | "importing";

const parsed = shallowRef<ParsedLog | null>(null);
const status = ref<Status>("idle");
const error = ref<string | null>(null);
/** Bytes read so far while downloading a log, null otherwise */
const progress = ref<{ loaded: number; total: number } | null>(null);
/** Timings of the last update, for the console and the settings dialog */
const timings = ref<Record<string, number>>({});
/** Size of the active log at the last check, null when unknown */
const logSize = ref<number | null>(null);
/** Name of the file being read (for the status text) */
const reading = ref<string>("");
/** Bytes of the history files, for the settings dialog */
const historyBytes = ref(0);
export interface OlderLog {
	name: string;
	size: number;
	lastModified: string | null;
	status: ImportStatus;
	record?: ImportRecord;
}
/** Files of the system directory at the last listing, and the history's import records */
const sysFiles = shallowRef<{ name: string; size: number; lastModified: string | null }[]>([]);
/** The log RRF was logging to when sysFiles was listed (the object model is not reliably reactive here) */
const activeLog = ref<string | null>(null);
const imports = shallowRef<ImportRecord[]>([]);
/**
 * Older logs in the system directory (other *log*.txt / .log files than the one RRF is logging to) and
 * whether they have been imported.
 */
const olderLogs = computed<OlderLog[]>(() => {
	const active = activeLog.value;
	const recorded = { imports: imports.value } as HistoryIndex;
	return sysFiles.value
		.filter(f => /\.(txt|log)$/i.test(f.name) && /log/i.test(f.name) && f.name !== active)
		.map(f => ({ ...f, status: importStatus(recorded, f), record: imports.value.find(r => r.name === f.name) }))
		.sort((a, b) => a.name.localeCompare(b.name));
});

/** The history as last read from or written to the printer */
let index: HistoryIndex | null = null;
let years = new Map<number, YearFile>();
let base: ParsedLog | null = null;
let busy: Promise<void> | null = null;
let browserTried = "";

function hostKey(): string {
	return `${BROWSER_KEY}:${String((useMachineStore().connector as any)?.hostname ?? location.host)}`;
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

const dirOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

function sourceOf(): SourceInfo {
	const m = index?.mark;
	return { file: m?.file ?? "", size: m?.size ?? 0, lastModified: m?.lastModified ?? null };
}

/** Rebuild the shown statistics from the year files */
function show(): void {
	if (!index) {
		return;
	}
	base = mergeYears([...years.values()], index, sourceOf());
	parsed.value = base;
	imports.value = index.imports ?? [];
	historyBytes.value = [...years.values()].reduce((a, y) => a + JSON.stringify(y).length, 0) + JSON.stringify(index).length;
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

/**
 * ok: the history is in sync with the printer's. none: there is no history anywhere yet.
 * repair: the printer's history is missing (folder deleted) or a year file is missing or unreadable. The
 * years this browser still has are written back (`rewrite`), and the current log is merged in to recover
 * what it can. The history is never replaced by the log alone: after a rotation the log holds only the
 * newest lines, and imported logs are not in it at all.
 */
type SyncResult = { kind: "ok" } | { kind: "none" } | { kind: "repair"; rewrite: Set<number>; force: boolean };

/** Bring the in-memory history up to date with the printer's, fetching only year files that changed */
async function syncFromPrinter(): Promise<SyncResult> {
	const t0 = performance.now();
	const remote = await readRemoteIndex();
	timings.value.index = performance.now() - t0;
	if (!remote) {
		if (!index) {
			return { kind: "none" };
		}
		// the printer's history is gone, but this browser has a copy: put it back
		console.warn("[PrintStats] the history on the printer is missing, restoring it from this browser's copy");
		return { kind: "repair", rewrite: new Set(years.keys()), force: true };
	}
	if (index && remote.gen === index.gen && Object.keys(remote.years).length === years.size) {
		index = remote;
		imports.value = index.imports ?? [];
		return { kind: "ok" };
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
	const rewrite = new Set<number>();
	const remoteYears = { ...remote.years };
	for (const [i, data] of fetched.entries()) {
		const y = wanted[i];
		if (isYearFile(data)) {
			next.set(data.year, data);
		} else if (next.has(y)) {
			// unreadable on the printer, but this browser has an older copy of that year: write it back
			console.warn(`[PrintStats] ${y}.json is missing or unreadable, restoring this browser's copy`);
			rewrite.add(y);
		} else {
			// lost: what the current log still has of that year is recovered by merging it in
			console.warn(`[PrintStats] ${y}.json is missing or unreadable, recovering what the log has`);
			delete remoteYears[y];
		}
	}
	const broken = rewrite.size > 0 || Object.keys(remoteYears).length !== Object.keys(remote.years).length;
	index = { ...remote, years: remoteYears };
	years = next;
	show();
	if (broken) {
		return { kind: "repair", rewrite, force: false };
	}
	saveBrowserCopy();
	return { kind: "ok" };
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
 * Gives up if another browser updated the history since it was read, unless `force` (the printer's history
 * is being restored). With `all`, every year is written (the first build); otherwise only `changed`.
 */
async function writeHistory(next: HistoryIndex, log: ParsedLog, changed: Set<number>, opts: { all?: boolean; force?: boolean } = {}): Promise<boolean> {
	const machineStore = useMachineStore();
	const remote = await readRemoteIndex();
	if ((remote?.gen ?? 0) !== (index?.gen ?? 0) && !opts.all && !opts.force) {
		console.info("[PrintStats] the history was updated elsewhere meanwhile, reloading it");
		return false;
	}
	const gen = Math.max(remote?.gen ?? 0, index?.gen ?? 0) + 1;
	const written = splitByYear(log, gen, opts.all ? undefined : changed);
	const nextYears = new Map(opts.all ? [] : years);
	const yearGens: Record<string, number> = opts.all ? {} : { ...next.years };
	for (const [y, file] of written) {
		nextYears.set(y, file);
		yearGens[y] = gen;
	}
	const newIndex: HistoryIndex = { ...next, gen, years: yearGens };

	try {
		await machineStore.makeDirectory(historyDir().slice(0, -1));
	} catch {
		// it exists already
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

/** Start downloads only once DWC has been connected this long: right after connecting, big downloads got cut off */
const SETTLE_MS = 5000;
let connectedAt = Date.now();
Events.on("connected", () => { connectedAt = Date.now(); });
Events.on("disconnected", () => resetLogging());

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Wait until DWC is connected and has been for SETTLE_MS (gives up after `limit` ms) */
async function settled(limit = 30000): Promise<boolean> {
	const machineStore = useMachineStore();
	const until = Date.now() + limit;
	while (Date.now() < until) {
		if (machineStore.isConnected && Date.now() - connectedAt >= SETTLE_MS) {
			return true;
		}
		await sleep(500);
	}
	return false;
}

/**
 * Download a text file with progress. A big download over WiFi can be cut off when DWC reconnects; then it
 * waits for the connection to come back and tries once more.
 */
async function downloadText(path: string, size: number): Promise<string> {
	reading.value = nameOf(path);
	const t0 = performance.now();
	try {
		for (let attempt = 0; ; attempt++) {
			await settled();
			progress.value = { loaded: 0, total: size };
			try {
				const text = await useMachineStore().download({ filename: path, type: "text" }, false, false, true, true,
					(loaded, total) => { progress.value = { loaded, total: total > 0 ? total : size }; });
				return typeof text === "string" ? text : String(text ?? "");
			} catch (e) {
				console.warn(`[PrintStats] reading ${nameOf(path)} failed (attempt ${attempt + 1})`, e);
				if (attempt >= 1) {
					throw new Error(i18n.global.t("plugins.printStats.errors.download", { file: nameOf(path), size: (size / 1048576).toFixed(1) }));
				}
			}
		}
	} finally {
		timings.value.log = performance.now() - t0;
		progress.value = null;
	}
}

const statOf = (item: any): FileStat => ({
	size: Number(item.size ?? 0),
	lastModified: item.lastModified ? new Date(item.lastModified).toISOString() : null,
});

/**
 * Look up a file's size and date. Listing the system directory also refreshes the older logs and their
 * import status, so the page knows whether anything needs importing without a request of its own.
 */
async function statFile(path: string): Promise<FileStat | null> {
	const items = await useMachineStore().getFileList(dirOf(path));
	if (dirOf(path) === sysDir()) {
		// a stat of the active log names it for sure; any other file (an import) leaves the name as it was
		const active = useLogging().fileName.value ?? activeLog.value;
		setOlderLogs(items, active);
	}
	const item = items.find((f: any) => !f.isDirectory && f.name === nameOf(path));
	return item ? statOf(item) : null;
}

function setOlderLogs(items: any[], active?: string | null): void {
	activeLog.value = active !== undefined ? active : useLogging().fileName.value;
	sysFiles.value = items.filter((f: any) => !f.isDirectory).map((f: any) => ({ name: String(f.name), ...statOf(f) }));
}

/** Sync with the printer's history, then add the log's new lines if it changed (recheck: the whole log, merged) */
async function update(recheck: boolean, attempt = 0): Promise<void> {
	const machineStore = useMachineStore();
	if (!machineStore.isConnected) {
		return;
	}
	timings.value = {};
	status.value = "checking";
	const { settings } = useSettings();
	if (settings.value === null) {
		await loadSettings();
	}
	const sync = await syncFromPrinter();
	if (sync.kind === "none") {
		await showOldCache();
	}
	// first run: nothing is read until the setup dialog has been saved
	if (!settings.value) {
		return;
	}

	const logging = await resolveLogging();
	const path = { value: logging.path };
	const level = { value: logging.level };
	activeLog.value = path.value ? nameOf(path.value) : null;
	const stat = path.value ? await timed("list", () => statFile(path.value!)) : null;
	logSize.value = stat?.size ?? null;
	if (!path.value) {
		// logging off: still list the older logs, for the import status
		await scanSysDir().catch(() => undefined);
	}
	if (!path.value || !stat) {
		// logging off, or a list taken while DWC reconnects: still put back what this browser has
		if (sync.kind === "repair" && index && base) {
			await writeHistory(index, base, sync.rewrite, { force: sync.force });
		}
		return;
	}

	let written: boolean | "conflict" = true;
	if (sync.kind === "none") {
		written = await readLog(path.value, stat, "build");
	} else if (recheck || sync.kind === "repair") {
		written = await readLog(path.value, stat, "merge", sync.kind === "repair" ? sync : undefined);
	} else if (!isRead(path.value, stat)) {
		written = await readLog(path.value, stat, "fold");
	}
	if (written === "conflict") {
		if (attempt < 1) {
			return update(false, attempt + 1);
		}
		return;
	}
	if (!written) {
		return;
	}

	await removeOldCache();
	if (settings.value.mode === "manage" && stat.size > ROTATE_AT) {
		await rotate(path.value, level.value);
	}
}

/** 1.0.0's single cache file is only shown while the first history is built; once there is one, it goes */
async function removeOldCache(): Promise<void> {
	if (!index || !sysFiles.value.some(f => f.name === OLD_CACHE_FILE)) {
		return;
	}
	try {
		await useMachineStore().delete(sysDir() + OLD_CACHE_FILE);
		sysFiles.value = sysFiles.value.filter(f => f.name !== OLD_CACHE_FILE);
		console.info(`[PrintStats] removed ${OLD_CACHE_FILE}, the history in ${HISTORY_DIR}/ replaces it`);
	} catch (e) {
		console.warn(`[PrintStats] could not remove ${OLD_CACHE_FILE}`, e);
	}
}

async function timed<T>(key: string, task: () => Promise<T>): Promise<T> {
	const t0 = performance.now();
	try {
		return await task();
	} finally {
		timings.value[key] = performance.now() - t0;
	}
}

type FileStat = { size: number; lastModified: string | null };

/** Whether the history has already read the log up to this size and date */
function isRead(path: string, stat: FileStat): boolean {
	const m = index?.mark;
	return !!m && m.file === nameOf(path) && m.size === stat.size && sameTime(m.lastModified, stat.lastModified);
}

/**
 * Download the log and add it to the history, then write the changed years.
 *   build: no history yet, read the whole log into a new one
 *   fold:  parse only the lines after the read position
 *   merge: parse the whole log and add only what the history is missing (re-check, repair); nothing is
 *          removed, so it is safe after a rotation or an import
 * Returns true when written, "conflict" when another browser wrote first, false when the write failed.
 */
async function readLog(path: string, stat: FileStat, how: "build" | "fold" | "merge",
	repair?: { rewrite: Set<number>; force: boolean }): Promise<boolean | "conflict"> {
	status.value = "downloading";
	const text = await downloadText(path, stat.size);
	const t1 = performance.now();
	const source: SourceInfo = { file: nameOf(path), size: stat.size, lastModified: stat.lastModified };
	let next: HistoryIndex, log: ParsedLog, changed: Set<number>;
	if (how === "merge" && index) {
		// the whole log, parsed from scratch: its end becomes the new read position and parser state
		const full = foldLog(emptyLog(source), emptyIndex(), text, source);
		const merged = importLog(base ?? emptyLog(source), full.log);
		log = { ...merged.log, source, parsedAt: full.log.parsedAt };
		changed = new Set([...merged.changed, ...(repair?.rewrite ?? [])]);
		next = {
			...index, updatedAt: full.index.updatedAt, mark: full.index.mark, state: full.index.state,
			first: log.first, last: Math.max(index.last, full.index.last), lines: Math.max(index.lines, full.log.lines),
		};
		console.info(`[PrintStats] re-check: ${merged.added} prints were missing from the history`);
	} else {
		const build = how === "build" || !index;
		const result = foldLog(build ? emptyLog(source) : (base ?? emptyLog(source)), build ? emptyIndex() : index!, text, source);
		({ index: next, log, changed } = result);
		if (!build && changed.size === 0) {
			parsed.value = log;
		}
	}
	timings.value.parse = performance.now() - t1;
	status.value = "saving";
	try {
		return await writeHistory(next, log, changed, { all: how === "build" || !index, force: repair?.force }) ? true : "conflict";
	} catch (e) {
		// the statistics are still shown; the new lines are read again next time
		parsed.value = log;
		console.warn("[PrintStats] could not write the history", e);
		return false;
	}
}

/**
 * Move the log away and start a fresh one (manage mode), only while the printer is idle. Logging is stopped
 * first (RRF must not have the file open while it is moved); whatever was added meanwhile is read in before
 * the file is moved. Logging is always restarted, at the same file and level, even if a step fails.
 */
async function rotate(path: string, level: LogLevel): Promise<void> {
	const machineStore = useMachineStore();
	const printerState = String((machineStore.model as any).state?.status ?? "");
	if (printerState !== "idle" || level === "off" || !index?.mark || index.mark.file !== nameOf(path)) {
		return;
	}
	status.value = "rotating";
	const restart = `M929 P"${nameOf(path)}" S${LEVEL_S[level]}`;
	let moved = false;
	await machineStore.sendCode("M929 S0", false, false);
	try {
		// logging is stopped, so the file can't change any more: read in what was added since the last read
		const stat = await statFile(path);
		if (!stat) {
			return;
		}
		if (!isRead(path, stat) && await readLog(path, stat, "fold") !== true) {
			console.info("[PrintStats] could not read the last lines before rotating, trying again next time");
			return;
		}
		status.value = "rotating";
		const stamp = new Date(localNow() * 1000).toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
		const stem = nameOf(path).replace(/\.[^.]*$/, "");
		if (KEEP_ARCHIVES) {
			try {
				await machineStore.makeDirectory(historyDir() + ARCHIVE_DIR);
			} catch {
				// it exists already
			}
			await machineStore.move(path, `${historyDir()}${ARCHIVE_DIR}/${stem}-${stamp}.txt`);
		} else {
			await machineStore.delete(path);
		}
		moved = true;
	} finally {
		await machineStore.sendCode(restart, false, false);
		if (moved) {
			// marks the "Event logging started" line just written as a rotation, not a power-up (log only, as WARN)
			await machineStore.sendCode(`M118 S"${ROTATED_MARKER}" L1`, false, false);
		}
	}
	if (!moved || !index?.mark) {
		return;
	}
	// the fresh log is read from its start
	const next: HistoryIndex = { ...index, mark: { ...index.mark, offset: 0, tail: "", size: 0, lastModified: null } };
	await writeHistory(next, base!, new Set());
	logSize.value = 0;
}

/** Add an older (or copied) log to the history; entries already there are not counted twice */
async function importFile(name: string): Promise<number> {
	const path = sysDir() + name;
	const stat = await statFile(path);
	if (!stat) {
		throw new Error(`${name} not found`);
	}
	if (!index && (await syncFromPrinter()).kind !== "ok") {
		// the log is read first, so its own entries are not mistaken for imported ones later
		throw new Error("Read the event log before importing an older one.");
	}
	status.value = "importing";
	const text = await downloadText(path, stat.size);
	const other = parseLog(text, { file: name, size: stat.size, lastModified: stat.lastModified });
	const result = importLog(base ?? emptyLog(sourceOf()), other);
	// recorded even when nothing was new (e.g. a copy, or a log imported before records were kept),
	// so the dialog shows it as imported from now on
	const record: ImportRecord = { name, size: stat.size, lastModified: stat.lastModified, at: new Date().toISOString(), added: result.added };
	status.value = "saving";
	const from = index!;
	const next: HistoryIndex = {
		...from,
		imports: [...(from.imports ?? []).filter(r => r.name !== name), record],
		first: result.log.first,
		last: result.log.last,
		lines: result.changed.size ? from.lines + other.lines : from.lines,
	};
	if (!await writeHistory(next, result.log, result.changed)) {
		throw new Error("The history changed meanwhile. Try the import again.");
	}
	await statFile(path);
	return result.added;
}

function run<T>(task: () => Promise<T>): Promise<T | undefined> {
	if (busy) {
		return busy.then(() => undefined);
	}
	error.value = null;
	let out: T | undefined;
	busy = (async () => {
		const t0 = performance.now();
		try {
			out = await task();
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
	return busy.then(() => out);
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

/** List the system directory: the active log's size (if it is there) and the older logs' import status */
async function scanSysDir(): Promise<void> {
	const { path } = await resolveLogging();
	if (path && dirOf(path) === sysDir()) {
		activeLog.value = nameOf(path);
		logSize.value = (await statFile(path))?.size ?? null;
		return;
	}
	setOlderLogs(await useMachineStore().getFileList(sysDir()), path ? nameOf(path) : null);
	logSize.value = path ? (await statFile(path))?.size ?? null : null;
}

export function usePrintStats() {
	return {
		parsed,
		status,
		error,
		progress,
		timings,
		logSize,
		reading,
		historyBytes,
		historyYears: computed(() => (parsed.value && index ? Object.keys(index.years).length : 0)),

		/** Show the browser copy (if any), then sync with the printer in the background */
		start: () => {
			loadBrowserCopy();
			return run(() => update(false));
		},

		/** Check the log for new lines now */
		refresh: () => run(() => update(false)),

		/** Read the whole log again and add anything the history is missing (nothing is removed) */
		recheck: () => run(() => update(true)),

		/** A print just ended: show it now, then read the log */
		jobEnded: () => {
			addEndedJob();
			return run(() => update(false));
		},

		importFile: (name: string) => run(() => importFile(name)),
		olderLogs,
		/** Older logs that are new or have changed since they were imported */
		pendingImports: computed(() => olderLogs.value.filter(l => l.status !== "imported")),

		/** Look up the active log's size and the older logs' status (for the settings dialog) */
		scanSysDir,
	};
}
