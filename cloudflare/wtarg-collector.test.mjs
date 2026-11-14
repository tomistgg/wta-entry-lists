import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { Miniflare } from "miniflare";
import { DEFAULT_COLLECTOR_WRITE_BUDGET, wtargCollectorResponse } from "./wtarg-collector.mjs";
import { wtargDataResponse } from "./wtarg-store.mjs";
import { RANKING_SOURCE_FILES } from "./wtarg-ranking-assets.mjs";

const token = "local-fixture-collector-token-32-characters";
const now = Date.parse("2026-11-14T12:00:00Z");
const hash = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value);
const oldId = hash("approved baseline"), nextId = hash("new collected data");
const JOB = "wtarg:collector:global";
const playerOperation = key => ({ table: "wtarg_players", key: { player_key: key }, before: null,
    after: { player_key: key, display_name: key, name_key: key, presentation_name: "", country: "ARG", dob: null,
        profile_json: "{}", updated_at: "2026-11-14T12:00:00Z" } });

function storageProbe(db, size) {
    return { prepare(sql) {
        const statement = db.prepare(sql);
        if (!sql.includes("storage_probe")) return statement;
        return { async run() {
            const result = await statement.run();
            return { ...result, meta: { ...result.meta, size_after: size } };
        } };
    }, batch(statements) { return db.batch(statements); } };
}

test("the default daily reserve can cover insertion and retirement of one measured ranking week", () => {
    const weeklyPlayers = 1556;
    const operations = weeklyPlayers * 2;
    const batches = Math.ceil(operations / 8);
    const reservedWithRollback = operations * 12 + batches * 8;
    assert.ok(reservedWithRollback < DEFAULT_COLLECTOR_WRITE_BUDGET);
    assert.ok(DEFAULT_COLLECTOR_WRITE_BUDGET <= 60000);
});

async function setup(t) {
    const mf = new Miniflare({ script: "export default { fetch() { return new Response('isolated'); } };", modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { ENTRY_LISTS_DB: "wtarg-collector-test" },
        outboundService() { throw new Error("No provider requests are allowed."); } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database("ENTRY_LISTS_DB");
    for (const path of [new URL("shared-schema.sql", import.meta.url), new URL("../../tenis-fem-arg/cloudflare/schema.sql", import.meta.url)]) {
        for (const sql of (await readFile(path, "utf8")).replace(/^--.*$/gm, "").split(";").filter(value => value.trim())) await db.prepare(sql).run();
    }
    const save = (kind, scope, payload) => db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) VALUES(?,?,?,?,NULL) " +
        "ON CONFLICT(kind,scope) DO UPDATE SET payload_json=excluded.payload_json").bind(kind, scope, json(payload), new Date(now).toISOString()).run();
    const raw = Buffer.from("{}"), gzip = gzipSync(raw), part = { sha256: hash(gzip), bytes: gzip.length };
    const map = JSON.parse(await readFile(new URL("../../tenis-fem-arg/cloudflare/import-map.json", import.meta.url), "utf8"));
    const files = Object.keys(map.sources).sort().map(name => ({ name, rawSha256: hash(raw), rawBytes: raw.length,
        gzipSha256: hash(gzip), gzipBytes: gzip.length, parts: [part] }));
    const source = { schemaVersion: 1, sourceVersion: hash(json(files.map(file => ({ name: file.name, bytes: file.rawBytes, sha256: file.rawSha256 })))),
        sourceRevision: "a".repeat(40), files, totalRawBytes: raw.length * files.length, totalGzipBytes: gzip.length * files.length };
    await save("wtarg:source_manifest", source.sourceVersion, source);
    await save("wtarg:source_current", "global", { schemaVersion: 1, sourceVersion: source.sourceVersion });
    await save("wtarg:source_blob", part.sha256, { sha256: part.sha256, bytes: part.bytes, base64: gzip.toString("base64") });
    const texts = { bootstrap: '{"schemaVersion":1,"data":{"old":true}}', identities: "[]", history: "[]", "rankings-latest": '{"p":[],"d":{}}' };
    const manifest = (id = nextId, input = texts) => ({ schemaVersion: 1, releaseId: id, applicationVersion: hash("app"),
        sourceVersion: source.sourceVersion, sourceFrozenAt: new Date(now).toISOString(), preparedAt: new Date(now).toISOString(),
        resources: Object.fromEntries(Object.entries(input).map(([name, text]) => [name, { storage: "d1", sha256: hash(text),
            bytes: Buffer.byteLength(text), parts: [{ sha256: hash(text), bytes: Buffer.byteLength(text),
                storedBytes: Buffer.byteLength(json({ text })) }] }])) });
    const base = manifest(oldId);
    await save("wtarg:read_manifest", oldId, base);
    await save("wtarg:read_accepted", oldId, { schemaVersion: 1, releaseId: oldId, manifestSha256: hash(json(base)) });
    await save("wtarg:read_current", "global", { schemaVersion: 1, releaseId: oldId });
    const env = { ENTRY_LISTS_DB: db, WTARG_COLLECTION_ENABLED: "true", WTARG_COLLECTOR_TOKEN: token };
    const call = async (operation, body, time = now, options = {}) => {
        const pathname = operation.startsWith("/") ? operation : "/wtarg/internal/v1/" + operation;
        const method = options.method || (body === undefined ? "GET" : "POST");
        const headers = { Authorization: "Bearer " + token, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers };
        const response = await wtargCollectorResponse(new Request("https://example.workers.dev" + pathname,
            { method, headers, ...(body === undefined ? {} : { body: typeof body === "string" ? body : json(body) }) }), env, {}, time);
        return { status: response.status, data: await response.json(), headers: response.headers };
    };
    const cleanup = async (time = now) => {
        for (let pass = 0; pass < 100; pass++) {
            const response = await call("gc", { limit: 20 }, time);
            assert.equal(response.status, 200, json(response.data));
            if (!response.data.continuation) return response.data;
        }
        assert.fail("Fixture cleanup did not complete its bounded sweep.");
    };
    const claim = async (time = now) => {
        const response = await call("claim", {}, time);
        assert.equal(response.status, 200, json(response.data));
        if (response.data.jobId) await cleanup(time);
        return response.data;
    };
    const preflight = async (lease, operations = [], release = manifest(), newSource = source, time = now) => {
        const batches = Array.from({ length: Math.ceil(operations.length / 8) }, (_, index) => operations.slice(index * 8, index * 8 + 8));
        const response = await call("preflight", { ...lease, manifest: release, sourceManifest: newSource,
            deltaBudget: { operations: operations.length, batches: batches.length,
                bytes: batches.reduce((sum, batch) => sum + Buffer.byteLength(json(batch)), 0) } }, time);
        assert.equal(response.status, 200, json(response.data));
        return response;
    };
    const stage = async (lease, batchHashes = [], input = texts, newSource = source, time = now) => {
        const release = { ...manifest(nextId, input), sourceVersion: newSource.sourceVersion };
        const plan = await db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind='wtarg:collector_preflight' AND scope=?").bind(lease.jobId).first();
        if (!plan) await preflight(lease, [], release, newSource, time);
        const response = await call("stage", { ...lease, manifest: release, sourceManifest: newSource,
            expectedBatches: batchHashes.length, deltaHashes: batchHashes }, time);
        assert.equal(response.status, 200, json(response.data));
        return release;
    };
    const upload = async (lease, input = texts, time = now) => {
        for (const [resource, text] of Object.entries(input)) {
            const response = await call("part", { ...lease, resource, index: 0, text }, time);
            assert.equal(response.status, 200, json(response.data));
        }
    };
    return { mf, db, env, save, call, claim, cleanup, preflight, stage, upload, source, texts, manifest, raw, gzip, part };
}

