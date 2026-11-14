import { acceptedWtargManifest, validWtargManifest, validateWtargResourceBackings } from "./wtarg-store.mjs";
import { applyDelta, rollbackDelta, deltaJournal, deltaSummary } from "./wtarg-delta.mjs";
import { payloadBytes, storageCharge, wtargStorage, requireWtargStorage } from "./wtarg-storage.mjs";
import { RANKING_SOURCE_FILES, rankingSourceBlob, validRankingAssetRef, validateRankingAssets,
    validateRankingWeekIndex } from "./wtarg-ranking-assets.mjs";

const JOB = "wtarg:collector:global";
const CONTROL = "wtarg:collector";
const COOLDOWN = 120000;
const INTERVAL = 2 * 60 * 60 * 1000;
const LEASE = 180000;
const BODY_LIMIT = 1400000;
const PART_LIMIT = 1000000;
export const DEFAULT_COLLECTOR_WRITE_BUDGET = 60000;
const HASH = /^[a-f0-9]{64}$/;
const JOB_ID = /^[a-f0-9-]{36}$/;
const encoder = new TextEncoder();
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const iso = now => new Date(now).toISOString();
const bytes = value => encoder.encode(value).length;
const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",
    typeof value === "string" ? encoder.encode(value) : value)), v => v.toString(16).padStart(2, "0")).join("");
const timestamp = value => typeof value === "string" && /T.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const day = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const safeMessage = value => typeof value === "string" ? value.replace(/[\x00-\x1f]/g, " ").slice(0, 240) : "";

const FILES = new Set(["player_aliases_wta_itf.json", "wta_rankings_83_99.csv", "wta_rankings_00_09.csv",
    "wta_rankings_10_19.csv", "wta_rankings_20_29.csv", "wta_ranking_refresh_status.json", "itf_rankings_cache.json",
    "wta_matches_arg.csv", "itf_matches_arg.csv", "gs_matches_arg.csv", "bjkc_matches_arg.csv", "og_matches_arg.csv",
    "united_cup_matches_arg.csv", "manually_added_matches.csv", "calendar_snapshot.json", "wta_full_calendar_cache.json",
    "itf_calendar_cache.json", "wta_pre_2016.json", "wta_missing_tournaments.json", "current_gs.json", "olympic_games.json",
    "manual_calendar_entries.json", "tournament_snapshot.json", "calendar_change_history.json", "entry_lists_cache.json",
    "entry_withdrawals.json", "itf_acceptance_state.json", "itf_event_filters_cache.json", "draws_store_cache.json",
    "draws_snapshot.json", "itf_drawsheets_cache.json", "itf_wtn_cache.json", "itf_wtn_entry_lists_seen.json",
    "wtn_singles_draw_history.json", "main_draw_wtn_gm.json", "tstrength_cache.json", "tournament_draw_sizes.json",
    "itf_player_details.json", "ao27_md_race.json", "ao27_q_race.json", "points_distribution.json",
    "points_distribution_history.json", "captains.csv", "national_team_order.csv", "cache_state.json",
    "draw_fetch_errors.json", "itf_blocked_responses.json", "main_draw_wtn_errors.json"]);
const PROTECTED = new Set(["manually_added_matches.csv", "current_gs.json", "olympic_games.json", "manual_calendar_entries.json",
    "ao27_md_race.json", "ao27_q_race.json", "points_distribution.json", "points_distribution_history.json", "captains.csv",
    "national_team_order.csv"]);

function fail(message, status = 400) { const error = new Error(message); error.status = status; throw error; }
function json(value) {
    const text = JSON.stringify(value);
    if (bytes(text) > 1900000) fail("Collector payload exceeds its storage limit.");
    return text;
}
const snapshot = (db, kind, scope = "global") => db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind=? AND scope=?")
    .bind(kind, scope).first();
const parsed = row => row ? JSON.parse(row.payload_json) : null;
const jobRow = db => db.prepare("SELECT * FROM wtarg_jobs WHERE job_key=?").bind(JOB).first();
const gateRow = db => db.prepare("SELECT * FROM wtarg_source_state WHERE source=? AND scope='global'").bind(CONTROL).first();
const fence = "EXISTS (SELECT 1 FROM wtarg_jobs WHERE job_key='wtarg:collector:global' AND lease_token=? " +
    "AND lease_until>? AND job_expires_at>? AND json_extract(payload_json,'$.jobId')=?)";
const fenceValues = (body, now) => [body.leaseToken, now, now, body.jobId];

async function journalState(db, jobId) {
    const entries = jobId ? await deltaJournal(db, jobId) : [];
    return { entries, batches: entries.length, remaining: entries.length };
}

function put(db, kind, scope, value, body, now, expiry = null) {
    return db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) SELECT ?,?,?,?,? WHERE " +
        fence + " ON CONFLICT(kind,scope) DO UPDATE SET payload_json=excluded.payload_json, fetched_at=excluded.fetched_at, " +
        "expires_at=excluded.expires_at WHERE " + fence).bind(kind, scope, json(value), iso(now), expiry,
        ...fenceValues(body, now), ...fenceValues(body, now));
}

async function immutablePut(db, kind, scope, value, body, now) {
    const existing = await snapshot(db, kind, scope);
    const text = json(value);
    if (existing) {
        if (existing.payload_json !== text) fail("Immutable collector content already has different bytes.", 409);
        return false;
    }
    await db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) SELECT ?,?,?,?,NULL WHERE " +
        fence + " ON CONFLICT(kind,scope) DO NOTHING").bind(kind, scope, text, iso(now), ...fenceValues(body, now)).run();
    const saved = await snapshot(db, kind, scope);
    if (!saved || saved.payload_json !== text) fail("The collector lease changed while saving content.", 409);
    return true;
}

export function getWtargCollectorRoute(pathname) {
    if (pathname === "/wtarg/v1/status") return { operation: "status", method: "GET", public: true };
    if (pathname === "/wtarg/v1/refresh") return { operation: "refresh", method: "POST", public: true };
    const match = /^\/wtarg\/internal\/v1\/(claim|heartbeat|preflight|storage|stage|part|delta|rollback|commit|finish|pace|wtn|wtn-page|gc|source(?:\/blobs\/([a-f0-9]{64}))?)$/.exec(pathname);
    if (!match) return null;
    return { operation: match[1].startsWith("source") ? "source" : match[1], blob: match[2] || null, public: false,
        method: match[1] === "storage" ? "GET" : match[1].startsWith("source") ? "GET, POST" : "POST" };
}

async function readBody(request) {
    if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) fail("Expected a JSON collector request.", 415);
    if (Number(request.headers.get("Content-Length")) > BODY_LIMIT) fail("Collector request is too large.", 413);
    const reader = request.body?.getReader();
    if (!reader) fail("A collector JSON body is required.");
    const chunks = []; let size = 0;
    while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > BODY_LIMIT) { await reader.cancel(); fail("Collector request is too large.", 413); }
        chunks.push(value);
    }
    const raw = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    try { const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
        if (!object(body)) fail("Expected a collector object."); return body;
    } catch { fail("Invalid collector JSON."); }
}

async function authorized(request, env) {
    if (request.headers.has("Origin")) fail("Collector credentials are not accepted from a browser origin.", 403);
    if (typeof env.WTARG_COLLECTOR_TOKEN !== "string" || env.WTARG_COLLECTOR_TOKEN.length < 32) fail("Collector access is not configured.", 503);
    const bearer = request.headers.get("Authorization") || "";
    if (!bearer.startsWith("Bearer ") || await hash(bearer.slice(7)) !== await hash(env.WTARG_COLLECTOR_TOKEN)) {
        fail("Collector authentication failed.", 401);
    }
}

async function currentSource(db) {
    const pointer = parsed(await snapshot(db, "wtarg:source_current"));
    if (!pointer || !HASH.test(pointer.sourceVersion)) return null;
    const manifest = parsed(await snapshot(db, "wtarg:source_manifest", pointer.checkpointId || pointer.sourceVersion));
    try { return manifest && manifest.sourceVersion === pointer.sourceVersion ? await validateSource(manifest) : null; }
    catch { return null; }
}

