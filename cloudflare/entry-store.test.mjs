import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { createEntryJob } from "./entry-collector.mjs";
import { retainPreviousMain, scheduledEntryRefresh } from "./entry-store.mjs";

const origin = "https://tomistgg.github.io";
const request = (path, options = {}) => new Request("https://example.workers.dev" + path,
    { headers: { Origin: origin }, ...options });
const fixture = createEntryJob();
const tournament = { tournamentGroup: { id: 900001, name: "EXAMPLE" }, year: Number(fixture.window_start.slice(0, 4)),
    level: "WTA 125", city: "Example", startDate: fixture.window_start };
const html = qualifyingOnly => `<html><body>
    ${qualifyingOnly ? "" : '<section class="tournament-player-list__tab" data-ui-tab="Singles"><article class="tournament-player-card" data-player-name="Main Player"><a href="/players/1/main-player">Main Player</a><span class="tournament-player-card__country-text">ARG</span></article></section>'}
    <section class="tournament-player-list__tab" data-ui-tab="Doubles"><article class="tournament-player-card" data-player-name="Doubles Only"><a href="/players/999/doubles-only">Doubles Only</a></article></section>
    <section class="tournament-player-list__tab" data-ui-tab="Qualifying"><article class="tournament-player-card" data-player-name="Qualifier"><a href="/players/2/qualifier">Qualifier</a><span class="tournament-player-card__country-text">ARG</span></article></section>
    </body></html>`;

