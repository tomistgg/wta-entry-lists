import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { createEntryJob } from "./entry-collector.mjs";
import { pruneExpiredEntryData, retainPreviousMain, saveEntrySnapshot, scheduledEntryRefresh } from "./entry-store.mjs";

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
    let mainId = 1, qualifierId = 2;
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
            if (url.hostname === "www.wtatennis.com") return new Response(html(qualifyingOnly)
                .replace('/players/1/main-player', '/players/' + mainId + '/main-player')
                .replace('/players/2/qualifier', '/players/' + qualifierId + '/qualifier'));
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
        assert.deepEqual(firstSnapshot.models[0].changes, []);
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

    await t.test("entry changes are saved with the snapshot and remain after reload and unchanged refreshes", async () => {
        mainId = 3;
        qualifierId = 5;
        await db.prepare("UPDATE entry_list_state SET next_refresh_at = 0 WHERE id = 1").run();
        const result = await finish();
        assert.equal(result.response.status, 200);
        const changes = result.state.snapshot.models[0].changes;
        assert.deepEqual(changes.map(({ player_id, draw, action }) => [player_id, draw, action]), [
            ["1", "main", "removed"], ["3", "main", "added"],
            ["2", "qualifying", "removed"], ["5", "qualifying", "added"],
        ]);
        assert.deepEqual((await (await get()).json()).snapshot.models[0].changes, changes);
        await db.prepare("UPDATE entry_list_state SET next_refresh_at = 0 WHERE id = 1").run();
        assert.deepEqual((await finish()).state.snapshot.models[0].changes, changes);
    });

    await t.test("imported history is served only for the matching active edition without entering snapshot baselines", async () => {
        const saved = (await (await get()).json()).snapshot;
        const current = saved.models[0];
        const date = current.dates.main;
        const legacy = { id: "legacy:imported", at: date + "T00:00:00.000Z", date, draw: "main", action: "added",
            player_id: null, name: "Imported Player", source: "legacy" };
        await db.prepare("INSERT INTO entry_legacy_history (tournament_id, week, rows_json) VALUES (?, ?, ?)")
            .bind(current.id, current.week, JSON.stringify([legacy])).run();
        const loaded = (await (await dispatch(request("/entry-lists?history=1"))).json()).snapshot;
        assert.equal(loaded.models[0].changes.at(-1).id, legacy.id);
        assert.equal((await (await get()).json()).snapshot.models[0].changes.some(change => change.player_id === null), false,
            "cached clients must keep receiving numeric player IDs only");
        const posted = await dispatch(request("/entry-lists/refresh?history=1", { method: "POST", headers: { Origin: origin } }));
        assert.equal((await posted.json()).snapshot.models[0].changes.at(-1).id, legacy.id);
        const raw = await db.prepare("SELECT snapshot FROM entry_list_state WHERE id = 1").first();
        assert.equal(JSON.parse(raw.snapshot).models[0].changes.some(change => change.player_id === null), false);
        assert.deepEqual(loaded.models[0].change_baselines, current.change_baselines);
        await db.prepare("DELETE FROM entry_legacy_history").run();
    });

    await t.test("successful publication deletes imported history for absent and older editions", async () => {
        const previous = (await (await get()).json()).snapshot;
        const current = previous.models[0];
        for (const [id, week] of [[current.id, current.week], [current.id, "2025-01-06"], ["ABSENT", current.week]]) {
            await db.prepare("INSERT INTO entry_legacy_history (tournament_id, week, rows_json) VALUES (?, ?, '[]')")
                .bind(id, week).run();
        }
        await db.prepare("UPDATE entry_list_state SET next_refresh_at = 0 WHERE id = 1").run();
        const restored = (await finish()).state.snapshot;
        assert.deepEqual(restored.models[0].changes, previous.models[0].changes);
        assert.deepEqual(restored.models[0].change_baselines, previous.models[0].change_baselines);
        const kept = await db.prepare("SELECT tournament_id, week FROM entry_legacy_history").all();
        assert.deepEqual(kept.results, [{ tournament_id: current.id, week: current.week }]);
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
        assert.equal(result.state.snapshot.models[0].main[0].id, String(mainId));
        assert.equal(result.state.snapshot.models[0].main_retained, true);
        assert.equal(result.state.snapshot.models[0].qualifying[0].id, String(qualifierId));
    });

    await t.test("expired job state is discarded and a verified empty calendar can be saved", async () => {
        empty = true;
        await db.prepare("UPDATE entry_list_state SET next_refresh_at = 0, job = ?, job_expires_at = 1, " +
            "lease_token = 'abandoned', lease_until = 1 WHERE id = 1").bind(JSON.stringify({ stage: "invalid" })).run();
        const result = await finish();
        assert.equal(result.response.status, 200);
        assert.deepEqual(result.state.snapshot.models, []);
        assert.equal(Object.hasOwn(result.state.snapshot, "hidden_models"), false);
        assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_legacy_history").first()).count, 0);
        empty = false;
        qualifyingOnly = false;
        await db.prepare("UPDATE entry_list_state SET next_refresh_at = 0 WHERE id = 1").run();
        const restored = (await finish()).state.snapshot;
        assert.deepEqual(restored.models[0].changes, [], "a returning tournament establishes a new baseline after deletion");
        assert.equal(Object.hasOwn(restored, "hidden_models"), false);
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

test("publication atomically deletes retired history and rejects an expired writer", async t => {
    const mf = new Miniflare({ script: "export default { fetch() { return new Response('ok'); } }", modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { ENTRY_LISTS_DB: "retention-test" } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("ENTRY_LISTS_DB");
    const schema = await readFile("cloudflare/schema.sql", "utf8");
    for (const sql of schema.split(";").filter(part => part.trim())) await db.prepare(sql).run();
    const previous = { saved_at: "2026-11-11T10:00:00.000Z", models: [{ id: "OLD", week: "2026-11-16", changes: [] }] };
    const current = { saved_at: "2026-11-18T10:00:00.000Z", models: [{ id: "NEW", week: "2026-11-23", changes: [] }] };
    await db.prepare("UPDATE entry_list_state SET snapshot = ?, lease_token = 'owner' WHERE id = 1")
        .bind(JSON.stringify(previous)).run();
    for (const model of [...previous.models, ...current.models]) {
        await db.prepare("INSERT INTO entry_legacy_history (tournament_id, week, rows_json) VALUES (?, ?, '[]')")
            .bind(model.id, model.week).run();
    }
    await db.prepare("CREATE TRIGGER reject_snapshot BEFORE UPDATE ON entry_list_state " +
        "WHEN NEW.snapshot != OLD.snapshot BEGIN SELECT RAISE(ABORT, 'snapshot unavailable'); END").run();
    await assert.rejects(saveEntrySnapshot(db, current, "owner"), /snapshot unavailable/);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_legacy_history").first()).count, 2);
    assert.deepEqual(JSON.parse((await db.prepare("SELECT snapshot FROM entry_list_state WHERE id = 1").first()).snapshot), previous);
    await db.prepare("DROP TRIGGER reject_snapshot").run();
    await saveEntrySnapshot(db, current, "stale-owner");
    assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_legacy_history").first()).count, 2);
    assert.deepEqual(JSON.parse((await db.prepare("SELECT snapshot FROM entry_list_state WHERE id = 1").first()).snapshot), previous);
    await saveEntrySnapshot(db, current, "owner");
    const records = await db.prepare("SELECT tournament_id, week FROM entry_legacy_history").all();
    assert.deepEqual(records.results, [{ tournament_id: "NEW", week: "2026-11-23" }]);
    assert.deepEqual(JSON.parse((await db.prepare("SELECT snapshot FROM entry_list_state WHERE id = 1").first()).snapshot), current);
    const later = { saved_at: "2026-11-25T10:00:00.000Z", models: [] };
    await db.prepare("UPDATE entry_list_state SET lease_token = 'next-owner' WHERE id = 1").run();
    await saveEntrySnapshot(db, later, "next-owner");
    assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_legacy_history").first()).count, 0);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE name = 'entry_tournament_archive'").first()).count, 0);
});

test("scheduled cleanup removes expired data despite WTA failure and preserves active history", async t => {
    const mf = new Miniflare({ script: "export default { fetch() { return new Response('ok'); } }", modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { ENTRY_LISTS_DB: "rollover-test" } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("ENTRY_LISTS_DB");
    const schema = await readFile("cloudflare/schema.sql", "utf8");
    for (const sql of schema.split(";").filter(part => part.trim())) await db.prepare(sql).run();
    const now = Date.parse("2026-11-22T23:00:00Z");
    const expired = { id: "EXPIRED", week: "2026-11-23", main: [{ name: "Expired player" }], qualifying: [], changes: [{ name: "Expired change" }] };
    const active = { id: "ACTIVE", week: "2026-11-30", main: [{ name: "Active player" }], qualifying: [], changes: [{ name: "Active change" }] };
    const original = { fetched_at: "2026-11-22T22:50:00.000Z", saved_at: "2026-11-22T22:55:00.000Z",
        window_start: "2026-11-23", window_end: "2026-12-21", models: [expired, active],
        hidden_models: [{ id: "HIDDEN", week: "2026-12-07", changes: [{ name: "Hidden change" }] }] };
    const oldJob = JSON.stringify({ window_start: original.window_start, stage: "entries", models: [expired] });
    const writeOriginal = () => db.prepare("UPDATE entry_list_state SET snapshot = ?, job = ?, job_expires_at = ?, " +
        "next_refresh_at = 0, lease_until = 0, lease_token = NULL, error = NULL WHERE id = 1")
        .bind(JSON.stringify(original), oldJob, now + 600000).run();
    await writeOriginal();
    for (const model of [expired, active, ...original.hidden_models]) {
        await db.prepare("INSERT INTO entry_legacy_history (tournament_id, week, rows_json) VALUES (?, ?, '[]')")
            .bind(model.id, model.week).run();
    }
    await db.prepare("INSERT INTO entry_ranking_cache VALUES ('2026-10-01', '[]', ?), ('2026-10-08', '[]', ?)")
        .bind(now - 1, now + 10000).run();
    const clock = t.mock.method(Date, "now", () => now);
    const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("WTA unavailable", { status: 503 }));
    await scheduledEntryRefresh({ ENTRY_LISTS_DB: db });
    fetchMock.mock.restore();
    clock.mock.restore();
    const row = await db.prepare("SELECT * FROM entry_list_state WHERE id = 1").first();
    const saved = JSON.parse(row.snapshot);
    assert.deepEqual(saved.models, [active]);
    assert.equal(Object.hasOwn(saved, "hidden_models"), false);
    assert.equal(saved.window_start, "2026-11-30");
    assert.equal(saved.window_end, "2026-12-28");
    assert.equal(saved.fetched_at, original.fetched_at);
    assert.equal(saved.saved_at, original.saved_at);
    assert.equal(row.job, null);
    assert.match(row.error, /last saved lists/);
    assert.doesNotMatch(row.snapshot, /Expired|Hidden/);
    assert.deepEqual((await db.prepare("SELECT tournament_id FROM entry_legacy_history").all()).results, [{ tournament_id: "ACTIVE" }]);
    assert.deepEqual((await db.prepare("SELECT ranking_date FROM entry_ranking_cache").all()).results, [{ ranking_date: "2026-10-08" }]);

    await writeOriginal();
    await db.prepare("UPDATE entry_list_state SET lease_until = ?, lease_token = 'current-owner' WHERE id = 1").bind(now + 90000).run();
    const leased = await pruneExpiredEntryData(db, now);
    assert.equal(leased.snapshot, JSON.stringify(original), "cleanup must not disturb a running collection");
    await db.prepare("UPDATE entry_list_state SET lease_until = 0, lease_token = NULL WHERE id = 1").run();
    const newer = { ...saved, models: [active, { ...active, id: "NEWLY_SAVED" }] };
    const concurrentDB = {
        prepare: sql => db.prepare(sql),
        async batch(statements) {
            await db.prepare("UPDATE entry_list_state SET snapshot = ?, job = NULL WHERE id = 1").bind(JSON.stringify(newer)).run();
            return db.batch(statements);
        },
    };
    const concurrent = await pruneExpiredEntryData(concurrentDB, now);
    assert.deepEqual(JSON.parse(concurrent.snapshot), newer, "a stale cleanup must not overwrite a newer completed snapshot");

    await db.prepare("UPDATE entry_list_state SET snapshot = NULL, job = NULL, lease_until = 0 WHERE id = 1").run();
    await pruneExpiredEntryData(db, now);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_legacy_history").first()).count, 0,
        "without displayed tournaments no imported history may remain");
});
