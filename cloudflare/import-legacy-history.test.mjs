import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { buildLegacyHistorySQL, normalizeLegacyHistory } from "./import-legacy-history.mjs";

const now = Date.parse("2026-11-12T10:00:00Z");
const row = (name = "L&Eacute;OLIA O'CONNELL", date = "2026-11-04") => ({ date,
    change: `<strong>${name}</strong> added to Qualifying` });
const edition = extra => ({ tournament_id: "WTA_500_MÉRIDA", week: "2026-11-16", deadline: "2026-10-19", rows: [row()], ...extra });

test("active history keeps names, dates, and repeated transitions with stable edition IDs", () => {
    const source = [edition({ rows: [row(), row(), { date: "2026-11-05", change: "<strong>PLAYER</strong> removed from Main Draw" }] })];
    const normalized = normalizeLegacyHistory(source, now);
    assert.deepEqual(normalizeLegacyHistory(source, now), normalized);
    assert.equal(normalized[0].tournament_id, "WTA_500_MÉRIDA");
    assert.equal(normalized[0].week, "2026-11-16");
    const [first, repeated, removed] = normalized[0].events;
    assert.equal(first.name, "LÉOLIA O'CONNELL");
    assert.equal(first.at, "2026-11-04T00:00:00.000Z");
    assert.equal(first.player_id, null);
    assert.equal(first.source, "legacy");
    assert.match(first.id, /^legacy:[a-f0-9]{64}$/);
    assert.notEqual(first.id, repeated.id);
    assert.equal(removed.draw, "main");
    assert.equal(removed.action, "removed");
});

test("expired editions and observations outside the active edition are never imported", () => {
    const source = [edition({ rows: [row("BEFORE DEADLINE", "2026-10-18"), row(), row("FUTURE", "2026-11-13")] }),
        edition({ week: "2026-11-09" }), edition({ week: "2026-12-14" })];
    assert.deepEqual(normalizeLegacyHistory(source, now).map(record => record.events.map(event => event.name)), [["LÉOLIA O'CONNELL"]]);
    assert.deepEqual(normalizeLegacyHistory([edition()], Date.parse("2026-11-16T00:01:00+01:00")), [],
        "the old seed cannot recreate a tournament after Madrid's weekly rollover");
    assert.deepEqual(normalizeLegacyHistory([], now), []);
});

test("invalid active records fail before any SQL is generated", () => {
    for (const source of [null, {}, [edition({ tournament_id: "BAD';KEY" })], [edition({ week: "2026-11-17" })],
        [edition({ rows: [row("", "2026-11-04")] })], [edition({ rows: [row("NAME", "2026-02-30")] })],
        [edition({ rows: [{ ...row(), change: "Unknown observation" }] })], [edition(), edition()]]) {
        assert.throws(() => buildLegacyHistorySQL(source, now));
    }
    assert.throws(() => buildLegacyHistorySQL([edition({ rows: [row("X".repeat(60000))] })], now), /limit/);
});

test("one-time SQL import only writes displayed editions and is safe to repeat", async t => {
    const mf = new Miniflare({ modules: true, script: "export default {fetch() {return new Response('ok')}}",
        compatibilityDate: "2026-07-30", d1Databases: { HISTORY_DB: "active-history-test" } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("HISTORY_DB");
    await db.prepare("CREATE TABLE entry_list_state (id INTEGER PRIMARY KEY, snapshot TEXT)").run();
    const seed = [edition({ rows: [row("O'NEIL'; SELECT 1; --")] }), edition({ tournament_id: "NOT_DISPLAYED" })];
    await db.prepare("INSERT INTO entry_list_state (id, snapshot) VALUES (1, ?)")
        .bind(JSON.stringify({ models: [{ id: seed[0].tournament_id, week: seed[0].week }] })).run();
    const sql = buildLegacyHistorySQL(seed, now).trim().split("\n");
    const execute = async () => { for (const statement of sql) await db.prepare(statement).run(); };
    await execute();
    const read = async () => (await db.prepare("SELECT tournament_id, week, rows_json FROM entry_legacy_history").all()).results;
    const saved = await read();
    assert.deepEqual(saved.map(record => ({ tournament_id: record.tournament_id, week: record.week,
        events: JSON.parse(record.rows_json) })), normalizeLegacyHistory([seed[0]], now));
    await execute();
    assert.deepEqual(await read(), saved);
    await db.prepare("DELETE FROM entry_legacy_history").run();
    await db.prepare("UPDATE entry_list_state SET snapshot = ? WHERE id = 1")
        .bind(JSON.stringify({ models: [{ id: seed[0].tournament_id, week: "2027-11-15" }] })).run();
    await execute();
    assert.deepEqual(await read(), [], "a reused tournament ID in another week cannot revive old data");
});
