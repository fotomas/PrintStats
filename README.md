# Print Stats

A Duet Web Control 3.7 plugin that turns the RRF event log into a statistics dashboard
(**Plugins → Print Stats**), for all time or the last year, month or week:

![Print Stats dashboard](docs/screenshots/dashboard.png)

- prints started, finished, cancelled and interrupted, print time, success rate
- prints and print time per month or day
- success by print length, when prints get cancelled, slicer estimate vs. actual time
- a 12-month calendar heatmap and a weekday × hour heatmap
- records: longest print, busiest day, streaks, breaks, busiest month
- materials, layer heights and most printed parts (from slicer file names)
- milestones, firmware history, bed leveling over time, heater faults, power-ups

### Setup

The first time the page opens on a printer, a setup dialog asks how to treat the event log. It can be opened
again later with the gear button. The log file and level are read from the printer, so there is nothing to pick.

- **Event logging**: if logging is off, the dialog can turn it on until the next reboot and shows the line to
  add to `config.g` to keep it on. Print Stats never changes `config.g`. Info and debug levels work, but the
  dialog suggests warning level, which keeps the log small.
- **Read-only mode** (default): the log file is never changed. The whole log is downloaded each time it has grown.
- **Manage the log**: once the log is over 256 kB and the printer is idle, logging is stopped, the log is read
  in and deleted, and logging restarts at the same file and level. Updates then download only a few kB. The
  original log text is not kept beyond what Print Stats counts; switch to read-only mode to keep the full log.
- **Older logs**: another log in `0:/sys/` (or a copy of one) can be imported. Entries already in the history,
  matched by time, aren't counted twice.
- **Re-check log** reads the whole current log again and adds anything the history is missing. It never
  removes anything, so it is safe after a rotation or an import.

The choice is stored in `0:/sys/PrintStats/settings.json`, so it applies to every browser.

### Caching

Reading a large event log over WiFi takes a while, so the parsed history is kept on the printer in
`0:/sys/PrintStats/`: an `index.json` (under 1 kB) and one file per year (`2025.json`, about 20–90 kB each),
plus a copy in the browser.

- Opening the page shows the browser copy at once, then reads `index.json` and only the year files that changed.
- If the event log changed since, it is downloaded, only the lines after the last read position are parsed,
  and only the changed year file and the index are written back. Past years are never rewritten.
- When a print ends while the page is open, it is shown at once and confirmed from the log shortly after.
- **Refresh** checks the log for new lines.
- The history is never replaced by what the log holds (after a rotation the log has only the newest lines).
  If a year file or the whole folder goes missing, the browser's copy is written back and the current log is
  merged in. Without a browser copy, a lost year can only be recovered as far as the current log reaches.
- When Print Stats rotates the log, it writes `PrintStats: log rotated` (`M118 ... L1`) right after restarting
  logging, so that restart is not counted as a power-up, however the log is read later.

The printer cannot send part of a file, so in read-only mode each update downloads the whole log when it has grown.

## Requirements

Event logging must be on. Warning level is enough, e.g. in `config.g`:

```
M929 P"eventlog.txt" S1    ; S1 = warnings (S2 = info, S3 = debug); started/finished/cancelled prints are warnings
```

Material, layer height, part name and slicer estimate come from OrcaSlicer/PrusaSlicer's default file
name, `{name}_{layer}mm_{material}_{1h23m}.gcode`; other names still count, they just lack those details.

## Building

Needs a DuetWebControl 3.7 checkout with this folder in `src/plugins/PrintStats`.

- Development: run `npm run dev` in the DWC folder; the plugin loads as a built-in with hot reload.
- Package: run `build.bat` (set `DWC_DIR` if DWC is somewhere else). It produces `PrintStats-<version>.zip`,
  which you install under Settings → Plugins.

## Layout

| File | Purpose |
| --- | --- |
| `src/index.ts` | Entry: registers the route, strings and remembered settings |
| `src/PrintStatsPage.vue` | The dashboard |
| `src/usePrintStats.ts` | Loading, caching, background refresh, log rotation and import |
| `src/settings.ts` | Per-printer settings and the printer's logging state |
| `src/components/SetupDialog.vue` | Setup and settings dialog |
| `src/model/logParser.ts` | Event log → jobs and machine events, incremental |
| `src/model/history.ts` | Yearly history files, index and folding new log lines in |
| `src/model/stats.ts` | Statistics for a time range |
| `src/components/` | Charts: period chart (Chart.js), heatmaps, small bar charts |
| `src/i18n/en.json` | Strings, under `plugins.printStats.*` |

## Licence

GPL-3.0-or-later
