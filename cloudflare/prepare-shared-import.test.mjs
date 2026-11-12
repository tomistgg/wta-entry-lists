import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Miniflare } from "miniflare";
import { applyImportPlan, buildImportPlan, prepareLocalImport, verifyImport } from "./prepare-shared-import.mjs";

function fixture() {
    const title = { tournament_id: "100", year: 2026, champion: { id: "1", name: "O'Connell" },
        category: "WTA 250", start_date: "2026-11-02", end_date: "2026-11-08", name: "Player's Open" };
    return { schema_version: 1, prepared_at: "2026-11-12T10:00:00.000Z",
        players: { snapshot_date: "2026-11-09", players: [{ id: "1", name: "O'Connell", display_name: "Léolia O'Connell",
            aliases: ["Alternate Name"], country: "FRA", dob: "2000-01-01", rank: 20, previous_rank: 21, points: 1000,
            last_rank: 20, last_rank_date: "2026-11-09", best_rank: 3, best_rank_year: 2020,
            tour_title_count: 1, tour_title_ids: ["100:2026"], latest_title: title }],
        player_names: { by_wta_id: { "1": "Léolia O'Connell", "999": "Historical Player" }, by_name: { "o'connell": "Léolia O'Connell" } } },
        calendar: { fields: ["name", "level", "startDate", "endDate", "calendarKey", "source"],
            weeks: { "2026-11-02": [["Player's Open", "WTA 250", "2026-11-02", "2026-11-08", "wta:100:2026", "WTA"]] } },
        champions: { champion_count: 2, updated_at: "2026-11-09T10:00:00Z", coverage_note: "Existing coverage only.",
            missing_champions: [{ tournament_id: "200", year: 2001 }],
            champions: [title, { ...title, tournament_id: "101", year: 2000, champion: { id: "999", name: "Historical Player" },
                start_date: "2000-01-03", end_date: "2000-01-08" }] },
        sources: [{ path: "haute_cadence/data/wta_champions.json", bytes: 123, sha256: "a".repeat(64) }] };
}

async function database(t) {
    const mf = new Miniflare({ script: "export default {fetch() {return new Response('ok')}}", modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { TEST_DB: "shared-import-test" } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("TEST_DB");
    for (const file of ["schema.sql", "shared-schema.sql"]) {
        const schema = await readFile(new URL(file, import.meta.url), "utf8");
        for (const sql of schema.split(";").filter(value => value.trim())) await db.prepare(sql).run();
    }
    return db;
}

test("parameterized import preserves names, all history, large snapshots, and repeatability without changing entry lists", async t => {
    const bundle = fixture();
    bundle.players.players[0].country = "";
    bundle.players.player_names.by_name["large alias"] = "x".repeat(110000);
    const plan = buildImportPlan(bundle);
    assert.ok(plan.statements.every(row => Buffer.byteLength(row.sql) < 100000 && row.params.length <= 100));
    assert.ok(plan.statements.some(row => row.params.some(value => typeof value === "string" && Buffer.byteLength(value) > 100000)));
    const db = await database(t);
    await db.prepare("UPDATE entry_list_state SET snapshot = '{\"keep\":true}', next_refresh_at = 123 WHERE id = 1").run();
    await db.prepare("INSERT INTO entry_ranking_cache VALUES ('2026-11-09', '[]', 123)").run();
    await db.prepare("INSERT INTO entry_legacy_history VALUES ('KEEP', '2026-11-16', '[]')").run();
    const before = (await db.prepare("SELECT * FROM entry_list_state").all()).results;
    await applyImportPlan(db, plan);
    await applyImportPlan(db, plan);
    assert.equal((await verifyImport(db, bundle)).titles, 2);
    assert.deepEqual((await db.prepare("SELECT * FROM entry_list_state").all()).results, before);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_ranking_cache").first()).count, 1);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_legacy_history").first()).count, 1);
    const metadata = JSON.parse((await db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind = 'champions'").first()).payload_json);
    assert.deepEqual(metadata.missing_champions, bundle.champions.missing_champions);
    await db.prepare("UPDATE wta_titles SET champion_id = '998' WHERE tournament_id = '101'").run();
    await assert.rejects(verifyImport(db, bundle), "canonical champion IDs outside the current directory must be checked");
    await db.prepare("UPDATE wta_titles SET champion_id = '999', end_date = '2000-01-09' WHERE tournament_id = '101'").run();
    await assert.rejects(verifyImport(db, bundle), "historical title dates must be checked independently of their JSON payload");
    await db.prepare("UPDATE wta_titles SET end_date = '2000-01-08' WHERE tournament_id = '101'").run();
    await db.prepare("UPDATE wta_players SET updated_at = '2026-11-13T10:00:00Z' WHERE player_id = '1'").run();
    await assert.rejects(applyImportPlan(db, plan), /Refusing to replace/);
});

test("duplicate and inconsistent source identities fail before output files are created", async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "shared-import-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const mutations = [
        bundle => bundle.players.players.push(structuredClone(bundle.players.players[0])),
        bundle => { bundle.champions.champions.push(structuredClone(bundle.champions.champions[0])); bundle.champions.champion_count++; },
        bundle => bundle.calendar.weeks["2026-11-02"].push([...bundle.calendar.weeks["2026-11-02"][0]]),
        bundle => { bundle.players.players[0].best_rank = 30; },
        bundle => { bundle.players.players[0].dob = "2000-02-30"; },
        bundle => { bundle.players.players[0].country = {}; },
        bundle => { bundle.players.players[0].tour_title_count = 2; },
    ];
    for (const mutate of mutations) {
        const bundle = fixture(); mutate(bundle);
        await assert.rejects(prepareLocalImport(bundle, directory));
        assert.deepEqual(await readdir(directory), []);
    }
});

test("local rehearsal reports verified counts and produces no refresh jobs or remote executor", async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "shared-import-report-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const report = await prepareLocalImport(fixture(), directory);
    assert.equal(report.local_only, true);
    assert.equal(report.entry_lists_preserved, true);
    assert.equal(report.roundtrip_verified, true);
    assert.equal(report.snapshots, 4);
    const saved = JSON.parse(await readFile(path.join(directory, "verification-report.json"), "utf8"));
    assert.deepEqual(saved, report);
    assert.ok((await readdir(directory)).includes("import-plan.json"));
    const db = await database(t);
    await db.prepare("INSERT INTO wta_refresh_state (kind) VALUES ('players')").run();
    await assert.rejects(applyImportPlan(db, buildImportPlan(fixture())), /refresh state exists/);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_players").first()).count, 0);
});
