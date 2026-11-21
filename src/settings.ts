/**
 * Per-printer settings in 0:/sys/PrintStats/settings.json, and what the printer says about its event log.
 * The settings live on the printer so every browser sees the same choice. Without the file the setup
 * dialog opens, and the log is not read until the user saves.
 */
import { computed, ref } from "vue";

import { useMachineStore } from "@/stores/machine";

/** readOnly: the log file is never changed. manage: the log is rotated after it has been read in. */
export type LogMode = "readOnly" | "manage";

export interface Settings {
	v: number;
	mode: LogMode;
}

export const SETTINGS_VERSION = 1;
export const SETTINGS_FILE = "settings.json";
export const HISTORY_DIR = "PrintStats";
export const DEFAULT_LOG_FILE = "eventlog.txt";

/** Log levels as RRF reports them in state.logLevel, and the M929 S value for each */
export type LogLevel = "off" | "warn" | "info" | "debug";
export const LEVEL_S: Record<Exclude<LogLevel, "off">, number> = { warn: 1, info: 2, debug: 3 };

/** null = not read yet, false = no settings file (first run) */
const settings = ref<Settings | null | false>(null);

export function sysDir(): string {
	const dir = String((useMachineStore().model as any).directories?.system ?? "0:/sys/");
	return dir.endsWith("/") ? dir : `${dir}/`;
}
export const historyDir = () => `${sysDir()}${HISTORY_DIR}/`;

/**
 * The printer's event logging as last confirmed by resolveLogging(), shared by the page, the dialog and the
 * updates. null until it is known: just after connecting the object model can still say "off" before RRF's
 * state has arrived, and it does not reliably trigger updates here, so nothing reads it directly.
 */
const logState = ref<{ level: LogLevel; path: string | null } | null>(null);

const toPath = (f: string) => (f.includes(":") || f.startsWith("/") ? f : sysDir() + f);

export function useLogging() {
	/** false until the logging state has been confirmed */
	const known = computed(() => logState.value !== null);
	const level = computed<LogLevel>(() => logState.value?.level ?? "off");
	/** Full path of the active log, or null when logging is off (or not known yet) */
	const path = computed<string | null>(() => logState.value?.path ?? null);
	/** File name of the active log (what M929 P is given back when logging restarts) */
	const fileName = computed(() => (path.value ? path.value.split("/").pop()! : null));
	return { known, level, path, fileName };
}

/** Forget the logging state, e.g. after a disconnect (another printer may be next) */
export function resetLogging(): void {
	logState.value = null;
}

/**
 * Find out the active log's path and level and store it for useLogging(). The object model is used when it
 * says logging is on; "off" is confirmed by asking the printer (M409), since the model can still say "off"
 * just after connecting.
 */
export async function resolveLogging(): Promise<{ level: LogLevel; path: string | null }> {
	const result = await readLogging();
	logState.value = result;
	return result;
}

async function readLogging(): Promise<{ level: LogLevel; path: string | null }> {
	const machineStore = useMachineStore();
	const state = (machineStore.model as any).state;
	const modelLevel = String(state?.logLevel ?? "off").toLowerCase();
	const modelFile = String(state?.logFile ?? "");
	if (["warn", "info", "debug"].includes(modelLevel) && modelFile) {
		return { level: modelLevel as LogLevel, path: toPath(modelFile) };
	}
	const ask = async (key: string): Promise<string> => {
		try {
			const reply = await machineStore.sendCode(`M409 K"${key}"`, false, false);
			return String(JSON.parse(String(reply)).result ?? "");
		} catch {
			return "";
		}
	};
	const l = (await ask("state.logLevel")).toLowerCase();
	const f = await ask("state.logFile");
	if (!["warn", "info", "debug"].includes(l) || !f) {
		return { level: "off", path: null };
	}
	return { level: l as LogLevel, path: toPath(f) };
}

function isSettings(x: unknown): x is Settings {
	const s = x as Settings;
	return !!s && s.v === SETTINGS_VERSION && (s.mode === "readOnly" || s.mode === "manage");
}

export async function loadSettings(): Promise<Settings | false> {
	try {
		const text = await useMachineStore().download({ filename: historyDir() + SETTINGS_FILE, type: "text" }, false, false, false);
		const data = JSON.parse(typeof text === "string" ? text : String(text));
		settings.value = isSettings(data) ? data : false;
	} catch {
		settings.value = false;
	}
	return settings.value;
}

export async function saveSettings(mode: LogMode): Promise<void> {
	const machineStore = useMachineStore();
	try {
		await machineStore.makeDirectory(historyDir().slice(0, -1));
	} catch {
		// it exists already
	}
	const next: Settings = { v: SETTINGS_VERSION, mode };
	await machineStore.upload({
		filename: historyDir() + SETTINGS_FILE,
		content: new Blob([JSON.stringify(next)], { type: "application/json" }),
	}, false, false, false);
	settings.value = next;
}

/** Turn logging on until the next reboot (config.g is never changed) */
export async function turnOnLogging(): Promise<void> {
	await useMachineStore().sendCode(`M929 P"${DEFAULT_LOG_FILE}" S${LEVEL_S.warn}`, false, false);
	await resolveLogging();
}

export function useSettings() {
	return { settings };
}
