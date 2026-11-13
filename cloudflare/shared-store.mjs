import { createSharedJob, advanceSharedJob } from "./shared-collector.mjs";
import { mergeCalendar } from "./shared-models.mjs";
import { createSharedIO } from "./shared-io.mjs";

const DAY = 86400000;
const COOLDOWN = 120000;
const LEASE = 90000;
const JOB_LIFETIME = 900000;
const BACKOFF = 15000;
const MAX_FORM_JOBS = 4;
const encoder = new TextEncoder();
const iso = value => new Date(value).toISOString();
const today = value => iso(value).slice(0, 10);
const stateKey = route => [route.kind, route.scope];

function jsonText(value) {
    const text = JSON.stringify(value);
    if (encoder.encode(text).length > 1900000) throw new Error("Shared data exceeds the D1 row limit.");
    return text;
}

export function getSharedRoute(pathname) {
    const form = /^\/data\/players\/([1-9]\d{0,9})\/form(\/refresh)?$/.exec(pathname);
    if (form) return { kind: "player_form", scope: form[1], view: "player_form", refresh: !!form[2] };
    const match = /^\/data\/(players|calendar|results|draws|champions)(\/refresh)?$/.exec(pathname);
    if (!match) return null;
    return { kind: ["results", "draws", "champions"].includes(match[1]) ? "matches" : match[1],
        scope: "global", view: match[1], refresh: !!match[2] };
}

const snapshotRow = (db, kind, scope = "global") => db.prepare(
    "SELECT * FROM wta_snapshots WHERE kind = ? AND scope = ?").bind(kind, scope).first();
const readState = (db, route) => db.prepare(
    "SELECT * FROM wta_refresh_state WHERE kind = ? AND scope = ?").bind(...stateKey(route)).first();

async function readPlayers(db) {
    const [metadata, names, rows, titles] = await Promise.all([
        snapshotRow(db, "players", "metadata"), snapshotRow(db, "player_names"),
        db.prepare("SELECT profile_json FROM wta_players").all(),
        db.prepare("SELECT champion_id, title_json FROM wta_titles ORDER BY end_date, " +
            "json_extract(title_json, '$.start_date'), tournament_id").all(),
    ]);
    if (!metadata) return null;
    const date = JSON.parse(metadata.payload_json).snapshot_date;
    const cutoff = new Date(date + "T00:00:00Z");
    const cutoffMonth = cutoff.getUTCMonth();
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 2);
    if (cutoff.getUTCMonth() !== cutoffMonth) cutoff.setUTCDate(0);
    const summaries = new Map();
    for (const row of titles.results) {
        const title = JSON.parse(row.title_json);
        const summary = summaries.get(row.champion_id) || { count: 0, ids: [], tour: null, wta125: null };
        if (["WTA 125", "125K"].includes(title.category)) summary.wta125 = title;
        else { summary.count++; summary.ids.push(String(title.tournament_id) + ":" + title.year); summary.tour = title; }
        summaries.set(row.champion_id, summary);
    }
    const players = rows.results.map(row => JSON.parse(row.profile_json))
        .filter(player => player.last_rank_date >= today(cutoff.getTime())).map(player => {
            const title = summaries.get(String(player.id));
            return { ...player, previous_rank: player.rank === null ? null : player.previous_rank,
                tour_title_count: title?.count || 0, tour_title_ids: title?.ids || [],
                latest_title: title?.tour || title?.wta125 || null };
        }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
    return { snapshot_date: date, players, player_names: names ? JSON.parse(names.payload_json) : { by_wta_id: {}, by_name: {} } };
}

async function readChampions(db) {
    const [metadata, records] = await Promise.all([
        snapshotRow(db, "champions", "metadata"),
        db.prepare("SELECT title_json FROM wta_titles ORDER BY end_date, json_extract(title_json, '$.start_date'), tournament_id").all(),
    ]);
    if (!metadata && !records.results.length) return null;
    const champions = records.results.map(row => JSON.parse(row.title_json));
    return { ...(metadata ? JSON.parse(metadata.payload_json) : {}), champion_count: champions.length, champions };
}

