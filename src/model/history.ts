/**
 * Print history kept on the printer in 0:/sys/PrintStats/: an index.json plus one file per year
 * (2024.json, ...). Each year file has the ParsedLog shape for that year's entries, with its own file and
 * fault-type lists. Past years never change, so after the first run an update rewrites only the current
 * year and the index.
 *
 * The index says how far the event log has been read (`mark`) and carries the parser's state, so the next
 * update parses only the lines added since. Pure functions, no DWC dependencies.
 */
import {
	emptyLog, newParserState, parseInto,
	type Job, type ParsedLog, type ParserState, type SourceInfo,
} from "./logParser";

export const HISTORY_VERSION = 1;

/** How far the event log has been read */
export interface LogMark {
	file: string;
	/** characters of the log consumed (whole lines only) */
	offset: number;
	/** the last characters before `offset`, to recognise the same log next time */
	tail: string;
	/** time of the last dated line consumed */
	time: number;
	size: number;
	lastModified: string | null;
}

export interface HistoryIndex {
	v: number;
	/** bumped on every write; a writer re-reads the index first and gives up if it changed meanwhile */
	gen: number;
	updatedAt: string;
	/** year -> gen of the write that last changed that year's file */
	years: Record<string, number>;
	mark: LogMark | null;
	state: ParserState;
	/** log lines read in total */
	lines: number;
	first: number;
	last: number;
	/** older logs imported into the history, so the dialog can tell which still need importing */
	imports?: ImportRecord[];
}

export interface ImportRecord {
	name: string;
	/** size and date of the file when it was imported: if they differ now, the file has changed since */
	size: number;
	lastModified: string | null;
	/** when it was imported (ISO) and how many prints it added */
	at: string;
	added: number;
}

/** new: never imported. imported: imported and unchanged since. changed: imported, but the file differs now */
export type ImportStatus = "new" | "imported" | "changed";

export function importStatus(index: HistoryIndex | null, file: { name: string; size: number; lastModified: string | null }): ImportStatus {
	const r = index?.imports?.find(i => i.name === file.name);
	if (!r) {
		return "new";
	}
	return r.size === file.size && sameTime(r.lastModified, file.lastModified) ? "imported" : "changed";
}

/**
 * Whether two file dates (ISO) are the same. RRF dates have whole seconds, but DWC's conversion adds
 * milliseconds that differ from one listing to the next, so they are compared with a little tolerance.
 */
export function sameTime(a: string | null, b: string | null): boolean {
	if (a === null || b === null) {
		return a === b;
	}
	return Math.abs(Date.parse(a) - Date.parse(b)) < 2000;
}

export interface YearFile {
	v: number;
	year: number;
	gen: number;
	files: string[];
	jobs: Job[];
	firmware: [number, string][];
	powerUps: number[];
	leveling: [number, number][];
	faults: [number, number][];
	faultTypes: string[];
	underVoltage: number[];
}

const TAIL = 256;

export const yearOf = (t: number) => new Date(t * 1000).getUTCFullYear();
const jobTime = (j: Job) => j[0] || j[1];

export function emptyIndex(): HistoryIndex {
	return {
		v: HISTORY_VERSION, gen: 0, updatedAt: new Date(0).toISOString(), years: {}, mark: null,
		state: newParserState(), lines: 0, first: 0, last: 0,
	};
}

export function isHistoryIndex(x: unknown): x is HistoryIndex {
	const i = x as HistoryIndex;
	return !!i && i.v === HISTORY_VERSION && typeof i.gen === "number" && typeof i.years === "object" && !!i.state;
}

export function isYearFile(x: unknown): x is YearFile {
	const y = x as YearFile;
	return !!y && y.v === HISTORY_VERSION && typeof y.year === "number" && Array.isArray(y.jobs) && Array.isArray(y.files);
}

