/**
 * Loading and caching. The parsed log is kept in 0:/sys/printstats-cache.json (about 250 kB for three
 * years of log), so the page can show statistics at once without downloading the full event log
 * (several MB over WiFi). After the cache is shown, the log's size and date are compared with the
 * cache's; when they differ the log is downloaded and parsed again in the background, and the cache
 * is rewritten. Refresh forces that.
 *
 * State is module-level, so it survives leaving and re-entering the page.
 */
import { ref, shallowRef } from "vue";

import { useCacheStore } from "@/stores/cache";
import { useMachineStore } from "@/stores/machine";

import { PLUGIN_ID } from "./id";
import { isParsedLog, parseLog, type ParsedLog, type SourceInfo } from "./model/logParser";

export const CACHE_FILE = "printstats-cache.json";

export type Status = "idle" | "loadingCache" | "checking" | "downloading" | "saving";

const parsed = shallowRef<ParsedLog | null>(null);
const status = ref<Status>("idle");
const error = ref<string | null>(null);
const noLogFile = ref(false);
const logFiles = ref<string[]>([]);
const logFile = ref<string>("");
/** Bytes read so far while downloading the log, null otherwise */
const progress = ref<{ loaded: number; total: number } | null>(null);
let cacheTried = false;
let busy: Promise<void> | null = null;

function sysDir(): string {
	const dir = String((useMachineStore().model as any).directories?.system ?? "0:/sys/");
	return dir.endsWith("/") ? dir : `${dir}/`;
}

function message(e: unknown): string {
	return e instanceof Error ? e.message : String(e);
}

/** The event log to use: the remembered one, else eventlog.txt, else any *eventlog*, else the first */
function pickLogFile(names: string[]): string {
	const remembered = String(useCacheStore().plugins[PLUGIN_ID]?.logFile ?? "");
	if (names.includes(remembered)) {
		return remembered;
	}
	return names.find(n => n.toLowerCase() === "eventlog.txt")
		?? names.find(n => n.toLowerCase().includes("eventlog"))
		?? names[0] ?? "";
}

async function loadCache(): Promise<void> {
	if (cacheTried || parsed.value) {
		return;
	}
	cacheTried = true;
	status.value = "loadingCache";
	try {
		const text = await useMachineStore().download({ filename: sysDir() + CACHE_FILE, type: "text" }, false, false, false);
		const data = JSON.parse(typeof text === "string" ? text : String(text));
		if (isParsedLog(data)) {
			parsed.value = data;
		}
	} catch {
		// no cache yet, or an unreadable one: it is rebuilt from the log
	}
}

async function downloadAndParse(item: { name: string; size: number; lastModified: Date | null }): Promise<void> {
	const machineStore = useMachineStore();
	status.value = "downloading";
	progress.value = { loaded: 0, total: item.size };
	let text: unknown;
	try {
		text = await machineStore.download({ filename: sysDir() + item.name, type: "text" }, false, false, true, true,
			(loaded, total) => { progress.value = { loaded, total: total > 0 ? total : item.size }; });
	} finally {
		progress.value = null;
	}
	const source: SourceInfo = {
		file: item.name,
		size: item.size,
		lastModified: item.lastModified ? new Date(item.lastModified).toISOString() : null,
	};
	parsed.value = parseLog(typeof text === "string" ? text : String(text ?? ""), source);

	status.value = "saving";
	try {
		const blob = new Blob([JSON.stringify(parsed.value)], { type: "application/json" });
		await machineStore.upload({ filename: sysDir() + CACHE_FILE, content: blob }, false, false, false);
	} catch (e) {
		// the statistics are still shown; they are just read from the log again next time
		console.warn("[PrintStats] could not write the cache file", e);
	}
}

/** Compare the log with the cache and re-read it when it changed (or always, with force) */
async function check(force: boolean): Promise<void> {
	const machineStore = useMachineStore();
	if (!machineStore.isConnected) {
		return;
	}
	status.value = "checking";
	const items = (await machineStore.getFileList(sysDir()))
		.filter((f: any) => !f.isDirectory && /\.(txt|log)$/i.test(String(f.name)));
	logFiles.value = items.map((f: any) => String(f.name)).sort((a, b) => a.localeCompare(b));
	if (!logFiles.value.includes(logFile.value)) {
		logFile.value = pickLogFile(logFiles.value);
	}
	const item = items.find((f: any) => f.name === logFile.value) as any;
	noLogFile.value = !item;
	if (!item) {
		return;
	}
	const src = parsed.value?.source;
	const modified = item.lastModified ? new Date(item.lastModified).toISOString() : null;
	const changed = !src || src.file !== item.name || src.size !== item.size || src.lastModified !== modified;
	if (force || changed) {
		await downloadAndParse({ name: item.name, size: Number(item.size ?? 0), lastModified: item.lastModified ?? null });
	}
}

function run(task: () => Promise<void>): Promise<void> {
	if (busy) {
		return busy;
	}
	error.value = null;
	busy = (async () => {
		try {
			await task();
		} catch (e) {
			console.warn("[PrintStats]", e);
			error.value = message(e);
		} finally {
			status.value = "idle";
			busy = null;
		}
	})();
	return busy;
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

		/** Show the cache (if any), then check the log in the background */
		start: () => run(async () => {
			await loadCache();
			await check(false);
		}),

		/** Re-read the log now */
		refresh: () => run(() => check(true)),

		/** Check the log for changes, e.g. after a print ended */
		checkForChanges: () => run(() => check(false)),

		/** Switch to another log file and read it */
		selectLogFile: (name: string) => {
			logFile.value = name;
			useCacheStore().setPluginData(PLUGIN_ID, "logFile", name);
			return run(() => check(false));
		},
	};
}