async function statusState(db, env, now) {
    const [row, gate, current, source] = await Promise.all([jobRow(db), gateRow(db), snapshot(db, "wtarg:read_current"), currentSource(db)]);
    const state = parsed(row) || {};
    const enabled = env.WTARG_COLLECTION_ENABLED === "true" && typeof env.WTARG_COLLECTOR_TOKEN === "string" &&
        env.WTARG_COLLECTOR_TOKEN.length >= 32 && !!source;
    const active = row?.status === "running" && row.lease_until > now && row.job_expires_at > now;
    let phase = state.phase || "idle";
    if (row?.status === "running" && !active) phase = "failed";
    if (phase === "repairing") phase = "publishing";
    return { enabled, jobId: state.jobId || null, state: phase, progress: safeMessage(state.progress),
        nextRefreshAt: state.nextRefreshAt || 0, nextCollectionAt: gate?.not_before || 0,
        currentReleaseId: parsed(current)?.releaseId || null, lastSuccessAt: row?.last_success_at || null,
        serverNow: now, error: phase === "failed" && row?.status === "running"
            ? "The collector stopped before finishing. Its previous saved data is still available." : row?.error || null };
}

async function initialize(db) {
    await db.batch([
        db.prepare("INSERT OR IGNORE INTO wtarg_jobs(job_key,source,kind,scope,payload_json) VALUES(?,?,?,?,?)")
            .bind(JOB, "wtarg", "collector_cycle", "global", "{}"),
        db.prepare("INSERT OR IGNORE INTO wtarg_source_state(source,scope) VALUES(?,'global')").bind(CONTROL),
    ]);
}

async function activeJob(db, body, now, allowRepair = false) {
    if (!JOB_ID.test(body.jobId || "") || !JOB_ID.test(body.leaseToken || "")) fail("Invalid collector job identity.");
    const row = await jobRow(db), state = parsed(row);
    if (!row || state?.jobId !== body.jobId || row.lease_token !== body.leaseToken || row.lease_until <= now ||
        row.job_expires_at <= now || row.status !== "running") fail("Collector lease expired or changed.", 409);
    if (!allowRepair && state.phase === "repairing") fail("The previous normalized update must be restored before collecting.", 409);
    const source = await currentSource(db);
    if (source?.sourceVersion !== state.baseSourceVersion) fail("The saved collector source changed.", 409);
    return { row, state, source };
}

async function reserveWrites(db, body, count, env, now) {
    const limit = Number(env.WTARG_DAILY_WRITE_BUDGET || DEFAULT_COLLECTOR_WRITE_BUDGET);
    if (!Number.isInteger(limit) || limit < 1000 || limit > 60000) fail("Collector write budget is not configured safely.", 503);
    const scope = "write-budget:" + iso(now).slice(0, 10);
    await db.prepare("INSERT OR IGNORE INTO wtarg_source_state(source,scope,payload_json) SELECT ?,?,? WHERE " + fence)
        .bind(CONTROL, scope, '{"reserved":0}', ...fenceValues(body, now)).run();
    const reserved = await db.prepare("UPDATE wtarg_source_state SET payload_json=json_set(payload_json,'$.reserved'," +
        "COALESCE(json_extract(payload_json,'$.reserved'),0)+?) WHERE source=? AND scope=? AND " +
        "COALESCE(json_extract(payload_json,'$.reserved'),0)+?<=? AND " + fence + " RETURNING payload_json")
        .bind(count, CONTROL, scope, count, limit, ...fenceValues(body, now)).first();
    if (!reserved) fail("The collector's daily write reserve is exhausted; saved data was kept.", 429);
}

async function requestRefresh(db, env, now) {
    if (!(await statusState(db, env, now)).enabled) fail("Collector refresh is not enabled or its approved baseline is missing.", 503);
    await initialize(db);
    const row = await jobRow(db), state = parsed(row) || {};
    if ((state.nextRefreshAt || 0) > now) return { status: 429, state: await statusState(db, env, now) };
    if (row.status === "running" && row.lease_until > now || row.status === "queued" && state.jobId) {
        await db.prepare("UPDATE wtarg_jobs SET payload_json=json_set(payload_json,'$.nextRefreshAt',?) WHERE job_key=? " +
            "AND COALESCE(json_extract(payload_json,'$.nextRefreshAt'),0)<=?").bind(now + COOLDOWN, JOB, now).run();
        return { status: 202, state: await statusState(db, env, now) };
    }
    const pending = await journalState(db, state.jobId);
    const keepOld = pending.remaining > 0;
    const next = { ...(keepOld ? state : {}), jobId: keepOld ? state.jobId : crypto.randomUUID(), phase: "queued",
        progress: keepOld ? "Waiting to restore the previous interrupted update." : "Queued for the scheduled collector.",
        nextRefreshAt: now + COOLDOWN };
    await db.prepare("UPDATE wtarg_jobs SET status='queued',due_at=?,payload_json=?,error=NULL WHERE job_key=? AND payload_json=? AND lease_until<=?")
        .bind(now, json(next), JOB, row.payload_json, now).run();
    return { status: 202, state: await statusState(db, env, now) };
}

async function claim(db, env, now) {
    if (!(await statusState(db, env, now)).enabled) fail("An approved source checkpoint and enabled collector are required.", 409);
    await initialize(db);
    const [row, gate, source, current, sourcePointer] = await Promise.all([jobRow(db), gateRow(db), currentSource(db),
        snapshot(db, "wtarg:read_current"), snapshot(db, "wtarg:source_current")]);
    const old = parsed(row) || {};
    if (row.lease_until > now) return { jobId: null, nextCollectionAt: gate.not_before, sourceManifest: null };
    const pending = await journalState(db, old.jobId);
    const repairing = pending.remaining > 0;
    if (!repairing && gate.not_before > now) return { jobId: null, nextCollectionAt: gate.not_before, sourceManifest: null };
    const jobId = repairing ? old.jobId : row.status === "queued" && old.jobId ? old.jobId : crypto.randomUUID();
    const token = crypto.randomUUID();
    const next = repairing ? { ...old, phase: "repairing", progress: "Restoring an interrupted normalized update." }
        : { jobId, phase: "collecting", progress: "Starting the scheduled collector.", nextRefreshAt: old.nextRefreshAt || 0,
            baseSourceVersion: source.sourceVersion,
            baseCheckpointId: parsed(sourcePointer)?.checkpointId || source.sourceVersion,
            baseReleaseId: parsed(current)?.releaseId || null };
    const sourceGuard = repairing ? "1" : "EXISTS (SELECT 1 FROM wtarg_source_state WHERE source='wtarg:collector' AND scope='global' AND not_before<=?)";
    const statements = [db.prepare("UPDATE wtarg_jobs SET status='running',lease_token=?,lease_until=?,job_expires_at=?," +
        "attempt_count=attempt_count+1,payload_json=?,error=NULL WHERE job_key=? AND payload_json=? AND lease_until<=? AND " + sourceGuard)
        .bind(token, now + LEASE, now + INTERVAL, json(next), JOB, row.payload_json, now, ...(repairing ? [] : [now]))];
    if (!repairing) statements.push(db.prepare("UPDATE wtarg_source_state SET not_before=?,last_checked_at=? WHERE source=? AND scope='global' " +
        "AND EXISTS(SELECT 1 FROM wtarg_jobs WHERE job_key=? AND lease_token=?)").bind(now + INTERVAL, iso(now), CONTROL, JOB, token));
    await db.batch(statements);
    const claimed = await jobRow(db);
    if (claimed.lease_token !== token) return { jobId: null, nextCollectionAt: (await gateRow(db)).not_before, sourceManifest: null };
    return { jobId, leaseToken: token, leaseUntil: now + LEASE, baseSourceVersion: next.baseSourceVersion,
        baseReleaseId: next.baseReleaseId, sourceManifest: source, repairing, nextCollectionAt: repairing ? gate.not_before : now + INTERVAL };
}