test("D1 persists authoritative snapshots, coordinates visitors, and keeps the previous good update", async t => {
    let requests = 0, empty = false, qualifyingOnly = false, rankingCount = 2, failPage = null;
    let holdCalendar, enteredCalendar;
    const mf = new Miniflare({
        scriptPath: "cloudflare/worker.mjs", modules: true, compatibilityDate: "2026-07-30",
        d1Databases: { ENTRY_LISTS_DB: "entry-test" },
        async outboundService(request) {
            requests++;
            const url = new URL(request.url);
            assert.equal(request.headers.get("Origin"), "https://www.wtatennis.com");
            if (url.pathname === "/tennis/tournaments/") {
                enteredCalendar?.();
                if (holdCalendar) await holdCalendar;
                return Response.json({ pageInfo: { page: 0, numEntries: empty ? 0 : 1 }, content: empty ? [] : [tournament] });
            }
            if (url.hostname === "www.wtatennis.com") return new Response(html(qualifyingOnly));
            assert.equal(url.pathname, "/tennis/players/ranked");
            assert.equal(url.searchParams.get("metric"), "SINGLES");
            const page = Number(url.searchParams.get("page"));
            if (page === failPage) return new Response("provider private error", { status: 503 });
            const content = Array.from({ length: Math.max(0, Math.min(100, rankingCount - page * 100)) }, (_, index) => {
                const id = page * 100 + index + 1;
                return { ranking: id, player: { id, fullName: id === 1 ? "Main Player" : id === 2 ? "Qualifier" : "Player " + id,
                    countryCode: "ARG" } };
            });
            return Response.json({ pageInfo: { page, numEntries: rankingCount }, content });
        },
    });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("ENTRY_LISTS_DB");
    const dispatch = async request => mf.dispatchFetch(request.url, { method: request.method,
        headers: Object.fromEntries(request.headers), body: request.body ? await request.text() : undefined });
    const schema = await readFile("cloudflare/schema.sql", "utf8");
    for (const sql of schema.split(";").filter(part => part.trim())) await db.prepare(sql).run();
    // Schema setup is idempotent and must preserve previously saved lists.
    for (const sql of schema.split(";").filter(part => part.trim())) await db.prepare(sql).run();
    const get = () => dispatch(request("/entry-lists"));
    const advance = () => dispatch(request("/entry-lists/refresh", { method: "POST", headers: { Origin: origin } }));
    const finish = async () => {
        for (let step = 0; step < 100; step++) {
            const before = requests;
            const response = await advance();
            const state = await response.json();
            assert.ok(requests - before <= 4, "each invocation must fit the bounded collection budget");
            if (response.status !== 202) return { response, state };
        }
        throw new Error("Refresh did not complete");
    };

    await t.test("initial read and request restrictions never accept browser-supplied player data", async () => {
        const initial = await (await get()).json();
        assert.equal(initial.snapshot, null);
        assert.equal(requests, 0);
        assert.equal((await dispatch(request("/entry-lists/refresh"))).status, 405);
        assert.equal((await dispatch(request("/entry-lists/refresh", { method: "POST", headers: { Origin: "https://other.example" } }))).status, 403);
        assert.equal((await dispatch(request("/entry-lists/refresh", { method: "POST", headers: { Origin: origin },
            body: JSON.stringify({ models: [{ name: "Forged player" }] }) }))).status, 400);
        assert.equal((await dispatch(new Request("https://example.workers.dev/entry-lists/refresh", { method: "POST" }))).status, 403);
        assert.equal((await (await get()).json()).snapshot, null);
    });

    let firstSnapshot;
    await t.test("successful refresh survives reload and other visitors reuse the shared cooldown", async () => {
        const result = await finish();
        assert.equal(result.response.status, 200, JSON.stringify(result.state));
        firstSnapshot = result.state.snapshot;
        assert.equal(firstSnapshot.models[0].main[0].name, "Main Player");
        assert.equal(firstSnapshot.models[0].qualifying[0].id, "2");
        assert.equal(JSON.stringify(firstSnapshot).includes("Doubles Only"), false);
        assert.ok(result.state.next_refresh_at >= Date.parse(firstSnapshot.saved_at) + 120000);
        const before = requests;
        assert.deepEqual((await (await get()).json()).snapshot, firstSnapshot);
        const otherBrowser = await finish();
        assert.deepEqual(otherBrowser.state.snapshot, firstSnapshot);
        assert.equal(requests, before, "cooldown must apply to every browser");
    });

    assert.ok(firstSnapshot, "Initial refresh must succeed before the remaining integration scenarios run.");

    await t.test("simultaneous visitors share one leased collection step", async () => {
        await db.prepare("UPDATE entry_list_state SET next_refresh_at = 0 WHERE id = 1").run();
        let release;
        holdCalendar = new Promise(resolve => { release = resolve; });
        const entered = new Promise(resolve => { enteredCalendar = resolve; });
        const first = advance();
        await entered;
        const before = requests;
        const second = await advance();
        assert.equal(second.status, 202);
        assert.equal((await second.json()).refreshing, true);
        assert.equal(requests, before, "the second visitor must not launch another WTA collection");
        holdCalendar = null;
        enteredCalendar = null;
        release();
        await first;
        assert.equal((await finish()).response.status, 200);
    });

    await t.test("partial failures never publish incomplete lists and retry backoff is shared", async () => {
        await db.prepare("UPDATE entry_list_state SET next_refresh_at = 0 WHERE id = 1").run();
        await db.prepare("DELETE FROM entry_ranking_cache").run();
        const previous = (await (await get()).json()).snapshot;
        rankingCount = 350;
        failPage = 2;
        const partial = await advance();
        assert.equal(partial.status, 202);
        assert.deepEqual((await partial.json()).snapshot, previous);
        const failed = await advance();
        assert.equal(failed.status, 502);
        const state = await failed.json();
        assert.deepEqual(state.snapshot, previous);
        assert.match(state.error, /last saved lists/);
        assert.doesNotMatch(state.error, /provider private/);
        const before = requests;
        await advance();
        assert.equal(requests, before);
        failPage = null;
        rankingCount = 2;
    });

    await t.test("a qualifying-only update saves the retained main draw explicitly", async () => {
        qualifyingOnly = true;
        await db.prepare("UPDATE entry_list_state SET next_refresh_at = 0 WHERE id = 1").run();
        const result = await finish();
        assert.equal(result.response.status, 200);
        assert.equal(result.state.snapshot.models[0].main[0].name, "Main Player");
        assert.equal(result.state.snapshot.models[0].main_retained, true);
        assert.equal(result.state.snapshot.models[0].qualifying[0].id, "2");
    });

    await t.test("expired job state is discarded and a verified empty calendar can be saved", async () => {
        empty = true;
        await db.prepare("UPDATE entry_list_state SET next_refresh_at = 0, job = ?, job_expires_at = 1, " +
            "lease_token = 'abandoned', lease_until = 1 WHERE id = 1").bind(JSON.stringify({ stage: "invalid" })).run();
        const result = await finish();
        assert.equal(result.response.status, 200);
        assert.deepEqual(result.state.snapshot.models, []);
    });

    await t.test("scheduled refresh skips fresh data and refreshes when thirty minutes stale", async () => {
        let outbound = 0;
        const fetchMock = t.mock.method(globalThis, "fetch", async () => {
            outbound++;
            return Response.json({ pageInfo: { page: 0, numEntries: 0 }, content: [] });
        });
        await scheduledEntryRefresh({ ENTRY_LISTS_DB: db });
        assert.equal(outbound, 0);
        const old = (await (await get()).json()).snapshot;
        old.saved_at = new Date(Date.now() - 1800001).toISOString();
        await db.prepare("UPDATE entry_list_state SET snapshot = ?, next_refresh_at = 0 WHERE id = 1").bind(JSON.stringify(old)).run();
        await scheduledEntryRefresh({ ENTRY_LISTS_DB: db });
        assert.equal(outbound, 1);
        assert.ok(Date.parse((await (await get()).json()).snapshot.saved_at) > Date.parse(old.saved_at));
        fetchMock.mock.restore();
    });
});

test("retained main draws cannot leak into a different tournament week", () => {
    const old = { id: "same", week: "2026-01-05", main: [{ id: "1" }] };
    const current = { id: "same", week: "2027-01-04", main: [], qualifying: [{ id: "2" }] };
    assert.equal(retainPreviousMain([current], { models: [old] })[0].main.length, 0);
});
