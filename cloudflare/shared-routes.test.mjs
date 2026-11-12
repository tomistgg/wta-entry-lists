import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";

const origin = "https://tomistgg.github.io";
const DAY = 86400000;
const isoDate = time => new Date(time).toISOString().slice(0, 10);
const nextMonday = now => {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + (7 - (date.getUTCDay() + 6) % 7));
    return isoDate(date);
};

async function setup(t, shared = true) {
    const now = Date.now(), next = nextMonday(now);
    const currentMonday = new Date(now);
    currentMonday.setUTCDate(currentMonday.getUTCDate() - (currentMonday.getUTCDay() + 6) % 7);
    const current = { tournamentGroup: { id: 100, name: "Current Open" }, year: Number(isoDate(now).slice(0, 4)),
        level: "WTA 250", title: "Current Open", city: "Current", startDate: isoDate(currentMonday), endDate: isoDate(now + DAY) };
    const future = { ...current, tournamentGroup: { id: 101, name: "Next Open" }, title: "Next Open", city: "Next",
        year: Number(next.slice(0, 4)), startDate: next, endDate: isoDate(Date.parse(next) + 6 * DAY) };
    const requests = [];
    const match = { MatchID: "LS001", DrawMatchType: "S", DrawLevelType: "M", RoundID: "F", MatchState: "F", Winner: "2",
        PlayerIDA: "1", PlayerIDB: "2", PlayerNameFirstA: "Main", PlayerNameLastA: "Player", PlayerCountryA: "ARG",
        PlayerNameFirstB: "Other", PlayerNameLastB: "Player", PlayerCountryB: "FRA",
        ScoreSet1A: "6", ScoreSet1B: "2", ScoreSet2A: "6", ScoreSet2B: "3",
        MatchTimeStamp: new Date(now - 3600000).toISOString(), MatchTimeTotal: "00:30:00" };
    const mf = new Miniflare({ scriptPath: "cloudflare/worker.mjs", modules: true, compatibilityDate: "2026-07-30",
        d1Databases: { ENTRY_LISTS_DB: "shared-routes-test" }, outboundService(request) {
            const url = new URL(request.url); requests.push(url);
            if (url.hostname === "www.wtatennis.com") return new Response(
                '<section class="tournament-player-list__tab" data-ui-tab="Singles"><article class="tournament-player-card" data-player-name="Main Player"><a href="/players/1/main-player">Main Player</a><span class="tournament-player-card__country-text">ARG</span></article></section>');
            if (url.pathname.endsWith("/matches")) return Response.json({ matches: [match] });
            if (url.pathname === "/tennis/players/ranked") return Response.json([
                { ranking: 10, player: { id: 1, fullName: "Main Player", countryCode: "ARG" } },
            ]);
            if (url.pathname === "/tennis/tournaments/") return Response.json({ pageInfo: { page: 0, numEntries: 2 }, content: [current, future] });
            throw new Error("Unexpected upstream path: " + url.pathname);
        } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("ENTRY_LISTS_DB");
    for (const name of shared ? ["schema.sql", "shared-schema.sql"] : ["schema.sql"]) {
        const schema = await readFile(new URL(name, import.meta.url), "utf8");
        for (const sql of schema.split(";").filter(value => value.trim())) await db.prepare(sql).run();
    }
    const call = (path, method = "GET", headers = { Origin: origin }, body) => mf.dispatchFetch("https://example.workers.dev" + path,
        { method, headers, ...(body === undefined ? {} : { body }) });
    if (shared) {
        await db.prepare("INSERT INTO wta_snapshots VALUES ('calendar_source','global',?,?,?)")
            .bind(JSON.stringify({ from: isoDate(now - 40 * DAY), to: isoDate(now + 50 * DAY), items: [current, future] }),
                new Date(now).toISOString(), now + 1800000).run();
    }
    return { db, call, requests };
}

test("shared Worker routes enforce refresh origins/methods and keep reads free of collection writes", async t => {
    const { db, call, requests } = await setup(t);
    for (const path of ["/data/players", "/data/calendar", "/data/results", "/data/draws", "/data/champions", "/data/players/1/form"]) {
        const response = await call(path);
        assert.equal(response.status, 200, path);
        assert.equal((await response.json()).snapshot, null);
    }
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_refresh_state").first()).count, 0);
    assert.equal(requests.length, 0);
    assert.equal((await call("/data/results/refresh")).status, 405);
    assert.equal((await call("/data/results", "POST")).status, 405);
    assert.equal((await call("/data/results/refresh", "POST", {})).status, 403);
    assert.equal((await call("/data/results/refresh", "POST", { Origin: "https://other.example" })).status, 403);
    assert.equal((await call("/data/results/refresh", "POST", { Origin: origin }, '{"matches":["forged"]}')).status, 400);
    assert.equal((await call("/data/players/not-an-id/form")).status, 404);
    const preflight = await call("/data/results/refresh", "OPTIONS");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Methods"), "POST, OPTIONS");
    assert.equal(requests.length, 0);
});

test("one shared match fetch publishes results, draws and titles; Entry Lists reuse the shared calendar", async t => {
    const { call, requests } = await setup(t);
    for (let step = 0; step < 20; step++) {
        const response = await call("/data/results/refresh", "POST");
        assert.ok([200, 202].includes(response.status), await response.clone().text());
        if (response.status === 200) break;
        if (step === 19) assert.fail("Shared refresh did not finish");
    }
    const results = await (await call("/data/results")).json();
    const draws = await (await call("/data/draws")).json();
    const champions = await (await call("/data/champions")).json();
    assert.ok(results.snapshot.matches.length >= 1);
    assert.ok(draws.snapshot.tournaments.length >= 1);
    assert.ok(champions.snapshot.champions.length >= 1);
    assert.equal(results.next_refresh_at, draws.next_refresh_at);
    const before = requests.length;
    assert.equal((await call("/data/draws/refresh", "POST")).status, 200);
    assert.equal(requests.length, before, "the cooldown is shared by match-based views");
    for (let step = 0; step < 20; step++) {
        const response = await call("/entry-lists/refresh", "POST");
        assert.ok([200, 202].includes(response.status), await response.clone().text());
        if (response.status === 200) break;
        if (step === 19) assert.fail("Entry-list refresh did not finish");
    }
    const entries = await (await call("/entry-lists")).json();
    assert.equal(entries.snapshot.models.length, 1);
    assert.equal(entries.snapshot.models[0].main[0].id, "1");
    assert.equal(requests.filter(url => url.pathname === "/tennis/tournaments/").length, 0,
        "both services must use the already saved complete calendar");
});

test("missing shared tables leave the existing Worker routes available", async t => {
    const { call } = await setup(t, false);
    assert.equal((await call("/health")).status, 200);
    assert.equal((await call("/entry-lists")).status, 200);
    assert.equal((await call("/data/players")).status, 503);
});
