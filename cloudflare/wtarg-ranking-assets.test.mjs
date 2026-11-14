import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { Miniflare } from "miniflare";
import { RANKING_SOURCE_FILES, rankingPublicPart, rankingSourceBlob, validRankingAssetRef,
    validateRankingAssets } from "./wtarg-ranking-assets.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const json = value => JSON.stringify(value);
const origin = "https://1234abcd.wtarg-ranking-files.pages.dev";

function fixture() {
    const packed = gzipSync("original,ranking,bytes\r\n");
    const part = { sha256: hash(packed), bytes: packed.length };
    const source = { rawSha256: hash("original,ranking,bytes\r\n"), rawBytes: Buffer.byteLength("original,ranking,bytes\r\n"),
        gzipSha256: hash(packed), gzipBytes: packed.length, parts: [part] };
    const text = '{"p":["Player"],"d":{"2026-11-09":[[1,null]]}}';
    const resource = { sha256: hash(text), bytes: Buffer.byteLength(text),
        parts: [{ sha256: hash(text), bytes: Buffer.byteLength(text) }] };
    const week = { week_date: "2026-11-09", sha256: hash("lossless archive"), bytes: 50, rows: 1,
        source_file: "wta_rankings_20_29.csv" };
    week.path = `history/${week.week_date}-${week.sha256}.json`;
    const bundle = { schemaVersion: 1, sources: Object.fromEntries([...RANKING_SOURCE_FILES].map(name => [name, source])),
        resources: { "rankings-latest": resource, "rankings-2026": resource }, weeks: [week] };
    const reference = { schemaVersion: 1, origin, bundleId: hash(json(bundle)) };
    const sourceManifest = { rankingAssets: reference, files: [...RANKING_SOURCE_FILES]
        .map(name => ({ ...source, name, storage: "ranking-assets" })), rankingCheckpointWeeks: { [week.week_date]: week.sha256 } };
    const manifest = { rankingAssets: reference, resources: Object.fromEntries(Object.entries(bundle.resources)
        .map(([name, value]) => [name, { ...value, storage: "asset", assetStore: "rankings", assetReleaseId: reference.bundleId }])) };
    const requests = [];
    const env = { WTARG_RANKING_ASSET_FETCHER: { async fetch(request) {
        requests.push(request);
        const path = new URL(request.url).pathname;
        if (path === "/manifest.json") return Response.json(bundle);
        if (path === `/source/${part.sha256}.bin`) return new Response(packed);
        if (/^\/public\/rankings-(?:latest|2026)\/0\.json$/.test(path)) return Response.json({ text });
        return new Response("missing", { status: 404 });
    } } };
    return { packed, part, source, sourceManifest, manifest, bundle, reference, text, env, requests };
}

test("ranking assets require an immutable deployment in the configured Pages project", async () => {
    const f = fixture();
    assert.equal(validRankingAssetRef(f.reference), true);
    for (const candidate of ["http://1234abcd.wtarg-ranking-files.pages.dev", "https://wtarg-ranking-files.pages.dev",
        "https://ranking-files.wtarg-ranking-files.pages.dev", origin + "/extra", origin + "/", origin + "?q=1",
        "https://user@1234abcd.wtarg-ranking-files.pages.dev", "https://1234abcd.wtarg-ranking-files.pages.dev:444",
        "https://1234abcd.wtarg-ranking-files.pages.dev.evil.test"]) {
        assert.equal(validRankingAssetRef({ ...f.reference, origin: candidate }), false, candidate);
    }
    const wrongProject = { ...f.reference, origin: "https://1234abcd.other-project.pages.dev" };
    await assert.rejects(rankingPublicPart(f.env, wrongProject, "rankings-latest", 0), /origin/);
    assert.equal(f.requests.length, 0);
});

