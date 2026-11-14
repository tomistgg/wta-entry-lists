import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import test from "node:test";
import { createWtargPreview, safeLocalDirectory, validatePreviewPlan } from "./preview-wtarg.mjs";

const localRoot = resolve(import.meta.dirname, "../../tenis-fem-arg/cloudflare/.local");
const hash = text => createHash("sha256").update(text).digest("hex");
const id = hash("preview fixture");

function preparedPlan() {
    const texts = { bootstrap: '{"schemaVersion":1}', history: '[{"result":"saved"}]' };
    const manifest = { schemaVersion: 1, releaseId: id, applicationVersion: hash("app"), sourceVersion: hash("source"),
        sourceFrozenAt: "2026-11-14T02:00:00Z", preparedAt: "2026-11-14T03:00:00Z",
        resources: Object.fromEntries(Object.entries(texts).map(([key, text]) => [key, {
            storage: key === "bootstrap" ? "d1" : "asset", sha256: hash(text), bytes: Buffer.byteLength(text),
            parts: [{ sha256: hash(text), bytes: Buffer.byteLength(text) }],
        }])) };
    const row = (kind, scope, payload) => ({ kind, scope, payload_json: JSON.stringify(payload),
        fetched_at: manifest.preparedAt, expires_at: null });
    const manifestRow = row("wtarg:read_manifest", id, manifest);
    return { texts, plan: { schemaVersion: 1, localPreviewOnly: true, manifest, snapshots: [manifestRow,
        row("wtarg:read_accepted", id, { schemaVersion: 1, releaseId: id, manifestSha256: hash(manifestRow.payload_json) }),
        row("wtarg:read_current", "global", { schemaVersion: 1, releaseId: id }),
        row("wtarg:read_part", `${id}:bootstrap:0`, { text: texts.bootstrap }),
    ] } };
}

async function directories(t) {
    await mkdir(localRoot, { recursive: true });
    const root = await mkdtemp(resolve(localRoot, "step4-preview-test-"));
    t.after(async () => {
        assert.ok(resolve(root).startsWith(localRoot + sep + "step4-preview-test-"));
        await rm(root, { recursive: true, force: true });
    });
    return root;
}

test("preview seeding only accepts its release, exact markers and complete bootstrap", () => {
    assert.equal(validatePreviewPlan(preparedPlan().plan).manifest.releaseId, id);
    const invalid = [
        plan => { plan.localPreviewOnly = false; },
        plan => { plan.snapshots.push({ ...plan.snapshots[0], kind: "players" }); },
        plan => { plan.snapshots[3].scope = `${hash("other")}:bootstrap:0`; },
        plan => { plan.snapshots.push(plan.snapshots[0]); },
        plan => { plan.snapshots.pop(); },
        plan => { plan.snapshots[3].payload_json = '{"text":"tampered"}'; },
        plan => { plan.snapshots[1].payload_json = JSON.stringify({ schemaVersion: 1, releaseId: id, manifestSha256: hash("wrong") }); },
        plan => { plan.snapshots[2].payload_json = JSON.stringify({ schemaVersion: 1, releaseId: hash("other") }); },
    ];
    for (const change of invalid) {
        const { plan } = preparedPlan(); change(plan);
        assert.throws(() => validatePreviewPlan(plan));
    }
});

test("preview directories must remain below the ignored WTARG directory", async t => {
    const root = await directories(t);
    assert.equal(await safeLocalDirectory(root), root);
    await assert.rejects(safeLocalDirectory(localRoot));
    await assert.rejects(safeLocalDirectory(resolve(localRoot, "..")));
});

test("actual offline Worker serves accepted D1 and asset parts with bounded static access", async t => {
    const root = await directories(t);
    const release = resolve(root, "release"), site = resolve(root, "site");
    const assetDirectory = resolve(release, "assets/wtarg-assets", id, "history");
    await mkdir(assetDirectory, { recursive: true });
    await mkdir(site);
    const { plan, texts } = preparedPlan();
    await writeFile(resolve(release, "preview-plan.json"), JSON.stringify(plan));
    await writeFile(resolve(assetDirectory, "0.json"), JSON.stringify({ text: texts.history }));
    await writeFile(resolve(site, "index.html"), "<h1>WTARG fixture</h1>");
    await writeFile(resolve(site, "app.html"), "<h1>WTARG app fixture</h1>");
    await writeFile(resolve(site, "private.json"), '{"private":true}');
    const preview = await createWtargPreview({ release, site, port: 0 });
    try {
        const base = preview.url.slice(0, -1);
        assert.equal(await (await fetch(preview.url)).text(), "<h1>WTARG fixture</h1>");
        assert.equal((await fetch(base + "/app.html", { method: "HEAD" })).status, 200);
        const manifest = await (await fetch(base + "/wtarg/v1/manifest")).json();
        assert.equal(manifest.releaseId, id);
        for (const name of ["bootstrap", "history"]) {
            const response = await fetch(base + `/wtarg/v1/releases/${id}/resources/${name}/parts/0`);
            assert.equal(response.status, 200);
            assert.deepEqual(await response.json(), { text: texts[name] });
        }
        assert.equal((await fetch(base + "/wtarg/v1/manifest", { method: "POST" })).status, 405);
        for (const path of ["/private.json", "/.git/config", "/%2e%2e/preview-plan.json", "/api/tennis/players/ranked"]) {
            assert.equal((await fetch(base + path)).status, 404, path);
        }
        assert.equal(JSON.parse(await readFile(resolve(release, "preview-plan.json"), "utf8")).localPreviewOnly, true);
    } finally { await preview.close(); }
});

