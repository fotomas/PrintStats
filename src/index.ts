/**
 * Print Stats - entry point.
 * Adds Plugins -> Print Stats, a dashboard of statistics from the RRF event log in 0:/sys. The parsed log
 * is cached in 0:/sys/printstats-cache.json (see usePrintStats.ts).
 */
import { registerPluginMessages, registerRoute, unregisterRoute } from "@/plugins";
import { useCacheStore } from "@/stores/cache";
import Events from "@/utils/events";

import en from "./i18n/en.json";
import { PLUGIN_ID } from "./id";
import PrintStatsPage from "./PrintStatsPage.vue";

const ROUTE_PATH = "/Plugins/PrintStats";

// strings live under plugins.printStats.*
registerPluginMessages("printStats", { en });

// last used log file and time range, remembered in the browser
const cacheStore = useCacheStore();
cacheStore.registerPluginData(PLUGIN_ID, "logFile", "");
cacheStore.registerPluginData(PLUGIN_ID, "range", "all");

registerRoute(PrintStatsPage, {
	Plugins: {
		PrintStats: {
			icon: "mdi-chart-areaspline",
			caption: "plugins.printStats.menuCaption",
			path: ROUTE_PATH,
		},
	},
});

function onPluginUnloaded(id: string): void {
	if (id === PLUGIN_ID) {
		unregisterRoute(ROUTE_PATH);
		Events.off("dwcPluginUnloaded", onPluginUnloaded);
	}
}
Events.on("dwcPluginUnloaded", onPluginUnloaded);