async function validateSource(manifest) {
    if (!object(manifest) || manifest.schemaVersion !== 1 || !HASH.test(manifest.sourceVersion) ||
        !/^[a-f0-9]{40}$/.test(manifest.sourceRevision || "") || !Array.isArray(manifest.files) || manifest.files.length !== FILES.size ||
        manifest.normalizedAt !== undefined && !timestamp(manifest.normalizedAt) ||
        manifest.capturedAt !== undefined && !timestamp(manifest.capturedAt) ||
        manifest.gitIdentityHash !== undefined && !HASH.test(manifest.gitIdentityHash) ||
        manifest.rankingAssets !== undefined && !validRankingAssetRef(manifest.rankingAssets) ||
        manifest.identityPatchRevision !== undefined && (!/^[a-f0-9]{40}$/.test(manifest.identityPatchRevision) ||
            manifest.identityPatchRevision !== manifest.sourceRevision) ||
        manifest.canonicalKeyOverrides !== undefined && (!object(manifest.canonicalKeyOverrides) ||
            Object.keys(manifest.canonicalKeyOverrides).length > 10000 || Object.entries(manifest.canonicalKeyOverrides)
                .some(([key, value]) => !key.length || key.length > 200 || /[\x00-\x1f]/.test(key) ||
                    typeof value !== "string" || !value.length || value.length > 200 || /[\x00-\x1f]/.test(value))) ||
        manifest.rankingCheckpointWeeks !== undefined && (!object(manifest.rankingCheckpointWeeks) ||
            Object.keys(manifest.rankingCheckpointWeeks).length > 10000 ||
            Object.entries(manifest.rankingCheckpointWeeks).some(([key, value]) => !day(key) || !HASH.test(value)))) {
        fail("Invalid collector source manifest.");
    }
    const overrides = new Map(Object.entries(manifest.canonicalKeyOverrides || {})), complete = new Set();
    for (const start of overrides.keys()) {
        let current = start; const visited = new Set();
        while (overrides.has(current) && !complete.has(current)) {
            if (visited.has(current)) fail("Canonical key override metadata contains a cycle.");
            visited.add(current); current = overrides.get(current);
        }
        for (const key of visited) complete.add(key);
    }
    const seen = new Set(); let raw = 0, compressed = 0;
    for (const file of manifest.files) {
        if (!object(file) || !FILES.has(file.name) || seen.has(file.name) || !HASH.test(file.rawSha256) || !HASH.test(file.gzipSha256) ||
            file.storage !== undefined && !["d1", "ranking-assets"].includes(file.storage) ||
            file.storage === "ranking-assets" && !RANKING_SOURCE_FILES.has(file.name) ||
            !Number.isInteger(file.rawBytes) || file.rawBytes < 1 || file.rawBytes > 128 * 1024 * 1024 ||
            !Number.isInteger(file.gzipBytes) || file.gzipBytes < 20 || file.gzipBytes > 96 * 1024 * 1024 ||
            !Array.isArray(file.parts) || !file.parts.length || file.parts.length > 1024 ||
            file.parts.some(part => !object(part) || !HASH.test(part.sha256) || !Number.isInteger(part.bytes) || part.bytes < 1 || part.bytes > 196608) ||
            file.parts.reduce((sum, part) => sum + part.bytes, 0) !== file.gzipBytes) fail("Invalid source file descriptor.");
        seen.add(file.name); raw += file.rawBytes; compressed += file.gzipBytes;
    }
    const external = manifest.files.filter(file => file.storage === "ranking-assets");
    if (external.length && (external.length !== RANKING_SOURCE_FILES.size || !validRankingAssetRef(manifest.rankingAssets)) ||
        !external.length && manifest.rankingAssets !== undefined) fail("Ranking recovery files need a complete immutable asset reference.");
    const fingerprints = [...manifest.files].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
        .map(file => ({ name: file.name, bytes: file.rawBytes, sha256: file.rawSha256 }));
    if (raw !== manifest.totalRawBytes || compressed !== manifest.totalGzipBytes || raw > 256 * 1024 * 1024 ||
        compressed > 96 * 1024 * 1024 || await hash(JSON.stringify(fingerprints)) !== manifest.sourceVersion) fail("Source manifest totals or identity do not match.");
    return manifest;
}

async function validateReleasePlan(db, env, body, source, state) {
    if (!validWtargManifest(body.manifest, body.manifest?.releaseId) ||
        Object.values(body.manifest.resources).reduce((total, resource) => total + resource.parts.length, 0) > 2048) {
        fail("Invalid or oversized public release.");
    }
    if (!["bootstrap", "identities", "history", "rankings-latest"].every(name => body.manifest.resources[name])) {
        fail("The public release is missing an existing website section.");
    }
    const sourceManifest = await validateSource(body.sourceManifest);
    if (body.manifest.sourceVersion !== sourceManifest.sourceVersion) fail("Public release and source checkpoint differ.");
    if (sourceManifest.identityPatchRevision && env.WTARG_AUTHORED_REVISION !== sourceManifest.identityPatchRevision) {
        fail("A reviewed identity correction requires approval of its exact Git revision.", 409);
    }
    const oldFiles = new Map(source.files.map(file => [file.name, file.rawSha256]));
    const changedAuthored = sourceManifest.files.some(file => PROTECTED.has(file.name) && oldFiles.get(file.name) !== file.rawSha256);
    if (changedAuthored && env.WTARG_AUTHORED_REVISION !== sourceManifest.sourceRevision) {
        fail("Authored configuration changed; approve its Git revision before publishing collector data.", 409);
    }
    const base = state.baseReleaseId && await acceptedWtargManifest(db, state.baseReleaseId);
    try { await validateRankingAssets(env, body.manifest, sourceManifest); }
    catch { fail("Ranking assets could not be verified against the release plan.", 409); }
    try { validateWtargResourceBackings(db, body.manifest, base); }
    catch { fail("Resource references must match the accepted base release.", 409); }
    return sourceManifest;
}

function deltaBudget(value) {
    if (!object(value) || Object.keys(value).some(key => !["operations", "batches", "bytes"].includes(key)) ||
        ![value.operations, value.batches, value.bytes].every(Number.isSafeInteger) ||
        value.operations < 0 || value.operations > 80000 || value.batches < 0 || value.batches > 10000 ||
        value.bytes < 0 || value.bytes > 24 * 1024 * 1024 ||
        (value.batches === 0 ? value.operations !== 0 || value.bytes !== 0 :
            value.operations < value.batches || value.operations > value.batches * 8 || value.bytes < value.operations)) {
        fail("Invalid normalized storage budget.");
    }
    return value;
}

async function updatePlan(db, body) {
    const plan = parsed(await snapshot(db, "wtarg:collector_preflight", body.jobId));
    if (!plan) fail("Approve the bounded storage plan before saving collector data.", 409);
    return plan;
}

