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

### Caching

Reading a large event log over WiFi takes a while, so the parsed history is kept on the printer in
`0:/sys/PrintStats/`: an `index.json` (under 1 kB) and one file per year (`2025.json`, about 20–90 kB each),
plus a copy in the browser.

- Opening the page shows the browser copy at once, then reads `index.json` and only the year files that changed.
- If the event log changed since, it is downloaded, only the lines after the last read position are parsed,
  and only the changed year file and the index are written back. Past years are never rewritten.
- When a print ends while the page is open, it is shown at once and confirmed from the log shortly after.
- **Refresh** re-reads the whole log and rebuilds the history. Deleting the folder is safe; it is rebuilt.

The printer cannot send part of a file, so each update still downloads the whole event log when it has grown.

## Requirements

Event logging must be on, e.g. in `config.g`:

```
M929 P"eventlog.txt" S3    ; S3 = log warnings and info (finished/cancelled prints are logged as warnings)
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
| `src/usePrintStats.ts` | Loading, caching and background refresh |
| `src/model/logParser.ts` | Event log → jobs and machine events, incremental |
| `src/model/history.ts` | Yearly history files, index and folding new log lines in |
| `src/model/stats.ts` | Statistics for a time range |
| `src/components/` | Charts: period chart (Chart.js), heatmaps, small bar charts |
| `src/i18n/en.json` | Strings, under `plugins.printStats.*` |

## Licence

GPL-3.0-or-later