async function rankingAssetsFixture(f) {
    const raw = Buffer.from("week_date,id,rank,points,player,country,dob\r\n2026-11-09,1,001,,Player,ARG,\r\n");
    const packed = gzipSync(raw), part = { sha256: hash(packed), bytes: packed.length };
    const description = { rawSha256: hash(raw), rawBytes: raw.length, gzipSha256: hash(packed), gzipBytes: packed.length, parts: [part] };
    for (const file of f.source.files) if (RANKING_SOURCE_FILES.has(file.name)) Object.assign(file, description);
    f.source.totalRawBytes = f.source.files.reduce((sum, file) => sum + file.rawBytes, 0);
    f.source.totalGzipBytes = f.source.files.reduce((sum, file) => sum + file.gzipBytes, 0);
    f.source.sourceVersion = hash(json(f.source.files.map(file => ({ name: file.name, bytes: file.rawBytes, sha256: file.rawSha256 }))));
    await f.save("wtarg:source_manifest", f.source.sourceVersion, f.source);
    await f.save("wtarg:source_current", "global", { schemaVersion: 1, sourceVersion: f.source.sourceVersion });
    await f.save("wtarg:source_blob", part.sha256, { ...part, base64: packed.toString("base64") });
    const old = f.manifest(oldId);
    await f.save("wtarg:read_manifest", oldId, old);
    await f.save("wtarg:read_accepted", oldId, { schemaVersion: 1, releaseId: oldId, manifestSha256: hash(json(old)) });
    const texts = { "rankings-latest": '{"p":["Player"],"d":{"2026-11-09":[[1,null]]}}' };
    const resources = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, {
        sha256: hash(text), bytes: Buffer.byteLength(text), parts: [{ sha256: hash(text), bytes: Buffer.byteLength(text) }],
    }]));
    const week = { week_date: "2026-11-09", sha256: hash("lossless weekly archive"), bytes: 100, rows: 1,
        source_file: "wta_rankings_20_29.csv" };
    week.path = `history/${week.week_date}-${week.sha256}.json`;
    const bundle = { schemaVersion: 1, sources: Object.fromEntries([...RANKING_SOURCE_FILES].map(name => [name, description])),
        resources, weeks: [week] };
    const reference = { schemaVersion: 1, bundleId: hash(json(bundle)), origin: "https://1234abcd.wtarg-ranking-files.pages.dev" };
    const source = structuredClone(f.source);
    source.files.forEach(file => { if (RANKING_SOURCE_FILES.has(file.name)) file.storage = "ranking-assets"; });
    source.rankingAssets = reference;
    source.rankingCheckpointWeeks = { [week.week_date]: week.sha256 };
    const manifest = f.manifest();
    manifest.rankingAssets = reference;
    for (const [name, resource] of Object.entries(resources)) manifest.resources[name] = {
        ...resource, storage: "asset", assetStore: "rankings", assetReleaseId: reference.bundleId,
    };
    await f.db.prepare("INSERT INTO wtarg_ranking_weeks(series,week_date,status,row_count,content_hash,archive_path) VALUES(?,?,?,?,?,?)")
        .bind("wta_singles", week.week_date, "archived", week.rows, week.sha256,
            `ranking-assets:wta_singles:${week.week_date}:${week.sha256}`).run();
    const state = { missing: false, corrupt: false, requests: [] };
    f.env.WTARG_RANKING_ASSET_FETCHER = { async fetch(request) {
        state.requests.push(request);
        if (state.missing) return new Response("missing", { status: 404 });
        const pathname = new URL(request.url).pathname;
        if (pathname === "/manifest.json") return state.corrupt ? Response.json({}) : Response.json(bundle);
        if (pathname === `/source/${part.sha256}.bin`) return new Response(packed);
        if (pathname === "/public/rankings-latest/0.json") return Response.json({ text: texts["rankings-latest"] });
        return new Response("missing", { status: 404 });
    } };
    return { source, manifest, texts, bundle, reference, packed, part, state };
}

test("public status is read-only, setup-gated, and refresh cannot accept client data", async t => {
    const f = await setup(t);
    const before = await f.db.prepare("SELECT count(*) AS count FROM wtarg_jobs").first();
    const state = await f.call("/wtarg/v1/status");
    assert.equal(state.data.enabled, true); assert.equal(state.data.state, "idle");
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wtarg_jobs").first()).count, before.count);
    f.env.WTARG_COLLECTION_ENABLED = "false";
    assert.equal((await f.call("/wtarg/v1/status")).data.enabled, false);
    assert.equal((await f.call("/wtarg/v1/refresh", undefined, now, { method: "POST", headers: { Origin: "https://wtarg.com" } })).status, 503);
    f.env.WTARG_COLLECTION_ENABLED = "true";
    assert.equal((await f.call("/wtarg/v1/refresh", {}, now, { headers: { Origin: "https://wtarg.com" } })).status, 400);
    assert.equal((await f.call("/wtarg/v1/refresh", undefined, now, { method: "POST" })).status, 403);
    await f.db.prepare("DELETE FROM wta_snapshots WHERE kind='wtarg:source_current'").run();
    assert.equal((await f.call("/wtarg/v1/status")).data.enabled, false);
});

