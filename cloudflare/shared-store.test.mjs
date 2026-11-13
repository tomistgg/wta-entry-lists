import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { getSharedRoute, pruneSharedData, scheduledSharedRefresh, sharedDataResponse } from "./shared-store.mjs";
import { createSharedJob } from "./shared-collector.mjs";

const now = Date.parse("2026-11-12T12:00:00Z");
const tournament = { tournamentGroup: { id: 100, name: "Example" }, year: 2026, level: "WTA 250",
    title: "Example Open", city: "Example", startDate: "2026-11-09", endDate: "2026-11-15" };
const source = { from: "2025-12-01", to: "2027-12-31", items: [tournament] };
const final = { DrawMatchType: "S", DrawLevelType: "M", RoundID: "F", MatchID: "LS001", MatchState: "F", Winner: "2",
    MatchTimeStamp: "2026-11-12T10:00:00Z", MatchTimeTotal: "00:30:00", PlayerIDA: "1", PlayerIDB: "2",
    PlayerNameFirstA: "Main", PlayerNameLastA: "Player", PlayerNameFirstB: "Other", PlayerNameLastB: "Player",
    PlayerCountryA: "ARG", PlayerCountryB: "FRA", ScoreSet1A: 6, ScoreSet1B: 4, ScoreSet2A: 6, ScoreSet2B: 3 };
const profile = { id: "1", name: "Main Player", display_name: "Chosen Name", aliases: ["Existing Alias"],
    country: "ARG", dob: "2000-01-01", rank: 10, previous_rank: 12, points: 1000, last_rank: 10,
    last_rank_date: "2026-11-02", best_rank: 2, best_rank_year: 2020, latest_title: null, tour_title_count: 999, tour_title_ids: [] };
const oldTitle = { tournament_id: "99", year: 2020, champion: { id: "1", name: "Main Player" },
    category: "WTA 250", start_date: "2020-01-01", end_date: "2020-01-05", name: "Old Open" };

