import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { applyImportPlan } from "./prepare-shared-import.mjs";
import { createSharedIO } from "./shared-io.mjs";
import { sharedDataResponse, scheduledSharedRefresh } from "./shared-store.mjs";

let plan;
try {
    plan = JSON.parse(await readFile(".wrangler/shared-import/import-plan.json", "utf8"));
} catch {
    console.error("Prepare the local baseline first; see cloudflare/SHARED_DATA.md, Local preview.");
    process.exit(1);
}

async function relayWta(url, options = {}) {
    url = new URL(url);
    const api = url.origin === "https://api.wtatennis.com";
    const entry = url.origin === "https://www.wtatennis.com" &&
        /^\/tournaments\/\d+\/[a-z0-9-]+\/\d{4}\/player-list\/?$/i.test(url.pathname);
    if (!api && !entry) throw new Error("Unknown WTA source.");
    const relay = new URL("https://tennis-wta-api.schiter-tomas.workers.dev");
    relay.pathname = (api ? "/api" : "/site") + url.pathname;
    relay.search = url.search;
    return fetch(relay, { ...options, method: "GET", headers: {
        Origin: "https://tomistgg.github.io", Accept: api ? "application/json" : "text/html",
    } });
}

const mf = new Miniflare({ host: "127.0.0.1", port: 8787, scriptPath: "cloudflare/worker.mjs",
    modules: true, compatibilityDate: "2026-07-30", d1Databases: { ENTRY_LISTS_DB: "haute-local-preview" },
    outboundService: request => relayWta(request.url) });
let timer;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
    clearInterval(timer); await mf.dispose(); process.exit(0);
});
try {
    const db = await mf.getD1Database("ENTRY_LISTS_DB");
    for (const name of ["schema.sql", "shared-schema.sql"]) {
        const sql = await readFile("cloudflare/" + name, "utf8");
        for (const statement of sql.split(";").filter(part => part.trim())) await db.prepare(statement).run();
    }
    await applyImportPlan(db, plan);
    const savedResponse = await fetch("https://tennis-wta-api.schiter-tomas.workers.dev/entry-lists?history=1", {
        headers: { Origin: "https://tomistgg.github.io" }, signal: AbortSignal.timeout(30000),
    });
    if (!savedResponse.ok) throw new Error("The saved entry lists could not be loaded.");
    const saved = await savedResponse.json();
    if (!saved.snapshot || !Array.isArray(saved.snapshot.models)) throw new Error("Invalid saved entry lists.");
    await db.prepare("UPDATE entry_list_state SET snapshot = ?, next_refresh_at = 0 WHERE id = 1")
        .bind(JSON.stringify(saved.snapshot)).run();
    console.log("Copied " + saved.snapshot.models.length + " saved entry lists into local D1.");
    console.log("Local backend ready: " + await mf.ready);
    const ioFactory = localDB => createSharedIO(localDB, { fetch: relayWta });
    for (const path of ["/data/calendar/refresh", "/data/results/refresh"]) {
        for (let step = 0; step < 30; step++) {
            const response = await sharedDataResponse(new Request("https://example.workers.dev" + path,
                { method: "POST", headers: { Origin: "https://tomistgg.github.io" } }), { ENTRY_LISTS_DB: db }, {}, ioFactory);
            const state = await response.json();
            console.log(path, response.status, state.progress || state.error || "complete");
            if (response.status !== 202) break;
        }
    }
    console.log("Preview feeds prepared. All database writes are local.");
    let busy = false;
    timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try { await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, ioFactory); }
        finally { busy = false; }
    }, 60000);
} catch (error) {
    console.error(error);
    await mf.dispose();
    process.exitCode = 1;
}