test("private routes authenticate before reading bodies and reject browser credentials", async t => {
    const f = await setup(t);
    assert.equal((await f.call("claim", {}, now, { headers: { Authorization: "Bearer wrong" } })).status, 401);
    assert.equal((await f.call("claim", {}, now, { headers: { Origin: "https://wtarg.com" } })).status, 403);
    const privateRead = await f.call("source");
    assert.equal(privateRead.status, 200); assert.equal(privateRead.headers.has("Access-Control-Allow-Origin"), false);
    assert.equal(privateRead.data.manifest.sourceVersion, f.source.sourceVersion);
    assert.equal((await f.call("claim", "not json")).status, 400);
    assert.equal((await f.call("claim", {}, now, { headers: { "Content-Type": "text/plain" } })).status, 415);
});

test("visitors share a queue/cooldown and scheduled claims enforce a two-hour provider-start interval", async t => {
    const f = await setup(t);
    const refresh = () => f.call("/wtarg/v1/refresh", undefined, now, { method: "POST", headers: { Origin: "https://wtarg.com" } });
    const queued = await refresh(); assert.equal(queued.status, 202);
    assert.equal(queued.data.state, "queued");
    const repeated = await refresh(); assert.equal(repeated.status, 429); assert.equal(repeated.data.jobId, queued.data.jobId);
    const lease = await f.claim(); assert.equal(lease.jobId, queued.data.jobId); assert.equal(lease.repairing, false);
    assert.equal((await f.claim(now + 1000)).jobId, null);
    const heartbeat = await f.call("heartbeat", { ...lease, state: "collecting", progress: "Checking scheduled events" }, now + 30000);
    assert.equal(heartbeat.data.leaseUntil, now + 210000);
    const joined = await f.call("/wtarg/v1/refresh", undefined, now + 120001, { method: "POST", headers: { Origin: "https://wtarg.com" } });
    assert.equal(joined.status, 202); assert.equal(joined.data.jobId, lease.jobId);
    assert.equal(joined.data.nextRefreshAt, now + 240001);
    assert.equal((await f.call("finish", { ...lease, state: "failed" }, now + 130000)).status, 200);
    assert.equal((await f.claim(now + 2 * 60 * 60 * 1000 - 1)).jobId, null);
    assert.notEqual((await f.claim(now + 2 * 60 * 60 * 1000)).jobId, lease.jobId);
});

test("a heartbeat does not overwrite a visitor cooldown changed after its lease read", async t => {
    const f = await setup(t), lease = await f.claim();
    const db = f.db; let raced = false;
    f.env.ENTRY_LISTS_DB = {
        prepare(sql) {
            const statement = db.prepare(sql);
            if (!sql.startsWith("UPDATE wtarg_jobs SET lease_until=")) return statement;
            return { bind(...values) {
                const bound = statement.bind(...values);
                return { async first() {
                    if (!raced) {
                        raced = true;
                        const join = await f.call("/wtarg/v1/refresh", undefined, now + 121000,
                            { method: "POST", headers: { Origin: "https://wtarg.com" } });
                        assert.equal(join.status, 202);
                    }
                    return bound.first();
                } };
            } };
        },
        batch(statements) { return db.batch(statements); },
    };
    const response = await f.call("heartbeat", { ...lease, state: "collecting", progress: "Checking entries" }, now + 121000);
    assert.equal(response.status, 200); assert.equal(raced, true);
    const state = (await f.call("/wtarg/v1/status", undefined, now + 121000)).data;
    assert.equal(state.nextRefreshAt, now + 241000);
    assert.equal(state.progress, "Checking entries");
});

test("provider pacing is durable across request classes and stale workers cannot reserve calls", async t => {
    const f = await setup(t), lease = await f.claim();
    assert.equal((await f.call("pace", { ...lease, provider: "itf", kind: "profile" })).data.granted, true);
    const api = await f.call("pace", { ...lease, provider: "itf", kind: "api" }, now + 1000);
    assert.deepEqual(api.data, { granted: false, waitMs: 12000 });
    assert.equal((await f.call("pace", { ...lease, provider: "itf", kind: "api" }, now + 13000)).data.granted, true);
    const blocked = await f.call("pace", { ...lease, provider: "itf", kind: "api", backoffMs: 60000 }, now + 14000);
    assert.equal(blocked.data.granted, false); assert.equal(blocked.data.waitMs, 60000);
    assert.equal((await f.call("pace", { ...lease, provider: "itf", kind: "profile" }, now + 30000)).data.waitMs, 44000);
    assert.equal((await f.call("pace", { ...lease, provider: "itf", kind: "api" }, now + 180001)).status, 409);
    assert.equal((await f.call("pace", { ...lease, provider: "other", kind: "api" })).status, 400);
});

