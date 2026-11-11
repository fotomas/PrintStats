/**
 * Turns an RRF event log into a compact list of jobs and machine events (ParsedLog).
 * Pure functions, no DWC dependencies. The result is what the cache file stores.
 *
 * Timestamps are the printer's local wall-clock time, stored as if it were UTC (seconds since 1970),
 * so a date never shifts with the browser's time zone. Lines logged right after power-up carry
 * "power up + hh:mm:ss" instead of a date until the clock is set; they reuse the last date seen.
 */

export const CACHE_VERSION = 1;

/** f = finished, c = cancelled, i = interrupted (reset, power loss or a new start without an end) */
export type JobStatus = "f" | "c" | "i";

/** [start, end, status, print minutes (-1 = unknown), file index (-1 = none), pauses] */
export type Job = [number, number, JobStatus, number, number, number];

export interface SourceInfo {
	file: string;
	size: number;
	lastModified: string | null;
}

export interface ParsedLog {
	v: number;
	source: SourceInfo;
	parsedAt: string;
	lines: number;
	first: number;                  // first timestamp in the log, 0 if none
	last: number;                   // last timestamp in the log
	files: string[];                // job file names (base name, without path, upload prefix or .gcode)
	jobs: Job[];
	firmware: [number, string][];   // [time, version] whenever the version changes
	powerUps: number[];             // times logging (re)started, i.e. boots
	leveling: [number, number][];   // [time, deviation before leveling in µm]
	faults: [number, number][];     // [time, index into faultTypes]
	faultTypes: string[];
	underVoltage: number[];
}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) /;
const PRINT_TIME = /print time was (\d+)h (\d+)m/;
const FILE = /file (.+?)(?:, print time was|$)/;
const FIRMWARE = /\[info\] Running: .*?: (\S+) \(/;
const LEVELING = /Leadscrew adjustments made:.*before \((-?[\d.]+), ([\d.]+)\)/;
const FAULT = /Heater \d+ fault: ([^:]+?)(?:: expected| expected|:|$)/;

/** Name used for a job's file: base name without upload prefix ("20231112-073107 - ") and .gcode */
export function baseName(path: string): string {
	const name = path.split("/").pop() ?? path;
	return name.replace(/^\d{8}-\d{6} - /, "").replace(/\.g(code)?$/i, "");
}

export function parseLog(text: string, source: SourceInfo): ParsedLog {
	const out: ParsedLog = {
		v: CACHE_VERSION, source, parsedAt: new Date().toISOString(), lines: 0, first: 0, last: 0,
		files: [], jobs: [], firmware: [], powerUps: [], leveling: [], faults: [], faultTypes: [], underVoltage: [],
	};
	const fileIndex = new Map<string, number>();
	const faultIndex = new Map<string, number>();
	const fileId = (path: string | undefined): number => {
		if (!path) {
			return -1;
		}
		const name = baseName(path);
		let id = fileIndex.get(name);
		if (id === undefined) {
			id = out.files.length;
			out.files.push(name);
			fileIndex.set(name, id);
		}
		return id;
	};

	let now = 0;
	let open: Job | null = null;
	const closeInterrupted = () => {
		if (open) {
			open[2] = "i";
			out.jobs.push(open);
			open = null;
		}
	};

	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		if (!line) {
			continue;
		}
		out.lines++;
		const m = TIMESTAMP.exec(line);
		if (m) {
			now = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000;
			if (!out.first) {
				out.first = now;
			}
			out.last = now;
		}

		if (line.includes("[warn]")) {
			if (line.includes("Started printing file")) {
				closeInterrupted();
				open = [now, 0, "i", -1, fileId(FILE.exec(line)?.[1]), 0];
			} else if (line.includes("Finished printing file") || line.includes("Cancelled printing file")) {
				const pt = PRINT_TIME.exec(line);
				const minutes = pt ? +pt[1] * 60 + +pt[2] : -1;
				const job: Job = open ?? [0, 0, "i", -1, fileId(FILE.exec(line)?.[1]), 0];
				job[1] = now;
				job[2] = line.includes("Finished") ? "f" : "c";
				job[3] = minutes;
				out.jobs.push(job);
				open = null;
			} else if (line.includes("Printing paused")) {
				if (open) {
					open[5]++;
				}
			} else if (line.includes("Leadscrew adjustments made")) {
				const l = LEVELING.exec(line);
				if (l) {
					out.leveling.push([now, Math.round(parseFloat(l[2]) * 1000)]);
				}
			} else if (line.includes("under-voltage")) {
				out.underVoltage.push(now);
			} else if (line.includes(" fault: ")) {
				const f = FAULT.exec(line);
				if (f) {
					const type = f[1].trim();
					let id = faultIndex.get(type);
					if (id === undefined) {
						id = out.faultTypes.length;
						out.faultTypes.push(type);
						faultIndex.set(type, id);
					}
					out.faults.push([now, id]);
				}
			}
		} else if (line.includes("[info]")) {
			if (line.includes("Event logging started")) {
				closeInterrupted();
				out.powerUps.push(now);
			} else if (line.includes("Running: ")) {
				const fw = FIRMWARE.exec(line)?.[1];
				if (fw && out.firmware[out.firmware.length - 1]?.[1] !== fw) {
					out.firmware.push([now, fw]);
				}
			}
		}
	}
	// a job still open at the end of the log is running (or the log stopped): leave it out
	return out;
}

/** Sanity check for a cache file read back from the printer */
export function isParsedLog(x: unknown): x is ParsedLog {
	const p = x as ParsedLog;
	return !!p && p.v === CACHE_VERSION && Array.isArray(p.jobs) && Array.isArray(p.files) && typeof p.source === "object";
}