async function setup(t, clock = () => now) {
    t.mock.method(Date, "now", clock);
    const mf = new Miniflare({ script: "export default {fetch() {return new Response('local')}}", modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { TEST_DB: "shared-store-test" } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("TEST_DB");
    for (const name of ["schema.sql", "shared-schema.sql"]) {
        const sql = await readFile(new URL(name, import.meta.url), "utf8");
        for (const statement of sql.split(";").filter(part => part.trim())) await db.prepare(statement).run();
    }
    const save = (kind, scope, payload, fetched = new Date(now).toISOString(), expiry = null) => db.prepare(
        "INSERT OR REPLACE INTO wta_snapshots VALUES (?, ?, ?, ?, ?)").bind(kind, scope, JSON.stringify(payload), fetched, expiry).run();
    await save("players", "metadata", { snapshot_date: "2026-11-02" });
    await save("player_names", "global", { by_wta_id: { "1": "Chosen Name", "900": "Outside Directory" }, by_name: { chosen: "Chosen Name" } });
    await save("champions", "metadata", { champion_count: 1, through: "2026-11-09", coverage_note: "Imported coverage",
        missing_champions: [{ tournament_id: "100", year: 2026 }, { tournament_id: "200", year: 2001 }] });
    await save("calendar_source", "global", source, new Date(now).toISOString(), now + 1800000);
    await save("calendar", "global", { fields: ["name", "level", "startDate", "endDate", "calendarKey", "source"],
        weeks: { "2026-11-09": [["ITF Event", "W15", "2026-11-09", "2026-11-15", "itf:keep", "ITF"]] } });
    await db.prepare("INSERT INTO wta_players VALUES ('1', ?, ?)").bind(JSON.stringify(profile), new Date(now).toISOString()).run();
    await db.prepare("INSERT INTO wta_titles VALUES ('99', 2020, '1', '2020-01-05', ?)").bind(JSON.stringify(oldTitle)).run();
    await db.prepare("UPDATE entry_list_state SET snapshot = '{\"keep\":true}' WHERE id = 1").run();
    return { db, save };
}

function service(db, io) {
    const call = (pathname, method = "GET") => sharedDataResponse(new Request("https://example.workers.dev" + pathname,
        { method, headers: { Origin: "https://tomistgg.github.io" } }), { ENTRY_LISTS_DB: db }, {}, () => io);
    return { call, async finish(pathname) {
        for (let step = 0; step < 100; step++) {
            const response = await call(pathname, "POST");
            const data = await response.json();
            if (response.status !== 202) return { response, data };
        }
        throw new Error("Shared refresh never completed");
    } };
}

function io(options = {}) {
    return { cachedCalendar: async () => source, async fetchJSON(path, params) {
        options.count && options.count();
        if (path.includes("/players/ranked")) {
            const content = options.rankings || [
            { ranking: options.rank || 8, points: 1200, rankedAt: "2026-11-09", player: { id: 1, fullName: "New Official Name", countryCode: "ARG", dateOfBirth: "2000-01-01" } },
            { ranking: 100, points: 50, rankedAt: "2026-11-09", player: { id: 3, fullName: "New Player", countryCode: "FRA", dateOfBirth: "2006-01-01" } },
            ];
            return { pageInfo: { page: 0, numEntries: content.length }, content };
        }
        if (/\/players\/\d+\/matches/.test(path)) return { matches: [] };
        if (path.includes("/matches")) { await options.hold?.(); if (options.fail) throw new Error("provider private failure"); return { matches: [final, { ...final, DrawMatchType: "D", MatchID: "LD001" }] }; }
        return { pageInfo: { page: Number(params.page), numEntries: 1 }, content: [tournament] };
    } };
}

test("shared routes validate identities and read imported player/title/calendar data without writes", async t => {
    const { db } = await setup(t);
    assert.equal(getSharedRoute("/data/players/0/form"), null);
    assert.equal(getSharedRoute("/data/players/1/form").scope, "1");
    const { call } = service(db, io());
    assert.equal((await call("/data/unknown")).status, 404);
    assert.equal((await call("/data/players/refresh")).status, 405);
    const saved = (await (await call("/data/players")).json()).snapshot;
    assert.equal(saved.players[0].display_name, "Chosen Name");
    assert.equal(saved.players[0].tour_title_count, 1, "title table overrides stale compatibility summaries");
    assert.equal(saved.players[0].latest_title.tournament_id, "99");
    assert.equal(saved.player_names.by_wta_id[900], "Outside Directory");
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_refresh_state").first()).count, 0);
});

test("one match refresh serves results, draws, champions, visitors and reloads with one cooldown", async t => {
    const { db } = await setup(t);
    const priorEdition = { ...oldTitle, tournament_id: "100", year: 2026,
        champion: { id: "2", name: "Previous Winner" }, country: "ARG", source_url: "https://example.test/saved-title" };
    await db.prepare("INSERT INTO wta_titles VALUES ('100', 2026, '2', '2020-01-05', ?)")
        .bind(JSON.stringify(priorEdition)).run();
    let requests = 0;
    const api = service(db, io({ count: () => requests++ }));
    const first = await api.finish("/data/results/refresh");
    assert.equal(first.response.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.snapshot.matches.length, 1);
    assert.equal(first.data.next_refresh_at, now + 120000);
    const before = requests;
    const other = await api.finish("/data/draws/refresh");
    assert.equal(other.data.snapshot.tournaments.length, 1);
    assert.equal(requests, before, "draw refresh reuses the same shared match gate");
    const titles = (await (await api.call("/data/champions")).json()).snapshot;
    assert.equal(titles.champion_count, 2);
    assert.equal(titles.coverage_note, "Imported coverage");
    assert.deepEqual(titles.missing_champions, [{ tournament_id: "200", year: 2001 }]);
    assert.equal(titles.through, "2026-11-15");
    const players = (await (await api.call("/data/players")).json()).snapshot;
    assert.equal(players.players[0].tour_title_count, 2);
    assert.equal(players.players[0].latest_title.tournament_id, "100");
    const corrected = await db.prepare("SELECT * FROM wta_titles WHERE tournament_id = '100' AND year = 2026").first();
    const titlePayload = JSON.parse(corrected.title_json);
    assert.equal(corrected.champion_id, "1", "a confirmed winner correction updates the authoritative winner");
    assert.equal(corrected.end_date, "2026-11-15");
    assert.equal(titlePayload.champion.id, "1");
    assert.equal(titlePayload.source_url, priorEdition.source_url, "sparser live finals preserve saved source metadata");
    assert.equal(titlePayload.country, "ARG");
    await db.prepare("UPDATE wta_snapshots SET payload_json = json_set(payload_json, '$.through', '2026-12-31') " +
        "WHERE kind = 'champions' AND scope = 'metadata'").run();
    await db.prepare("UPDATE wta_refresh_state SET next_refresh_at = 0 WHERE kind = 'matches'").run();
    await api.finish("/data/champions/refresh");
    assert.equal((await (await api.call("/data/champions")).json()).snapshot.through, "2026-12-31",
        "a later saved coverage date must never move backward");
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_titles").first()).count, 2, "repeated finals cannot duplicate titles");
    assert.equal((await db.prepare("SELECT snapshot FROM entry_list_state").first()).snapshot, '{"keep":true}');
    await pruneSharedData(db, now + 86400001);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind = 'draws'").first()).count, 1,
        "a still-active tournament's saved draw survives an upstream outage longer than a day");
});

test("ranking refresh preserves curated details and career bests without shifting previous rank twice", async t => {
    const { db } = await setup(t);
    await db.prepare("INSERT INTO wta_players VALUES ('2', ?, ?)").bind(JSON.stringify({ ...profile, id: "2",
        name: "Missing Player", rank: 11, previous_rank: 9 }), new Date(now).toISOString()).run();
    const first = await service(db, io()).finish("/data/players/refresh");
    assert.equal(first.response.status, 200, JSON.stringify(first.data));
    let player = first.data.snapshot.players.find(player => player.id === "1");
    assert.equal(player.rank, 8);
    assert.equal(player.previous_rank, 10);
    assert.equal(player.best_rank, 2);
    assert.equal(player.best_rank_year, 2020);
    assert.equal(player.display_name, "Chosen Name");
    assert.ok(player.aliases.includes("Existing Alias"));
    assert.equal(first.data.snapshot.players.find(player => player.id === "2").previous_rank, null,
        "unranked profiles do not display a previous-week ranking as a current ranking comparison");
    assert.equal(first.data.snapshot.players.find(player => player.id === "3").best_rank, null, "a new current rank cannot prove a lifetime career best");
    await db.prepare("UPDATE wta_refresh_state SET next_refresh_at = 0 WHERE kind = 'players'").run();
    const again = await service(db, io({ rank: 1 })).finish("/data/players/refresh");
    player = again.data.snapshot.players.find(player => player.id === "1");
    assert.equal(player.previous_rank, 10);
    assert.equal(player.best_rank, 1);
    assert.equal(player.best_rank_year, 2026);
});

test("title checkpoint and pending finals survive reloads, source failures, pruning and an old saved job", async t => {
    let current = Date.parse("2026-11-18T12:00:00Z");
    const { db, save } = await setup(t, () => current);
    const ended = { ...tournament, tournamentGroup: { id: 101, name: "Missed final" } };
    const active = { ...tournament, startDate: "2026-11-16", endDate: "2026-11-22" };
    await save("title_tracking", "global", { version: 1, checked_through: "2026-11-12", pending: [] });
    let failing = true;
    const calls = [];
    const factory = () => ({ cachedCalendar: async () => ({ ...source, items: [ended, active] }),
        fetchJSON: async path => {
            calls.push(path);
            if (path.includes("/101/") && failing) throw new Error("Final not published yet");
            return { matches: [{ ...final, MatchTimeStamp: path.includes("/101/") ? "2026-11-15T10:00:00Z" : "2026-11-18T10:00:00Z" }] };
        } });
    // An update installed mid-job must rediscover titles instead of accepting the old rolling-window-only job.
    await db.prepare("INSERT INTO wta_refresh_state (kind, scope, job_json, job_expires_at) VALUES ('matches', 'global', ?, ?)")
        .bind(JSON.stringify({ kind: "matches", scope: "global", stage: "events", tournaments: [], index: 0,
            event_matches: [], started_at: new Date(current).toISOString(), now_ms: current, today: "2026-11-18" }), current + 900000).run();
    let refreshed = await service(db, factory()).finish("/data/results/refresh");
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.data));
    assert.equal(refreshed.data.snapshot.matches.length, 1);
    assert.ok(calls.some(path => path.includes("/101/")), "old in-flight jobs restart with title tracking");
    let tracking = JSON.parse((await db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind = 'title_tracking'").first()).payload_json);
    assert.equal(tracking.checked_through, "2026-11-18");
    assert.equal(tracking.pending[0].tournamentGroup.id, 101);

    await pruneSharedData(db, current + 86400001);
    assert.equal((await db.prepare("SELECT expires_at FROM wta_snapshots WHERE kind = 'title_tracking'").first()).expires_at, null,
        "title retry metadata survives temporary-feed cleanup");
    current += 120001;
    const before = (await db.prepare("SELECT * FROM wta_snapshots WHERE kind = 'title_tracking'").first());
    const failed = await service(db, { ...factory(), fetchJSON: async () => { throw new Error("Current source unavailable"); } })
        .finish("/data/results/refresh");
    assert.equal(failed.response.status, 502);
    assert.deepEqual(await db.prepare("SELECT * FROM wta_snapshots WHERE kind = 'title_tracking'").first(), before,
        "a failed current refresh cannot advance the discovery checkpoint or discard pending editions");

    current += 15001;
    failing = false;
    refreshed = await service(db, factory()).finish("/data/champions/refresh");
    assert.equal(refreshed.response.status, 200, JSON.stringify(refreshed.data));
    assert.equal(refreshed.data.snapshot.champions.filter(title => title.tournament_id === "101").length, 1);
    tracking = JSON.parse((await db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind = 'title_tracking'").first()).payload_json);
    assert.deepEqual(tracking.pending, []);
    current += 120001;
    calls.length = 0;
    await service(db, factory()).finish("/data/champions/refresh");
    assert.equal(calls.some(path => path.includes("/101/")), false, "resolved old editions are not fetched again");
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_titles WHERE tournament_id = '101'").first()).count, 1);
});

test("the two-year player directory includes the February 28 leap-year boundary", async t => {
    const { db, save } = await setup(t);
    await save("players", "metadata", { snapshot_date: "2024-02-29" });
    await db.prepare("UPDATE wta_players SET profile_json = ? WHERE player_id = '1'")
        .bind(JSON.stringify({ ...profile, rank: null, last_rank_date: "2022-02-28" })).run();
    const data = await (await service(db, io()).call("/data/players")).json();
    assert.equal(data.snapshot.players.length, 1);
});

test("same-week ranking corrections retain the previous published week across temporary omissions", async t => {
    let current = now;
    const { db, save } = await setup(t, () => current);
    await save("players", "metadata", { snapshot_date: "2026-11-09" });
    await db.prepare("UPDATE wta_players SET profile_json = ? WHERE player_id = '1'")
        .bind(JSON.stringify({ ...profile, rank: 22, last_rank: 22, previous_rank: 20, last_rank_date: "2026-11-09" })).run();
    const rankingRow = (id, ranking, rankedAt) => ({ ranking, points: 1200, rankedAt,
        player: { id, fullName: "Player " + id, countryCode: "ARG", dateOfBirth: "2000-01-01" } });
    const refresh = async rankings => {
        await db.prepare("UPDATE wta_refresh_state SET next_refresh_at = 0 WHERE kind = 'players'").run();
        const result = await service(db, io({ rankings })).finish("/data/players/refresh");
        assert.equal(result.response.status, 200, JSON.stringify(result.data));
        return result.data.snapshot.players.find(player => player.id === "1");
    };
    let player = await refresh([rankingRow(3, 100, "2026-11-09")]);
    assert.equal(player.rank, null);
    assert.equal(player.previous_rank, null, "NR public profiles hide their stored comparison baseline");
    assert.equal(JSON.parse((await db.prepare("SELECT profile_json FROM wta_players WHERE player_id = '1'").first()).profile_json).previous_rank, 20);
    player = await refresh([rankingRow(1, 23, "2026-11-09"), rankingRow(3, 100, "2026-11-09")]);
    assert.equal(player.previous_rank, 20);

    current += 7 * 86400000;
    player = await refresh([rankingRow(3, 100, "2026-11-16")]);
    assert.equal(player.rank, null);
    assert.equal(player.previous_rank, null);
    player = await refresh([rankingRow(1, 24, "2026-11-16"), rankingRow(3, 100, "2026-11-16")]);
    assert.equal(player.previous_rank, 23, "the first new-week publication captures the old current rank once");
});

test("simultaneous refreshes share a lease and failed publication keeps all previous data", async t => {
    const { db, save } = await setup(t);
    let entered, release, requests = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const api = service(db, io({ count: () => requests++, hold: async () => { entered(); await held; } }));
    const running = api.call("/data/results/refresh", "POST");
    await started;
    assert.equal((await api.call("/data/draws/refresh", "POST")).status, 202);
    release();
    assert.equal((await running).status, 200);
    assert.equal(requests, 1);
    const before = (await db.prepare("SELECT * FROM wta_snapshots WHERE kind IN ('results', 'draws') ORDER BY kind").all()).results;
    const trackingBefore = await db.prepare("SELECT * FROM wta_snapshots WHERE kind = 'title_tracking'").first();
    await db.prepare("UPDATE wta_refresh_state SET next_refresh_at = 0 WHERE kind = 'matches'").run();
    const failed = await service(db, io({ fail: true })).finish("/data/results/refresh");
    assert.equal(failed.response.status, 502);
    assert.equal(failed.data.snapshot.matches.length, 1);
    assert.equal(JSON.stringify(failed.data).includes("provider private"), false);
    assert.deepEqual((await db.prepare("SELECT * FROM wta_snapshots WHERE kind IN ('results', 'draws') ORDER BY kind").all()).results, before);
    await db.prepare("UPDATE wta_refresh_state SET next_refresh_at = 0 WHERE kind = 'matches'").run();
    await db.prepare("CREATE TRIGGER fail_draw BEFORE INSERT ON wta_snapshots WHEN NEW.kind = 'draws' " +
        "BEGIN SELECT RAISE(ABORT, 'cannot publish'); END").run();
    const aborted = await service(db, io()).finish("/data/results/refresh");
    assert.equal(aborted.response.status, 502);
    assert.deepEqual((await db.prepare("SELECT * FROM wta_snapshots WHERE kind IN ('results', 'draws') ORDER BY kind").all()).results, before);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_titles").first()).count, 2);
    assert.deepEqual(await db.prepare("SELECT * FROM wta_snapshots WHERE kind = 'title_tracking'").first(), trackingBefore,
        "a publication rollback keeps the title checkpoint in the same transaction as feeds and titles");
});

test("expiry removes old feeds and form jobs without deleting player or title statistics", async t => {
    const { db, save } = await setup(t);
    const api = service(db, io());
    const form = await api.finish("/data/players/1/form/refresh");
    assert.equal(form.response.status, 200, JSON.stringify(form.data));
    assert.equal(form.data.snapshot.results.length, 10);
    assert.equal(form.data.snapshot.results.at(-1), "win");
    await save("results", "global", { updated_at: new Date(now).toISOString(), matches: [{ completed_at: "2026-11-10T10:00:00Z" }] }, new Date(now).toISOString(), now + 86400000);
    await save("draws", "global", { tournaments: [{ start_date: "2026-11-02", end_date: "2026-11-08" }] }, new Date(now).toISOString(), now + 86400000);
    assert.deepEqual((await (await api.call("/data/results")).json()).snapshot.matches, []);
    assert.deepEqual((await (await api.call("/data/draws")).json()).snapshot.tournaments, []);
    await pruneSharedData(db, now + 300001);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind = 'player_form'").first()).count, 0);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_refresh_state WHERE kind = 'player_form'").first()).count, 0);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_players").first()).count, 1);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_titles").first()).count, 1);
});