test("verified release publication atomically changes source and public pointers and supports safe retry", async t => {
    const f = await setup(t), lease = await f.claim();
    await f.stage(lease);
    assert.equal((await f.call("commit", lease)).status, 409);
    const oldPointer = await f.db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind='wtarg:read_current' AND scope='global'").first();
    assert.equal(JSON.parse(oldPointer.payload_json).releaseId, oldId);
    await f.upload(lease);
    const committed = await f.call("commit", lease);
    assert.equal(committed.status, 200, json(committed.data)); assert.equal(committed.data.committed, true);
    assert.equal((await f.call("commit", lease)).data.alreadyCommitted, true);
    const sourcePointer = JSON.parse((await f.db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind='wtarg:source_current' AND scope='global'").first()).payload_json);
    assert.equal(sourcePointer.checkpointId, nextId);
    const response = await wtargDataResponse(new Request("https://example.workers.dev/wtarg/v1/manifest"), f.env);
    assert.equal((await response.json()).releaseId, nextId);
    assert.equal((await f.call("/wtarg/v1/status")).data.state, "complete");
    assert.equal((await f.call("part", { ...lease, resource: "bootstrap", index: 0, text: "corrupt" })).status, 409);
});

test("part uploads reserve both snapshot rows and exact retries never rewrite content or receipts", async t => {
    const f = await setup(t), lease = await f.claim();
    await f.stage(lease);
    const budget = async () => JSON.parse((await f.db.prepare("SELECT payload_json FROM wtarg_source_state WHERE source='wtarg:collector' " +
        "AND scope='write-budget:2026-11-14'").first()).payload_json).reserved;
    const before = await budget();
    const part = { ...lease, resource: "bootstrap", index: 0, text: f.texts.bootstrap };
    assert.equal((await f.call("part", part)).status, 200);
    assert.equal(await budget(), before + 4);
    const rows = () => f.db.prepare("SELECT kind,payload_json,fetched_at FROM wta_snapshots WHERE kind IN('wtarg:read_part','wtarg:read_part_meta') " +
        "AND scope=? ORDER BY kind").bind(`${nextId}:bootstrap:0`).all();
    const accepted = (await rows()).results;
    const retry = await f.call("part", part, now + 1000);
    assert.equal(retry.status, 200); assert.equal(retry.data.unchanged, true);
    assert.equal(await budget(), before + 4);
    assert.deepEqual((await rows()).results, accepted);
    await f.db.prepare("UPDATE wta_snapshots SET payload_json=? WHERE kind='wtarg:read_part_meta' AND scope=?")
        .bind(json({ sha256: hash("wrong"), bytes: Buffer.byteLength(part.text) }), `${nextId}:bootstrap:0`).run();
    assert.equal((await f.call("part", part, now + 2000)).status, 409);
    assert.equal(await budget(), before + 4);
});

test("accepted native degraded data publishes with a visible warning state", async t => {
    const f = await setup(t), lease = await f.claim();
    await f.stage(lease); await f.upload(lease);
    assert.equal((await f.call("commit", { ...lease, outcome: "partial" })).status, 400);
    const committed = await f.call("commit", { ...lease, outcome: "degraded" });
    assert.equal(committed.status, 200); assert.equal(committed.data.outcome, "degraded");
    const state = (await f.call("/wtarg/v1/status")).data;
    assert.equal(state.state, "partial"); assert.equal(state.currentReleaseId, nextId);
    assert.match(state.progress, /warnings/); assert.ok(state.lastSuccessAt);
});

test("new releases reuse only matching accepted immutable archive backing", async t => {
    const f = await setup(t);
    const baseline = f.manifest(oldId);
    baseline.resources.history.storage = "asset";
    await f.save("wtarg:read_manifest", oldId, baseline);
    await f.save("wtarg:read_accepted", oldId, { schemaVersion: 1, releaseId: oldId, manifestSha256: hash(json(baseline)) });
    const lease = await f.claim(), next = f.manifest();
    next.resources.history = { ...baseline.resources.history, assetReleaseId: oldId };
    await f.preflight(lease, [], next);
    const staged = await f.call("stage", { ...lease, manifest: next, sourceManifest: f.source, expectedBatches: 0, deltaHashes: [] });
    assert.equal(staged.status, 200, json(staged.data));
    const { history, ...dynamic } = f.texts;
    await f.upload(lease, dynamic);
    assert.equal((await f.call("commit", lease)).status, 200);
    f.env.WTARG_ASSETS = { async fetch(request) {
        assert.equal(new URL(request.url).pathname, `/wtarg-assets/${oldId}/history/0.json`);
        return Response.json({ text: history });
    } };
    const response = await wtargDataResponse(new Request(`https://example.workers.dev/wtarg/v1/releases/${nextId}/resources/history/parts/0`), f.env);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { text: history });
    await f.call("gc", { limit: 50 }, now + 2 * 86400000);
    assert.ok(await f.db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind='wtarg:read_accepted' AND scope=?").bind(oldId).first());
});

test("altered source manifests, checksums, authored files and static backing references are rejected", async t => {
    const f = await setup(t), lease = await f.claim();
    const bad = structuredClone(f.source); bad.files.pop();
    let response = await f.call("stage", { ...lease, manifest: f.manifest(), sourceManifest: bad, expectedBatches: 0, deltaHashes: [] });
    assert.equal(response.status, 400);
    const changed = structuredClone(f.source); changed.files.find(file => file.name === "ao27_q_race.json").rawSha256 = hash("changed");
    changed.sourceVersion = hash(json(changed.files.map(file => ({ name: file.name, bytes: file.rawBytes, sha256: file.rawSha256 }))));
    response = await f.call("stage", { ...lease, manifest: { ...f.manifest(), sourceVersion: changed.sourceVersion }, sourceManifest: changed, expectedBatches: 0, deltaHashes: [] });
    assert.equal(response.status, 409); assert.match(response.data.error, /Authored/);
    await f.stage(lease);
    assert.equal((await f.call("part", { ...lease, resource: "bootstrap", index: 0, text: "corrupt" })).status, 400);
    assert.equal((await f.call("source/blobs/" + f.part.sha256, { ...lease, sha256: f.part.sha256, bytes: 1, base64: "AA==" })).status, 400);
    const assetManifest = f.manifest(); assetManifest.resources.history = { ...assetManifest.resources.history, storage: "asset", assetReleaseId: hash("unknown") };
    response = await f.call("stage", { ...lease, manifest: assetManifest, sourceManifest: f.source, expectedBatches: 0, deltaHashes: [] });
    assert.equal(response.status, 409);
});

test("explicit identity corrections require approval of their exact reviewed Git revision", async t => {
    const f = await setup(t), lease = await f.claim();
    const source = { ...f.source, gitIdentityHash: hash("reviewed registry"), identityPatchRevision: f.source.sourceRevision };
    const body = { ...lease, manifest: f.manifest(), sourceManifest: source, expectedBatches: 0, deltaHashes: [] };
    assert.equal((await f.call("stage", body)).status, 409);
    f.env.WTARG_AUTHORED_REVISION = source.sourceRevision;
    await f.preflight(lease, [], body.manifest, source);
    assert.equal((await f.call("stage", body)).status, 200);
    await f.upload(lease);
    assert.equal((await f.call("commit", lease)).status, 200);
    assert.equal((await f.call("source")).data.manifest.identityPatchRevision, source.sourceRevision);
});

test("canonical-key compatibility metadata is bounded and rejects cycles", async t => {
    const f = await setup(t), lease = await f.claim();
    const body = { ...lease, manifest: f.manifest(), sourceManifest: { ...f.source,
        canonicalKeyOverrides: { "itf:800123456": "wta:123", "wta:123": "itf:800123456" } }, expectedBatches: 0, deltaHashes: [] };
    assert.equal((await f.call("stage", body)).status, 400);
    body.sourceManifest.canonicalKeyOverrides = { "itf:800123456": "wta:123" };
    await f.preflight(lease, [], body.manifest, body.sourceManifest);
    assert.equal((await f.call("stage", body)).status, 200);
});

test("failed normalized changes remain unpublished and must be undone before a new provider job", async t => {
    const f = await setup(t), lease = await f.claim();
    const after = { player_key: "fixture:1", display_name: "Fixture Player", name_key: "fixture player", presentation_name: "",
        country: "ARG", dob: null, profile_json: "{}", updated_at: "2026-11-14T12:00:00Z" };
    const operations = [{ table: "wtarg_players", key: { player_key: after.player_key }, before: null, after }];
    await f.preflight(lease, operations);
    const delta = await f.call("delta", { ...lease, batchId: 0, operations });
    assert.equal(delta.status, 200, json(delta.data)); assert.match(delta.data.operationsHash, /^[a-f0-9]{64}$/);
    assert.equal((await f.call("finish", { ...lease, state: "partial" })).data.needsRollback, true);
    assert.equal((await f.call("pace", { ...lease, provider: "itf", kind: "api" })).status, 409);
    const recovered = await f.call("rollback", lease);
    assert.equal(recovered.data.complete, true);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wtarg_players").first()).count, 0);
    assert.equal((await f.claim(now + 1000)).jobId, null);
    assert.equal((await f.call("/wtarg/v1/status")).data.currentReleaseId, oldId);
});

test("expired collectors are fenced and the next claimant first repairs their pending index writes", async t => {
    const f = await setup(t), lease = await f.claim();
    const after = { player_key: "fixture:2", display_name: "Fixture Two", name_key: "fixture two", presentation_name: "",
        country: "ARG", dob: null, profile_json: "{}", updated_at: "2026-11-14T12:00:00Z" };
    const operations = [{ table: "wtarg_players", key: { player_key: after.player_key }, before: null, after }];
    await f.preflight(lease, operations);
    assert.equal((await f.call("delta", { ...lease, batchId: 0, operations })).status, 200);
    const recovery = await f.claim(now + 180001);
    assert.equal(recovery.repairing, true); assert.equal(recovery.jobId, lease.jobId); assert.notEqual(recovery.leaseToken, lease.leaseToken);
    assert.equal((await f.call("heartbeat", lease, now + 180001)).status, 409);
    assert.equal((await f.call("pace", { ...recovery, provider: "itf", kind: "api" }, now + 180001)).status, 409);
    assert.equal((await f.call("rollback", recovery, now + 180001)).data.complete, true);
});

test("independent profile checkpoints concern singles only and survive a failed main cycle", async t => {
    const f = await setup(t), lease = await f.claim();
    const observation = { source: "profile", wtn: 11.2, retrieved_at: "2026-11-14",
        profile_url: "https://www.itftennis.com/en/players/fixture/800123456/arg/wt/s/overview/" };
    assert.equal((await f.call("wtn", { ...lease, observations: [{ playerId: "800123456", observation }] })).data.saved, 1);
    assert.equal((await f.call("wtn", { ...lease, observations: [{ playerId: "800123456", observation: { ...observation, discipline: "D" } }] })).status, 400);
    assert.equal((await f.call("wtn", { ...lease, observations: [{ playerId: "800123456", observation: { ...observation, source: "entry_list" } }] })).status, 400);
    assert.equal((await f.call("wtn", { ...lease, observations: [{ playerId: "800123456", observation: { ...observation, retrieved_at: "2026-11-15" } }] })).status, 400);
    await f.call("finish", { ...lease, state: "failed" });
    const restored = await f.call("source"); assert.equal(restored.data.wtnObservations["800123456"].wtn, 11.2);
    assert.equal(restored.data.manifest.sourceVersion, f.source.sourceVersion);
});

test("write budget exhaustion keeps the old accepted version and does not prevent prepaid rollback", async t => {
    const f = await setup(t), lease = await f.claim();
    const after = { player_key: "fixture:budget", display_name: "Budget Fixture", name_key: "budget fixture", presentation_name: "",
        country: "ARG", dob: null, profile_json: "{}", updated_at: "2026-11-14T12:00:00Z" };
    const operations = [{ table: "wtarg_players", key: { player_key: after.player_key }, before: null, after }];
    await f.preflight(lease, operations);
    const batch = await f.call("delta", { ...lease, batchId: 0, operations });
    assert.equal(batch.status, 200);
    await f.stage(lease, [batch.data.operationsHash]);
    f.env.WTARG_DAILY_WRITE_BUDGET = "1000";
    await f.db.prepare("UPDATE wtarg_source_state SET payload_json='{\"reserved\":1000}' WHERE source='wtarg:collector' AND scope='write-budget:2026-11-14'").run();
    assert.equal((await f.call("part", { ...lease, resource: "bootstrap", index: 0, text: f.texts.bootstrap })).status, 429);
    assert.equal((await f.call("/wtarg/v1/status")).data.currentReleaseId, oldId);
    assert.equal((await f.call("finish", { ...lease, state: "partial" })).data.needsRollback, true);
    assert.equal((await f.call("rollback", lease)).data.complete, true);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wtarg_players").first()).count, 0);
});

test("a negative profile check retains newer positive evidence and its original observation date", async t => {
    const f = await setup(t), lease = await f.claim();
    const profile = "https://www.itftennis.com/en/players/fixture/800123456/arg/wt/s/overview/";
    const fresh = { source: "profile", wtn: 11.2, observed_on: "2026-11-13", retrieved_at: "2026-11-13", profile_url: profile };
    const negative = { source: "entry_list", wtn: 14.6, observed_on: "2026-11-09", retrieved_at: "2026-11-09",
        no_wtn_checked_at: "2026-11-14", last_profile_url: profile };
    assert.equal((await f.call("wtn", { ...lease, observations: [{ playerId: "800123456", observation: fresh }] })).status, 200);
    assert.equal((await f.call("wtn", { ...lease, observations: [{ playerId: "800123456", observation: negative }] })).status, 200);
    const saved = (await f.call("source")).data.wtnObservations["800123456"];
    assert.equal(saved.wtn, 11.2); assert.equal(saved.observed_on, "2026-11-13");
    assert.equal(saved.retrieved_at, "2026-11-13"); assert.equal(saved.no_wtn_checked_at, "2026-11-14");
});

test("private singles checkpoint pages are bounded and do not lose later identities", async t => {
    const f = await setup(t), lease = await f.claim();
    for (let index = 0; index < 51; index++) await f.save("wtarg:verified_wtn", String(800123000 + index), {
        observation: { name: "Profile " + index, source: "profile", wtn: 12.1, retrieved_at: "2026-11-14" },
    });
    const first = (await f.call("source")).data;
    assert.equal(Object.keys(first.wtnObservations).length, 50); assert.match(first.nextWtnCursor, /^800/);
    const second = (await f.call("wtn-page", { ...lease, cursor: first.nextWtnCursor })).data;
    assert.equal(Object.keys(second.wtnObservations).length, 1); assert.equal(second.nextWtnCursor, null);
    assert.equal((await f.call("wtn-page", { ...lease, cursor: "../private" })).status, 400);
});

test("bounded cleanup preserves accepted source/read data, independent WTN, recovery journals and other applications", async t => {
    const f = await setup(t), lease = await f.claim();
    await f.stage(lease); await f.upload(lease);
    await f.call("finish", { ...lease, state: "failed" });
    await f.save("wtarg:source_blob", hash("unreferenced"), { bytes: 1, base64: "AA==", sha256: hash("unreferenced") });
    await f.save("wtarg:verified_wtn", "800123456", { observation: { wtn: 11.2, source: "profile", retrieved_at: "2026-11-14" } });
    await f.save("wtarg:delta_journal", "interrupted-job:000000", { schemaVersion: 1, operations: [] });
    await f.save("calendar", "global", { otherApplication: true });
    for (let index = 0; index < 3; index++) {
        const result = await f.call("gc", { limit: 20 }, now + 2 * 86400000);
        assert.equal(result.status, 200, json(result.data)); assert.ok(result.data.deleted <= 20);
    }
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:source_blob' AND scope=?").bind(f.part.sha256).first()).count, 1);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:source_blob' AND scope=?").bind(hash("unreferenced")).first()).count, 0);
    for (const kind of ["wtarg:verified_wtn", "wtarg:delta_journal", "calendar"]) {
        assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind=?").bind(kind).first()).count, 1);
    }
    assert.equal((await f.call("source")).data.manifest.sourceVersion, f.source.sourceVersion);
    assert.equal((await f.call("/wtarg/v1/status")).data.currentReleaseId, oldId);
    assert.equal((await f.call("gc", { limit: 51 })).status, 400);
});

test("a complete guarded cleanup and immutable storage plan are required before normalized changes", async t => {
    const f = await setup(t), lease = (await f.call("claim", {})).data;
    const operations = [playerOperation("fixture:preflight")];
    const request = { ...lease, manifest: f.manifest(), sourceManifest: f.source,
        deltaBudget: { operations: 1, batches: 1, bytes: Buffer.byteLength(json(operations)) } };
    assert.equal((await f.call("preflight", request)).status, 409);
    assert.equal((await f.call("delta", { ...lease, batchId: 0, operations })).status, 409);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wtarg_players").first()).count, 0);
    await f.cleanup();
    const approved = await f.call("preflight", request);
    assert.equal(approved.status, 200, json(approved.data));
    const snapshotRows = () => f.db.prepare("SELECT kind,scope,payload_json,fetched_at FROM wta_snapshots ORDER BY kind,scope").all();
    const beforeRetry = (await snapshotRows()).results;
    const retry = await f.call("preflight", request, now + 1000);
    assert.equal(retry.status, 200); assert.equal(retry.data.unchanged, true);
    assert.deepEqual((await snapshotRows()).results, beforeRetry);
    const altered = { ...request, manifest: { ...request.manifest, preparedAt: new Date(now + 1000).toISOString() } };
    assert.equal((await f.call("preflight", altered)).status, 409);
    assert.equal((await f.call("delta", { ...lease, batchId: 0, operations })).status, 200);
});

test("near-cap and unknown database sizes stop before publication or normalized mutation", async t => {
    const f = await setup(t), lease = await f.claim();
    const operations = [playerOperation("fixture:capacity")];
    const request = { ...lease, manifest: f.manifest(), sourceManifest: f.source,
        deltaBudget: { operations: 1, batches: 1, bytes: Buffer.byteLength(json(operations)) } };
    f.env.ENTRY_LISTS_DB = storageProbe(f.db, 390000000);
    const blocked = await f.call("preflight", request);
    assert.equal(blocked.status, 507, json(blocked.data));
    assert.match(blocked.data.error, /storage|reserve/);
    f.env.ENTRY_LISTS_DB = storageProbe(f.db, undefined);
    assert.equal((await f.call("storage")).status, 503);
    assert.equal((await f.call("preflight", request)).status, 503);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wtarg_players").first()).count, 0);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:collector_preflight'").first()).count, 0);
    f.env.ENTRY_LISTS_DB = f.db;
    assert.equal((await f.call("/wtarg/v1/status")).data.currentReleaseId, oldId);
    const storage = await f.call("storage");
    assert.equal(storage.status, 200); assert.ok(storage.data.databaseBytes > 0);
    assert.equal(storage.data.limitBytes, 400000000);
    assert.equal(storage.data.recoveryReserveBytes, 32 * 1024 * 1024);
});

