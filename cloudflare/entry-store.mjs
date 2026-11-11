import { createEntryJob, advanceEntryJob } from "./entry-collector.mjs";

const COOLDOWN = 120000;
const LEASE = 90000;
const JOB_LIFETIME = 900000;
const ERROR_BACKOFF = 15000;
const AUTO_REFRESH = 1800000;
const MAX_JSON_BYTES = 1500000;

function storedJSON(value) {
    const json = JSON.stringify(value);
    if (new TextEncoder().encode(json).length > MAX_JSON_BYTES) throw new Error("Entry-list data exceeds the storage limit.");
    return json;
}

function publicState(row, now = Date.now()) {
    const snapshot = row.snapshot ? JSON.parse(row.snapshot) : null;
    const job = row.job && row.job_expires_at > now ? JSON.parse(row.job) : null;
    return {
        snapshot,
        refreshing: !!job || row.lease_until > now,
        next_refresh_at: row.next_refresh_at,
        progress: job?.progress || (row.lease_until > now ? "Starting shared refresh…" : ""),
        error: row.error || null,
    };
}

async function readState(db) {
    const row = await db.prepare("SELECT * FROM entry_list_state WHERE id = 1").first();
    if (!row) throw new Error("Entry-list schema has not been initialized.");
    return row;
}

async function wtaText(path, params = {}) {
    const api = path.startsWith("/api/");
    const allowed = api
        ? /^\/api\/tennis\/(tournaments\/?|players\/ranked)$/.test(path)
        : /^\/site\/tournaments\/\d+\/[a-z0-9-]+\/\d{4}\/player-list$/i.test(path);
    if (!allowed) throw new Error("Unknown collection source.");
    const url = new URL(api ? "https://api.wtatennis.com" : "https://www.wtatennis.com");
    url.pathname = path.slice(api ? 4 : 5);
    url.search = new URLSearchParams(params);
    const response = await fetch(url, {
        headers: { Accept: api ? "application/json" : "text/html", account: "wta",
            Origin: "https://www.wtatennis.com", Referer: "https://www.wtatennis.com/" },
        redirect: "manual", signal: AbortSignal.timeout(12000), cache: "no-store",
    });
    if (!response.ok) throw new Error("WTA returned an unsuccessful collection response.");
    const bytes = await response.arrayBuffer();
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return new TextDecoder("windows-1252").decode(bytes); }
}

function collectionIO(db) {
    return {
        fetchJSON: async (path, params) => JSON.parse(await wtaText(path, params)),
        fetchHTML: path => wtaText(path),
        async loadRankings(date) {
            const cached = await db.prepare("SELECT rows_json FROM entry_ranking_cache WHERE ranking_date = ? AND expires_at > ?")
                .bind(date, Date.now()).first();
            return cached ? JSON.parse(cached.rows_json) : null;
        },
        async saveRankings(date, rows) {
            await db.prepare("INSERT INTO entry_ranking_cache (ranking_date, rows_json, expires_at) VALUES (?, ?, ?) " +
                "ON CONFLICT(ranking_date) DO UPDATE SET rows_json = excluded.rows_json, expires_at = excluded.expires_at")
                .bind(date, storedJSON(rows), Date.now() + 86400000).run();
        },
    };
}

export function retainPreviousMain(models, previous) {
    const saved = new Map((previous?.models || []).map(model => [model.id, model]));
    return models.map(model => {
        const old = saved.get(model.id);
        if (!model.main.length && model.qualifying.length && old?.main.length && old.week === model.week) {
            return { ...model, main: old.main, main_retained: true };
        }
        return model;
    });
}

function validateCompleteModels(models, job) {
    if (!Array.isArray(models)) throw new Error("Incomplete entry-list snapshot.");
    const ids = new Set();
    for (const model of models) {
        if (typeof model.id !== "string" || !model.id || ids.has(model.id) ||
            model.week < job.window_start || model.week >= job.window_end ||
            !Array.isArray(model.main) || !Array.isArray(model.qualifying)) {
            throw new Error("Invalid entry-list snapshot.");
        }
        ids.add(model.id);
    }
}

