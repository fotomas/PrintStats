/**
 * Statistics for one time range, computed from a ParsedLog. Pure functions, no DWC dependencies.
 * All times are printer wall-clock seconds stored as UTC (see logParser.ts).
 */
import type { Job, ParsedLog } from "./logParser";

export type TimeRange = "all" | "year" | "month" | "week";
export const TIME_RANGES: TimeRange[] = ["all", "year", "month", "week"];

const DAY = 86400;

export interface FileInfo {
	part: string;            // name without slicer suffix
	layer: string | null;    // "0.2"
	material: string | null; // "PLA"
	estimate: number | null; // minutes
}

/** OrcaSlicer/PrusaSlicer default output name: {name}_{layer}mm_{material}_{1h23m45s} */
const SLICER_NAME = /^(.*)_(\d+(?:\.\d+)?)mm_([A-Za-z][A-Za-z0-9+-]*)_((?:\d+d)?(?:\d+h)?(?:\d+m)?(?:\d+s)?)$/;

export function fileInfo(name: string): FileInfo {
	const m = SLICER_NAME.exec(name);
	if (!m) {
		return { part: name, layer: null, material: null, estimate: null };
	}
	const t = /(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/.exec(m[4])!;
	const est = (+(t[1] ?? 0)) * 1440 + (+(t[2] ?? 0)) * 60 + (+(t[3] ?? 0)) + (+(t[4] ?? 0)) / 60;
	return { part: m[1], layer: String(parseFloat(m[2])), material: m[3].toUpperCase(), estimate: est > 0 ? est : null };
}

/** Printer-style "now": local wall-clock time as UTC seconds */
export function localNow(): number {
	const d = new Date();
	return Math.floor(d.getTime() / 1000) - d.getTimezoneOffset() * 60;
}

export const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
export const dayKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const monthKey = (t: number) => new Date(t * 1000).toISOString().slice(0, 7);

export function rangeStart(range: TimeRange, now: number, first: number): number {
	const d = new Date(dayStart(now) * 1000);
	switch (range) {
		case "year": d.setUTCFullYear(d.getUTCFullYear() - 1); break;
		case "month": d.setUTCMonth(d.getUTCMonth() - 1); break;
		case "week": d.setUTCDate(d.getUTCDate() - 7); break;
		default: return first ? dayStart(first) : dayStart(now);
	}
	return d.getTime() / 1000;
}

const jobTime = (j: Job) => j[0] || j[1];

export interface Period { key: string; finished: number; cancelled: number; interrupted: number; hours: number }
export interface Bucket { label: string; value: number }
export interface LengthBucket { label: string; finished: number; cancelled: number; pct: number }
export interface DayRecord { day: string; value: number }
export interface Named { name: string; value: number }

export interface Stats {
	range: TimeRange;
	from: number;
	to: number;
	groupBy: "day" | "month";
	totals: {
		started: number; finished: number; cancelled: number; interrupted: number;
		hours: number; successPct: number; successAfter5Pct: number; earlyCancels: number;
		medianMinutes: number; p90Minutes: number; busyPct: number; activeDays: number;
	};
	periods: Period[];
	byLength: LengthBucket[];
	hourWeek: number[][];                 // [weekday Mon=0][hour]
	cancelMinutes: Bucket[];              // 0..9, 10+
	estimate: { buckets: Bucket[]; median: number | null; n: number };
	materials: Named[];                   // hours
	layers: Named[];                      // job count
	topParts: Named[];                    // finished count
	records: {
		longest: { minutes: number; name: string; day: string } | null;
		mostPrintsDay: DayRecord | null;
		mostHoursDay: DayRecord | null;
		streak: { days: number; from: string; to: string } | null;
		longestBreak: { days: number; from: string; to: string } | null;
		busiestMonth: { month: string; hours: number } | null;
	};
	faults: Named[];
	underVoltage: number;
	powerUps: number;
}

function median(xs: number[]): number | null {
	if (!xs.length) {
		return null;
	}
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function topN(map: Map<string, number>, n: number): Named[] {
	return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, value]) => ({ name, value }));
}

const add = (map: Map<string, number>, key: string, v: number) => map.set(key, (map.get(key) ?? 0) + v);