test("capacity is rechecked after preflight while saved data and retry receipts remain intact", async t => {
    const f = await setup(t), lease = await f.claim();
    await f.stage(lease);
    const part = { ...lease, resource: "bootstrap", index: 0, text: f.texts.bootstrap };
    f.env.ENTRY_LISTS_DB = storageProbe(f.db, 390000000);
    assert.equal((await f.call("part", part)).status, 507);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:read_part' AND scope=?")
        .bind(`${nextId}:bootstrap:0`).first()).count, 0);
    f.env.ENTRY_LISTS_DB = f.db;
    assert.equal((await f.call("part", part)).status, 200);
    f.env.ENTRY_LISTS_DB = storageProbe(f.db, undefined);
    const retry = await f.call("part", part, now + 1000);
    assert.equal(retry.status, 200); assert.equal(retry.data.unchanged, true);
});

test("unchanged D1 resources reuse initial accepted parts without requiring collector receipts", async t => {
    const f = await setup(t);
    for (const [resource, text] of Object.entries(f.texts)) await f.save("wtarg:read_part", `${oldId}:${resource}:0`, { text });
    const lease = await f.claim(), release = f.manifest();
    for (const resource of Object.values(release.resources)) resource.d1ReleaseId = oldId;
    await f.preflight(lease, [], release);
    assert.equal((await f.call("stage", { ...lease, manifest: release, sourceManifest: f.source,
        expectedBatches: 0, deltaHashes: [] })).status, 200);
    assert.equal((await f.call("part", { ...lease, resource: "history", index: 0, text: f.texts.history })).status, 400);
    const committed = await f.call("commit", lease);
    assert.equal(committed.status, 200, json(committed.data));
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:read_part' AND scope>=? AND scope<?")
        .bind(`${nextId}:`, `${nextId};`).first()).count, 0);
    const response = await wtargDataResponse(new Request(`https://example.workers.dev/wtarg/v1/releases/${nextId}/resources/bootstrap/parts/0`), f.env);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { text: f.texts.bootstrap });
});