async function storageProjection(db, manifest, sourceManifest, budget) {
    const blobs = [...new Map(sourceManifest.files.filter(file => file.storage !== "ranking-assets")
        .flatMap(file => file.parts).map(part => [part.sha256, part])).values()];
    const saved = await db.prepare("SELECT scope FROM wta_snapshots WHERE kind='wtarg:source_blob' AND scope IN " +
        "(SELECT json_extract(value,'$.sha256') FROM json_each(?))").bind(json(blobs)).all();
    const known = new Set(saved.results.map(row => row.scope));
    let sourceBytes = 0, sourceRows = 0;
    for (const part of blobs) if (!known.has(part.sha256)) {
        sourceBytes += payloadBytes({ sha256: part.sha256, bytes: part.bytes, base64: "" }) + 4 * Math.ceil(part.bytes / 3);
        sourceRows++;
    }
    const parts = [];
    for (const [name, resource] of Object.entries(manifest.resources)) if (resource.storage === "d1" && !resource.d1ReleaseId) {
        resource.parts.forEach((part, index) => {
            if (part.storedBytes !== undefined && part.storedBytes < part.bytes + 11) fail("Invalid stored resource size.");
            parts.push({ scope: `${manifest.releaseId}:${name}:${index}`, ...part });
        });
    }
    const receipts = parts.length ? await db.prepare("SELECT r.scope,length(CAST(p.payload_json AS BLOB)) AS stored_bytes," +
        "length(CAST(r.payload_json AS BLOB)) AS meta_bytes FROM wta_snapshots r LEFT JOIN wta_snapshots p " +
        "ON p.kind='wtarg:read_part' AND p.scope=r.scope WHERE r.kind='wtarg:read_part_meta' AND r.scope IN " +
        "(SELECT json_extract(value,'$.scope') FROM json_each(?))").bind(json(parts)).all() : { results: [] };
    const knownParts = new Map(receipts.results.map(row => [row.scope, row]));
    let publicBytes = 0, publicRows = 0;
    for (const part of parts) {
        const receipt = knownParts.get(part.scope);
        if (!receipt?.stored_bytes) {
            publicBytes += part.storedBytes ?? 6 * part.bytes + 11;
            publicRows++;
        }
        if (!receipt?.meta_bytes) { publicBytes += payloadBytes(part); publicRows++; }
    }
    const normalizedGrowthBytes = Math.ceil(budget.bytes * 1.5) + budget.operations * 8192;
    const metadataGrowthBytes = storageCharge((payloadBytes(manifest) + payloadBytes(sourceManifest) + payloadBytes(budget)) * 3, 12);
    const sourceGrowthBytes = storageCharge(sourceBytes, sourceRows);
    const publicGrowthBytes = storageCharge(publicBytes, publicRows);
    return { sourceGrowthBytes, publicGrowthBytes, normalizedGrowthBytes, metadataGrowthBytes,
        projectedGrowthBytes: sourceGrowthBytes + publicGrowthBytes + normalizedGrowthBytes + metadataGrowthBytes };
}

async function preflight(db, env, body, now) {
    const { state, source } = await activeJob(db, body, now);
    const sourceManifest = await validateReleasePlan(db, env, body, source, state);
    const budget = deltaBudget(body.deltaBudget);
    const core = { manifest: body.manifest, sourceManifest, deltaBudget: budget };
    const old = parsed(await snapshot(db, "wtarg:collector_preflight", body.jobId));
    if (old) {
        if (json({ manifest: old.manifest, sourceManifest: old.sourceManifest, deltaBudget: old.deltaBudget }) !== json(core)) {
            fail("The approved collector storage plan cannot be replaced.", 409);
        }
        return { approved: true, unchanged: true, ...old.projection };
    }
    const cleanup = parsed(await snapshot(db, "wtarg:collector_gc"));
    if (!cleanup?.complete || cleanup.jobId !== body.jobId || cleanup.leaseHash !== await hash(body.leaseToken) ||
        cleanup.readReleaseId !== state.baseReleaseId || cleanup.checkpointId !== state.baseCheckpointId) {
        fail("Complete a guarded cleanup sweep before preparing collector data.", 409);
    }
    if ((await deltaSummary(db, body.jobId)).batches) fail("Recover pending normalized changes before preparing another plan.", 409);
    const projection = await storageProjection(db, body.manifest, sourceManifest, budget);
    const capacity = await requireWtargStorage(db, env, projection.projectedGrowthBytes);
    await reserveWrites(db, body, 4, env, now);
    await immutablePut(db, "wtarg:collector_preflight", body.jobId, { ...core, projection: { ...projection, ...capacity } }, body, now);
    return { approved: true, ...projection, ...capacity };
}

async function stage(db, env, body, now) {
    const { source, state } = await activeJob(db, body, now);
    if (!Number.isInteger(body.expectedBatches) || body.expectedBatches < 0 || body.expectedBatches > 10000 ||
        !Array.isArray(body.deltaHashes) || body.deltaHashes.length !== body.expectedBatches ||
        body.deltaHashes.some(value => !HASH.test(value))) fail("Invalid normalized batch count.");
    const sourceManifest = await validateReleasePlan(db, env, body, source, state);
    const plan = await updatePlan(db, body);
    if (json(body.manifest) !== json(plan.manifest) || json(sourceManifest) !== json(plan.sourceManifest) ||
        body.expectedBatches !== plan.deltaBudget.batches) fail("The staged data differs from its approved storage plan.", 409);
    const value = { manifest: body.manifest, sourceManifest,
        expectedBatches: body.expectedBatches, deltaHashes: body.deltaHashes };
    const existing = await snapshot(db, "wtarg:collector_stage", body.jobId);
    if (existing) {
        if (existing.payload_json !== json(value)) fail("The staged collector data cannot be replaced.", 409);
        return { staged: true, unchanged: true };
    }
    const journal = await journalState(db, body.jobId);
    const totals = await deltaSummary(db, body.jobId);
    if (journal.entries.length !== body.expectedBatches || journal.entries.some((entry, index) => entry.operationsHash !== body.deltaHashes[index]) ||
        totals.operations !== plan.deltaBudget.operations || totals.operationBytes > plan.deltaBudget.bytes) {
        fail("The staged normalized plan differs from its applied journal.", 409);
    }
    await requireWtargStorage(db, env, storageCharge(payloadBytes(value), 2));
    await reserveWrites(db, body, 4, env, now);
    await immutablePut(db, "wtarg:collector_stage", body.jobId, value, body, now);
    return { staged: true };
}

async function savedStage(db, body) {
    const value = parsed(await snapshot(db, "wtarg:collector_stage", body.jobId));
    if (!value) fail("Stage the collector manifests first.", 409);
    return value;
}

async function uploadPart(db, env, body, now) {
    await activeJob(db, body, now);
    const stage = await savedStage(db, body), resource = stage.manifest.resources[body.resource];
    if (resource?.storage !== "d1" || resource.d1ReleaseId || !Number.isInteger(body.index) ||
        !resource.parts[body.index] || typeof body.text !== "string") fail("Unknown D1 resource part.");
    const expected = resource.parts[body.index];
    if (bytes(body.text) > PART_LIMIT || bytes(body.text) !== expected.bytes || await hash(body.text) !== expected.sha256) fail("Resource part checksum or size is invalid.");
    const textBytes = payloadBytes({ text: body.text });
    if (expected.storedBytes !== undefined && expected.storedBytes !== textBytes) fail("Stored resource size differs from its approved plan.");
    const scope = `${stage.manifest.releaseId}:${body.resource}:${body.index}`;
    const existing = await snapshot(db, "wtarg:read_part", scope);
    if (existing && existing.payload_json !== json({ text: body.text })) fail("Immutable resource part already differs.", 409);
    const meta = await snapshot(db, "wtarg:read_part_meta", scope);
    if (meta && meta.payload_json !== json(expected)) fail("Immutable resource receipt already differs.", 409);
    if (existing && meta) return { saved: true, unchanged: true };
    await requireWtargStorage(db, env, storageCharge((existing ? 0 : textBytes) +
        (meta ? 0 : payloadBytes(expected)), Number(!existing) + Number(!meta)));
    await reserveWrites(db, body, 4, env, now);
    const statements = [];
    if (!existing) statements.push(put(db, "wtarg:read_part", scope, { text: body.text }, body, now));
    if (!meta) statements.push(put(db, "wtarg:read_part_meta", scope, expected, body, now));
    await db.batch(statements);
    return { saved: true };
}

