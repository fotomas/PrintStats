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
// and shows "Page not found". Now that the route exists, have the router read the address again: it listens
// to popstate. (DWC's router itself can't be imported here: the separate plugin build can't resolve it.)
if (location.pathname.endsWith(ROUTE_PATH)) {
	window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
}

function onPluginUnloaded(id: string): void {
	if (id === PLUGIN_ID) {
		unregisterRoute(ROUTE_PATH);
		Events.off("dwcPluginUnloaded", onPluginUnloaded);
	}
}
Events.on("dwcPluginUnloaded", onPluginUnloaded);