/** Split a log into one YearFile per year that has entries */
export function splitByYear(log: ParsedLog, gen: number, only?: Set<number>): Map<number, YearFile> {
	const out = new Map<number, YearFile>();
	const fileMaps = new Map<number, Map<number, number>>();
	const faultMaps = new Map<number, Map<number, number>>();
	const get = (year: number) => {
		let y = out.get(year);
		if (!y) {
			y = { v: HISTORY_VERSION, year, gen, files: [], jobs: [], firmware: [], powerUps: [], leveling: [], faults: [], faultTypes: [], underVoltage: [] };
			out.set(year, y);
			fileMaps.set(year, new Map());
			faultMaps.set(year, new Map());
		}
		return y;
	};
	const want = (t: number) => !only || only.has(yearOf(t));
	const reindex = (map: Map<number, number>, list: string[], from: string[], i: number) => {
		if (i < 0) {
			return -1;
		}
		let id = map.get(i);
		if (id === undefined) {
			id = list.length;
			list.push(from[i]);
			map.set(i, id);
		}
		return id;
	};

	for (const j of log.jobs) {
		const t = jobTime(j);
		if (!want(t)) continue;
		const y = get(yearOf(t));
		y.jobs.push([j[0], j[1], j[2], j[3], reindex(fileMaps.get(y.year)!, y.files, log.files, j[4]), j[5]]);
	}
	for (const [t, fw] of log.firmware) if (want(t)) get(yearOf(t)).firmware.push([t, fw]);
	for (const t of log.powerUps) if (want(t)) get(yearOf(t)).powerUps.push(t);
	for (const [t, d] of log.leveling) if (want(t)) get(yearOf(t)).leveling.push([t, d]);
	for (const t of log.underVoltage) if (want(t)) get(yearOf(t)).underVoltage.push(t);
	for (const [t, f] of log.faults) {
		if (!want(t)) continue;
		const y = get(yearOf(t));
		y.faults.push([t, reindex(faultMaps.get(y.year)!, y.faultTypes, log.faultTypes, f)]);
	}
	return out;
}

/** Join year files (any order) into one log, as the statistics expect it */
export function mergeYears(years: YearFile[], index: HistoryIndex, source: SourceInfo): ParsedLog {
	const out = emptyLog(source);
	out.parsedAt = index.updatedAt;
	out.lines = index.lines;
	const fileIds = new Map<string, number>();
	const faultIds = new Map<string, number>();
	const intern = (map: Map<string, number>, list: string[], name: string | undefined) => {
		if (name === undefined) {
			return -1;
		}
		let id = map.get(name);
		if (id === undefined) {
			id = list.length;
			list.push(name);
			map.set(name, id);
		}
		return id;
	};
	const limit = index.mark?.time ?? Infinity;
	for (const y of [...years].sort((a, b) => a.year - b.year)) {
		// a year file newer than the index comes from a write that stopped half-way: keep only what the index covers
		const ok = (t: number) => y.gen <= index.gen || t <= limit;
		for (const j of y.jobs) {
			if (ok(jobTime(j))) out.jobs.push([j[0], j[1], j[2], j[3], j[4] < 0 ? -1 : intern(fileIds, out.files, y.files[j[4]]), j[5]]);
		}
		for (const f of y.firmware) if (ok(f[0]) && out.firmware[out.firmware.length - 1]?.[1] !== f[1]) out.firmware.push(f);
		for (const t of y.powerUps) if (ok(t)) out.powerUps.push(t);
		for (const l of y.leveling) if (ok(l[0])) out.leveling.push(l);
		for (const t of y.underVoltage) if (ok(t)) out.underVoltage.push(t);
		for (const [t, f] of y.faults) if (ok(t)) out.faults.push([t, intern(faultIds, out.faultTypes, y.faultTypes[f])]);
	}
	out.first = index.first;
	out.last = index.last;
	return out;
}

function cloneLog(log: ParsedLog): ParsedLog {
	return {
		...log,
		files: [...log.files], jobs: [...log.jobs], firmware: [...log.firmware], powerUps: [...log.powerUps],
		leveling: [...log.leveling], faults: [...log.faults], faultTypes: [...log.faultTypes], underVoltage: [...log.underVoltage],
	};
}

/**
 * Add the entries of another parsed log (an older log, or a copy that overlaps the history) that the history
 * does not have yet. Entries are matched on time: a finished or cancelled print by its end and status, an
 * interrupted one by its start, other events by time and value. Undated entries (time 0) are not imported.
 */
