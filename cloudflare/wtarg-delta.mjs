// Only the canonical WTARG index is mutable here; read releases and collector coordination have separate APIs.
export const WTARG_DELTA_TABLES = new Set([
    "wtarg_players", "wtarg_player_ids", "wtarg_player_aliases", "wtarg_tournaments", "wtarg_tournament_sources",
    "wtarg_ranking_weeks", "wtarg_rankings", "wtarg_matches", "wtarg_match_participants", "wtarg_entry_lists",
    "wtarg_entries", "wtarg_entry_changes", "wtarg_draws", "wtarg_player_wtn", "wtarg_draw_wtn",
    "wtarg_tournament_metrics", "wtarg_calendar_changes", "wtarg_jobs", "wtarg_source_state",
]);
const RETIRABLE = new Set(["wtarg_rankings", "wtarg_entry_lists", "wtarg_entries", "wtarg_calendar_changes",
    "wtarg_jobs", "wtarg_source_state"]);
const JOB_KEY = "wtarg:collector:global";
const KIND = "wtarg:delta_journal";
const MAX_JOURNAL_BYTES = 20 * 1024 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
const json = value => JSON.stringify(value);
const failure = (message, status = 409) => Object.assign(new Error(message), { status });
const quote = name => `"${name}"`;
const journalScope = (jobId, batchId) => `${jobId}:${String(batchId).padStart(6, "0")}`;
const fence = "EXISTS (SELECT 1 FROM wtarg_jobs WHERE job_key = ? AND lease_token = ? AND lease_until > ? " +
    "AND job_expires_at > ? AND json_extract(payload_json, '$.jobId') = ?) " +
    "AND NOT EXISTS (SELECT 1 FROM wta_snapshots WHERE kind='wtarg:admin_lock' AND scope='global')";
const fenceValues = (body, now) => [JOB_KEY, body.leaseToken, now, now, body.jobId];

function validIdentity(body) {
    if (!object(body) || !/^[A-Za-z0-9-]{1,44}$/.test(body.jobId || "") ||
        typeof body.leaseToken !== "string" || body.leaseToken.length < 16 || body.leaseToken.length > 200) {
        throw failure("Invalid collector job identity.", 400);
    }
}

async function requireLease(db, body, now) {
    validIdentity(body);
    const live = await db.prepare("SELECT 1 AS live WHERE " + fence).bind(...fenceValues(body, now)).first();
    if (!live) throw failure("The collector lease is no longer active.");
}

async function layout(db, table) {
    if (!WTARG_DELTA_TABLES.has(table)) throw failure("Unknown canonical table.", 400);
    const { results } = await db.prepare(`PRAGMA table_info(${quote(table)})`).all();
    if (!results.length || results.some(row => !/^[a-z_]+$/.test(row.name))) throw failure("Canonical schema is unavailable.");
    return { columns: results.map(row => row.name),
        keys: results.filter(row => row.pk).sort((a, b) => a.pk - b.pk).map(row => row.name) };
}

function validateOperation(operation, schema, restoring = false) {
    const { table, key, before, after } = operation;
    if (!object(key) || Object.keys(key).sort().join() !== [...schema.keys].sort().join() ||
        before === null && after === null) throw failure("Invalid canonical operation.", 400);
    for (const row of [before, after]) {
        if (row === null) continue;
        if (!object(row) || Object.keys(row).sort().join() !== [...schema.columns].sort().join() ||
            Object.values(row).some(value => value !== null && typeof value !== "string" &&
                !(typeof value === "number" && Number.isFinite(value))) ||
            schema.keys.some(name => row[name] !== key[name])) throw failure("Invalid canonical row.", 400);
        if (table === "wtarg_jobs" && (!String(row.job_key).startsWith("wtarg:wtn_gm:") || row.kind !== "wtn_gm" ||
            row.discipline !== "S" || !["MDS", "QS"].includes(row.draw_code) || row.lease_token !== null || row.lease_until !== 0)) {
            throw failure("Collector coordination cannot be replaced by a canonical delta.", 400);
        }
        if (table === "wtarg_source_state" && !/^(?:wtarg:(?:acceptance|wtn_publication|withdrawal_header|legacy_cache_file|legacy_cache_entry:[a-z0-9_.]+|main_draw_observation|profile_entry_checks|legacy_diagnostic:[a-z0-9_.]+)|itf_player_details|(?:wta_full_calendar_cache|itf_calendar_cache|wta_calendar_history|cache_state))$/.test(row.source)) {
            throw failure("Provider coordination cannot be replaced by a canonical delta.", 400);
        }
    }
    if (!restoring && after === null && !RETIRABLE.has(table)) throw failure("Permanent tennis history cannot be deleted.");
    if (!restoring && table === "wtarg_rankings" && after?.series === "wta_singles") {
        throw failure("Global WTA rankings are immutable files, not per-player SQL rows.");
    }
    if (!restoring && before?.frozen === 1 && json(schema.columns.map(name => before[name])) !==
        json(schema.columns.map(name => after?.[name]))) throw failure("A frozen metric cannot be replaced.");
}