test("expired unpublished stages are reclaimed before another provider cycle while accepted data survives", async t => {
    const f = await setup(t), lease = await f.claim();
    await f.stage(lease); await f.upload(lease);
    await f.cleanup(now + 180001);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:read_part' AND scope>=? AND scope<?")
        .bind(`${nextId}:`, `${nextId};`).first()).count, 0);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:source_blob' AND scope=?")
        .bind(f.part.sha256).first()).count, 1);
    assert.equal((await f.call("/wtarg/v1/status", undefined, now + 180001)).data.currentReleaseId, oldId);
});

test("cleanup retains interrupted undo evidence until rollback finishes", async t => {
    const f = await setup(t), lease = await f.claim();
    const operations = [playerOperation("fixture:undo-storage")];
    await f.preflight(lease, operations);
    const delta = await f.call("delta", { ...lease, batchId: 0, operations });
    assert.equal(delta.status, 200);
    await f.stage(lease, [delta.data.operationsHash]); await f.upload(lease);
    await f.cleanup(now + 180001);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:delta_journal'").first()).count, 1);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wtarg_players").first()).count, 1);
    const repair = await f.claim(now + 180001);
    assert.equal(repair.repairing, true);
    assert.equal((await f.call("rollback", repair, now + 180001)).data.complete, true);
    await f.cleanup(now + 180001);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wtarg_players").first()).count, 0);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:read_part' AND scope>=? AND scope<?")
        .bind(`${nextId}:`, `${nextId};`).first()).count, 0);
});

