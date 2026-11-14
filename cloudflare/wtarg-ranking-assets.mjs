const HASH = /^[a-f0-9]{64}$/;
const RANKING = /^rankings-(?:latest|\d{4})$/;
const PROJECT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const checksum = value => typeof value === "string" && HASH.test(value);
const fail = message => { throw new Error(message); };
const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", value))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");

export const RANKING_SOURCE_FILES = new Set([
    "wta_rankings_83_99.csv", "wta_rankings_00_09.csv", "wta_rankings_10_19.csv", "wta_rankings_20_29.csv",
]);
export const isRankingResource = name => RANKING.test(name);

export function validRankingAssetRef(value, project) {
    if (!object(value) || value.schemaVersion !== 1 || !checksum(value.bundleId) || typeof value.origin !== "string") return false;
    try {
        const url = new URL(value.origin);
        const match = /^([a-f0-9]{8,40})\.([a-z0-9-]+)\.pages\.dev$/.exec(url.hostname);
        return !!match && url.protocol === "https:" && url.origin === value.origin && !url.username && !url.password &&
            !url.port && url.pathname === "/" && !url.search && !url.hash && PROJECT.test(match[2]) &&
            (project === undefined || PROJECT.test(project) && match[2] === project);
    } catch { return false; }
}

async function assetBytes(env, reference, path, limit) {
    const project = env.WTARG_RANKING_PAGES_PROJECT || "wtarg-ranking-files";
    if (!validRankingAssetRef(reference, project)) fail("Invalid immutable ranking asset origin.");
    const request = new Request(reference.origin + path, { method: "GET", redirect: "manual",
        headers: { Accept: path.endsWith(".json") ? "application/json" : "application/octet-stream" },
        signal: AbortSignal.timeout(20000) });
    const response = env.WTARG_RANKING_ASSET_FETCHER?.fetch ?
        await env.WTARG_RANKING_ASSET_FETCHER.fetch(request) : await fetch(request);
    if (!response.ok || response.redirected || Number(response.headers.get("Content-Length")) > limit) {
        fail("Ranking asset is unavailable.");
    }
    const reader = response.body?.getReader();
    if (!reader) fail("Ranking asset is empty.");
    const chunks = []; let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) { await reader.cancel(); fail("Ranking asset exceeds its size limit."); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
}

