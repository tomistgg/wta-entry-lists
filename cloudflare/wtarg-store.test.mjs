import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { getWtargRoute, validWtargManifest, validateWtargResourceBackings, wtargDataResponse } from "./wtarg-store.mjs";
import worker from "./worker.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const id = hash("release one");
const secondId = hash("release two");
const bytes = value => Buffer.byteLength(value, "utf8");
const request = (path, method = "GET") => new Request("https://example.workers.dev" + path, { method });
const releasePath = releaseId => `/wtarg/v1/releases/${releaseId}`;

function fixture() {
    const rows = new Map(), assetRows = new Map(), reads = [], assetReads = [];
    const save = (kind, scope, value) => rows.set(`${kind}/${scope}`, { payload_json: JSON.stringify(value) });
    const db = { prepare(sql) {
        assert.equal(sql, "SELECT payload_json FROM wta_snapshots WHERE kind = ? AND scope = ?");
        return { bind(kind, scope) { return { async first() {
            reads.push([kind, scope]);
            return rows.get(`${kind}/${scope}`) || null;
        } }; } };
    } };
    const env = { ENTRY_LISTS_DB: db, WTARG_ASSETS: { async fetch(req) {
        assetReads.push(req.url);
        const payload = assetRows.get(new URL(req.url).pathname);
        return payload === undefined ? new Response("missing", { status: 404 }) : Response.json(payload);
    } } };
    function seed(releaseId = id, overrides = {}) {
        const texts = { bootstrap: '{"schemaVersion":1,"tournaments":["Córdoba"]}', history: '[{"match":"saved"}]' };
        const resources = Object.fromEntries(Object.entries(texts).map(([name, text]) => [name, {
            storage: name === "bootstrap" ? "d1" : "asset", sha256: hash(text), bytes: bytes(text),
            parts: [{ sha256: hash(text), bytes: bytes(text) }],
        }]));
        const manifest = { schemaVersion: 1, releaseId, applicationVersion: hash("app"), sourceVersion: hash("source"),
            sourceFrozenAt: "2026-11-14T02:22:42.520063+00:00", preparedAt: "2026-11-14T12:00:00Z", resources,
            ...overrides };
        save("wtarg:read_current", "global", { schemaVersion: 1, releaseId });
        save("wtarg:read_manifest", releaseId, manifest);
        save("wtarg:read_accepted", releaseId, { schemaVersion: 1, releaseId, manifestSha256: hash(JSON.stringify(manifest)) });
        save("wtarg:read_part", `${releaseId}:bootstrap:0`, { text: texts.bootstrap });
        assetRows.set(`/wtarg-assets/${releaseId}/history/0.json`, { text: texts.history });
        return { manifest, texts };
    }
    const call = (path, method = "GET") => wtargDataResponse(request(path, method), env, { "X-Test": "preserved" });
    return { rows, save, env, reads, assetRows, assetReads, seed, call };
}

test("WTARG routes only accept fixed versioned resource paths", () => {
    assert.deepEqual(getWtargRoute("/wtarg/v1/manifest"), { current: true });
    assert.equal(getWtargRoute(`${releasePath(id)}/resources/bootstrap/parts/0`).resource, "bootstrap");
    for (const path of ["/wtarg/v2/manifest", `${releasePath("bad")}/manifest`,
        `${releasePath(id)}/resources/wtarg:source_bytes/parts/0`, `${releasePath(id)}/resources/../parts/0`,
        `${releasePath(id)}/resources/%2Fhistory/parts/0`, `${releasePath(id)}/resources/history/parts/-1`,
        `${releasePath(id)}/resources/history/parts/00`, `${releasePath(id)}/resources/history/parts/1000`]) {
        assert.equal(getWtargRoute(path), null, path);
    }
});

test("an unpublished or unaccepted baseline is never exposed", async () => {
    const { call, seed, rows } = fixture();
    assert.equal((await call("/wtarg/v1/manifest")).status, 503);
    assert.equal((await call(`${releasePath(id)}/manifest`)).status, 404);
    seed();
    rows.delete(`wtarg:read_accepted/${id}`);
    assert.equal((await call("/wtarg/v1/manifest")).status, 503);
    assert.equal((await call(`${releasePath(id)}/resources/bootstrap/parts/0`)).status, 404);
});

test("accepted reads return verified content without writes or provider calls", async t => {
    const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider request"); });
    const { call, seed, assetReads } = fixture();
    const { manifest, texts } = seed();
    const current = await call("/wtarg/v1/manifest");
    assert.equal(current.headers.get("X-Test"), "preserved");
    assert.deepEqual(await current.json(), manifest);
    assert.deepEqual(await (await call(`${releasePath(id)}/resources/bootstrap/parts/0`)).json(), { text: texts.bootstrap });
    assert.deepEqual(await (await call(`${releasePath(id)}/resources/history/parts/0`)).json(), { text: texts.history });
    assert.deepEqual(assetReads, [`https://wtarg-assets.invalid/wtarg-assets/${id}/history/0.json`]);
    assert.equal(upstream.mock.callCount(), 0);
});

