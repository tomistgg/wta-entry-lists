import { createEntryJob, advanceEntryJob } from "./entry-collector.mjs";
import { previousEntryModels, withEntryHistory, withLegacyHistory } from "./entry-history.mjs";

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

async function includeLegacyHistory(db, state) {
    const snapshot = state.snapshot;
    if (!snapshot?.models.length) return state;
    const rows = await db.prepare("SELECT tournament_id, week, rows_json FROM entry_legacy_history " +
        "WHERE (tournament_id, week) IN (SELECT json_extract(value, '$.id'), json_extract(value, '$.week') FROM json_each(?))")
        .bind(JSON.stringify(snapshot.models.map(({ id, week }) => ({ id, week })))).all();
    const legacy = new Map(rows.results.map(row => [row.tournament_id + ":" + row.week, JSON.parse(row.rows_json)]));
    return { ...state, snapshot: { ...snapshot, models: snapshot.models.map(model =>
        withLegacyHistory(model, legacy.get(model.id + ":" + model.week) || [], snapshot.saved_at)) } };
}

export async function saveEntrySnapshot(db, snapshot, token) {
    const keys = JSON.stringify(snapshot.models.map(({ id, week }) => ({ id, week })));
    // Retired editions are deleted in the same transaction that publishes their replacement.
    await db.batch([
        db.prepare("DELETE FROM entry_legacy_history WHERE (tournament_id, week) NOT IN " +
            "(SELECT json_extract(value, '$.id'), json_extract(value, '$.week') FROM json_each(?)) " +
            "AND EXISTS (SELECT 1 FROM entry_list_state WHERE id = 1 AND lease_token = ?)").bind(keys, token),
        db.prepare("UPDATE entry_list_state SET snapshot = ?, next_refresh_at = ?, job = NULL, " +
        "job_expires_at = 0, lease_token = NULL, lease_until = 0, error = NULL WHERE id = 1 AND lease_token = ?")
            .bind(storedJSON(snapshot), Date.parse(snapshot.saved_at) + COOLDOWN, token),
    ]);
}

export async function pruneExpiredEntryData(db, now = Date.now()) {
    const row = await readState(db);
    if (row.lease_until > now) return row;
    const window = createEntryJob(now);
    const snapshot = row.snapshot ? JSON.parse(row.snapshot) : null;
    if (snapshot) {
        snapshot.models = snapshot.models.filter(model => model.week >= window.window_start && model.week < window.window_end);
        snapshot.window_start = window.window_start;
        snapshot.window_end = window.window_end;
        delete snapshot.hidden_models;
    }
    const job = row.job ? JSON.parse(row.job) : null;
    const keepJob = job && row.job_expires_at > now && job.window_start === window.window_start;
    const keys = JSON.stringify(snapshot?.models.map(({ id, week }) => ({ id, week })) || []);
    const guard = "EXISTS (SELECT 1 FROM entry_list_state WHERE id = 1 AND lease_until <= ? AND snapshot IS ? AND job IS ?)";
    await db.batch([
        db.prepare("DELETE FROM entry_legacy_history WHERE (week < ? OR week >= ? " +
            "OR (tournament_id, week) NOT IN (SELECT json_extract(value, '$.id'), json_extract(value, '$.week') FROM json_each(?)) " +
            ") AND " + guard).bind(window.window_start, window.window_end,
            keys, now, row.snapshot, row.job),
        db.prepare("DELETE FROM entry_ranking_cache WHERE expires_at <= ? AND " + guard)
            .bind(now, now, row.snapshot, row.job),
        db.prepare("UPDATE entry_list_state SET snapshot = ?, job = ?, job_expires_at = ?, lease_token = NULL, lease_until = 0 " +
            "WHERE id = 1 AND lease_until <= ? AND snapshot IS ? AND job IS ?")
            .bind(snapshot ? storedJSON(snapshot) : null, keepJob ? row.job : null, keepJob ? row.job_expires_at : 0,
                now, row.snapshot, row.job),
    ]);
    return readState(db);
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
    const saved = new Map(previousEntryModels(previous).map(model => [model.id + ":" + model.week, model]));
    return models.map(model => {
        const old = saved.get(model.id + ":" + model.week);
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
            const models = withEntryHistory(retainPreviousMain(result.models, previous), previous, completedAt);
            const snapshot = { schema_version: 1, fetched_at: result.job.started_at,
                saved_at: new Date(completedAt).toISOString(), window_start: result.job.window_start,
                window_end: result.job.window_end, models };
            await saveEntrySnapshot(db, snapshot, token);
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
    // Cached clients require numeric player IDs; imported date-only history is opt-in.
    const responseState = state => new URL(request.url).searchParams.get("history") === "1"
        ? includeLegacyHistory(env.ENTRY_LISTS_DB, state) : state;
    try {
        if (request.method === "GET") return json(await responseState(publicState(await readState(env.ENTRY_LISTS_DB))));
        const result = await advanceStoredRefresh(env.ENTRY_LISTS_DB);
        return json(await responseState(result.state),
            result.failed ? 502 : result.state.refreshing ? 202 : 200);
    } catch {
        return json({ error: "Shared entry-list storage is unavailable. Check the D1 binding and schema." }, 503);
    }
}

export async function scheduledEntryRefresh(env) {
    if (!env.ENTRY_LISTS_DB) return;
    try {
        const row = await pruneExpiredEntryData(env.ENTRY_LISTS_DB);
        const snapshot = row.snapshot ? JSON.parse(row.snapshot) : null;
        if (row.job || (!snapshot || createEntryJob(Date.parse(snapshot.fetched_at)).window_start !== createEntryJob().window_start ||
            Date.now() - Date.parse(snapshot.saved_at) >= AUTO_REFRESH)) {
            if (row.next_refresh_at <= Date.now() || row.job) await advanceStoredRefresh(env.ENTRY_LISTS_DB);
        }
    } catch {
        console.error("Scheduled entry-list storage is unavailable; check the D1 binding and schema.");
    }
}