test("unknown form IDs cannot create jobs, source caches or upstream requests", async t => {
    const { db } = await setup(t);
    let requests = 0;
    const api = service(db, io({ count: () => requests++ }));
    for (const id of ["999", "1234567890"]) {
        const response = await api.call(`/data/players/${id}/form/refresh`, "POST");
        assert.equal(response.status, 404);
        assert.match((await response.json()).error, /saved WTA directory/);
    }
    assert.equal(requests, 0);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_refresh_state").first()).count, 0);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind = 'source'").first()).count, 0);
    await db.prepare("INSERT INTO wta_refresh_state (kind, scope, job_json, job_expires_at) " +
        "VALUES ('player_form', '999', '{}', ?)").bind(now + 900000).run();
    await pruneSharedData(db);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_refresh_state").first()).count, 0,
        "pre-upgrade unknown-player jobs cannot keep occupying scheduler turns");
});

test("form admission is atomic across visitors, bounds queued work and allows existing jobs to resume", async t => {
    const { db } = await setup(t);
    for (const id of ["2", "3", "4", "5", "6"]) await db.prepare("INSERT INTO wta_players VALUES (?, ?, ?)")
        .bind(id, JSON.stringify({ ...profile, id }), new Date(now).toISOString()).run();
    for (const id of ["2", "3", "4", "6"]) await db.prepare(
        "INSERT INTO wta_refresh_state (kind, scope, job_json, job_expires_at) VALUES ('player_form', ?, ?, ?)")
        .bind(id, JSON.stringify(createSharedJob("player_form", id, now)), now + 900000).run();
    const api = service(db, io());
    const full = await api.call("/data/players/1/form/refresh", "POST");
    assert.equal(full.status, 429);
    assert.equal(full.headers.get("Retry-After"), "15");
    assert.match((await full.json()).error, /Several player forms/);
    assert.equal((await api.finish("/data/players/2/form/refresh")).response.status, 200,
        "a saved job can finish while all four slots are occupied");

    let release;
    const held = new Promise(resolve => { release = resolve; });
    const base = io();
    const racing = service(db, { ...base, async fetchJSON(path, params) {
        await held;
        return base.fetchJSON(path, params);
    } });
    const fallback = setTimeout(release, 1000);
    t.after(() => { clearTimeout(fallback); release(); });
    const responses = await Promise.all(["1", "5"].map(async id => {
        const response = await racing.call(`/data/players/${id}/form/refresh`, "POST");
        if (response.status === 429) release();
        return response;
    }));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 429],
        "concurrent visitors cannot both claim the final form-job slot");
});