test("clients keep their accepted release after the current pointer advances", async () => {
    const { call, seed } = fixture();
    const first = seed();
    seed(secondId);
    assert.equal((await (await call("/wtarg/v1/manifest")).json()).releaseId, secondId);
    assert.deepEqual(await (await call(`${releasePath(id)}/manifest`)).json(), first.manifest);
    assert.deepEqual(await (await call(`${releasePath(id)}/resources/bootstrap/parts/0`)).json(), { text: first.texts.bootstrap });
});

test("unchanged D1 and asset resources keep flattened accepted owners through later releases", async () => {
    const f = fixture();
    const first = f.seed();
    const resources = structuredClone(first.manifest.resources);
    resources.bootstrap.d1ReleaseId = id;
    resources.history.assetReleaseId = id;
    const second = { ...first.manifest, releaseId: secondId, resources };
    assert.equal(validateWtargResourceBackings(f.env.ENTRY_LISTS_DB, second, first.manifest), true);
    const thirdId = hash("release three");
    const third = { ...second, releaseId: thirdId, resources: structuredClone(resources) };
    assert.equal(validateWtargResourceBackings(f.env.ENTRY_LISTS_DB, third, second), true);
    assert.deepEqual(f.reads, []);
    f.seed(thirdId, third);
    f.rows.delete(`wtarg:read_part/${thirdId}:bootstrap:0`);
    assert.deepEqual(await (await f.call(`${releasePath(thirdId)}/resources/bootstrap/parts/0`)).json(),
        { text: first.texts.bootstrap });
    assert.deepEqual(await (await f.call(`${releasePath(thirdId)}/resources/history/parts/0`)).json(),
        { text: first.texts.history });
    assert.equal(f.assetReads.at(-1), `https://wtarg-assets.invalid/wtarg-assets/${id}/history/0.json`);
});

test("accepted static ranking reads use their immutable Pages origin while ordinary assets keep their binding", async () => {
    const f = fixture(), first = f.seed();
    const text = '{"p":["Player"],"d":{"2026-11-09":[[1,null]]}}';
    const rankingAssets = { schemaVersion: 1, bundleId: hash("ranking bundle"), origin: "https://1234abcd.wtarg-ranking-files.pages.dev" };
    const resources = { ...first.manifest.resources, "rankings-latest": { storage: "asset", assetStore: "rankings",
        assetReleaseId: rankingAssets.bundleId, sha256: hash(text), bytes: bytes(text), parts: [{ sha256: hash(text), bytes: bytes(text) }] } };
    const manifest = f.seed(secondId, { rankingAssets, resources }).manifest;
    assert.equal(validWtargManifest(manifest, secondId), true);
    const calls = [];
    f.env.WTARG_RANKING_ASSET_FETCHER = { async fetch(request) { calls.push(request); return Response.json({ text }); } };
    const path = `${releasePath(secondId)}/resources/rankings-latest/parts/0`;
    assert.deepEqual(await (await f.call(path)).json(), { text });
    assert.equal(calls[0].url, rankingAssets.origin + "/public/rankings-latest/0.json");
    assert.equal(calls[0].headers.has("Authorization"), false);
    assert.equal(f.assetReads.length, 0);
    assert.deepEqual(await (await f.call(`${releasePath(secondId)}/resources/history/parts/0`)).json(), { text: first.texts.history });
    f.env.WTARG_RANKING_ASSET_FETCHER.fetch = async () => Response.json({ text: "corrupt" });
    assert.equal((await f.call(path)).status, 503);
});

test("ranking asset references cannot target other public resources or lose their bundle binding", () => {
    const f = fixture(), first = f.seed();
    const rankingAssets = { schemaVersion: 1, bundleId: hash("ranking bundle"), origin: "https://1234abcd.wtarg-ranking-files.pages.dev" };
    const resource = { ...first.manifest.resources.history, assetStore: "rankings", assetReleaseId: rankingAssets.bundleId };
    const valid = { ...first.manifest, rankingAssets, resources: { ...first.manifest.resources, "rankings-latest": resource } };
    assert.equal(validWtargManifest(valid, id), true);
    for (const changed of [
        { ...valid, rankingAssets: undefined },
        { ...valid, rankingAssets: { ...rankingAssets, origin: "https://ranking-files.wtarg-ranking-files.pages.dev" } },
        { ...valid, resources: { ...valid.resources, history: resource } },
        { ...valid, resources: { ...valid.resources, "rankings-latest": { ...resource, assetReleaseId: hash("different bundle") } } },
    ]) assert.equal(validWtargManifest(changed, id), false);
});