export function computeStats(log: ParsedLog, range: TimeRange, now = localNow()): Stats {
	const infos = log.files.map(fileInfo);
	const from = rangeStart(range, now, log.first);
	const to = Math.max(now, log.last);
	const groupBy = range === "month" || range === "week" ? "day" : "month";
	const jobs = log.jobs.filter(j => jobTime(j) >= from);

	let finished = 0, cancelled = 0, interrupted = 0, minutesTotal = 0, earlyCancels = 0;
	const finishedMinutes: number[] = [];
	const periodMap = new Map<string, Period>();
	const dayCount = new Map<string, number>();
	const dayMinutes = new Map<string, number>();
	const monthMinutes = new Map<string, number>();
	const hourWeek = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
	const cancelMin = new Array<number>(11).fill(0);
	const lengthEdges = [5, 30, 120, 360, Infinity];
	const lenF = new Array<number>(5).fill(0), lenC = new Array<number>(5).fill(0);
	const ratios: number[] = [];
	const materials = new Map<string, number>(), layers = new Map<string, number>(), parts = new Map<string, number>();
	let longest: Stats["records"]["longest"] = null;

	for (const j of jobs) {
		const t = jobTime(j);
		const [start, , status, minutes, file] = j;
		const key = groupBy === "day" ? dayKey(t) : monthKey(t);
		let p = periodMap.get(key);
		if (!p) {
			p = { key, finished: 0, cancelled: 0, interrupted: 0, hours: 0 };
			periodMap.set(key, p);
		}
		const info = file >= 0 ? infos[file] : null;
		const m = minutes >= 0 ? minutes : 0;

		if (status === "f") { finished++; p.finished++; }
		else if (status === "c") { cancelled++; p.cancelled++; }
		else { interrupted++; p.interrupted++; }

		p.hours += m / 60;
		minutesTotal += m;
		add(dayCount, dayKey(t), 1);
		add(dayMinutes, dayKey(t), m);
		add(monthMinutes, monthKey(t), m);
		if (start) {
			const d = new Date(start * 1000);
			hourWeek[(d.getUTCDay() + 6) % 7][d.getUTCHours()]++;
		}

		if (status !== "i" && minutes >= 0) {
			const b = lengthEdges.findIndex(e => minutes < e);
			(status === "f" ? lenF : lenC)[b]++;
		}
		if (status === "c" && minutes >= 0) {
			cancelMin[Math.min(10, minutes)]++;
			if (minutes < 5) {
				earlyCancels++;
			}
		}
		if (info?.material) {
			add(materials, info.material, m / 60);
		}
		if (info?.layer) {
			add(layers, info.layer, 1);
		}
		if (status === "f" && minutes >= 0) {
			finishedMinutes.push(minutes);
			if (info) {
				add(parts, info.part, 1);
			}
			if (info?.estimate && info.estimate >= 10) {
				ratios.push(minutes / info.estimate);
			}
			if (!longest || minutes > longest.minutes) {
				longest = { minutes, name: info?.part ?? "?", day: dayKey(t) };
			}
		}
	}

	// periods with the empty days/months filled in, from the range start (or first job) to now
	const periods: Period[] = [];
	if (jobs.length) {
		const startAt = range === "all" ? jobTime(jobs[0]) : from;
		const d = new Date(dayStart(startAt) * 1000);
		if (groupBy === "month") {
			d.setUTCDate(1);
		}
		while (d.getTime() / 1000 <= to) {
			const t = d.getTime() / 1000;
			const key = groupBy === "day" ? dayKey(t) : monthKey(t);
			periods.push(periodMap.get(key) ?? { key, finished: 0, cancelled: 0, interrupted: 0, hours: 0 });
			if (groupBy === "day") {
				d.setUTCDate(d.getUTCDate() + 1);
			} else {
				d.setUTCMonth(d.getUTCMonth() + 1);
			}
		}
	}

	// streaks over active days
	const days = [...dayCount.keys()].sort();
	let streak: Stats["records"]["streak"] = null, longestBreak: Stats["records"]["longestBreak"] = null;
	if (days.length) {
		let runStart = days[0], run = 1;
		streak = { days: 1, from: days[0], to: days[0] };
		for (let i = 1; i < days.length; i++) {
			const gap = (Date.parse(days[i]) - Date.parse(days[i - 1])) / 86400000;
			if (gap === 1) {
				run++;
			} else {
				run = 1;
				runStart = days[i];
				if (!longestBreak || gap - 1 > longestBreak.days) {
					longestBreak = { days: gap - 1, from: days[i - 1], to: days[i] };
				}
			}
			if (run > streak.days) {
				streak = { days: run, from: runStart, to: days[i] };
			}
		}
	}
	const best = (map: Map<string, number>) => {
		let r: DayRecord | null = null;
		for (const [day, value] of map) {
			if (!r || value > r.value) {
				r = { day, value };
			}
		}
		return r;
	};
	const mh = best(monthMinutes);

	const estBuckets: Bucket[] = [];
	for (let b = 6; b <= 20; b++) {
		const lo = b / 10;
		estBuckets.push({
			label: lo.toFixed(1),
			value: ratios.filter(r => (b === 6 ? r < 0.65 : b === 20 ? r >= 1.95 : Math.abs(r - lo) < 0.05)).length,
		});
	}

	const ended = finished + cancelled + interrupted;
	const faults = new Map<string, number>();
	for (const [t, type] of log.faults) {
		if (t >= from) {
			add(faults, log.faultTypes[type] ?? "?", 1);
		}
	}
	const sortedF = [...finishedMinutes].sort((a, b) => a - b);

	return {
		range, from, to, groupBy,
		totals: {
			started: jobs.filter(j => j[0]).length,
			finished, cancelled, interrupted,
			hours: minutesTotal / 60,
			successPct: ended ? (finished / ended) * 100 : 0,
			successAfter5Pct: ended - earlyCancels ? (finished / (ended - earlyCancels)) * 100 : 0,
			earlyCancels,
			medianMinutes: median(finishedMinutes) ?? 0,
			p90Minutes: sortedF.length ? sortedF[Math.floor(sortedF.length * 0.9)] : 0,
			busyPct: to > from ? (minutesTotal * 60) / (to - from) * 100 : 0,
			activeDays: dayCount.size,
		},
		periods,
		byLength: ["<5m", "5–30m", "30m–2h", "2–6h", "6h+"].map((label, i) => ({
			label, finished: lenF[i], cancelled: lenC[i], pct: lenF[i] + lenC[i] ? (lenF[i] / (lenF[i] + lenC[i])) * 100 : 0,
		})),
		hourWeek,
		cancelMinutes: cancelMin.map((value, i) => ({ label: i === 10 ? "10+" : String(i), value })),
		estimate: { buckets: estBuckets, median: median(ratios), n: ratios.length },
		materials: topN(materials, 4),
		layers: topN(layers, 6),
		topParts: topN(parts, 6),
		records: {
			longest,
			mostPrintsDay: best(dayCount),
			mostHoursDay: (() => { const r = best(dayMinutes); return r ? { day: r.day, value: r.value / 60 } : null; })(),
			streak,
			longestBreak,
			busiestMonth: mh ? { month: mh.day, hours: mh.value / 60 } : null,
		},
		faults: topN(faults, 6),
		underVoltage: log.underVoltage.filter(t => t >= from).length,
		powerUps: log.powerUps.filter(t => t >= from).length,
	};
}