async function readSnapshot(db, route, now = Date.now()) {
    if (route.view === "players") return readPlayers(db);
    if (route.view === "champions") return readChampions(db);
    const row = await snapshotRow(db, route.view, route.scope);
    if (!row || row.expires_at !== null && row.expires_at <= now) return null;
    const payload = JSON.parse(row.payload_json);
    if (route.view === "results") return { ...payload,
        matches: payload.matches.filter(match => Date.parse(match.completed_at) >= now - DAY && Date.parse(match.completed_at) <= now) };
    if (route.view === "draws") return { ...payload, tournaments: payload.tournaments.filter(tournament =>
        tournament.start_date.slice(0, 10) <= today(now) && tournament.end_date.slice(0, 10) >= today(now)) };
    return payload;
}

async function publicState(db, route, now = Date.now()) {
    const [row, snapshot] = await Promise.all([readState(db, route), readSnapshot(db, route, now)]);
    const job = row?.job_json && row.job_expires_at > now ? JSON.parse(row.job_json) : null;
    return { snapshot, refreshing: !!job || (row?.lease_until || 0) > now,
        next_refresh_at: row?.next_refresh_at || 0, progress: job?.progress || "", error: row?.error || null };
}

function snapshotStatement(db, route, token, kind, scope, payload, fetchedAt, expiresAt = null) {
    return db.prepare("INSERT INTO wta_snapshots (kind, scope, payload_json, fetched_at, expires_at) " +
        "SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM wta_refresh_state WHERE kind = ? AND scope = ? AND lease_token = ?) " +
        "ON CONFLICT(kind, scope) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at")
        .bind(kind, scope, jsonText(payload), fetchedAt, expiresAt, ...stateKey(route), token);
}

function playerUpdates(previous, rankings, rankingDate, previousDate, nameIndex) {
    const ranked = new Map(rankings.map(row => [String(row.id), row]));
    const profiles = new Map(previous.map(profile => [String(profile.id), profile]));
    for (const row of rankings) if (!profiles.has(String(row.id))) profiles.set(String(row.id), { id: String(row.id),
        name: row.name, display_name: nameIndex.by_wta_id?.[row.id] || row.name, aliases: [row.name],
        country: row.country || "", dob: row.dob || "", rank: null, previous_rank: null, points: 0,
        last_rank: row.rank, last_rank_date: rankingDate, best_rank: null, best_rank_year: null });
    return [...profiles.values()].map(old => {
        const row = ranked.get(String(old.id));
        const name = row?.name || old.name;
        const advanced = previousDate < rankingDate;
        const best = row && old.best_rank && row.rank <= old.best_rank ? row.rank : old.best_rank;
        return { ...old, name, display_name: nameIndex.by_wta_id?.[old.id] ||
            (old.display_name && old.display_name !== old.name ? old.display_name : name),
            aliases: [...new Set([...(old.aliases || []), old.name, name].filter(Boolean))],
            country: row?.country || old.country || "", dob: row?.dob || old.dob || "",
            rank: row?.rank ?? null, points: row?.points ?? 0,
            previous_rank: advanced ? old.rank ?? null : old.previous_rank ?? null,
            last_rank: row?.rank ?? old.last_rank, last_rank_date: row ? rankingDate : old.last_rank_date,
            best_rank: best ?? null, best_rank_year: row && old.best_rank && row.rank <= old.best_rank
                ? Number(rankingDate.slice(0, 4)) : old.best_rank_year ?? null };
    });
}

