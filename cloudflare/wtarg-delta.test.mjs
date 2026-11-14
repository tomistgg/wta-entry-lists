import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Miniflare } from "miniflare";
import { applyDelta, rollbackDelta, deltaJournal, deltaSummary } from "./wtarg-delta.mjs";

const now = Date.parse("2026-11-14T13:00:00Z");
const identity = { jobId: "job-one", leaseToken: "a-private-fixture-lease-token" };
const player = key => ({ player_key: key, display_name: "A Player", name_key: key, presentation_name: "",
    country: "ARG", dob: null, profile_json: "{}", updated_at: "2026-11-14T02:22:42Z" });
const insert = key => ({ table: "wtarg_players", key: { player_key: key }, before: null, after: player(key) });
const call = (operations, batchId = 0) => ({ ...identity, batchId, operations });

async function setup(t) {
    const mf = new Miniflare({ script: "export default {fetch(){return new Response('fixture')}}", modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { ENTRY_LISTS_DB: "wtarg-delta-test" },
        outboundService() { throw new Error("No providers in delta tests"); } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("ENTRY_LISTS_DB");
    for (const path of [new URL("./shared-schema.sql", import.meta.url),
        new URL("../../tenis-fem-arg/cloudflare/schema.sql", import.meta.url)]) {
        const schema = (await readFile(path, "utf8")).replace(/^\s*--.*$/gm, "");
        for (const sql of schema.split(";").filter(value => value.trim())) await db.prepare(sql).run();
    }
    await db.prepare("INSERT INTO wtarg_jobs(job_key,source,kind,scope,status,lease_token,lease_until,job_expires_at,payload_json) " +
        "VALUES ('wtarg:collector:global','wtarg','collector','global','running',?,?,?,?)")
        .bind(identity.leaseToken, now + 180000, now + 7200000, JSON.stringify({ jobId: identity.jobId })).run();
    await db.prepare("INSERT INTO wta_snapshots VALUES('calendar','global','{\"keep\":true}','2026-11-14',NULL)").run();
    return db;
}

test("canonical batches are sequential, idempotent, reversible and keep shared applications untouched", async t => {
    const db = await setup(t);
    assert.equal((await applyDelta(db, call([insert("wta:1")]), now)).applied, true);
    assert.equal((await applyDelta(db, call([insert("wta:1")]), now)).applied, false);
    const before = await db.prepare("SELECT * FROM wtarg_players WHERE player_key='wta:1'").first();
    const operation = { table: "wtarg_players", key: { player_key: "wta:1" }, before,
        after: { ...before, display_name: "Corrected Player" } };
    await assert.rejects(applyDelta(db, call([operation], 2), now), /in order/);
    await assert.rejects(applyDelta(db, call([operation], 0), now), /content changed/);
    await applyDelta(db, call([operation], 1), now);
    assert.equal((await deltaJournal(db, identity.jobId)).length, 2);
    assert.equal((await rollbackDelta(db, identity, now)).remaining, 1);
    assert.deepEqual(await db.prepare("SELECT * FROM wtarg_players WHERE player_key='wta:1'").first(), before);
    assert.equal((await rollbackDelta(db, identity, now)).remaining, 0);
    assert.deepEqual(await deltaSummary(db, identity.jobId), { batches: 0, bytes: 0, operations: 0, operationBytes: 0 });
    assert.equal(await db.prepare("SELECT * FROM wtarg_players WHERE player_key='wta:1'").first(), null);
    assert.equal((await rollbackDelta(db, identity, now)).rolledBack, false);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM wta_snapshots WHERE kind='wtarg:delta_guard'").first()).n, 0);
    assert.equal((await db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind='calendar'").first()).payload_json,
        '{"keep":true}');
});

test("before-image drift and a lease lost immediately before SQL cannot publish mutations", async t => {
    const db = await setup(t);
    await applyDelta(db, call([insert("wta:1")]), now);
    const before = player("wta:1");
    const change = { table: "wtarg_players", key: { player_key: "wta:1" }, before,
        after: { ...before, display_name: "New Name" } };
    await db.prepare("UPDATE wtarg_players SET country='FRA' WHERE player_key='wta:1'").run();
    await assert.rejects(applyDelta(db, call([change], 1), now), /conflicted/);
    assert.equal((await deltaJournal(db, identity.jobId)).length, 1);
    const late = { prepare: db.prepare.bind(db), async batch(statements) {
        await db.prepare("UPDATE wtarg_jobs SET lease_until=? WHERE job_key='wtarg:collector:global'").bind(now).run();
        return db.batch(statements);
    } };
    await assert.rejects(applyDelta(late, call([insert("wta:2")], 1), now), /lease/);
    assert.equal(await db.prepare("SELECT * FROM wtarg_players WHERE player_key='wta:2'").first(), null);
    assert.equal((await deltaJournal(db, identity.jobId)).length, 1);
});

test("foreign-key errors roll back every operation and the undo journal together", async t => {
    const db = await setup(t);
    const invalidAlias = { table: "wtarg_player_aliases", key: { player_key: "wta:missing", alias: "Alias" }, before: null,
        after: { player_key: "wta:missing", alias: "Alias", normalized_alias: "alias", source: "import" } };
    await assert.rejects(applyDelta(db, call([insert("wta:1"), invalidAlias]), now), /conflicted/);
    assert.equal((await db.prepare("SELECT count(*) AS n FROM wtarg_players").first()).n, 0);
    assert.equal((await deltaJournal(db, identity.jobId)).length, 0);
});

test("private deltas cannot touch arbitrary tables, runtime coordination, frozen metrics or delete history", async t => {
    const db = await setup(t);
    await assert.rejects(applyDelta(db, call([{ ...insert("wta:1"), table: "wta_snapshots" }]), now), /Unknown/);
    await applyDelta(db, call([insert("wta:1")]), now);
    await assert.rejects(applyDelta(db, call([{ ...insert("wta:1"), before: player("wta:1"), after: null }], 1), now), /history/);
    const coordinator = await db.prepare("SELECT * FROM wtarg_jobs WHERE job_key='wtarg:collector:global'").first();
    await assert.rejects(applyDelta(db, call([{ table: "wtarg_jobs", key: { job_key: coordinator.job_key },
        before: coordinator, after: { ...coordinator, status: "complete" } }], 1), now), /coordination/);
    await db.prepare("INSERT INTO wtarg_tournaments(tournament_key,source,name,updated_at) VALUES('event','itf','Event','now')").run();
    await db.prepare("INSERT INTO wtarg_tournament_metrics(tournament_key,draw_code,metric,version,status,value," +
        "expected_count,covered_count,frozen,roster_hash,formula_version) VALUES('event','MDS','wtn_gm',1,'complete',10,2,2,1,'roster','v1')").run();
    const metric = await db.prepare("SELECT * FROM wtarg_tournament_metrics").first();
    await assert.rejects(applyDelta(db, call([{ table: "wtarg_tournament_metrics",
        key: { tournament_key: "event", draw_code: "MDS", week_number: 0, metric: "wtn_gm", version: 1 },
        before: metric, after: { ...metric, value: 12 } }], 1), now), /frozen/);
});

test("recovery refuses drift instead of erasing an independently changed row", async t => {
    const db = await setup(t);
    await applyDelta(db, call([insert("wta:1")]), now);
    await db.prepare("UPDATE wtarg_players SET country='FRA' WHERE player_key='wta:1'").run();
    await assert.rejects(rollbackDelta(db, identity, now), /recovery conflicted/);
    assert.equal((await deltaJournal(db, identity.jobId)).length, 1);
    assert.equal((await db.prepare("SELECT country FROM wtarg_players").first()).country, "FRA");
});

test("the recovery storage reserve rejects a batch before modifying canonical rows", async t => {
    const db = await setup(t);
    await db.prepare("INSERT INTO wta_snapshots VALUES('wtarg:delta_totals',?,?,'now',NULL)")
        .bind(identity.jobId, JSON.stringify({ batches: 0, bytes: 20 * 1024 * 1024 })).run();
    await assert.rejects(applyDelta(db, call([insert("wta:1")]), now), /storage reserve/);
    assert.equal(await db.prepare("SELECT * FROM wtarg_players").first(), null);
    assert.deepEqual(await deltaJournal(db, identity.jobId), []);
});

test("canonical batches stay within eight rows and count their exact operation bytes through retry and rollback", async t => {
    const db = await setup(t);
    const operations = Array.from({ length: 8 }, (_value, index) => insert(`wta:${index + 1}`));
    await assert.rejects(applyDelta(db, call([...operations, insert("wta:9")]), now), /Invalid canonical batch/);
    assert.equal((await deltaSummary(db, identity.jobId)).operations, 0);
    await applyDelta(db, call(operations), now);
    const beforeRetry = await deltaSummary(db, identity.jobId);
    assert.equal(beforeRetry.operations, 8);
    assert.equal(beforeRetry.operationBytes, Buffer.byteLength(JSON.stringify(operations)));
    await applyDelta(db, call(operations), now);
    assert.deepEqual(await deltaSummary(db, identity.jobId), beforeRetry);
    await rollbackDelta(db, identity, now);
    assert.deepEqual(await deltaSummary(db, identity.jobId), { batches: 0, bytes: 0, operations: 0, operationBytes: 0 });
});

test("approved operation and byte budgets are checked against fresh CAS-fenced totals inside the mutation", async t => {
    const db = await setup(t);
    const first = [insert("wta:1")];
    const second = [insert("wta:2"), insert("wta:3")];
    // A caller may have checked zero totals before another batch committed.
    const staleOuter = await deltaSummary(db, identity.jobId);
    assert.equal(staleOuter.operations, 0);
    const bytes = Buffer.byteLength(JSON.stringify(first)) + Buffer.byteLength(JSON.stringify(second));
    const budget = { operations: 2, batches: 2, bytes };
    await applyDelta(db, call(first), now, budget);
    await assert.rejects(applyDelta(db, call(second, 1), now, budget), /approved storage plan/);
    assert.equal((await deltaSummary(db, identity.jobId)).operations, 1);
    assert.equal(await db.prepare("SELECT * FROM wtarg_players WHERE player_key='wta:2'").first(), null);
    const byteBudget = { operations: 3, batches: 2, bytes: bytes - 1 };
    await assert.rejects(applyDelta(db, call(second, 1), now, byteBudget), /approved storage plan/);
    assert.equal((await deltaSummary(db, identity.jobId)).batches, 1);
    await applyDelta(db, call(second, 1), now, { operations: 3, batches: 2, bytes });
    assert.equal((await deltaSummary(db, identity.jobId)).operations, 3);
});
