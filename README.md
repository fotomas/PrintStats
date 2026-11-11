# Print Stats

A Duet Web Control 3.7 plugin that turns the RRF event log into a statistics dashboard
(**Plugins → Print Stats**), for all time or the last year, month or week:

- prints started, finished, cancelled and interrupted, print time, success rate
- prints and print time per month or day
- success by print length, when prints get cancelled, slicer estimate vs. actual time
- a 12-month calendar heatmap and a weekday × hour heatmap
- records: longest print, busiest day, streaks, breaks, busiest month
- materials, layer heights and most printed parts (from slicer file names)
- milestones, firmware history, bed leveling over time, heater faults, power-ups

### Caching

Reading a large event log over WiFi takes a while, so the parsed log is saved to
`0:/sys/printstats-cache.json` (about 250 kB for three years). The page shows the cache at once, then checks
the log's size and date and re-reads it in the background when it changed. It also checks after a print ends.
**Refresh** re-reads the log now. Deleting the cache file is safe; it is rebuilt.

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
| `src/model/logParser.ts` | Event log → jobs and machine events (the cache format) |
| `src/model/stats.ts` | Statistics for a time range |
| `src/components/` | Charts: period chart (Chart.js), heatmaps, small bar charts |
| `src/i18n/en.json` | Strings, under `plugins.printStats.*` |

## Licence

GPL-3.0-or-later