async function publishResult(db, route, token, result, job, now) {
    const fetchedAt = job.started_at || iso(now);
    const statements = [];
    const add = (kind, scope, payload, expiry = null) => statements.push(snapshotStatement(
        db, route, token, kind, scope, payload, fetchedAt, expiry));
    if (route.kind === "calendar") {
        const old = await snapshotRow(db, "calendar");
        add("calendar_source", "global", result.calendar_source, now + 1800000);
        add("calendar", "global", mergeCalendar(old ? JSON.parse(old.payload_json) : null, result.calendar_source));
    } else if (route.kind === "players") {
        const [old, metadata, names] = await Promise.all([
            db.prepare("SELECT profile_json FROM wta_players").all(), snapshotRow(db, "players", "metadata"), snapshotRow(db, "player_names"),
        ]);
        const previousDate = metadata ? JSON.parse(metadata.payload_json).snapshot_date : "";
        if (previousDate > result.ranking_date) throw new Error("Refusing an older WTA ranking week.");
        const profiles = playerUpdates(old.results.map(row => JSON.parse(row.profile_json)), result.rankings,
            result.ranking_date, previousDate, names ? JSON.parse(names.payload_json) : {});
        for (const profile of profiles) statements.push(db.prepare(
            "INSERT INTO wta_players (player_id, profile_json, updated_at) SELECT ?, ?, ? " +
            "WHERE EXISTS (SELECT 1 FROM wta_refresh_state WHERE kind = ? AND scope = ? AND lease_token = ?) " +
            "ON CONFLICT(player_id) DO UPDATE SET profile_json = excluded.profile_json, updated_at = excluded.updated_at")
            .bind(profile.id, jsonText(profile), fetchedAt, ...stateKey(route), token));
        add("players", "metadata", { snapshot_date: result.ranking_date });
        add("rankings", "singles:" + result.ranking_date, result.rankings.map(row =>
            ({ id: String(row.id), name: row.name, country: row.country || "-", rank: row.rank })), now + DAY);
    } else if (route.kind === "matches") {
        add("results", "global", result.results, now + DAY);
        const drawExpiry = result.draws.tournaments.reduce((latest, tournament) => Math.max(latest,
            Date.parse(tournament.end_date.slice(0, 10) + "T00:00:00Z") + DAY), now + 300000);
        add("draws", "global", result.draws, drawExpiry);
        add("event_matches", "global", result.event_matches, now + 300000);
        add("title_tracking", "global", result.title_tracking);
        for (const title of result.champions) statements.push(db.prepare(
            "INSERT INTO wta_titles (tournament_id, year, champion_id, end_date, title_json) SELECT ?, ?, ?, ?, ? " +
            "WHERE EXISTS (SELECT 1 FROM wta_refresh_state WHERE kind = ? AND scope = ? AND lease_token = ?) " +
            "ON CONFLICT(tournament_id, year) DO UPDATE SET champion_id = excluded.champion_id, end_date = excluded.end_date, " +
            "title_json = json_patch(wta_titles.title_json, excluded.title_json)")
            .bind(String(title.tournament_id), title.year, String(title.champion.id), title.end_date,
                jsonText(title), ...stateKey(route), token));
        const previous = await snapshotRow(db, "champions", "metadata");
        const metadata = previous ? JSON.parse(previous.payload_json) : {};
        if (Array.isArray(metadata.missing_champions)) {
            const complete = new Set(result.champions.map(title => String(title.tournament_id) + ":" + title.year));
            metadata.missing_champions = metadata.missing_champions.filter(title => !complete.has(String(title.tournament_id) + ":" + title.year));
            metadata.missing_champion_count = metadata.missing_champions.length;
        }
        const latestTitleDate = result.champions.reduce((latest, title) => title.end_date > latest ? title.end_date : latest, "");
        if (latestTitleDate && (!metadata.through || latestTitleDate > metadata.through)) metadata.through = latestTitleDate;
        add("champions", "metadata", { ...metadata, updated_at: iso(now) });
    } else add("player_form", route.scope, result, now + 300000);
    statements.push(db.prepare("UPDATE wta_refresh_state SET next_refresh_at = ?, job_json = NULL, job_expires_at = 0, " +
        "lease_token = NULL, lease_until = 0, last_success_at = ?, error = NULL WHERE kind = ? AND scope = ? AND lease_token = ?")
        .bind(now + COOLDOWN, iso(now), ...stateKey(route), token));
    await db.batch(statements);
}