function predicate(schema, row, key) {
    const fields = row === null ? schema.keys : schema.columns;
    const values = fields.map(name => (row || key)[name]);
    const condition = fields.map(name => `${quote(name)} IS ?`).join(" AND ");
    return { sql: `${row === null ? "NOT " : ""}EXISTS (SELECT 1 FROM TABLE WHERE ${condition})`, values };
}

function mutation(db, table, schema, row, key) {
    if (row === null) return db.prepare(`DELETE FROM ${quote(table)} WHERE ` +
        schema.keys.map(name => `${quote(name)} IS ?`).join(" AND ")).bind(...schema.keys.map(name => key[name]));
    const update = schema.columns.filter(name => !schema.keys.includes(name));
    return db.prepare(`INSERT INTO ${quote(table)} (${schema.columns.map(quote).join(",")}) VALUES (` +
        schema.columns.map(() => "?").join(",") + `) ON CONFLICT (${schema.keys.map(quote).join(",")}) ` +
        (update.length ? "DO UPDATE SET " + update.map(name => `${quote(name)}=excluded.${quote(name)}`).join(",") : "DO NOTHING"))
        .bind(...schema.columns.map(name => row[name]));
}

function guardStart(db, body, now, scope) {
    return db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) VALUES " +
        "('wtarg:delta_guard',?,CASE WHEN " + fence + " THEN '{}' ELSE '[' END,?,NULL)")
        .bind(scope, ...fenceValues(body, now), new Date(now).toISOString());
}

function guardRow(db, operation, schema, expected, scope) {
    const condition = predicate(schema, expected, operation.key);
    return db.prepare("UPDATE wta_snapshots SET payload_json = CASE WHEN " +
        condition.sql.replace("FROM TABLE", `FROM ${quote(operation.table)}`) +
        " THEN '{}' ELSE '[' END WHERE kind='wtarg:delta_guard' AND scope=?")
        .bind(...condition.values, scope);
}

export async function deltaJournal(db, jobId) {
    if (!/^[A-Za-z0-9-]{1,44}$/.test(jobId || "")) throw failure("Invalid collector job identity.", 400);
    const { results } = await db.prepare("SELECT scope,json_extract(payload_json,'$.batchId') AS batchId," +
        "json_extract(payload_json,'$.operationsHash') AS operationsHash FROM wta_snapshots " +
        "WHERE kind=? AND scope>=? AND scope<? ORDER BY scope")
        .bind(KIND, jobId + ":", jobId + ";").all();
    return results;
}

async function lastJournal(db, jobId) {
    const row = await db.prepare("SELECT scope,payload_json FROM wta_snapshots " +
        "WHERE kind=? AND scope>=? AND scope<? ORDER BY scope DESC LIMIT 1")
        .bind(KIND, jobId + ":", jobId + ";").first();
    return row ? { scope: row.scope, ...JSON.parse(row.payload_json) } : null;
}

async function totalsRow(db, jobId) {
    const row = await db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind='wtarg:delta_totals' AND scope=?")
        .bind(jobId).first();
    const total = row ? JSON.parse(row.payload_json) : { batches: 0, bytes: 0, operations: 0, operationBytes: 0 };
    if (!object(total) || !Number.isInteger(total.batches) || total.batches < 0 ||
        !Number.isInteger(total.bytes) || total.bytes < 0) throw failure("Invalid canonical recovery counters.");
    if (!Number.isInteger(total.operations ?? 0) || (total.operations ?? 0) < 0 ||
        !Number.isInteger(total.operationBytes ?? 0) || (total.operationBytes ?? 0) < 0) {
        throw failure("Invalid canonical recovery counters.");
    }
    return { raw: row?.payload_json ?? null, operations: 0, operationBytes: 0, ...total };
}

export async function deltaSummary(db, jobId) {
    const total = await totalsRow(db, jobId);
    return { batches: total.batches, bytes: total.bytes, operations: total.operations, operationBytes: total.operationBytes };
}

function guardTotals(db, jobId, previous, scope) {
    return db.prepare("UPDATE wta_snapshots SET payload_json=CASE WHEN " +
        "(SELECT payload_json FROM wta_snapshots WHERE kind='wtarg:delta_totals' AND scope=?) IS ? " +
        "THEN '{}' ELSE '[' END WHERE kind='wtarg:delta_guard' AND scope=?")
        .bind(jobId, previous.raw, scope);
}

function writeTotals(db, jobId, total, now) {
    return db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) " +
        "VALUES('wtarg:delta_totals',?,?,?,NULL) ON CONFLICT(kind,scope) DO UPDATE SET " +
        "payload_json=excluded.payload_json,fetched_at=excluded.fetched_at")
        .bind(jobId, json(total), new Date(now).toISOString());
}