async function advanceStoredRefresh(db) {
    const now = Date.now();
    const token = crypto.randomUUID();
    // A conditional UPDATE is the shared lock: two visitors cannot both own the same step.
    const claimed = await db.prepare("UPDATE entry_list_state SET lease_token = ?, lease_until = ? " +
        "WHERE id = 1 AND lease_until <= ? AND (job IS NOT NULL OR next_refresh_at <= ?) RETURNING *")
        .bind(token, now + LEASE, now, now).first();
    if (!claimed) return { state: publicState(await readState(db)), failed: false };
    try {
        const fresh = createEntryJob(now);
        let job = claimed.job && claimed.job_expires_at > now ? JSON.parse(claimed.job) : fresh;
        if (job.window_start !== fresh.window_start) job = fresh;
        const result = await advanceEntryJob(job, collectionIO(db));
        if (result.done) {
            validateCompleteModels(result.models, result.job);
            const completedAt = Date.now();
            const previous = claimed.snapshot ? JSON.parse(claimed.snapshot) : null;
            const snapshot = { schema_version: 1, fetched_at: result.job.started_at,
                saved_at: new Date(completedAt).toISOString(), window_start: result.job.window_start,
                window_end: result.job.window_end, models: retainPreviousMain(result.models, previous) };
            await db.prepare("UPDATE entry_list_state SET snapshot = ?, next_refresh_at = ?, job = NULL, " +
                "job_expires_at = 0, lease_token = NULL, lease_until = 0, error = NULL WHERE id = 1 AND lease_token = ?")
                .bind(storedJSON(snapshot), completedAt + COOLDOWN, token).run();
            await db.prepare("DELETE FROM entry_ranking_cache WHERE expires_at <= ?").bind(completedAt).run().catch(() => {});
        } else {
            await db.prepare("UPDATE entry_list_state SET job = ?, job_expires_at = ?, lease_token = NULL, " +
                "lease_until = 0, error = NULL WHERE id = 1 AND lease_token = ?")
                .bind(storedJSON(result.job), Date.now() + JOB_LIFETIME, token).run();
        }
        return { state: publicState(await readState(db)), failed: false };
    } catch {
        await db.prepare("UPDATE entry_list_state SET job = NULL, job_expires_at = 0, lease_token = NULL, " +
            "lease_until = 0, next_refresh_at = ?, error = ? WHERE id = 1 AND lease_token = ?")
            .bind(Date.now() + ERROR_BACKOFF, "WTA could not be refreshed. The last saved lists are still available.", token).run();
        return { state: publicState(await readState(db)), failed: true };
    }
}

export async function entryListResponse(request, env, headers) {
    const json = (data, status = 200) => Response.json(data, { status, headers });
    if (!env.ENTRY_LISTS_DB) return json({ error: "Shared saving is not configured. Add the ENTRY_LISTS_DB D1 binding." }, 503);
    try {
        if (request.method === "GET") return json(publicState(await readState(env.ENTRY_LISTS_DB)));
        const result = await advanceStoredRefresh(env.ENTRY_LISTS_DB);
        return json(result.state, result.failed ? 502 : result.state.refreshing ? 202 : 200);
    } catch {
        return json({ error: "Shared entry-list storage is unavailable. Check the D1 binding and schema." }, 503);
    }
}

export async function scheduledEntryRefresh(env) {
    if (!env.ENTRY_LISTS_DB) return;
    try {
        const row = await readState(env.ENTRY_LISTS_DB);
        const snapshot = row.snapshot ? JSON.parse(row.snapshot) : null;
        if (row.job || (!snapshot || Date.now() - Date.parse(snapshot.saved_at) >= AUTO_REFRESH)) {
            if (row.next_refresh_at <= Date.now() || row.job) await advanceStoredRefresh(env.ENTRY_LISTS_DB);
        }
    } catch {
        console.error("Scheduled entry-list storage is unavailable; check the D1 binding and schema.");
    }
}
