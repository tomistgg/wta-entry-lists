import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";

test("shared schema is additive, repeatable, and protects shared data identities", async t => {
    const mf = new Miniflare({ script: "export default { fetch() { return new Response('ok'); } }", modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { TEST_DB: "shared-schema-test" } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("TEST_DB");
    const apply = async name => {
        const sql = await readFile(new URL(name, import.meta.url), "utf8");
        for (const statement of sql.split(";").filter(part => part.trim())) await db.prepare(statement).run();
    };
    await apply("./schema.sql");
    await db.prepare("UPDATE entry_list_state SET snapshot = ?, next_refresh_at = 123 WHERE id = 1")
        .bind(JSON.stringify({ models: [{ id: "EXISTING", week: "2026-11-16" }] })).run();
    await db.prepare("INSERT INTO entry_ranking_cache VALUES ('2026-11-09', '[]', 123456)").run();
    await db.prepare("INSERT INTO entry_legacy_history VALUES ('EXISTING', '2026-11-16', '[]')").run();
    const existing = async () => Promise.all(["entry_list_state", "entry_ranking_cache", "entry_legacy_history"]
        .map(async table => (await db.prepare("SELECT * FROM " + table).all()).results));
    const before = await existing();
    await apply("./shared-schema.sql");
    await apply("./shared-schema.sql");
    assert.deepEqual(await existing(), before, "creating shared tables must preserve the live entry-list data");

    await t.test("player IDs are unique and profile payloads are JSON objects", async () => {
        await db.prepare("INSERT INTO wta_players VALUES ('1', ?, '2026-11-12T10:00:00Z')")
            .bind(JSON.stringify({ name: "Player", best_rank: 3, aliases: ["Display name"] })).run();
        await assert.rejects(db.prepare("INSERT INTO wta_players VALUES ('1', '{}', '2026-11-12T10:00:00Z')").run());
        for (const payload of ["invalid JSON", "[]", "null"]) {
            await assert.rejects(db.prepare("INSERT INTO wta_players VALUES ('2', ?, '2026-11-12T10:00:00Z')").bind(payload).run());
        }
    });

    await t.test("an edition has one singles champion and historical champions need no current profile", async () => {
        const insert = (year, champion) => db.prepare("INSERT INTO wta_titles VALUES ('100', ?, ?, '2026-11-08', '{}')")
            .bind(year, champion).run();
        await insert(2026, "999");
        await assert.rejects(insert(2026, "1"));
        await insert(2025, "1");
        assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_titles").first()).count, 2);
    });

    await t.test("snapshot scopes coexist and expiring feeds are independent of lasting statistics", async () => {
        const insert = (kind, scope, expiry) => db.prepare("INSERT INTO wta_snapshots VALUES (?, ?, '{}', '2026-11-12T10:00:00Z', ?)")
            .bind(kind, scope, expiry).run();
        await insert("calendar", "wta:2026", null);
        await insert("calendar", "wta:2027", null);
        await insert("results", "global", 100);
        await assert.rejects(insert("results", "global", 200));
        await db.prepare("DELETE FROM wta_snapshots WHERE expires_at IS NOT NULL AND expires_at <= 100").run();
        assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_snapshots").first()).count, 2);
        assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_players").first()).count, 1);
        assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_titles").first()).count, 2);
    });

    await t.test("refresh coordination rejects invalid jobs and negative control timestamps", async () => {
        await db.prepare("INSERT INTO wta_refresh_state (kind) VALUES ('results')").run();
        await assert.rejects(db.prepare("INSERT INTO wta_refresh_state (kind) VALUES ('results')").run());
        await assert.rejects(db.prepare("UPDATE wta_refresh_state SET job_json = 'invalid' WHERE kind = 'results'").run());
        for (const column of ["next_refresh_at", "job_expires_at", "lease_until"]) {
            await assert.rejects(db.prepare("UPDATE wta_refresh_state SET " + column + " = -1 WHERE kind = 'results'").run());
        }
    });
    await apply("./shared-schema.sql");
    assert.deepEqual(await existing(), before);
    assert.equal((await db.prepare("SELECT count(*) AS count FROM wta_players").first()).count, 1,
        "reapplying the schema must also preserve newly populated shared tables");
});