test("scheduled work advances only one bounded job and calendar merge preserves non-WTA rows", async t => {
    const { db } = await setup(t);
    let requests = 0;
    const factory = () => io({ count: () => requests++ });
    assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, factory), true, "old player week needs updating");
    assert.equal(requests, 1);
    assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, factory), true, "missing results need one job");
    assert.equal(requests, 2);
    assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, factory), false);
    const api = service(db, io());
    const calendar = await api.finish("/data/calendar/refresh");
    assert.equal(calendar.response.status, 200, JSON.stringify(calendar.data));
    const fields = calendar.data.snapshot.fields;
    const rows = Object.values(calendar.data.snapshot.weeks).flat();
    assert.ok(rows.some(row => row[fields.indexOf("calendarKey")] === "itf:keep"));
    assert.ok(rows.some(row => row[fields.indexOf("calendarKey")] === "wta:100:2026"));
});

test("a failing calendar job cannot starve healthy scheduled matches and rankings", async t => {
    let current = now;
    const { db } = await setup(t, () => current);
    await db.prepare("DELETE FROM wta_snapshots WHERE kind = 'calendar_source'").run();
    const base = io();
    const factory = () => ({ ...base, async fetchJSON(path, params) {
        if (path.includes("/tournaments/") && !path.includes("/matches")) throw new Error("calendar unavailable");
        return base.fetchJSON(path, params);
    } });
    assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, factory), true);
    assert.match((await db.prepare("SELECT error FROM wta_refresh_state WHERE kind = 'calendar'").first()).error, /could not/);
    current += 60000;
    assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, factory), true);
    assert.ok((await db.prepare("SELECT last_success_at FROM wta_refresh_state WHERE kind = 'matches'").first()).last_success_at);
    current += 60000;
    assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, factory), true);
    assert.ok((await db.prepare("SELECT last_success_at FROM wta_refresh_state WHERE kind = 'players'").first()).last_success_at);
});

