import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";
import { Miniflare } from "miniflare";
import { WTARG_DELTA_TABLES } from "./wtarg-delta.mjs";

const trackerRoot = resolve(import.meta.dirname, "..");
const localRoot = resolve(trackerRoot, "../tenis-fem-arg/cloudflare/.local");
const hash = value => createHash("sha256").update(value).digest("hex");
const inside = (root, path) => { const part = relative(root, path); return part && !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep); };
const mimeTypes = new Map(Object.entries({
    ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".webp": "image/webp",
    ".gif": "image/gif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
    ".otf": "font/otf", ".webmanifest": "application/manifest+json",
}));

export async function safeLocalDirectory(path, root = localRoot) {
    const [actualRoot, actual] = await Promise.all([realpath(root), realpath(resolve(path))]);
    if (!inside(actualRoot, actual) || !(await stat(actual)).isDirectory()) {
        throw new Error("Preview directories must stay below WTARG cloudflare/.local.");
    }
    return actual;
}

async function safeFile(root, path) {
    const actual = await realpath(resolve(root, path));
    if (!inside(root, actual) || !(await stat(actual)).isFile()) throw new Error("Preview file is outside its directory.");
    return actual;
}

export function validatePreviewPlan(plan) {
    const releaseId = plan?.manifest?.releaseId;
    if (plan?.schemaVersion !== 1 || plan.localPreviewOnly !== true || !/^[a-f0-9]{64}$/.test(releaseId) ||
        !Array.isArray(plan.snapshots)) throw new Error("A local-only WTARG preview plan is required.");
    const rows = new Map();
    for (const row of plan.snapshots) {
        if (!row || typeof row.kind !== "string" || typeof row.scope !== "string" || typeof row.payload_json !== "string" ||
            Buffer.byteLength(row.payload_json) > 1900000 || typeof row.fetched_at !== "string" ||
            !Number.isFinite(Date.parse(row.fetched_at)) || row.expires_at !== null) throw new Error("Invalid preview snapshot.");
        const key = row.kind + "/" + row.scope;
        if (rows.has(key)) throw new Error("Duplicate preview snapshot.");
        const metadata = row.scope === releaseId && ["wtarg:read_manifest", "wtarg:read_accepted"].includes(row.kind);
        const current = row.kind === "wtarg:read_current" && row.scope === "global";
        const part = row.kind === "wtarg:read_part" && new RegExp(`^${releaseId}:bootstrap:(0|[1-9]\\d{0,2})$`).test(row.scope);
        if (!metadata && !current && !part) throw new Error("Preview plan contains a snapshot outside its release.");
        rows.set(key, row);
    }
    const manifestRow = rows.get(`wtarg:read_manifest/${releaseId}`);
    if (!manifestRow || !isDeepStrictEqual(JSON.parse(manifestRow.payload_json), plan.manifest)) {
        throw new Error("Preview manifest does not match its snapshot.");
    }
    for (const [kind, expected] of [
        ["wtarg:read_current", { schemaVersion: 1, releaseId }],
        ["wtarg:read_accepted", { schemaVersion: 1, releaseId, manifestSha256: hash(manifestRow.payload_json) }],
    ]) {
        const row = rows.get(`${kind}/${kind === "wtarg:read_current" ? "global" : releaseId}`);
        if (!row || !isDeepStrictEqual(JSON.parse(row.payload_json), expected)) throw new Error("Invalid preview acceptance marker.");
    }
    const parts = plan.manifest.resources?.bootstrap?.parts;
    if (!Array.isArray(parts) || rows.size !== parts.length + 3) throw new Error("Preview bootstrap parts are incomplete.");
    for (const [index, descriptor] of parts.entries()) {
        const row = rows.get(`wtarg:read_part/${releaseId}:bootstrap:${index}`);
        const part = row && JSON.parse(row.payload_json);
        if (typeof part?.text !== "string" || Buffer.byteLength(part.text) !== descriptor.bytes || hash(part.text) !== descriptor.sha256) {
            throw new Error("Preview bootstrap part does not match its manifest.");
        }
    }
    return plan;
}

function send(response, status, type, body, method = "GET", extraHeaders = {}) {
    response.writeHead(status, { ...extraHeaders, "Content-Type": type, "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Content-Length": Buffer.byteLength(body) });
    response.end(method === "HEAD" ? undefined : body);
}