function parse(bytes) { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
const equalParts = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((part, index) => part.sha256 === right[index].sha256 && part.bytes === right[index].bytes);
const validParts = (parts, limit) => Array.isArray(parts) && parts.length > 0 && parts.length <= 1024 &&
    parts.every(part => object(part) && checksum(part.sha256) && Number.isInteger(part.bytes) && part.bytes > 0 && part.bytes <= limit);
const day = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export async function validateRankingAssets(env, manifest, sourceManifest) {
    const externalSources = sourceManifest.files.filter(file => file.storage === "ranking-assets");
    const externalResources = Object.entries(manifest.resources).filter(([, resource]) => resource.assetStore === "rankings");
    if (!externalSources.length && !externalResources.length && !manifest.rankingAssets && !sourceManifest.rankingAssets) return null;
    const reference = manifest.rankingAssets;
    if (!validRankingAssetRef(reference) || !validRankingAssetRef(sourceManifest.rankingAssets) ||
        reference.bundleId !== sourceManifest.rankingAssets.bundleId || reference.origin !== sourceManifest.rankingAssets.origin ||
        externalSources.length !== RANKING_SOURCE_FILES.size || externalSources.some(file => !RANKING_SOURCE_FILES.has(file.name))) {
        fail("Public rankings and recovery files need the same immutable asset bundle.");
    }
    const raw = await assetBytes(env, reference, "/manifest.json", 1900000);
    if (await hash(raw) !== reference.bundleId) fail("Ranking asset manifest checksum differs.");
    const bundle = parse(raw);
    if (!object(bundle) || bundle.schemaVersion !== 1 || !object(bundle.sources) || !object(bundle.resources) ||
        Object.keys(bundle.sources).length !== RANKING_SOURCE_FILES.size || !Array.isArray(bundle.weeks) ||
        !bundle.weeks.length || bundle.weeks.length > 10000) fail("Invalid ranking asset manifest.");
    for (const source of externalSources) {
        const saved = bundle.sources[source.name];
        if (!object(saved) || !validParts(saved.parts, 196608) ||
            !["rawSha256", "rawBytes", "gzipSha256", "gzipBytes"].every(key => saved[key] === source[key]) ||
            !equalParts(saved.parts, source.parts)) fail("Ranking source asset differs from the accepted checkpoint plan.");
    }
    const expectedNames = Object.keys(manifest.resources).filter(isRankingResource).sort();
    if (externalResources.length !== expectedNames.length || !expectedNames.includes("rankings-latest") ||
        Object.keys(bundle.resources).sort().join("|") !== expectedNames.join("|")) fail("Ranking public asset inventory differs.");
    for (const [name, resource] of externalResources) {
        const saved = bundle.resources[name];
        if (!isRankingResource(name) || resource.storage !== "asset" || resource.assetReleaseId !== reference.bundleId ||
            !object(saved) || !validParts(saved.parts, 1000000) || saved.sha256 !== resource.sha256 ||
            saved.bytes !== resource.bytes || !equalParts(saved.parts, resource.parts)) fail("Ranking public asset differs from its release plan.");
    }
    const weeks = new Map();
    for (const week of bundle.weeks) {
        if (!object(week) || !day(week.week_date) || weeks.has(week.week_date) || !checksum(week.sha256) ||
            week.path !== `history/${week.week_date}-${week.sha256}.json` || !Number.isInteger(week.bytes) ||
            week.bytes < 1 || week.bytes > 25 * 1024 * 1024 || !Number.isInteger(week.rows) || week.rows < 1 ||
            !RANKING_SOURCE_FILES.has(week.source_file)) fail("Invalid lossless ranking archive inventory.");
        weeks.set(week.week_date, week);
    }
    for (const [date, checksum] of Object.entries(sourceManifest.rankingCheckpointWeeks || {})) {
        if (weeks.get(date)?.sha256 !== checksum) fail("Ranking archive metadata differs from its immutable file.");
    }
    return bundle;
}

export async function rankingPublicPart(env, reference, resource, index) {
    if (!isRankingResource(resource) || !Number.isInteger(index) || index < 0 || index > 255) fail("Invalid ranking public part.");
    const value = parse(await assetBytes(env, reference, `/public/${resource}/${index}.json`, 1900000));
    if (!object(value) || typeof value.text !== "string") fail("Invalid ranking public content.");
    return value;
}

export async function validateRankingWeekIndex(db, bundle) {
    if (!bundle) return;
    const { results } = await db.prepare("SELECT week_date,content_hash,row_count,archive_path FROM wtarg_ranking_weeks WHERE series='wta_singles'").all();
    const weeks = new Map(bundle.weeks.map(week => [week.week_date, week]));
    if (results.length !== weeks.size || results.some(row => {
        const expected = weeks.get(row.week_date);
        return !expected || expected.sha256 !== row.content_hash || expected.rows !== row.row_count ||
            row.archive_path !== `ranking-assets:wta_singles:${row.week_date}:${row.content_hash}`;
    })) fail("Ranking database metadata differs from its immutable archive inventory.");
}

export async function rankingSourceBlob(env, sourceManifest, blobId) {
    const descriptor = sourceManifest.files.filter(file => file.storage === "ranking-assets")
        .flatMap(file => file.parts).find(part => part.sha256 === blobId);
    if (!descriptor || !checksum(blobId)) return null;
    const raw = await assetBytes(env, sourceManifest.rankingAssets, `/source/${blobId}.bin`, 196608);
    if (raw.length !== descriptor.bytes || await hash(raw) !== blobId) fail("Ranking recovery asset checksum differs.");
    let binary = "";
    for (let index = 0; index < raw.length; index += 32768) binary += String.fromCharCode(...raw.subarray(index, index + 32768));
    return { sha256: blobId, bytes: raw.length, base64: btoa(binary) };
}