async function advanceRefresh(db, route, ioFactory, now = Date.now()) {
    if (route.kind === "player_form" && !await db.prepare("SELECT player_id FROM wta_players WHERE player_id = ?")
        .bind(route.scope).first()) return { status: 404, state: { snapshot: null, refreshing: false,
        next_refresh_at: 0, progress: "", error: "This player is not in the saved WTA directory." } };
    await db.prepare("INSERT OR IGNORE INTO wta_refresh_state (kind, scope) VALUES (?, ?)").bind(...stateKey(route)).run();
    const token = crypto.randomUUID();
    const row = await db.prepare("UPDATE wta_refresh_state SET lease_token = ?, lease_until = ? " +
        "WHERE kind = ? AND scope = ? AND lease_until <= ? AND (job_json IS NOT NULL OR next_refresh_at <= ?) " +
        "AND (kind != 'player_form' OR (job_json IS NOT NULL AND job_expires_at > ?) OR " +
        "(SELECT count(*) FROM wta_refresh_state WHERE kind = 'player_form' AND " +
        "(lease_until > ? OR (job_json IS NOT NULL AND job_expires_at > ?))) < ?) RETURNING *")
        .bind(token, now + LEASE, ...stateKey(route), now, now, now, now, now, MAX_FORM_JOBS).first();
    if (!row) {
        const state = await publicState(db, route);
        if (route.kind === "player_form" && !state.refreshing && state.next_refresh_at <= now) {
            return { status: 429, state: { ...state, next_refresh_at: now + BACKOFF,
                error: "Several player forms are updating. Please try again shortly." } };
        }
        return { state, failed: false };
    }
    try {
        let job = row.job_json && row.job_expires_at > now ? JSON.parse(row.job_json) : null;
        if (!job || (route.kind === "matches" && job.title_scan?.version !== 1)) {
            let titles = null;
            if (route.kind === "matches") {
                const [tracking, known] = await Promise.all([
                    snapshotRow(db, "title_tracking"), db.prepare("SELECT tournament_id, year FROM wta_titles").all(),
                ]);
                titles = { ...(tracking ? JSON.parse(tracking.payload_json) : { pending: [] }),
                    known: known.results.map(title => String(title.tournament_id) + ":" + title.year) };
            }
            job = createSharedJob(route.kind, route.scope, now, titles);
        }
        const collected = await advanceSharedJob(job, ioFactory(db));
        if (collected.done) await publishResult(db, route, token, collected.result, collected.job, Date.now());
        else await db.prepare("UPDATE wta_refresh_state SET job_json = ?, job_expires_at = ?, lease_token = NULL, lease_until = 0, " +
            "error = NULL WHERE kind = ? AND scope = ? AND lease_token = ?")
            .bind(jsonText(collected.job), Date.now() + JOB_LIFETIME, ...stateKey(route), token).run();
        return { state: await publicState(db, route), failed: false };
    } catch {
        await db.prepare("UPDATE wta_refresh_state SET job_json = NULL, job_expires_at = 0, lease_token = NULL, lease_until = 0, " +
            "next_refresh_at = ?, error = ? WHERE kind = ? AND scope = ? AND lease_token = ?")
            .bind(Date.now() + BACKOFF, "WTA could not be refreshed. The last saved data is still available.", ...stateKey(route), token).run();
        return { state: await publicState(db, route), failed: true };
    }
}

export async function sharedDataResponse(request, env, headers = {}, ioFactory = createSharedIO) {
    const json = (payload, status = 200) => Response.json(payload, { status, headers });
    const route = getSharedRoute(new URL(request.url).pathname);
    if (!route) return json({ error: "Unknown shared data endpoint." }, 404);
    if (request.method !== (route.refresh ? "POST" : "GET")) return json({ error: "Method not allowed." }, 405);
    if (!env.ENTRY_LISTS_DB) return json({ error: "Shared data storage is not configured." }, 503);
    try {
        if (!route.refresh) return json(await publicState(env.ENTRY_LISTS_DB, route));
        const result = await advanceRefresh(env.ENTRY_LISTS_DB, route, ioFactory);
        const response = json(result.state, result.status || (result.failed ? 502 : result.state.refreshing ? 202 : 200));
        if (result.status === 429) response.headers.set("Retry-After", String(BACKOFF / 1000));
        return response;
    } catch {
        return json({ error: "Shared data storage is unavailable. Check the shared schema and baseline import." }, 503);
    }
}