test("D1 backing reads fail visibly when the accepted owner's part is missing or corrupt", async () => {
    for (const payload of [undefined, { text: "corrupt" }]) {
        const f = fixture();
        const first = f.seed();
        const resources = structuredClone(first.manifest.resources);
        resources.bootstrap.d1ReleaseId = id;
        f.seed(secondId, { resources });
        if (payload === undefined) f.rows.delete(`wtarg:read_part/${id}:bootstrap:0`);
        else f.save("wtarg:read_part", `${id}:bootstrap:0`, payload);
        assert.equal((await f.call(`${releasePath(secondId)}/resources/bootstrap/parts/0`)).status, 503);
    }
});

test("resource references cannot change owners, type, content, part storage or introduce a chain", () => {
    const f = fixture();
    const first = f.seed();
    const next = () => {
        const manifest = structuredClone(first.manifest);
        manifest.releaseId = secondId;
        manifest.resources.bootstrap.d1ReleaseId = id;
        manifest.resources.history.assetReleaseId = id;
        return manifest;
    };
    for (const mutate of [
        manifest => { manifest.resources.bootstrap.d1ReleaseId = secondId; },
        manifest => { manifest.resources.bootstrap.d1ReleaseId = hash("unaccepted owner"); },
        manifest => { manifest.resources.bootstrap.sha256 = hash("different content"); },
        manifest => { manifest.resources.bootstrap.parts[0].sha256 = hash("different part"); },
        manifest => { manifest.resources.bootstrap.parts[0].storedBytes = 10; },
        manifest => { manifest.resources.history.storage = "d1"; delete manifest.resources.history.assetReleaseId;
            manifest.resources.history.d1ReleaseId = id; },
        manifest => { delete manifest.resources.history.assetReleaseId; },
    ]) {
        const manifest = next(); mutate(manifest);
        assert.throws(() => validateWtargResourceBackings(f.env.ENTRY_LISTS_DB, manifest, first.manifest), /backing|reference/);
    }
    const second = next();
    assert.equal(validateWtargResourceBackings(f.env.ENTRY_LISTS_DB, second, first.manifest), true);
    const chained = { ...next(), releaseId: hash("third"), resources: structuredClone(second.resources) };
    chained.resources.bootstrap.d1ReleaseId = secondId;
    assert.throws(() => validateWtargResourceBackings(f.env.ENTRY_LISTS_DB, chained, second), /reference/);
});

test("resource backing verification remains bounded with many distinct accepted owners", () => {
    const f = fixture();
    const { manifest: base } = f.seed();
    for (let year = 1983; year <= 2026; year++) base.resources[`rankings-${year}`] = {
        ...structuredClone(base.resources.bootstrap), d1ReleaseId: hash(`owner ${year}`),
    };
    const next = structuredClone(base);
    next.releaseId = secondId;
    next.resources.bootstrap.d1ReleaseId = id;
    next.resources.history.assetReleaseId = id;
    assert.equal(validateWtargResourceBackings(f.env.ENTRY_LISTS_DB, next, base), true);
    assert.deepEqual(f.reads, []);
});

test("optional backing and stored-size metadata is type checked while legacy descriptors remain valid", () => {
    const { manifest } = fixture().seed();
    assert.equal(validWtargManifest(manifest, id), true);
    for (const value of [null, 0, -1, 1900001, 1.5, "15", Number.NaN]) {
        const altered = structuredClone(manifest);
        altered.resources.bootstrap.parts[0].storedBytes = value;
        assert.equal(validWtargManifest(altered, id), false, String(value));
    }
    for (const value of [null, 123, "bad", [id]]) {
        const altered = structuredClone(manifest);
        altered.resources.bootstrap.d1ReleaseId = value;
        assert.equal(validWtargManifest(altered, id), false, String(value));
    }
    const valid = structuredClone(manifest);
    valid.resources.bootstrap.parts[0].storedBytes = bytes(JSON.stringify({ text: "fixture" }));
    valid.resources.bootstrap.d1ReleaseId = secondId;
    assert.equal(validWtargManifest(valid, id), true);
    valid.resources.history.d1ReleaseId = secondId;
    assert.equal(validWtargManifest(valid, id), false);
});

