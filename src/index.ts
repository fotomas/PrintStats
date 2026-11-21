/**
 * Print Stats - entry point.
 * Adds Plugins -> Print Stats, a dashboard of statistics from the RRF event log in 0:/sys. The parsed log
 * is cached in 0:/sys/printstats-cache.json (see usePrintStats.ts).
 */
import { registerPluginMessages, registerRoute, unregisterRoute } from "@/plugins";
import router from "@/router";
import { useCacheStore } from "@/stores/cache";
import Events from "@/utils/events";

import en from "./i18n/en.json";
import { PLUGIN_ID } from "./id";
import PrintStatsPage from "./PrintStatsPage.vue";

const ROUTE_PATH = "/Plugins/PrintStats";

// strings live under plugins.printStats.*
registerPluginMessages("printStats", { en });

// last used time range, remembered in the browser (the log file comes from the printer)
const cacheStore = useCacheStore();
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

// After a browser reload on this page, DWC resolves the address before the plugin has registered its route
// and shows "Page not found". Now that the route exists, open the page again.
if (router.currentRoute.value.path === ROUTE_PATH) {
	router.replace({ path: ROUTE_PATH, force: true }).catch(() => undefined);
}

function onPluginUnloaded(id: string): void {
	if (id === PLUGIN_ID) {
		unregisterRoute(ROUTE_PATH);
		Events.off("dwcPluginUnloaded", onPluginUnloaded);
	}
}
Events.on("dwcPluginUnloaded", onPluginUnloaded);