test("cleanup cannot delete candidates when the accepted pointer changes before its transaction", async t => {
    const f = await setup(t);
    const orphan = hash("racing orphan");
    await f.save("wtarg:source_blob", orphan, { sha256: orphan, bytes: 1, base64: "AA==" });
    let raced = false;
    f.env.ENTRY_LISTS_DB = { prepare(sql) { return f.db.prepare(sql); }, async batch(statements) {
        if (!raced) {
            raced = true;
            await f.save("wtarg:read_current", "global", { schemaVersion: 1, releaseId: hash("concurrent accepted release") });
        }
        return f.db.batch(statements);
    } };
    const result = await f.call("gc", { limit: 20 });
    assert.equal(result.status, 200, json(result.data)); assert.equal(raced, true);
    assert.equal(result.data.deleted, 0);
    assert.ok(await f.db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind='wtarg:source_blob' AND scope=?").bind(orphan).first());
});

test("repeated failed stages do not accumulate uploads and fifty-row cleanup stays within the Free query boundary", async t => {
    const f = await setup(t);
    for (let cycle = 0; cycle < 3; cycle++) {
        const time = now + cycle * 2 * 60 * 60 * 1000;
        const lease = await f.claim(time);
        await f.stage(lease, [], f.texts, f.source, time);
        await f.upload(lease, f.texts, time);
        assert.equal((await f.call("finish", { ...lease, state: "failed" }, time + 1000)).status, 200);
        await f.cleanup(time + 1000);
        assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind IN " +
            "('wtarg:collector_stage','wtarg:collector_preflight','wtarg:read_part','wtarg:read_part_meta')").first()).count, 0);
    }
    for (let index = 0; index < 50; index++) await f.save("wtarg:source_blob", hash(`unaccepted-${index}`),
        { bytes: 1, base64: "AA==", sha256: hash(`unaccepted-${index}`) });
    let queries = 0;
    f.env.ENTRY_LISTS_DB = { prepare(sql) { queries++; return f.db.prepare(sql); }, batch(statements) { return f.db.batch(statements); } };
    const cleanup = await f.call("gc", { limit: 50 }, now + 5 * 60 * 60 * 1000);
    assert.equal(cleanup.status, 200, json(cleanup.data)); assert.equal(cleanup.data.deleted, 50);
    assert.ok(queries <= 50, `cleanup prepared ${queries} queries`);
    assert.ok(await f.db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind='wtarg:source_blob' AND scope=?").bind(f.part.sha256).first());
});

test("eight distinct normalized tables and reverse recovery remain within the Free query boundary", async t => {
    const f = await setup(t), lease = await f.claim();
    const supplied = [
        ["wtarg_players", { player_key: "fixture:query", display_name: "Query Player", name_key: "query player", updated_at: "2026-11-14" }],
        ["wtarg_player_ids", { source: "itf", source_id: "800123456", player_key: "fixture:query" }],
        ["wtarg_player_aliases", { player_key: "fixture:query", alias: "Query Alias", normalized_alias: "query alias" }],
        ["wtarg_ranking_weeks", { series: "itf_singles", week_date: "2026-11-09", status: "imported" }],
        ["wtarg_rankings", { series: "itf_singles", week_date: "2026-11-09", row_key: "fixture", player_key: "fixture:query", rank: 1 }],
        ["wtarg_tournaments", { tournament_key: "fixture:event", source: "itf", name: "Query Tournament", updated_at: "2026-11-14" }],
        ["wtarg_tournament_sources", { source: "itf", source_event_key: "fixture:event", tournament_key: "fixture:event" }],
        ["wtarg_matches", { source: "itf", source_match_key: "fixture:match", tournament_key: "fixture:event", updated_at: "2026-11-14" }],
    ];
    const operations = [];
    for (const [table, values] of supplied) {
        const schema = (await f.db.prepare(`PRAGMA table_info("${table}")`).all()).results;
        const after = Object.fromEntries(schema.map(column => [column.name, Object.hasOwn(values, column.name) ? values[column.name] :
            column.dflt_value === null ? null : column.dflt_value.startsWith("'") ? column.dflt_value.slice(1, -1) : Number(column.dflt_value)]));
        operations.push({ table, key: Object.fromEntries(schema.filter(column => column.pk).map(column => [column.name, after[column.name]])),
            before: null, after });
    }
    await f.preflight(lease, operations);
    let queries = 0;
    f.env.ENTRY_LISTS_DB = { prepare(sql) { queries++; return f.db.prepare(sql); }, batch(statements) { return f.db.batch(statements); } };
    const delta = await f.call("delta", { ...lease, batchId: 0, operations });
    assert.equal(delta.status, 200, json(delta.data)); assert.ok(queries <= 50, `delta prepared ${queries} queries`);
    await f.call("finish", { ...lease, state: "failed" });
    queries = 0;
    const recovery = await f.call("rollback", lease);
    assert.equal(recovery.status, 200, json(recovery.data)); assert.equal(recovery.data.complete, true);
    assert.ok(queries <= 50, `rollback prepared ${queries} queries`);
});