test("manifest tampering, incompatible shape and unsafe dimensions fail closed", async () => {
    const altered = fixture();
    altered.seed();
    altered.rows.get(`wtarg:read_manifest/${id}`).payload_json += " ";
    assert.equal((await altered.call("/wtarg/v1/manifest")).status, 503);
    const invalid = [
        { schemaVersion: 2 }, { releaseId: secondId }, { applicationVersion: "bad" }, { sourceFrozenAt: "invalid" },
        { resources: {} }, { resources: { private: {} } },
        { resources: { bootstrap: { storage: "asset", sha256: id, bytes: 1, parts: [{ sha256: id, bytes: 1 }] } } },
        { resources: { bootstrap: { storage: "d1", sha256: id, bytes: 1, parts: [{ sha256: id, bytes: 2 }] } } },
        { resources: { bootstrap: { storage: "d1", sha256: id, bytes: 1000001, parts: [{ sha256: id, bytes: 1000001 }] } } },
        { resources: { bootstrap: { storage: "d1", sha256: id, bytes: 257,
            parts: Array.from({ length: 257 }, () => ({ sha256: id, bytes: 1 })) } } },
    ];
    for (const override of invalid) {
        const { call, seed } = fixture(); seed(id, override);
        assert.equal((await call("/wtarg/v1/manifest")).status, 503, JSON.stringify(override));
    }
});

test("missing, corrupt and oversized resource parts never become successful data", async () => {
    for (const payload of [null, { text: "changed" }, { text: 123 }, { text: "" }]) {
        const { call, seed, save } = fixture(); seed();
        save("wtarg:read_part", `${id}:bootstrap:0`, payload);
        assert.equal((await call(`${releasePath(id)}/resources/bootstrap/parts/0`)).status, 503);
    }
    const { call, seed, env } = fixture(); seed();
    env.WTARG_ASSETS.fetch = async () => new Response("x".repeat(1900001));
    assert.equal((await call(`${releasePath(id)}/resources/history/parts/0`)).status, 503);
});

test("missing asset binding or missing archive part is a visible temporary failure", async () => {
    const { call, seed, env, assetRows } = fixture(); seed();
    assetRows.clear();
    assert.equal((await call(`${releasePath(id)}/resources/history/parts/0`)).status, 503);
    delete env.WTARG_ASSETS;
    assert.equal((await call(`${releasePath(id)}/resources/history/parts/0`)).status, 503);
    assert.equal((await call(`${releasePath(id)}/resources/bootstrap/parts/0`)).status, 200);
});

test("unknown resources/parts and mutating methods do not reach content storage", async () => {
    const { call, seed, reads } = fixture(); seed();
    assert.equal((await call(`${releasePath(id)}/resources/rankings-2027/parts/0`)).status, 404);
    assert.equal((await call(`${releasePath(id)}/resources/bootstrap/parts/1`)).status, 404);
    const before = reads.length;
    for (const method of ["POST", "PUT", "DELETE"]) {
        assert.equal((await call("/wtarg/v1/manifest", method)).status, 405);
    }
    assert.equal(reads.length, before);
});

test("Worker integration preserves CORS/method guards and existing health route", async () => {
    const { env, seed } = fixture(); const { manifest } = seed();
    const response = await worker.fetch(request("/wtarg/v1/manifest"), env);
    assert.deepEqual(await response.json(), manifest);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "https://tomistgg.github.io");
    assert.equal((await worker.fetch(request("/wtarg/v1/manifest", "POST"), env)).status, 405);
    assert.equal((await worker.fetch(request("/wtarg/v1/manifest", "OPTIONS"), env)).status, 204);
    assert.equal((await worker.fetch(request("/wtarg/v1/unknown"), env)).status, 404);
    assert.deepEqual(await (await worker.fetch(request("/health"), env)).json(), { ok: true });
});

test("WTARG custom domains have scoped read/preflight access without widening other routes", async t => {
    const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected provider request"); });
    const { env, seed } = fixture(); seed();
    const call = (path, origin, method = "GET") => worker.fetch(new Request("https://example.workers.dev" + path,
        { method, headers: { Origin: origin } }), env);
    for (const origin of ["https://wtarg.com", "https://www.wtarg.com"]) {
        for (const method of ["GET", "OPTIONS"]) {
            const response = await call("/wtarg/v1/manifest", origin, method);
            assert.equal(response.status, method === "GET" ? 200 : 204);
            assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
            assert.equal(response.headers.get("Vary"), "Origin");
        }
        for (const path of ["/health", "/entry-lists", "/data/players", "/photos", "/api/tennis/players/ranked"]) {
            assert.equal((await call(path, origin)).status, 403, path);
        }
        for (const path of ["/entry-lists/refresh", "/data/results/refresh"]) {
            assert.equal((await call(path, origin, "POST")).status, 403, path);
        }
    }
    for (const origin of ["https://other.example", "http://wtarg.com", "https://wtarg.com.other.example"]) {
        assert.equal((await call("/wtarg/v1/manifest", origin)).status, 403);
    }
    assert.equal(upstream.mock.callCount(), 0);
});