test("collector preview loads a private baseline, forwards authenticated bodies and keeps browser-origin isolation", async t => {
    const root = await directories(t);
    const release = resolve(root, "release"), site = resolve(root, "site"), seed = resolve(root, "collector");
    await mkdir(resolve(release, "assets"), { recursive: true });
    await mkdir(site); await mkdir(seed);
    const { plan } = preparedPlan();
    const map = JSON.parse(await readFile(new URL("../../tenis-fem-arg/cloudflare/import-map.json", import.meta.url), "utf8"));
    const raw = Buffer.from("{}"), compressed = gzipSync(raw);
    const blob = { sha256: hash(compressed), bytes: compressed.length, base64: compressed.toString("base64") };
    const files = Object.keys(map.sources).sort().map(name => ({ name, rawSha256: hash(raw), rawBytes: raw.length,
        gzipSha256: blob.sha256, gzipBytes: blob.bytes, parts: [{ sha256: blob.sha256, bytes: blob.bytes }] }));
    const source = { schemaVersion: 1, sourceVersion: hash(JSON.stringify(files.map(file => ({ name: file.name, bytes: file.rawBytes, sha256: file.rawSha256 })))),
        sourceRevision: "a".repeat(40), files, totalRawBytes: raw.length * files.length, totalGzipBytes: compressed.length * files.length };
    plan.manifest.sourceVersion = source.sourceVersion;
    plan.snapshots[0].payload_json = JSON.stringify(plan.manifest);
    plan.snapshots[1].payload_json = JSON.stringify({ schemaVersion: 1, releaseId: id, manifestSha256: hash(plan.snapshots[0].payload_json) });
    await writeFile(resolve(release, "preview-plan.json"), JSON.stringify(plan));
    await writeFile(resolve(site, "app.html"), "<h1>Private fixture</h1>");
    await writeFile(resolve(seed, "collector-seed.json"), JSON.stringify({ sourceManifest: source, blobs: [blob] }));
    const records = [];
    for (let index = 0; index < 500; index++) records.push({ table: "wtarg_players", row: {
        player_key: "fixture:" + index, display_name: "Fixture " + index, name_key: "fixture " + index, presentation_name: "", country: "ARG",
        dob: null, profile_json: "{}", updated_at: plan.manifest.preparedAt,
    } });
    for (let index = 0; index < 500; index++) records.push({ table: "wtarg_player_aliases", row: {
        player_key: "fixture:" + index, alias: "Alias " + index, normalized_alias: "alias " + index, source: "fixture",
    } });
    await writeFile(resolve(seed, "normalized.ndjson"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
    const progress = [];
    const preview = await createWtargPreview({ release, site, collectorSeed: seed, port: 0, progress: message => progress.push(message) });
    try {
        const base = preview.url.slice(0, -1);
        assert.ok(progress.some(message => message.includes("1,000 normalized records")));
        const state = await (await fetch(base + "/wtarg/v1/status")).json();
        assert.equal(state.enabled, true);
        assert.equal((await fetch(base + "/wtarg/v1/refresh", { method: "POST", headers: { Origin: base } })).status, 202);
        assert.equal((await fetch(base + "/wtarg/v1/refresh", { method: "POST", headers: { Origin: "https://other.example" } })).status, 403);
        const headers = { Authorization: "Bearer " + preview.collectorToken, "Content-Type": "application/json" };
        const claim = await fetch(base + "/wtarg/internal/v1/claim", { method: "POST", headers, body: "{}" });
        assert.equal(claim.status, 200); const claimed = await claim.json(); assert.ok(claimed.jobId);
        assert.equal((await fetch(base + "/wtarg/internal/v1/heartbeat", { method: "POST", headers,
            body: JSON.stringify({ jobId: claimed.jobId, leaseToken: claimed.leaseToken, state: "collecting", progress: "Fixture collecting" }) })).status, 200);
        assert.equal((await fetch(base + "/wtarg/internal/v1/claim", { method: "POST", headers: { ...headers, Origin: base }, body: "{}" })).status, 403);
        assert.equal((await fetch(base + "/wtarg/internal/v1/source", { headers })).status, 200);
        assert.equal((await fetch(base + "/wtarg/internal/v1/source")).status, 401);
        assert.equal((await fetch(base + "/collector-seed.json")).status, 404);
    } finally { await preview.close(); }
});