async function seedCollector(db, directory, manifest, progress, rankingConfig) {
    progress("Loading the private source checkpoint into local D1...");
    const plan = JSON.parse(await readFile(await safeFile(directory, "collector-seed.json"), "utf8"));
    const source = plan.sourceManifest;
    if (source?.sourceVersion !== manifest.sourceVersion || !Array.isArray(plan.blobs)) throw new Error("Collector seed differs from the public read release.");
    const saved = new Map();
    const statements = [];
    const flush = async () => { if (statements.length) { await db.batch(statements.splice(0)); } };
    for (const blob of plan.blobs) {
        if (typeof blob?.base64 !== "string" || blob.base64.length > 350000 || !/^[a-f0-9]{64}$/.test(blob.sha256) ||
            Buffer.from(blob.base64, "base64").toString("base64") !== blob.base64 ||
            Buffer.from(blob.base64, "base64").length !== blob.bytes || blob.bytes > 262144 ||
            hash(Buffer.from(blob.base64, "base64")) !== blob.sha256) throw new Error("Invalid private source seed blob.");
        saved.set(blob.sha256, blob.bytes);
        statements.push(db.prepare("INSERT OR IGNORE INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) VALUES ('wtarg:source_blob',?,?,?,NULL)")
            .bind(blob.sha256, JSON.stringify(blob), manifest.preparedAt));
        if (statements.length >= 8) await flush();
        if (saved.size % 50 === 0) progress(`Loaded ${saved.size} private source chunks.`);
    }
    for (const file of source.files || []) for (const part of file.parts || []) {
        if (file.storage === "ranking-assets") {
            if (!rankingConfig || !isDeepStrictEqual(source.rankingAssets, manifest.rankingAssets) ||
                source.rankingAssets?.origin !== rankingConfig.origin || source.rankingAssets?.bundleId !== rankingConfig.bundleId) {
                throw new Error("External source seed needs the matching isolated ranking files.");
            }
            const directory = await safeLocalDirectory(rankingConfig.directory);
            const raw = await readFile(await safeFile(directory, `source/${part.sha256}.bin`));
            if (raw.length !== part.bytes || hash(raw) !== part.sha256) throw new Error("External source seed is incomplete or corrupt.");
        } else if (saved.get(part.sha256) !== part.bytes) throw new Error("Private source seed blobs are incomplete.");
    }
    await flush();
    progress(`Loaded ${saved.size} private source chunks. Loading the normalized index...`);
    for (const [kind, scope, payload] of [
        ["wtarg:source_manifest", manifest.releaseId, source],
        ["wtarg:source_current", "global", { schemaVersion: 1, sourceVersion: source.sourceVersion, checkpointId: manifest.releaseId }],
    ]) await db.prepare("INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) VALUES(?,?,?,?,NULL)")
        .bind(kind, scope, JSON.stringify(payload), manifest.preparedAt).run();
    const layouts = new Map();
    for (const table of WTARG_DELTA_TABLES) {
        const schema = await db.prepare(`PRAGMA table_info("${table}")`).all();
        layouts.set(table, schema.results.map(row => row.name));
    }
    let pendingBytes = 0, normalizedRows = 0, group = null;
    const flushGroup = () => {
        if (!group) return;
        const columns = group.columns;
        const placeholders = group.rows.map(() => "(" + columns.map(() => "?").join(",") + ")").join(",");
        const sql = `INSERT INTO "${group.table}" (${columns.map(name => `"${name}"`).join(",")}) VALUES ${placeholders}`;
        statements.push(db.prepare(sql).bind(...group.rows.flatMap(row => columns.map(name => row[name]))));
        group = null;
    };
    const normalized = await safeFile(directory, "normalized.ndjson");
    const lines = createInterface({ input: createReadStream(normalized, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const line of lines) {
        if (!line.trim()) continue;
        if (Buffer.byteLength(line) > 1900000) throw new Error("Oversized normalized preview record.");
        const record = JSON.parse(line), columns = layouts.get(record.table);
        if (!columns || !record.row || Object.keys(record.row).sort().join() !== [...columns].sort().join() ||
            record.table === "wtarg_jobs" && record.row.job_key === "wtarg:collector:global" ||
            record.table === "wtarg_source_state" && ["wtarg:collector", "wtarg:pace"].includes(record.row.source)) {
            throw new Error("Private preview index contains an unknown table, columns or coordination row.");
        }
        const rowBytes = Buffer.byteLength(line);
        if (group && (group.table !== record.table || (group.rows.length + 1) * columns.length > 100 || pendingBytes + rowBytes > 1000000)) flushGroup();
        if (pendingBytes + rowBytes > 1000000 && statements.length) { await flush(); pendingBytes = 0; }
        if (!group) group = { table: record.table, columns, rows: [] };
        group.rows.push(record.row);
        pendingBytes += rowBytes; normalizedRows++;
        if (group.rows.length * columns.length + columns.length > 100) flushGroup();
        if (statements.length >= 500 || pendingBytes >= 1000000) { flushGroup(); await flush(); pendingBytes = 0; }
        if (normalizedRows % 10000 === 0) progress(`Loaded ${normalizedRows.toLocaleString("en-US")} normalized records.`);
    }
    flushGroup(); await flush();
    progress(`Loaded ${normalizedRows.toLocaleString("en-US")} normalized records. Starting the local website...`);
}

async function requestBody(request) {
    if (Number(request.headers["content-length"]) > 1400000) throw Object.assign(new Error("Request too large."), { status: 413 });
    const chunks = []; let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 1400000) throw Object.assign(new Error("Request too large."), { status: 413 });
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

export async function createWtargPreview({ release, site, port = 8766, collectorSeed, progress = () => {} }) {
    release = await safeLocalDirectory(release);
    if (!site) site = JSON.parse(await readFile(await safeFile(await realpath(localRoot), "step4-latest.json"), "utf8")).site;
    if (typeof site !== "string") throw new Error("The preview site path is missing.");
    site = await safeLocalDirectory(site);
    await safeFile(site, "app.html");
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid preview port.");
    const plan = validatePreviewPlan(JSON.parse(await readFile(await safeFile(release, "preview-plan.json"), "utf8")));
    let rankingConfigPath, rankingConfig;
    try {
        rankingConfigPath = await safeFile(release, "ranking-assets.json");
        rankingConfig = JSON.parse(await readFile(rankingConfigPath, "utf8"));
        if (rankingConfig.localPreviewOnly !== true) throw new Error("A local-only ranking asset configuration is required.");
        await safeLocalDirectory(rankingConfig.directory);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (collectorSeed) collectorSeed = await safeLocalDirectory(collectorSeed);
    const collectorToken = collectorSeed ? process.env.WTARG_PREVIEW_COLLECTOR_TOKEN || randomBytes(32).toString("hex") : null;
    if (collectorToken && collectorToken.length < 32) throw new Error("The private preview collector token must have at least 32 characters.");
    const assetsRoot = await safeLocalDirectory(resolve(release, "assets"));
    const assetPrefix = `/wtarg-assets/${plan.manifest.releaseId}/`;
    const mf = new Miniflare({ scriptPath: resolve(trackerRoot, "cloudflare/worker.mjs"), modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { ENTRY_LISTS_DB: "wtarg-offline-preview" },
        bindings: collectorSeed ? { WTARG_COLLECTION_ENABLED: "true", WTARG_COLLECTOR_TOKEN: collectorToken } : {},
        serviceBindings: { ...(rankingConfig ? { WTARG_RANKING_ASSET_FETCHER: async request => {
            const url = new URL(request.url);
            try {
                const config = JSON.parse(await readFile(rankingConfigPath, "utf8"));
                const directory = config.origin === url.origin ? config.directory : config.additional?.[url.origin];
                if (config.localPreviewOnly !== true || typeof directory !== "string" || request.method !== "GET" ||
                    url.search || !/^\/(?:manifest\.json|source\/[a-f0-9]{64}\.bin|public\/rankings-(?:latest|\d{4})\/(?:0|[1-9]\d{0,2})\.json|history\/\d{4}-\d{2}-\d{2}-[a-f0-9]{64}\.json)$/.test(url.pathname)) {
                    return new Response("Unknown local ranking file.", { status: 404 });
                }
                const root = await safeLocalDirectory(directory);
                const path = await safeFile(root, "." + url.pathname);
                if ((await stat(path)).size > 1900000) throw new Error("Oversized ranking file.");
                return new Response(await readFile(path), { headers: {
                    "Content-Type": url.pathname.endsWith(".bin") ? "application/octet-stream" : "application/json",
                } });
            } catch { return new Response("Local ranking file is unavailable.", { status: 503 }); }
        } } : {}), WTARG_ASSETS: async request => {
            const url = new URL(request.url);
            const resourcePart = url.pathname.slice(assetPrefix.length);
            if (request.method !== "GET" || url.origin !== "https://wtarg-assets.invalid" || url.search ||
                !url.pathname.startsWith(assetPrefix) || !/^(?:identities|history|rankings-latest|rankings-\d{4})\/(0|[1-9]\d{0,2})\.json$/.test(resourcePart)) {
                return new Response("Unknown archive asset.", { status: 404 });
            }
            try {
                const path = await safeFile(assetsRoot, "." + url.pathname);
                if ((await stat(path)).size > 1900000) throw new Error("Oversized archive asset.");
                return new Response(await readFile(path), { headers: { "Content-Type": "application/json" } });
            } catch { return new Response("Archive asset is unavailable.", { status: 404 }); }
        } },
        outboundService() { throw new Error("Provider/network requests are disabled in the WTARG preview."); },
    });
    let server;
    try {
        const db = await mf.getD1Database("ENTRY_LISTS_DB");
        for (const path of [resolve(trackerRoot, "cloudflare/shared-schema.sql"), resolve(trackerRoot, "../tenis-fem-arg/cloudflare/schema.sql")]) {
            const schema = (await readFile(path, "utf8")).replace(/^--.*$/gm, "");
            for (const statement of schema.split(";").filter(value => value.trim())) await db.prepare(statement).run();
        }
        for (const row of plan.snapshots) await db.prepare(
            "INSERT INTO wta_snapshots(kind,scope,payload_json,fetched_at,expires_at) VALUES(?,?,?,?,?)")
            .bind(row.kind, row.scope, row.payload_json, row.fetched_at, row.expires_at).run();
        if (collectorSeed) await seedCollector(db, collectorSeed, plan.manifest, progress, rankingConfig);
        const accepted = await mf.dispatchFetch("https://local-preview.invalid/wtarg/v1/manifest");
        if (!accepted.ok) throw new Error("The local Worker rejected the prepared WTARG release.");
        if (collectorSeed) {
            const enabled = await mf.dispatchFetch("https://local-preview.invalid/wtarg/v1/status");
            if (!enabled.ok || !(await enabled.json()).enabled) throw new Error("The local Worker rejected the private source checkpoint seed.");
        }
        server = createServer(async (request, response) => {
            try {
                const url = new URL(request.url, "http://127.0.0.1");
                if (url.pathname.startsWith("/wtarg/")) {
                    const method = request.method === "HEAD" ? "GET" : request.method;
                    const origin = request.headers.origin;
                    const headers = new Headers();
                    for (const name of ["authorization", "content-type", "accept"]) if (request.headers[name]) headers.set(name, request.headers[name]);
                    if (origin) headers.set("Origin", url.pathname === "/wtarg/v1/refresh" &&
                        origin === `http://127.0.0.1:${server.address().port}` ? "https://wtarg.com" : origin);
                    const body = await requestBody(request);
                    const result = await mf.dispatchFetch("https://local-preview.invalid" + url.pathname + url.search,
                        { method, headers, ...(!["GET", "HEAD"].includes(method) && body.length ? { body } : {}) });
                    return send(response, result.status, result.headers.get("Content-Type") || "application/json",
                        Buffer.from(await result.arrayBuffer()), request.method,
                        result.headers.has("Allow") ? { Allow: result.headers.get("Allow") } : {});
                }
                request.resume();
                if (!["GET", "HEAD"].includes(request.method)) return send(response, 405, "text/plain", "Method not allowed.");
                const pathname = decodeURIComponent(url.pathname);
                if (/[\\:\x00-\x1f]/.test(pathname) || pathname.split("/").some(part => part === ".." || part.startsWith("."))) {
                    return send(response, 404, "text/plain", "Not found.");
                }
                const relativePath = "." + (pathname.endsWith("/") ? pathname + "index.html" : pathname);
                const type = mimeTypes.get(extname(relativePath).toLowerCase());
                if (!type) return send(response, 404, "text/plain", "Not found.");
                const body = await readFile(await safeFile(site, relativePath));
                send(response, 200, type, body, request.method);
            } catch (error) {
                const missing = ["ENOENT", "ENOTDIR"].includes(error.code);
                send(response, error.status || (missing ? 404 : 503), "text/plain", missing ? "Not found." : "Local preview request failed.", request.method);
            }
        });
        await new Promise((resolveReady, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveReady); });
        return { server, manifest: plan.manifest, collectorToken, url: `http://127.0.0.1:${server.address().port}/`, async close() {
            server.closeAllConnections();
            await new Promise(resolveClosed => server.close(resolveClosed));
            await mf.dispose();
        } };
    } catch (error) { server?.close(); await mf.dispose(); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    try {
        const args = process.argv.slice(2), options = {};
        for (let index = 0; index < args.length; index += 2) {
            const key = args[index];
            if (!["--release", "--site", "--port", "--collector-seed"].includes(key) || !args[index + 1]) throw new Error("Use --release <directory> [--site <directory>] [--collector-seed <directory>] [--port 8766].");
            options[key === "--collector-seed" ? "collectorSeed" : key.slice(2)] = key === "--port" ? Number(args[index + 1]) : args[index + 1];
        }
        if (!options.release) throw new Error("The --release directory is required.");
        const preview = await createWtargPreview({ ...options, progress: message => console.log(message) });
        console.log(`WTARG local preview: ${preview.url}\nAccepted local release: ${preview.manifest.releaseId}\nProvider requests are disabled. Nothing is deployed.`);
        let closing = false;
        for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, async () => {
            if (closing) return; closing = true; await preview.close(); process.exit(0);
        });
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