test("overdue weekly rankings run between stages of a slow match job", async t => {
    let current = now;
    const { db, save } = await setup(t, () => current);
    await save("players", "metadata", { snapshot_date: "2026-11-09" });
    const several = { ...source, items: Array.from({ length: 5 }, (_, index) => ({ ...tournament,
        tournamentGroup: { id: 100 + index, name: "Event " + index } })) };
    const factory = () => ({ ...io(), cachedCalendar: async () => several });
    assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, factory), true);
    assert.ok((await db.prepare("SELECT job_json FROM wta_refresh_state WHERE kind = 'matches'").first()).job_json);
    await save("players", "metadata", { snapshot_date: "2026-11-02" });
    current += 6 * 60000;
    assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, factory), true);
    assert.ok((await db.prepare("SELECT last_success_at FROM wta_refresh_state WHERE kind = 'players'").first()).last_success_at);
    assert.ok((await db.prepare("SELECT job_json FROM wta_refresh_state WHERE kind = 'matches'").first()).job_json,
        "a ranking turn preserves the interrupted match job");
    current += 60000;
    assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, factory), true);
    assert.equal((await db.prepare("SELECT job_json FROM wta_refresh_state WHERE kind = 'matches'").first()).job_json, null);
});

test("queued player forms share scheduler turns with overdue global feeds and each other", async t => {
    let current = now;
    const { db } = await setup(t, () => current);
    await db.prepare("INSERT INTO wta_players VALUES ('2', ?, ?)")
        .bind(JSON.stringify({ ...profile, id: "2" }), new Date(now).toISOString()).run();
    for (const id of ["1", "2"]) {
        const job = { ...createSharedJob("player_form", id, now), stage: "events",
            tournaments: Array.from({ length: 10 }, (_, index) => ({ ...tournament,
                tournamentGroup: { id: index + 10, name: "Event " + index } })) };
        await db.prepare("INSERT INTO wta_refresh_state (kind, scope, job_json, job_expires_at) VALUES ('player_form', ?, ?, ?)")
            .bind(id, JSON.stringify(job), now + 900000).run();
    }
    for (let step = 0; step < 4; step++) {
        assert.equal(await scheduledSharedRefresh({ ENTRY_LISTS_DB: db }, () => io()), true);
        current += 60000;
    }
    assert.ok((await db.prepare("SELECT last_success_at FROM wta_refresh_state WHERE kind = 'matches'").first()).last_success_at,
        "queued form jobs do not delay missing results");
    assert.ok((await db.prepare("SELECT last_success_at FROM wta_refresh_state WHERE kind = 'players'").first()).last_success_at,
        "queued form jobs do not delay a new ranking week");
    const forms = (await db.prepare("SELECT job_json FROM wta_refresh_state WHERE kind = 'player_form'").all()).results;
    assert.equal(forms.length, 2);
    assert.deepEqual(forms.map(row => JSON.parse(row.job_json).index), [4, 4],
        "every interrupted form gets a bounded turn before the first form runs again");
});