export async function applyDelta(db, body, now = Date.now(), approvedBudget = null) {
    await requireLease(db, body, now);
    if (!Number.isInteger(body.batchId) || body.batchId < 0 || body.batchId > 9999 ||
        !Array.isArray(body.operations) || body.operations.length < 1 || body.operations.length > 8 ||
        new TextEncoder().encode(json(body.operations)).length > 900000) throw failure("Invalid canonical batch.", 400);
    const operationsHash = await hash(json(body.operations));
    const scope = journalScope(body.jobId, body.batchId);
    const saved = await db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind=? AND scope=?").bind(KIND, scope).first();
    if (saved) {
        if (JSON.parse(saved.payload_json).operationsHash !== operationsHash) throw failure("Canonical batch content changed.");
        return { applied: false, batchId: body.batchId };
    }
    const previous = await lastJournal(db, body.jobId);
    if (body.batchId !== (previous ? previous.batchId + 1 : 0)) throw failure("Canonical batches must be applied in order.");
    const totals = await totalsRow(db, body.jobId);
    const operationBytes = new TextEncoder().encode(json(body.operations)).length;
    if (approvedBudget && (body.batchId >= approvedBudget.batches ||
        totals.operations + body.operations.length > approvedBudget.operations ||
        totals.operationBytes + operationBytes > approvedBudget.bytes)) {
        throw failure("Canonical changes exceed their approved storage plan.");
    }
    const payload = json({ schemaVersion: 1, jobId: body.jobId, batchId: body.batchId, operationsHash,
        operations: body.operations });
    const payloadBytes = new TextEncoder().encode(payload).length;
    if (totals.batches !== body.batchId || totals.bytes + payloadBytes > MAX_JOURNAL_BYTES) {
        throw failure("Canonical recovery storage reserve exceeded; collection must pause.");
    }
    const schemas = new Map();
    const seen = new Set();
    for (const operation of body.operations) {
        if (!object(operation) || !WTARG_DELTA_TABLES.has(operation.table)) throw failure("Unknown canonical table.", 400);
        if (!schemas.has(operation.table)) schemas.set(operation.table, await layout(db, operation.table));
        const schema = schemas.get(operation.table);
        validateOperation(operation, schema);
        const identity = json([operation.table, ...schema.keys.map(name => operation.key[name])]);
        if (seen.has(identity)) throw failure("Repeated row in canonical batch.", 400);
        seen.add(identity);
    }
    const statements = [guardStart(db, body, now, scope), guardTotals(db, body.jobId, totals, scope)];
    for (const operation of body.operations) {
        const schema = schemas.get(operation.table);
        statements.push(guardRow(db, operation, schema, operation.before, scope));
        statements.push(mutation(db, operation.table, schema, operation.after, operation.key));
    }
    statements.push(db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) VALUES(?,?,?,?,NULL)")
        .bind(KIND, scope, payload, new Date(now).toISOString()));
    statements.push(writeTotals(db, body.jobId, { batches: totals.batches + 1, bytes: totals.bytes + payloadBytes,
        operations: totals.operations + body.operations.length,
        operationBytes: totals.operationBytes + operationBytes }, now));
    statements.push(db.prepare("DELETE FROM wta_snapshots WHERE kind='wtarg:delta_guard' AND scope=?").bind(scope));
    try { await db.batch(statements); }
    catch { throw failure("Canonical batch conflicted with the current rows or collector lease."); }
    return { applied: true, batchId: body.batchId };
}

export async function rollbackDelta(db, body, now = Date.now()) {
    await requireLease(db, body, now);
    const last = await lastJournal(db, body.jobId);
    if (!last) return { rolledBack: false, remaining: 0 };
    const totals = await totalsRow(db, body.jobId);
    if (totals.batches !== last.batchId + 1) throw failure("Canonical recovery counters are inconsistent.");
    const payloadBytes = new TextEncoder().encode(json({ schemaVersion: last.schemaVersion, jobId: last.jobId,
        batchId: last.batchId, operationsHash: last.operationsHash, operations: last.operations })).length;
    if (totals.bytes < payloadBytes) throw failure("Canonical recovery counters are inconsistent.");
    const schemas = new Map();
    const statements = [guardStart(db, body, now, last.scope), guardTotals(db, body.jobId, totals, last.scope)];
    for (const operation of [...last.operations].reverse()) {
        if (!schemas.has(operation.table)) schemas.set(operation.table, await layout(db, operation.table));
        const schema = schemas.get(operation.table);
        validateOperation(operation, schema, true);
        statements.push(guardRow(db, operation, schema, operation.after, last.scope));
        statements.push(mutation(db, operation.table, schema, operation.before, operation.key));
    }
    statements.push(db.prepare("DELETE FROM wta_snapshots WHERE kind=? AND scope=?").bind(KIND, last.scope));
    statements.push(writeTotals(db, body.jobId, { batches: totals.batches - 1, bytes: totals.bytes - payloadBytes,
        operations: Math.max(0, totals.operations - last.operations.length),
        operationBytes: Math.max(0, totals.operationBytes - new TextEncoder().encode(json(last.operations)).length) }, now));
    statements.push(db.prepare("DELETE FROM wta_snapshots WHERE kind='wtarg:delta_guard' AND scope=?").bind(last.scope));
    try { await db.batch(statements); }
    catch { throw failure("Canonical recovery conflicted; provider collection must remain stopped."); }
    return { rolledBack: true, batchId: last.batchId, remaining: last.batchId };
}