export async function pruneSharedData(db, now = Date.now()) {
    const expired = await db.prepare("SELECT kind, scope, payload_json FROM wta_snapshots WHERE kind IN ('results', 'draws')").all();
    for (const row of expired.results) {
        const route = { kind: "matches", scope: "global", view: row.kind };
        const payload = await readSnapshot(db, route, now);
        if (payload && jsonText(payload) !== row.payload_json) await db.prepare(
            "UPDATE wta_snapshots SET payload_json = ? WHERE kind = ? AND scope = ? AND payload_json = ? " +
            "AND NOT EXISTS (SELECT 1 FROM wta_refresh_state WHERE kind = 'matches' AND scope = 'global' AND lease_until > ?)")
            .bind(jsonText(payload), row.kind, row.scope, row.payload_json, now).run();
    }
    await db.batch([
        db.prepare("DELETE FROM wta_snapshots WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now),
        db.prepare("UPDATE wta_refresh_state SET job_json = NULL, job_expires_at = 0, lease_token = NULL, lease_until = 0 " +
            "WHERE job_expires_at <= ? AND lease_until <= ? AND job_json IS NOT NULL").bind(now, now),
        db.prepare("DELETE FROM wta_refresh_state WHERE kind = 'player_form' AND job_json IS NULL AND lease_until <= ? " +
            "AND next_refresh_at <= ? AND NOT EXISTS (SELECT 1 FROM wta_snapshots WHERE kind = 'player_form' " +
            "AND wta_snapshots.scope = wta_refresh_state.scope)").bind(now, now),
        db.prepare("DELETE FROM wta_refresh_state WHERE kind = 'player_form' AND lease_until <= ? " +
            "AND NOT EXISTS (SELECT 1 FROM wta_players WHERE player_id = wta_refresh_state.scope)").bind(now),
    ]);
}

export async function scheduledSharedRefresh(env, ioFactory = createSharedIO) {
    if (!env.ENTRY_LISTS_DB) return false;
    const db = env.ENTRY_LISTS_DB;
    try {
        await pruneSharedData(db);
        const now = Date.now();
        const inflight = await db.prepare("SELECT kind, scope, job_expires_at FROM wta_refresh_state WHERE job_json IS NOT NULL " +
            "AND lease_until <= ? AND job_expires_at > ?").bind(now, now).all();
        // Job expiry is renewed after each stage; subtracting its lifetime gives the last stage's turn.
        const candidates = inflight.results.map(row => ({ route: { kind: row.kind, scope: row.scope,
            view: row.kind === "matches" ? "results" : row.kind }, nextRefresh: row.job_expires_at - JOB_LIFETIME }));
        for (const [kind, view, snapshotKind, scope, interval] of [
            ["calendar", "calendar", "calendar_source", "global", 1800000],
            ["matches", "results", "results", "global", 300000],
            ["players", "players", "players", "metadata", 7 * DAY],
        ]) {
            const route = { kind, scope: "global", view };
            const [saved, gate] = await Promise.all([snapshotRow(db, snapshotKind, scope), readState(db, route)]);
            const sourceDate = kind === "players" && saved ? JSON.parse(saved.payload_json).snapshot_date : null;
            const due = kind === "players"
                ? (!sourceDate || sourceDate < createSharedJob("players", "global", now).ranking_date)
                : (!saved || now - Date.parse(saved.fetched_at) >= interval);
            if (due && (gate?.lease_until || 0) <= now && (gate?.next_refresh_at || 0) <= now &&
                !candidates.some(candidate => candidate.route.kind === kind && candidate.route.scope === "global")) {
                candidates.push({ route, nextRefresh: gate?.next_refresh_at || 0 });
            }
        }
        candidates.sort((a, b) => a.nextRefresh - b.nextRefresh);
        if (candidates.length) {
            await advanceRefresh(db, candidates[0].route, ioFactory);
            return true;
        }
    } catch {
        console.error("Shared data refresh is unavailable; check the shared schema and baseline import.");
    }
    return false;
}
