import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { createSharedIO } from "./shared-io.mjs";

const reference = Date.parse("2026-11-12T10:00:00Z");
const tournament = { tournamentGroup: { id: 100, name: "Example" }, year: 2026,
    level: "WTA 125", startDate: "2026-11-09", endDate: "2026-11-15" };
const calendarParams = { from: "2026-11-09", to: "2026-11-16", page: 0, pageSize: 100, excludeLevels: "ITF" };
const calendar = () => ({ pageInfo: { page: 0, numEntries: 1 }, content: [tournament] });
const rankings = [{ id: "1", name: "Player", country: "ARG", rank: 20 }];

async function database(t, shared = true) {
    const mf = new Miniflare({ script: "export default { fetch() { return new Response('local'); } }", modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { TEST_DB: "shared-io-test" } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("TEST_DB");
    for (const file of shared ? ["schema.sql", "shared-schema.sql"] : ["schema.sql"]) {
        const schema = await readFile(new URL(file, import.meta.url), "utf8");
        for (const sql of schema.split(";").filter(value => value.trim())) await db.prepare(sql).run();
    }
    return db;
}

test("shared source calls use the fixed WTA host and canonical cache keys across clients", async t => {
    const db = await database(t);
    let now = reference, requests = 0;
    const upstream = async (url, options) => {
        requests++;
        assert.equal(url.origin, "https://api.wtatennis.com");
        assert.equal(url.pathname, "/tennis/tournaments/");
        assert.equal(options.headers.account, "wta");
        assert.equal(options.headers.Origin, "https://www.wtatennis.com");
        assert.equal(options.headers.Referer, "https://www.wtatennis.com/");
        assert.equal(options.redirect, "manual");
        assert.equal(options.cache, "no-store");
        assert.ok(options.signal instanceof AbortSignal);
        return Response.json(calendar());
    };
    const first = createSharedIO(db, { now: () => now, fetch: upstream });
    assert.deepEqual(await first.fetchJSON("/api/tennis/tournaments/", calendarParams), calendar());
    const saved = await db.prepare("SELECT fetched_at, expires_at FROM wta_snapshots WHERE kind = 'source'").first();
    now += 10000;
    const second = createSharedIO(db, { now: () => now, fetch: upstream });
    assert.deepEqual(await second.fetchJSON("/tennis/tournaments", { excludeLevels: "ITF", to: "2026-11-16",
        from: "2026-11-09", pageSize: 100 }), calendar());
    assert.equal(requests, 1);
    assert.deepEqual(await db.prepare("SELECT fetched_at, expires_at FROM wta_snapshots WHERE kind = 'source'").first(), saved,
        "reading cached data must not pretend it was fetched again");
    now = reference + 120000;
    await second.fetchJSON("/api/tennis/tournaments/", calendarParams);
    assert.equal(requests, 2, "the next permitted manual refresh cannot receive an older source cache");
});

test("unknown paths, extra parameters and doubles requests cannot become cached source proxies", async t => {
    const db = await database(t);
    let requests = 0;
    const io = createSharedIO(db, { now: () => reference, fetch: async () => { requests++; return Response.json({}); } });
    for (const [path, params] of [["https://other.example/tennis/tournaments", calendarParams],
        ["/tennis/players/1/profile", {}], ["/api/tennis/tournaments/", { ...calendarParams, token: "unsupported" }],
        ["/api/tennis/players/ranked", { at: "2026-11-09", metric: "DOUBLES" }],
        ["/api/tennis/players/1/matches", { year: 2026, type: "D" }],
        ["/api/tennis/tournaments/100/2026/matches", { states: "anything" }],
        ["/api/tennis/tournaments/", { ...calendarParams, from: "2026-02-30" }]]) {
        await assert.rejects(io.fetchJSON(path, params));
    }
    assert.equal(requests, 0);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_snapshots").first()).count, 0);
});

test("invalid and incomplete responses never become a successful source cache", async t => {
    const db = await database(t);
    const cases = [
        ["/api/tennis/tournaments/", calendarParams, () => new Response("private provider page", { status: 503 })],
        ["/api/tennis/tournaments/", calendarParams, () => new Response(null, { status: 302 })],
        ["/api/tennis/tournaments/", calendarParams, () => new Response("<html>challenge</html>")],
        ["/api/tennis/tournaments/", calendarParams, () => Response.json({ ...calendar(), pageInfo: { page: 0, numEntries: 20 } })],
        ["/api/tennis/tournaments/", calendarParams, () => Response.json({ ...calendar(), content: [{ ...tournament, level: "" }] })],
        ["/api/tennis/players/ranked", { at: "2026-11-09" }, () => Response.json([])],
        ["/api/tennis/tournaments/100/2026/matches", {}, () => Response.json({ matches: null })],
        ["/api/tennis/tournaments/100/2026/matches", {}, () => Response.json({ matches: [null] })],
        ["/api/tennis/tournaments/100/2026/matches", {}, () => Response.json({ matches: [], pageInfo: { page: 0, numEntries: 1 } })],
    ];
    for (const [path, params, response] of cases) {
        const io = createSharedIO(db, { now: () => reference, fetch: async () => response() });
        await assert.rejects(io.fetchJSON(path, params));
    }
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_snapshots").first()).count, 0);
});

test("all-state match responses are shared while completed-only and player history remain separate", async t => {
    const db = await database(t);
    let requests = 0;
    const io = createSharedIO(db, { now: () => reference, fetch: async url => {
        requests++;
        return Response.json({ matches: [{ MatchID: "LS001", query: url.search }] });
    } });
    const all = await io.fetchJSON("/api/tennis/tournaments/100/2026/matches");
    assert.deepEqual(await io.fetchJSON("/api/tennis/tournaments/100/2026/matches"), all);
    const completed = await io.fetchJSON("/api/tennis/tournaments/100/2026/matches", { states: "C" });
    assert.notDeepEqual(completed, all);
    const history = await io.fetchJSON("/api/tennis/players/1/matches", { year: 2026 });
    assert.deepEqual(await io.fetchJSON("/tennis/players/1/matches", { type: "S", year: 2026, page: 0, pageSize: 100 }), history);
    assert.equal(requests, 3);
});

test("ranking dates and completed ranking caches have bounded freshness and a legacy-only migration fallback", async t => {
    const db = await database(t);
    let now = reference, requests = 0;
    const io = createSharedIO(db, { now: () => now, fetch: async () => {
        requests++;
        return Response.json([{ ranking: 20, player: { id: 1, fullName: "Player", countryCode: "ARG" } }]);
    } });
    await io.fetchJSON("/api/tennis/players/ranked", { at: "2026-10-19" });
    await io.fetchJSON("/api/tennis/players/ranked", { at: "2026-11-09" });
    await io.saveRankings("2026-10-19", rankings);
    await io.saveRankings("2026-11-09", rankings);
    assert.deepEqual(await io.loadRankings("2026-10-19"), rankings);
    assert.deepEqual(await io.loadRankings("2026-11-09"), rankings);
    now += 120000;
    assert.equal(await io.loadRankings("2026-11-09"), null);
    assert.deepEqual(await io.loadRankings("2026-10-19"), rankings);
    await io.fetchJSON("/api/tennis/players/ranked", { at: "2026-10-19" });
    await io.fetchJSON("/api/tennis/players/ranked", { at: "2026-11-09" });
    assert.equal(requests, 3);
    await assert.rejects(io.saveRankings("2026-10-19", [rankings[0], rankings[0]]));
    await assert.rejects(io.saveRankings("2026-10-19", [{ ...rankings[0], id: 1 }]),
        "completed ranking identities must stay strings for the entry-list player-ID map");
    await db.prepare("INSERT INTO entry_ranking_cache VALUES ('2026-10-26', ?, ?), ('2026-11-09', ?, ?)")
        .bind(JSON.stringify(rankings), now + 86400000, JSON.stringify(rankings), now + 86400000).run();
    assert.deepEqual(await io.loadRankings("2026-10-26"), rankings);
    assert.equal(await io.loadRankings("2026-11-09"), null, "legacy rows cannot establish current-week fetch freshness");
    now = reference + 86400000;
    assert.equal(await io.loadRankings("2026-10-19"), null);
});

test("published calendar coverage is read-only, expires after thirty minutes, and rejects malformed items", async t => {
    const db = await database(t);
    let now = reference;
    const io = createSharedIO(db, { now: () => now, fetch: async () => { throw new Error("Calendar lookup must not fetch"); } });
    const saved = { from: "2026-01-01", to: "2027-12-31", items: [tournament] };
    const write = payload => db.prepare("INSERT INTO wta_snapshots VALUES ('calendar_source', 'global', ?, ?, ?) " +
        "ON CONFLICT(kind,scope) DO UPDATE SET payload_json = excluded.payload_json, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at")
        .bind(JSON.stringify(payload), new Date(reference).toISOString(), reference + 1800000).run();
    await write(saved);
    assert.deepEqual(await io.cachedCalendar("2026-11-09", "2026-11-16"), saved);
    assert.equal(await io.cachedCalendar("2025-12-01", "2026-01-01"), null);
    await write({ ...saved, items: [{ ...tournament, level: undefined }] });
    assert.equal(await io.cachedCalendar("2026-11-09", "2026-11-16"), null);
    await write({ ...saved, items: [tournament, tournament] });
    assert.equal(await io.cachedCalendar("2026-11-09", "2026-11-16"), null);
    await write(saved);
    now += 1800000;
    assert.equal(await io.cachedCalendar("2026-11-09", "2026-11-16"), null);
});

test("entry-list calendar pages can omit end dates without qualifying for a complete shared calendar", async t => {
    const db = await database(t);
    const item = { ...tournament };
    delete item.endDate;
    const payload = { ...calendar(), content: [item] };
    const io = createSharedIO(db, { now: () => reference, fetch: async () => Response.json(payload) });
    assert.deepEqual(await io.fetchJSON("/api/tennis/tournaments/", calendarParams), payload);
    await db.prepare("INSERT INTO wta_snapshots VALUES ('calendar_source', 'global', ?, ?, ?)")
        .bind(JSON.stringify({ from: "2026-01-01", to: "2027-12-31", items: [item] }),
            new Date(reference).toISOString(), reference + 1800000).run();
    assert.equal(await io.cachedCalendar("2026-11-09", "2026-11-16"), null);
});

test("missing shared tables preserve old entry-list fetching and historical ranking cache behavior", async t => {
    const db = await database(t, false);
    let requests = 0;
    const io = createSharedIO(db, { now: () => reference, fetch: async () => { requests++; return Response.json(calendar()); } });
    await io.fetchJSON("/api/tennis/tournaments/", calendarParams);
    await io.saveRankings("2026-10-19", rankings);
    assert.deepEqual(await io.loadRankings("2026-10-19"), rankings);
    assert.equal(await io.cachedCalendar("2026-11-09", "2026-11-16"), null);
    assert.equal(requests, 1);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_ranking_cache").first()).count, 1);
});

test("UTF-8 fallback preserves names, large valid responses skip D1 caching, and response size is capped", async t => {
    const db = await database(t);
    const latin = new TextEncoder().encode(JSON.stringify({ matches: [{ name: "Léolia" }] }));
    const utf8 = [...latin];
    const accent = utf8.indexOf(195);
    utf8.splice(accent, 2, 233);
    let response = () => new Response(new Uint8Array(utf8));
    const io = createSharedIO(db, { now: () => reference, fetch: async () => response() });
    const path = "/api/tennis/tournaments/100/2026/matches";
    assert.equal((await io.fetchJSON(path)).matches[0].name, "Léolia");
    await db.prepare("DELETE FROM wta_snapshots WHERE kind = 'source'").run();
    response = () => Response.json({ matches: [{ name: "x".repeat(1900000) }] });
    assert.equal((await io.fetchJSON(path)).matches[0].name.length, 1900000);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_snapshots").first()).count, 0);
    response = () => new Response("{}", { headers: { "Content-Length": "8000001" } });
    await assert.rejects(io.fetchJSON(path), /collection limit/);
});