function decodeBase64(value) {
    if (typeof value !== "string" || value.length > 350000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail("Invalid compressed source blob.");
    let raw; try { raw = atob(value); } catch { fail("Invalid compressed source blob."); }
    if (btoa(raw) !== value) fail("Source blob must use canonical base64.");
    return Uint8Array.from(raw, character => character.charCodeAt(0));
}

async function uploadBlob(db, env, body, blobId, now) {
    await activeJob(db, body, now);
    const value = decodeBase64(body.base64);
    if (body.sha256 !== blobId || body.bytes !== value.byteLength || value.byteLength > 262144 || await hash(value) !== blobId) fail("Source blob checksum or size is invalid.");
    const stage = await savedStage(db, body);
    if (!stage.sourceManifest.files.some(file => file.storage !== "ranking-assets" &&
        file.parts.some(part => part.sha256 === blobId && part.bytes === value.byteLength))) fail("Source blob is not a D1 part in the staged checkpoint.");
    const stored = { sha256: blobId, bytes: value.byteLength, base64: body.base64 };
    if (!await snapshot(db, "wtarg:source_blob", blobId)) {
        await requireWtargStorage(db, env, storageCharge(payloadBytes(stored)));
        await reserveWrites(db, body, 2, env, now);
    }
    await immutablePut(db, "wtarg:source_blob", blobId, stored, body, now);
    return { saved: true };
}

async function pace(db, body, now) {
    await activeJob(db, body, now);
    if (!["itf", "wta"].includes(body.provider) || !["api", "profile", "browser"].includes(body.kind)) fail("Unknown provider pacing class.");
    const interval = body.provider === "wta" ? 1000 : body.kind === "profile" ? 2000 : 13000;
    const source = "wtarg:pace", scope = body.provider;
    await db.prepare("INSERT OR IGNORE INTO wtarg_source_state(source,scope) SELECT ?,? WHERE " + fence)
        .bind(source, scope, ...fenceValues(body, now)).run();
    if (body.backoffMs !== undefined) {
        if (!Number.isInteger(body.backoffMs) || body.backoffMs < 1 || body.backoffMs > 300000) fail("Provider backoff is limited to five minutes.");
        await db.prepare("UPDATE wtarg_source_state SET backoff_until=max(backoff_until,?) WHERE source=? AND scope=? AND " + fence)
            .bind(now + body.backoffMs, source, scope, ...fenceValues(body, now)).run();
        const held = await db.prepare("SELECT not_before,backoff_until FROM wtarg_source_state WHERE source=? AND scope=?").bind(source, scope).first();
        return { granted: false, waitMs: Math.max(1, Math.max(held.not_before, held.backoff_until) - now) };
    }
    const previous = await db.prepare("SELECT not_before,backoff_until,last_checked_at FROM wtarg_source_state WHERE source=? AND scope=?").bind(source, scope).first();
    const available = Math.max(previous?.not_before || 0, previous?.backoff_until || 0,
        previous?.last_checked_at ? Date.parse(previous.last_checked_at) + interval : 0);
    if (available > now) return { granted: false, waitMs: available - now };
    const granted = await db.prepare("UPDATE wtarg_source_state SET not_before=?,last_checked_at=? WHERE source=? AND scope=? " +
        "AND last_checked_at IS ? AND not_before<=? AND backoff_until<=? AND " + fence + " RETURNING not_before")
        .bind(now + interval, iso(now), source, scope, previous?.last_checked_at || null, now, now, ...fenceValues(body, now)).first();
    if (granted) return { granted: true, waitMs: 0 };
    const row = await db.prepare("SELECT not_before,backoff_until FROM wtarg_source_state WHERE source=? AND scope=?").bind(source, scope).first();
    return { granted: false, waitMs: Math.max(1, (Math.max(row?.not_before || 0, row?.backoff_until || 0) - now)) };
}

async function verifiedWtn(db, env, body, now) {
    await activeJob(db, body, now);
    if (!Array.isArray(body.observations) || body.observations.length > 12) fail("At most 12 singles observations are accepted.");
    let saved = 0;
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(new Date(now)).map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    for (const item of body.observations) {
        const observation = item?.observation;
        const allowed = new Set(["name", "country", "wtn", "source", "profile_url", "retrieved_at", "source_key",
            "observed_on", "no_wtn_checked_at", "last_profile_url"]);
        if (!/^800\d+$/.test(item?.playerId || "") || !object(observation) || Object.keys(observation).some(key => !allowed.has(key)) ||
            bytes(json(observation)) > 6000) fail("Only verified singles profile observations are accepted.");
        const value = Number(observation.wtn);
        const negative = day(observation.no_wtn_checked_at);
        const observed = observation.observed_on || (typeof observation.retrieved_at === "string" ? observation.retrieved_at.slice(0, 10) : "");
        const positive = observation.source === "profile" && typeof observation.wtn !== "boolean" && Number.isFinite(value) &&
            value > 0 && value <= 40 && day(observed) && (day(observation.retrieved_at) || timestamp(observation.retrieved_at));
        if (!positive && !negative) fail("WTN observation provenance is incomplete.");
        if (positive && observed > today || negative && observation.no_wtn_checked_at > today) fail("A verified profile observation cannot be dated in the future.");
        let url;
        try { url = new URL(negative ? observation.last_profile_url : observation.profile_url); } catch { fail("A verified singles profile link is required."); }
        if (url.protocol !== "https:" || !["www.itftennis.com", "www.world.tennis", "world.tennis"].includes(url.hostname) ||
            url.username || url.password || url.search || url.hash || url.href.length > 500 ||
            !new RegExp(`^/en/players/[a-z0-9-]+/${item.playerId}/[a-z]{2,3}/(?:wt/s/overview|jt/s)/?$`, "i").test(url.pathname)) {
            fail("The verified profile link is not an official singles player profile.");
        }
        const old = parsed(await snapshot(db, "wtarg:verified_wtn", item.playerId));
        const previous = old?.observation || {};
        const observationFields = ["wtn", "source", "source_key", "profile_url", "retrieved_at", "observed_on"];
        const priority = record => [String(record.observed_on || (record.source === "entry_list" ? "" : record.retrieved_at) || ""), record.source === "profile" ? "1" : "0"].join(":");
        let merged = { ...previous, ...(observation.name ? { name: observation.name } : {}), ...(observation.country ? { country: observation.country } : {}) };
        const hasPrior = Number(previous.wtn) > 0 && Number(previous.wtn) <= 40;
        if (!hasPrior || priority(observation) >= priority(previous)) {
            for (const field of observationFields) delete merged[field];
            for (const field of observationFields) if (Object.hasOwn(observation, field)) merged[field] = observation[field];
        }
        if (negative && observation.no_wtn_checked_at >= (previous.no_wtn_checked_at || "")) {
            merged.no_wtn_checked_at = observation.no_wtn_checked_at;
            merged.last_profile_url = observation.last_profile_url;
        } else if (positive && observed >= (previous.no_wtn_checked_at || "")) {
            delete merged.no_wtn_checked_at;
            merged.last_profile_url = observation.profile_url;
        }
        if (json(merged) === json(previous)) continue;
        const valueToSave = { playerId: item.playerId, observation: merged, verifiedAt: iso(now), jobId: body.jobId };
        await requireWtargStorage(db, env, storageCharge(payloadBytes(valueToSave)));
        await db.batch([put(db, "wtarg:verified_wtn", item.playerId, valueToSave, body, now)]); saved++;
    }
    return { saved };
}

async function heartbeat(db, body, now) {
    const { row, state } = await activeJob(db, body, now, true);
    if (body.state !== undefined && !["collecting", "publishing"].includes(body.state)) fail("Unknown collector progress state.");
    const progress = safeMessage(body.progress) || state.progress || "";
    const renewed = await db.prepare("UPDATE wtarg_jobs SET lease_until=?,payload_json=json_set(payload_json,'$.phase'," +
        "CASE WHEN json_extract(payload_json,'$.phase')='repairing' THEN 'repairing' ELSE ? END,'$.progress',?) " +
        "WHERE job_key=? AND " + fence + " RETURNING lease_until")
        .bind(Math.min(now + LEASE, row.job_expires_at), body.state || state.phase, progress, JOB, ...fenceValues(body, now)).first();
    if (!renewed) fail("Collector lease expired or changed.", 409);
    return { leaseUntil: renewed.lease_until };
}

async function finish(db, body, now) {
    const { state } = await activeJob(db, body, now, true);
    if (!["failed", "partial"].includes(body.state)) fail("Only a failed or partial collector is finished without publication.");
    const journal = await journalState(db, body.jobId);
    const needsRollback = journal.remaining > 0;
    const next = { ...state, phase: needsRollback ? "repairing" : body.state,
        progress: needsRollback ? "Restoring the previous saved data." : "Saved data was kept after an incomplete update.",
        failedState: body.state };
    const error = body.state === "partial" ? "The collector returned incomplete data. The previous saved version was kept."
        : "The collector could not finish. The previous saved version was kept.";
    const statements = [db.prepare("UPDATE wtarg_jobs SET status=?,payload_json=?,error=?,lease_token=?,lease_until=? WHERE job_key=? AND " + fence)
        .bind(needsRollback ? "running" : "failed", json(next), error, needsRollback ? body.leaseToken : null,
            needsRollback ? Math.min(now + LEASE, now + INTERVAL) : 0, JOB, ...fenceValues(body, now))];
    if (body.details !== undefined) {
        if (payloadBytes(body.details) > 65536) fail("Collector diagnostics exceed their emergency reserve.");
        statements.unshift(put(db, "wtarg:collector_diagnostic", body.jobId,
            { state: body.state, details: body.details }, body, now));
    }
    await db.batch(statements);
    return { needsRollback };
}

async function rollback(db, body, now) {
    const { state } = await activeJob(db, body, now, true);
    if (state.phase !== "repairing") fail("This collector is not restoring an interrupted update.", 409);
    const result = await rollbackDelta(db, body, now);
    const journal = await journalState(db, body.jobId);
    if (!journal.remaining) {
        const next = { ...state, phase: state.failedState || "failed", progress: "The previous saved data was restored." };
        await db.prepare("UPDATE wtarg_jobs SET status='failed',lease_token=NULL,lease_until=0,payload_json=? WHERE job_key=? AND " + fence)
            .bind(json(next), JOB, ...fenceValues(body, now)).run();
    }
    return { ...result, remaining: journal.remaining, complete: journal.remaining === 0 };
}

async function commit(db, env, body, now) {
    const outcome = body.outcome || "success";
    if (!["success", "degraded"].includes(outcome)) fail("Only a validated success or degraded transaction can be published.");
    const receipt = parsed(await snapshot(db, "wtarg:collector_receipt", body.jobId || ""));
    if (receipt && receipt.leaseHash === await hash(body.leaseToken || "")) return { committed: true,
        releaseId: receipt.releaseId, sourceVersion: receipt.sourceVersion, outcome: receipt.outcome || "success", alreadyCommitted: true };
    const { state } = await activeJob(db, body, now);
    const staged = await savedStage(db, body), manifest = staged.manifest;
    try { await validateRankingWeekIndex(db, await validateRankingAssets(env, manifest, staged.sourceManifest)); }
    catch { fail("Ranking assets are unavailable; the saved release was retained.", 409); }
    const journal = await journalState(db, body.jobId);
    if (journal.batches !== staged.expectedBatches || journal.entries.some((entry, index) => entry.operationsHash !== staged.deltaHashes[index])) {
        fail("Normalized update batches are incomplete or differ from the staged plan.", 409);
    }
    const requiredParts = [];
    for (const [name, resource] of Object.entries(manifest.resources)) if (resource.storage === "d1" && !resource.d1ReleaseId) {
        resource.parts.forEach((part, index) => requiredParts.push({ scope: `${manifest.releaseId}:${name}:${index}`, ...part }));
    }
    const requiredBlobs = [...new Map(staged.sourceManifest.files.filter(file => file.storage !== "ranking-assets")
        .flatMap(file => file.parts).map(part => [part.sha256, part])).values()];
    for (const [kind, required] of [["wtarg:read_part_meta", requiredParts], ["wtarg:source_blob", requiredBlobs.map(part => ({ scope: part.sha256, ...part }))]]) {
        const saved = await db.prepare("SELECT s.scope,json_extract(s.payload_json,'$.bytes') AS bytes," +
            "json_extract(s.payload_json,'$.sha256') AS sha256 FROM wta_snapshots s JOIN json_each(?) r " +
            "ON s.scope=json_extract(r.value,'$.scope') WHERE s.kind=?").bind(json(required), kind).all();
        const byScope = new Map(saved.results.map(row => [row.scope, row]));
        if (required.some(part => byScope.get(part.scope)?.bytes !== part.bytes || byScope.get(part.scope)?.sha256 !== part.sha256)) {
            fail("Staged public data or compressed source checkpoint is incomplete.", 409);
        }
    }
    const existing = await snapshot(db, "wtarg:read_manifest", manifest.releaseId);
    if (existing && existing.payload_json !== json(manifest)) fail("An accepted release cannot be replaced.", 409);
    const sourceExisting = await snapshot(db, "wtarg:source_manifest", manifest.releaseId);
    if (sourceExisting && sourceExisting.payload_json !== json(staged.sourceManifest)) fail("An accepted source checkpoint cannot be replaced.", 409);
    await requireWtargStorage(db, env, storageCharge(payloadBytes(manifest) + payloadBytes(staged.sourceManifest), 10));
    await reserveWrites(db, body, 12, env, now);
    const current = { schemaVersion: 1, releaseId: manifest.releaseId };
    const next = { ...state, phase: outcome === "degraded" ? "partial" : "complete",
        progress: outcome === "degraded" ? "Saved data was updated with warnings; some sources may be older." : "Saved data was updated.",
        previousReleaseId: state.baseReleaseId, nextRefreshAt: Math.max(state.nextRefreshAt || 0, now + COOLDOWN) };
    const guardScope = body.jobId;
    const guard = db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) VALUES" +
        "('wtarg:publish_guard',?,CASE WHEN " + fence + " AND EXISTS (SELECT 1 FROM wta_snapshots " +
        "WHERE kind='wtarg:source_current' AND scope='global' AND json_extract(payload_json,'$.sourceVersion')=? " +
        "AND COALESCE(json_extract(payload_json,'$.checkpointId'),json_extract(payload_json,'$.sourceVersion'))=?) " +
        "THEN '{}' ELSE '[' END,?,NULL)").bind(guardScope, ...fenceValues(body, now), state.baseSourceVersion,
            state.baseCheckpointId || state.baseSourceVersion, iso(now));
    await db.batch([
        guard,
        put(db, "wtarg:read_manifest", manifest.releaseId, manifest, body, now),
        put(db, "wtarg:read_accepted", manifest.releaseId, { schemaVersion: 1, releaseId: manifest.releaseId,
            manifestSha256: await hash(json(manifest)) }, body, now),
        put(db, "wtarg:source_manifest", manifest.releaseId, staged.sourceManifest, body, now),
        put(db, "wtarg:source_current", "global", { schemaVersion: 1, sourceVersion: staged.sourceManifest.sourceVersion,
            checkpointId: manifest.releaseId }, body, now),
        put(db, "wtarg:read_current", "global", current, body, now),
        put(db, "wtarg:collector_receipt", body.jobId, { leaseHash: await hash(body.leaseToken), releaseId: manifest.releaseId,
            sourceVersion: staged.sourceManifest.sourceVersion, outcome }, body, now),
        ...(state.baseReleaseId ? [put(db, "wtarg:read_previous", "global", { schemaVersion: 1, releaseId: state.baseReleaseId }, body, now)] : []),
        put(db, "wtarg:source_previous", "global", { schemaVersion: 1, sourceVersion: state.baseSourceVersion,
            checkpointId: state.baseCheckpointId || state.baseSourceVersion }, body, now),
        db.prepare("DELETE FROM wta_snapshots WHERE kind='wtarg:delta_journal' AND scope>=? AND scope<? AND " + fence)
            .bind(body.jobId + ":", body.jobId + ";", ...fenceValues(body, now)),
        db.prepare("DELETE FROM wta_snapshots WHERE kind='wtarg:delta_totals' AND scope=? AND " + fence)
            .bind(body.jobId, ...fenceValues(body, now)),
        db.prepare("DELETE FROM wta_snapshots WHERE kind='wtarg:publish_guard' AND scope=?").bind(guardScope),
        db.prepare("UPDATE wtarg_source_state SET last_success_at=? WHERE source=? AND scope='global' AND " + fence)
            .bind(iso(now), CONTROL, ...fenceValues(body, now)),
        db.prepare("UPDATE wtarg_jobs SET status='complete',lease_token=NULL,lease_until=0,last_success_at=?,error=NULL,payload_json=? WHERE job_key=? AND " + fence)
            .bind(iso(now), json(next), JOB, ...fenceValues(body, now)),
    ]);
    return { committed: true, releaseId: manifest.releaseId, sourceVersion: staged.sourceManifest.sourceVersion, outcome };
}