test("the complete hashed ranking bundle binds public, raw and lossless weekly recovery inventories", async () => {
    const f = fixture();
    assert.deepEqual(await validateRankingAssets(f.env, f.manifest, f.sourceManifest), f.bundle);
    for (const target of ["public", "source", "week"]) {
        const manifest = structuredClone(f.manifest), source = structuredClone(f.sourceManifest);
        if (target === "public") manifest.resources["rankings-latest"].sha256 = hash("changed public content");
        if (target === "source") source.files[0].rawSha256 = hash("changed source");
        if (target === "week") source.rankingCheckpointWeeks["2026-11-09"] = hash("changed archive");
        await assert.rejects(validateRankingAssets(f.env, manifest, source), /differs/);
    }
});

test("ranking asset reads verify source bytes and never forward collector or provider credentials", async () => {
    const f = fixture();
    const value = await rankingSourceBlob(f.env, f.sourceManifest, f.part.sha256);
    assert.equal(value.base64, f.packed.toString("base64"));
    assert.equal(value.sha256, f.part.sha256);
    assert.deepEqual(await rankingPublicPart(f.env, f.reference, "rankings-latest", 0), { text: f.text });
    for (const request of f.requests) {
        assert.equal(request.redirect, "manual");
        for (const header of ["authorization", "origin", "referer", "account"]) assert.equal(request.headers.has(header), false);
    }
    f.env.WTARG_RANKING_ASSET_FETCHER.fetch = async () => new Response("corrupted gzip");
    await assert.rejects(rankingSourceBlob(f.env, f.sourceManifest, f.part.sha256), /checksum/);
});

test("corrupt, redirecting, missing and oversized ranking manifests cannot validate a release", async () => {
    for (const response of [() => new Response("{}"), () => new Response(null, { status: 302, headers: { Location: "https://evil.test" } }),
        () => new Response("missing", { status: 404 }), () => new Response("x".repeat(1900001))]) {
        const f = fixture();
        f.env.WTARG_RANKING_ASSET_FETCHER.fetch = async () => response();
        await assert.rejects(validateRankingAssets(f.env, f.manifest, f.sourceManifest));
    }
});

test("external sources are limited to the four ranking CSVs and the same public bundle", async () => {
    const f = fixture();
    const changed = structuredClone(f.sourceManifest);
    changed.files[0].name = "player_aliases_wta_itf.json";
    await assert.rejects(validateRankingAssets(f.env, f.manifest, changed), /same immutable/);
    changed.files[0].name = [...RANKING_SOURCE_FILES][0];
    changed.rankingAssets.bundleId = hash("different bundle");
    await assert.rejects(validateRankingAssets(f.env, f.manifest, changed), /same immutable/);
});

test("full-size ranking source chunks round-trip through the actual Worker runtime", async t => {
    const raw = randomBytes(196608), checksum = hash(raw);
    const source = { files: [{ storage: "ranking-assets", parts: [{ sha256: checksum, bytes: raw.length }] }],
        rankingAssets: { schemaVersion: 1, bundleId: hash("bundle"), origin } };
    const mf = new Miniflare({ compatibilityDate: "2026-07-30", modules: [
        { type: "ESModule", path: "entry.mjs", contents: `import { rankingSourceBlob } from './ranking-assets.mjs';
            export default { async fetch(request, env) { try {
                return Response.json(await rankingSourceBlob(env, ${json(source)}, '${checksum}'));
            } catch (error) { return Response.json({ error: error.message, stack: error.stack }, { status: 500 }); } } };` },
        { type: "ESModule", path: "ranking-assets.mjs", contents: await readFile(new URL("wtarg-ranking-assets.mjs", import.meta.url), "utf8") },
    ], serviceBindings: { WTARG_RANKING_ASSET_FETCHER: async () => new Response(raw) },
    outboundService() { throw new Error("No provider requests are allowed."); } });
    t.after(() => mf.dispose());
    const response = await mf.dispatchFetch("https://local.invalid/source");
    const result = await response.json();
    assert.equal(response.status, 200, json(result));
    assert.deepEqual(Buffer.from(result.base64, "base64"), raw);
});