/** Daily print hours for the last 52 full weeks plus this week, Monday first (independent of the range) */
export function calendar(log: ParsedLog, now = localNow()): { day: string; hours: number; prints: number }[] {
	const today = dayStart(now);
	const weekday = (new Date(today * 1000).getUTCDay() + 6) % 7;
	const start = today - (52 * 7 + weekday) * DAY;
	const hours = new Map<string, number>(), prints = new Map<string, number>();
	for (const j of log.jobs) {
		const t = jobTime(j);
		if (t >= start) {
			add(hours, dayKey(t), Math.max(0, j[3]) / 60);
			add(prints, dayKey(t), 1);
		}
	}
	const out = [];
	for (let t = start; t <= today; t += DAY) {
		const k = dayKey(t);
		out.push({ day: k, hours: hours.get(k) ?? 0, prints: prints.get(k) ?? 0 });
	}
	return out;
}

/** Leveling deviation before adjustment, median per quarter (all time) */
export function levelingByQuarter(log: ParsedLog): { quarter: string; microns: number; n: number }[] {
	const q = new Map<string, number[]>();
	for (const [t, dev] of log.leveling) {
		const d = new Date(t * 1000);
		const key = `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
		(q.get(key) ?? q.set(key, []).get(key)!).push(dev);
	}
	return [...q.entries()].sort().map(([quarter, xs]) => ({ quarter, microns: median(xs) ?? 0, n: xs.length }));
}

/** The 1st, 100th, 500th, 1000th, 2000th, 5000th... finished print (all time) */
export function milestones(log: ParsedLog): { n: number; day: string; name: string }[] {
	const marks = [1, 100, 500, 1000, 2000, 3000, 5000, 10000];
	const out = [];
	let count = 0;
	for (const j of log.jobs) {
		if (j[2] === "f") {
			count++;
			if (marks.includes(count)) {
				out.push({ n: count, day: dayKey(jobTime(j)), name: j[4] >= 0 ? fileInfo(log.files[j[4]]).part : "?" });
			}
		}
	}
	return out;
}

export function formatMinutes(minutes: number): string {
	if (!(minutes > 0)) {
		return "—";
	}
	const total = Math.round(minutes);
	const h = Math.floor(total / 60), m = total % 60;
	return h === 0 ? `${m} min` : `${h} h ${String(m).padStart(2, "0")} m`;
}