async function privateSource(db, env, route, request) {
    if (request.method !== "GET") fail("Use POST with a source blob identifier to upload compressed content.", 405);
    if (route.blob) {
        const source = await currentSource(db);
        if (source) {
            const external = await rankingSourceBlob(env, source, route.blob);
            if (external) return external;
        }
        const blob = parsed(await snapshot(db, "wtarg:source_blob", route.blob));
        if (!blob) fail("Source blob is not available.", 404);
        return blob;
    }
    return { manifest: await currentSource(db), ...await wtnPage(db, "") };
}

async function wtnPage(db, cursor) {
    if (cursor !== "" && !/^800\d+$/.test(cursor || "")) fail("Invalid singles WTN page cursor.");
    const observations = await db.prepare("SELECT scope,payload_json FROM wta_snapshots WHERE kind='wtarg:verified_wtn' AND scope>? ORDER BY scope LIMIT 51")
        .bind(cursor).all();
    const records = observations.results.slice(0, 50);
    const wtnObservations = Object.fromEntries(records.map(row => [row.scope, JSON.parse(row.payload_json).observation]));
    return { wtnObservations, nextWtnCursor: observations.results.length > 50 ? records.at(-1).scope : null };
}

async function garbageCollect(db, env, body, now) {
    const limit = body.limit === undefined ? 20 : body.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) fail("Collector cleanup is limited to 50 rows per request.");
    const [row, currentRead, previousRead, currentCheckpoint, previousCheckpoint] = await Promise.all([
        jobRow(db), snapshot(db, "wtarg:read_current"), snapshot(db, "wtarg:read_previous"),
        snapshot(db, "wtarg:source_current"), snapshot(db, "wtarg:source_previous"),
    ]);
    const state = parsed(row) || {};
    const currentReadId = parsed(currentRead)?.releaseId;
    const currentSourcePointer = parsed(currentCheckpoint);
    if (!HASH.test(currentReadId || "") || !HASH.test(currentSourcePointer?.sourceVersion || "")) {
        fail("An approved source and public baseline are required before cleanup.", 409);
    }
    const [stageRow, planRow] = state.jobId ? await Promise.all([
        snapshot(db, "wtarg:collector_stage", state.jobId), snapshot(db, "wtarg:collector_preflight", state.jobId),
    ]) : [null, null];
    const pending = state.jobId ? await deltaSummary(db, state.jobId) : { batches: 0 };
    const live = row?.status === "running" && row.lease_until > now && row.job_expires_at > now;
    const keepStage = !!state.jobId && (live || pending.batches > 0);
    const staged = keepStage ? [parsed(stageRow), parsed(planRow)].filter(Boolean) : [];
    const readIds = new Set([currentReadId, parsed(previousRead)?.releaseId].filter(Boolean));
    const manifests = new Map();
    for (const id of readIds) {
        const manifest = await acceptedWtargManifest(db, id);
        if (!manifest) fail("Accepted public data could not be verified before cleanup.", 409);
        manifests.set(id, manifest);
    }
    for (const stage of staged) {
        if (!validWtargManifest(stage.manifest, stage.manifest?.releaseId)) fail("Invalid staged cleanup inventory.", 409);
        manifests.set(stage.manifest.releaseId, stage.manifest);
    }
    const metadataIds = new Set();
    const partScopes = new Set();
    for (const manifest of manifests.values()) {
        metadataIds.add(manifest.releaseId);
        for (const [name, resource] of Object.entries(manifest.resources)) {
            const owner = resource.storage === "asset" ? resource.assetReleaseId || manifest.releaseId :
                resource.d1ReleaseId || manifest.releaseId;
            metadataIds.add(owner);
            if (resource.storage === "d1") resource.parts.forEach((_part, index) => partScopes.add(`${owner}:${name}:${index}`));
        }
    }
    const sourceIds = new Set();
    const sourceManifests = [];
    for (const pointer of [currentSourcePointer, parsed(previousCheckpoint)].filter(Boolean)) {
        const id = pointer.checkpointId || pointer.sourceVersion;
        if (!HASH.test(id || "")) fail("Invalid accepted source pointer before cleanup.", 409);
        const manifest = parsed(await snapshot(db, "wtarg:source_manifest", id));
        if (!manifest || manifest.sourceVersion !== pointer.sourceVersion) fail("Accepted source inventory is missing.", 409);
        await validateSource(manifest);
        sourceIds.add(id); sourceManifests.push(manifest);
    }
    for (const stage of staged) {
        sourceManifests.push(await validateSource(stage.sourceManifest));
        sourceIds.add(stage.manifest.releaseId);
    }
    const keepBlobs = new Set(sourceManifests.flatMap(manifest => manifest.files.filter(file => file.storage !== "ranking-assets")
        .flatMap(file => file.parts.map(part => part.sha256))));
    const kinds = ["wtarg:read_part", "wtarg:read_part_meta", "wtarg:read_manifest", "wtarg:read_accepted",
        "wtarg:source_manifest", "wtarg:source_blob", "wtarg:collector_stage", "wtarg:collector_preflight",
        "wtarg:collector_diagnostic", "wtarg:collector_receipt"];
    const cursor = parsed(await snapshot(db, "wtarg:collector_gc")) || { kind: "", scope: "" };
    const rows = await db.prepare("SELECT s.kind,s.scope,s.fetched_at,EXISTS(SELECT 1 FROM wta_snapshots a " +
        "WHERE a.kind='wtarg:read_accepted' AND a.scope=substr(s.scope,1,64)) AS accepted FROM wta_snapshots s WHERE s.kind IN (" +
        kinds.map(() => "?").join(",") + ") AND (s.kind>? OR (s.kind=? AND s.scope>?)) ORDER BY s.kind,s.scope LIMIT 1000")
        .bind(...kinds, cursor.kind, cursor.kind, cursor.scope).all();
    const deletions = [];
    let last = null;
    for (const candidate of rows.results) {
        last = { kind: candidate.kind, scope: candidate.scope };
        const age = now - Date.parse(candidate.fetched_at);
        if (!Number.isFinite(age)) fail("Invalid cleanup row age; saved data was kept.", 409);
        let remove = false;
        if (candidate.kind === "wtarg:read_part" || candidate.kind === "wtarg:read_part_meta") {
            remove = !partScopes.has(candidate.scope) && (!candidate.accepted || age > 3600000);
        } else if (candidate.kind === "wtarg:read_manifest" || candidate.kind === "wtarg:read_accepted") {
            remove = !metadataIds.has(candidate.scope) && (!candidate.accepted || age > 3600000);
        } else if (candidate.kind === "wtarg:source_manifest") remove = !sourceIds.has(candidate.scope);
        else if (candidate.kind === "wtarg:source_blob") remove = !keepBlobs.has(candidate.scope);
        else if (candidate.kind === "wtarg:collector_stage" || candidate.kind === "wtarg:collector_preflight") {
            remove = !keepStage || candidate.scope !== state.jobId;
        } else remove = age > 7 * 86400000;
        if (remove) deletions.push(candidate);
        if (deletions.length >= limit) break;
    }
    const nextCursor = last && (deletions.length >= limit || rows.results.length === 1000) ? last : { kind: "", scope: "" };
    const continuation = nextCursor.kind !== "";
    const checkpointId = currentSourcePointer.checkpointId || currentSourcePointer.sourceVersion;
    const marker = { ...nextCursor, complete: !continuation, jobId: state.jobId || null,
        leaseHash: await hash(row?.lease_token || ""), readReleaseId: currentReadId, checkpointId };
    const pointerGuards = [
        ["wtarg:read_current", "global", currentRead], ["wtarg:read_previous", "global", previousRead],
        ["wtarg:source_current", "global", currentCheckpoint], ["wtarg:source_previous", "global", previousCheckpoint],
        ["wtarg:collector_stage", state.jobId || "", stageRow], ["wtarg:collector_preflight", state.jobId || "", planRow],
    ];
    const unchanged = "(SELECT payload_json FROM wtarg_jobs WHERE job_key='wtarg:collector:global') IS ? " +
        "AND (SELECT lease_token FROM wtarg_jobs WHERE job_key='wtarg:collector:global') IS ? " +
        "AND (SELECT lease_until FROM wtarg_jobs WHERE job_key='wtarg:collector:global') IS ? " +
        pointerGuards.map(() => "AND (SELECT payload_json FROM wta_snapshots WHERE kind=? AND scope=?) IS ?").join(" ");
    const values = [row?.payload_json || null, row?.lease_token || null, row?.lease_until ?? null,
        ...pointerGuards.flatMap(([kind, scope, saved]) => [kind, scope, saved?.payload_json || null])];
    const budgetLimit = Number(env.WTARG_DAILY_WRITE_BUDGET || DEFAULT_COLLECTOR_WRITE_BUDGET);
    if (!Number.isInteger(budgetLimit) || budgetLimit < 1000 || budgetLimit > 60000) fail("Collector write budget is not configured safely.", 503);
    const budgetScope = "write-budget:" + iso(now).slice(0, 10);
    const oldBudget = await db.prepare("SELECT payload_json FROM wtarg_source_state WHERE source=? AND scope=?")
        .bind(CONTROL, budgetScope).first();
    const reserved = parsed(oldBudget)?.reserved || 0;
    const charge = deletions.length * 2 + 12;
    if (!Number.isSafeInteger(reserved) || reserved < 0 || reserved + charge > budgetLimit) {
        fail("The collector cleanup write reserve is exhausted; collection remains stopped.", 429);
    }
    const guard = db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) VALUES(" +
        "'wtarg:collector_gc_guard','global',CASE WHEN " + unchanged + " AND (SELECT payload_json FROM wtarg_source_state " +
        "WHERE source=? AND scope=?) IS ? THEN '{}' ELSE '[' END,?,NULL)")
        .bind(...values, CONTROL, budgetScope, oldBudget?.payload_json || null, iso(now));
    try {
        const results = await db.batch([
            guard,
            db.prepare("INSERT INTO wtarg_source_state(source,scope,payload_json) VALUES(?,?,?) " +
                "ON CONFLICT(source,scope) DO UPDATE SET payload_json=excluded.payload_json")
                .bind(CONTROL, budgetScope, json({ reserved: reserved + charge })),
            db.prepare("DELETE FROM wta_snapshots WHERE EXISTS(SELECT 1 FROM json_each(?) d " +
                "WHERE wta_snapshots.kind=json_extract(d.value,'$.kind') AND wta_snapshots.scope=json_extract(d.value,'$.scope') " +
                "AND wta_snapshots.fetched_at=json_extract(d.value,'$.fetched_at'))").bind(json(deletions)),
            db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) " +
                "VALUES('wtarg:collector_gc','global',?,?,NULL) ON CONFLICT(kind,scope) DO UPDATE SET " +
                "payload_json=excluded.payload_json,fetched_at=excluded.fetched_at").bind(json(marker), iso(now)),
            db.prepare("DELETE FROM wta_snapshots WHERE kind='wtarg:collector_gc_guard' AND scope='global'"),
        ]);
        return { scanned: rows.results.length, deleted: results[2].meta?.changes || 0, continuation, complete: !continuation };
    } catch {
        // A heartbeat, pointer change or another cleanup wins safely; repeat without advancing its cursor.
        return { scanned: rows.results.length, deleted: 0, continuation: true, complete: false };
    }
}