export function importLog(base: ParsedLog, other: ParsedLog): { log: ParsedLog; changed: Set<number>; added: number } {
	const log = cloneLog(base);
	const changed = new Set<number>();
	let added = 0;
	const jobKey = (j: Job, files: string[]) => (j[2] === "i" ? `i|${j[0]}` : `${j[2]}|${j[1]}`) + `|${j[4] < 0 ? "" : files[j[4]]}`;

	const jobs = new Set(log.jobs.map(j => jobKey(j, log.files)));
	const fileIds = new Map(log.files.map((f, i) => [f, i]));
	for (const j of other.jobs) {
		const t = jobTime(j);
		if (!t || jobs.has(jobKey(j, other.files))) continue;
		jobs.add(jobKey(j, other.files));
		let id = -1;
		if (j[4] >= 0) {
			const name = other.files[j[4]];
			id = fileIds.get(name) ?? -1;
			if (id < 0) {
				id = log.files.length;
				log.files.push(name);
				fileIds.set(name, id);
			}
		}
		log.jobs.push([j[0], j[1], j[2], j[3], id, j[5]]);
		changed.add(yearOf(t));
		added++;
	}

	const addTimes = (into: number[], from: number[]) => {
		const have = new Set(into);
		for (const t of from) if (t && !have.has(t)) { into.push(t); have.add(t); changed.add(yearOf(t)); }
		into.sort((a, b) => a - b);
	};
	addTimes(log.powerUps, other.powerUps);
	addTimes(log.underVoltage, other.underVoltage);

	const levels = new Set(log.leveling.map(l => l.join("|")));
	for (const l of other.leveling) if (l[0] && !levels.has(l.join("|"))) { log.leveling.push(l); changed.add(yearOf(l[0])); }
	log.leveling.sort((a, b) => a[0] - b[0]);

	const faultIds = new Map(log.faultTypes.map((f, i) => [f, i]));
	const faults = new Set(log.faults.map(([t, f]) => `${t}|${log.faultTypes[f]}`));
	for (const [t, f] of other.faults) {
		const type = other.faultTypes[f];
		if (!t || faults.has(`${t}|${type}`)) continue;
		let id = faultIds.get(type);
		if (id === undefined) {
			id = log.faultTypes.length;
			log.faultTypes.push(type);
			faultIds.set(type, id);
		}
		log.faults.push([t, id]);
		faults.add(`${t}|${type}`);
		changed.add(yearOf(t));
	}
	log.faults.sort((a, b) => a[0] - b[0]);

	// firmware is a list of changes: merge both, sort, and drop repeats of the same version
	const fw = [...log.firmware, ...other.firmware.filter(f => f[0])].sort((a, b) => a[0] - b[0]);
	const merged = fw.filter((f, i) => i === 0 || f[1] !== fw[i - 1][1]);
	const had = new Set(log.firmware.map(f => f.join("|")));
	for (const f of merged) if (!had.has(f.join("|"))) changed.add(yearOf(f[0]));
	log.firmware = merged;

	log.jobs.sort((a, b) => jobTime(a) - jobTime(b));
	const times = [log.first, other.first].filter(t => t > 0);
	log.first = times.length ? Math.min(...times) : 0;
	log.last = Math.max(log.last, other.last);
	return { log, changed, added };
}

export interface FoldResult {
	log: ParsedLog;
	index: HistoryIndex;
	/** years whose files must be written */
	changed: Set<number>;
	/** whether the log was read from the last mark (false: the log was replaced, so it was read from the start) */
	continued: boolean;
}

/**
 * Add the event log's new lines to the history. When the log still starts with what was read before, only
 * the text after the mark is parsed; otherwise (the log was rotated, replaced or truncated) the whole text
 * is read, skipping lines dated at or before the last line already in the history.
 */
export function foldLog(base: ParsedLog, index: HistoryIndex, text: string, source: SourceInfo): FoldResult {
	const mark = index.mark;
	// only whole lines: the printer may be writing the last one while we read
	const end = text.lastIndexOf("\n") + 1;
	const continued = !!mark && mark.file === source.file && end >= mark.offset
		&& text.slice(Math.max(0, mark.offset - mark.tail.length), mark.offset) === mark.tail;
	const from = continued ? mark!.offset : 0;

	const log = cloneLog(base);
	const before = {
		jobs: log.jobs.length, firmware: log.firmware.length, powerUps: log.powerUps.length,
		leveling: log.leveling.length, faults: log.faults.length, underVoltage: log.underVoltage.length,
	};
	const state: ParserState = JSON.parse(JSON.stringify(index.state));
	parseInto(text.slice(from, end), log, state, !continued && mark ? { time: mark.time } : undefined);

	const changed = new Set<number>();
	for (const j of log.jobs.slice(before.jobs)) changed.add(yearOf(jobTime(j)));
	for (const [t] of log.firmware.slice(before.firmware)) changed.add(yearOf(t));
	for (const t of log.powerUps.slice(before.powerUps)) changed.add(yearOf(t));
	// a rotation marker can remove a power-up that was read in the previous piece
	if (before.powerUps && log.powerUps[before.powerUps - 1] !== base.powerUps[before.powerUps - 1]) {
		changed.add(yearOf(base.powerUps[before.powerUps - 1]));
	}
	for (const [t] of log.leveling.slice(before.leveling)) changed.add(yearOf(t));
	for (const [t] of log.faults.slice(before.faults)) changed.add(yearOf(t));
	for (const t of log.underVoltage.slice(before.underVoltage)) changed.add(yearOf(t));

	log.source = source;
	log.parsedAt = new Date().toISOString();
	const next: HistoryIndex = {
		...index,
		updatedAt: log.parsedAt,
		state,
		lines: log.lines,
		first: log.first,
		last: log.last,
		mark: {
			file: source.file,
			offset: end,
			tail: text.slice(Math.max(0, end - TAIL), end),
			time: Math.max(log.last, mark?.time ?? 0),
			size: source.size,
			lastModified: source.lastModified,
		},
	};
	return { log, index: next, changed, continued };
}