test("external ranking files publish without D1 payload copies and remain available through pinned readers", async t => {
    const f = await setup(t), assets = await rankingAssetsFixture(f), lease = await f.claim();
    const prepared = await f.preflight(lease, [], assets.manifest, assets.source);
    assert.equal(prepared.data.sourceGrowthBytes, 0);
    assert.equal((await f.call("stage", { ...lease, manifest: assets.manifest, sourceManifest: assets.source,
        expectedBatches: 0, deltaHashes: [] })).status, 200);
    const nonRankings = Object.fromEntries(Object.entries(f.texts).filter(([name]) => name !== "rankings-latest"));
    await f.upload(lease, nonRankings);
    assert.equal((await f.call("part", { ...lease, resource: "rankings-latest", index: 0,
        text: assets.texts["rankings-latest"] })).status, 400);
    const commit = await f.call("commit", lease);
    assert.equal(commit.status, 200, json(commit.data));
    await f.cleanup();
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:read_part' " +
        "AND substr(scope,1,64)=? AND substr(scope,66,9)='rankings-'").bind(nextId).first()).count, 0);
    const response = await wtargDataResponse(new Request(`https://example.workers.dev/wtarg/v1/releases/${nextId}/resources/rankings-latest/parts/0`), f.env);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { text: assets.texts["rankings-latest"] });
    const source = await f.call("source/blobs/" + assets.part.sha256);
    assert.equal(source.status, 200); assert.equal(source.data.base64, assets.packed.toString("base64"));
    for (const request of assets.state.requests) assert.equal(request.headers.has("Authorization"), false);
    assets.state.missing = true;
    assert.equal((await f.call("source/blobs/" + assets.part.sha256)).status, 503);
});

test("unverified ranking assets cannot stage or commit a new accepted release", async t => {
    const f = await setup(t), assets = await rankingAssetsFixture(f), lease = await f.claim();
    const body = { ...lease, manifest: assets.manifest, sourceManifest: assets.source,
        deltaBudget: { operations: 0, batches: 0, bytes: 0 } };
    assets.state.missing = true;
    assert.equal((await f.call("preflight", body)).status, 409);
    assets.state.missing = false; assets.state.corrupt = true;
    assert.equal((await f.call("preflight", body)).status, 409);
    assets.state.corrupt = false;
    await f.preflight(lease, [], assets.manifest, assets.source);
    assert.equal((await f.call("stage", { ...lease, manifest: assets.manifest, sourceManifest: assets.source,
        expectedBatches: 0, deltaHashes: [] })).status, 200);
    await f.upload(lease, Object.fromEntries(Object.entries(f.texts).filter(([name]) => name !== "rankings-latest")));
    assets.state.missing = true;
    assert.equal((await f.call("commit", lease)).status, 409);
    assert.equal((await f.call("/wtarg/v1/status")).data.currentReleaseId, oldId);
    assets.state.missing = false;
    await f.db.prepare("UPDATE wtarg_ranking_weeks SET content_hash=? WHERE series='wta_singles'").bind(hash("wrong metadata")).run();
    assert.equal((await f.call("commit", lease)).status, 409);
    assert.equal((await f.call("/wtarg/v1/status")).data.currentReleaseId, oldId);
});

test("old D1 ranking recovery chunks are reclaimed only after both accepted generations use external files", async t => {
    const f = await setup(t), assets = await rankingAssetsFixture(f);
    const nonRankings = Object.fromEntries(Object.entries(f.texts).filter(([name]) => name !== "rankings-latest"));
    for (let generation = 0; generation < 2; generation++) {
        const time = now + generation * 2 * 60 * 60 * 1000;
        const lease = await f.claim(time);
        const manifest = { ...assets.manifest, releaseId: generation ? hash("second external release") : nextId };
        await f.preflight(lease, [], manifest, assets.source, time);
        assert.equal((await f.call("stage", { ...lease, manifest, sourceManifest: assets.source,
            expectedBatches: 0, deltaHashes: [] }, time)).status, 200);
        await f.upload(lease, nonRankings, time);
        const commit = await f.call("commit", lease, time);
        assert.equal(commit.status, 200, json(commit.data));
        await f.cleanup(time);
        const count = (await f.db.prepare("SELECT count(*) AS count FROM wta_snapshots WHERE kind='wtarg:source_blob' AND scope=?")
            .bind(assets.part.sha256).first()).count;
        assert.equal(count, generation === 0 ? 1 : 0);
    }
    assert.ok(await f.db.prepare("SELECT payload_json FROM wta_snapshots WHERE kind='wtarg:source_blob' AND scope=?")
        .bind(f.part.sha256).first());
    const value = await f.call("source/blobs/" + assets.part.sha256);
    assert.equal(value.status, 200); assert.equal(value.data.base64, assets.packed.toString("base64"));
});

test("the collector refuses per-player global WTA SQL rows while metadata remains independently mutable", async t => {
    const f = await setup(t), lease = await f.claim();
    await f.db.prepare("INSERT INTO wtarg_ranking_weeks(series,week_date,status) VALUES('wta_singles','2026-11-09','imported')").run();
    const schema = (await f.db.prepare("PRAGMA table_info(wtarg_rankings)").all()).results;
    const values = { series: "wta_singles", week_date: "2026-11-09", row_key: "1", name: "Player", rank: 1 };
    const after = Object.fromEntries(schema.map(column => [column.name, Object.hasOwn(values, column.name) ? values[column.name] :
        column.dflt_value === null ? null : column.dflt_value.startsWith("'") ? column.dflt_value.slice(1, -1) : Number(column.dflt_value)]));
    const operations = [{ table: "wtarg_rankings", key: { series: "wta_singles", week_date: "2026-11-09", row_key: "1" }, before: null, after }];
    await f.preflight(lease, operations);
    const result = await f.call("delta", { ...lease, batchId: 0, operations });
    assert.equal(result.status, 409); assert.match(result.data.error, /immutable files/);
    assert.equal((await f.db.prepare("SELECT count(*) AS count FROM wtarg_rankings WHERE series='wta_singles'").first()).count, 0);
});