export async function wtargCollectorResponse(request, env, headers = {}, now = Date.now()) {
    const route = getWtargCollectorRoute(new URL(request.url).pathname);
    const responseHeaders = { ...headers, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
    if (route && !route.public) for (const key of Object.keys(responseHeaders)) if (key.toLowerCase().startsWith("access-control-")) delete responseHeaders[key];
    const reply = (value, status = 200) => Response.json(value, { status, headers: responseHeaders });
    try {
        if (!route) fail("Unknown WTARG collector route.", 404);
        if (!route.public) await authorized(request, env);
        if (!route.method.split(", ").includes(request.method)) fail("Method not allowed.", 405);
        if (!env.ENTRY_LISTS_DB) fail("WTARG collection storage is unavailable.", 503);
        const db = env.ENTRY_LISTS_DB;
        if (route.operation === "status") return reply(await statusState(db, env, now));
        if (route.operation === "refresh") {
            if (!['https://wtarg.com', 'https://www.wtarg.com', 'https://tomistgg.github.io'].includes(request.headers.get("Origin"))) fail("Website origin is required for refresh.", 403);
            if (request.body) { const reader = request.body.getReader(); const first = await reader.read(); await reader.cancel();
                if (!first.done && first.value?.byteLength) fail("Refresh accepts an empty request only."); }
            const result = await requestRefresh(db, env, now); return reply(result.state, result.status);
        }
        if (route.operation === "storage") return reply(await wtargStorage(db, env));
        if (route.operation === "source" && request.method === "GET") return reply(await privateSource(db, env, route, request));
        const body = await readBody(request);
        if (route.operation === "claim") return reply(await claim(db, env, now));
        if (route.operation === "heartbeat") return reply(await heartbeat(db, body, now));
        if (route.operation === "preflight") return reply(await preflight(db, env, body, now));
        if (route.operation === "stage") return reply(await stage(db, env, body, now));
        if (route.operation === "part") return reply(await uploadPart(db, env, body, now));
        if (route.operation === "source" && route.blob) return reply(await uploadBlob(db, env, body, route.blob, now));
        if (route.operation === "delta") {
            await activeJob(db, body, now);
            if (!Number.isInteger(body.batchId) || body.batchId < 0 || body.batchId >= 10000) fail("Unknown normalized batch.");
            const plan = await updatePlan(db, body);
            if (!Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 8 ||
                body.batchId >= plan.deltaBudget.batches) fail("The normalized batch exceeds its approved storage plan.", 409);
            const stage = parsed(await snapshot(db, "wtarg:collector_stage", body.jobId));
            if (stage && body.batchId >= stage.expectedBatches) fail("The normalized plan was already sealed.", 409);
            const journal = await deltaSummary(db, body.jobId);
            if (body.batchId >= journal.batches) {
                const operationBytes = payloadBytes(body.operations);
                if (journal.operations + body.operations.length > plan.deltaBudget.operations ||
                    journal.operationBytes + operationBytes > plan.deltaBudget.bytes) {
                    fail("Normalized changes exceed the approved operation or byte allowance.", 409);
                }
                await requireWtargStorage(db, env, Math.ceil(operationBytes * 1.5) + body.operations.length * 8192);
                await reserveWrites(db, body, body.operations.length * 12 + 8, env, now);
            }
            return reply({ ...await applyDelta(db, body, now, plan.deltaBudget), operationsHash: await hash(JSON.stringify(body.operations)) });
        }
        if (route.operation === "rollback") return reply(await rollback(db, body, now));
        if (route.operation === "commit") return reply(await commit(db, env, body, now));
        if (route.operation === "finish") return reply(await finish(db, body, now));
        if (route.operation === "pace") return reply(await pace(db, body, now));
        if (route.operation === "wtn") return reply(await verifiedWtn(db, env, body, now));
        if (route.operation === "wtn-page") { await activeJob(db, body, now, true); return reply(await wtnPage(db, body.cursor || "")); }
        if (route.operation === "gc") return reply(await garbageCollect(db, env, body, now));
        fail("Unknown collector operation.", 404);
    } catch (error) {
        const message = error.status ? error.message : "WTARG collector storage is unavailable. The previous saved version was kept.";
        if (route?.public) {
            let state = {}; try { state = await statusState(env.ENTRY_LISTS_DB, env, now); } catch {}
            return reply({ ...state, error: message }, error.status || 503);
        }
        return reply({ error: message }, error.status || 503);
    }
}
