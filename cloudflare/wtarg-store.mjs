const ID = /^[a-f0-9]{64}$/;
const RESOURCE = /^(?:bootstrap|identities|history|rankings-latest|rankings-\d{4})$/;
const MAX_PART_BYTES = 1000000;
const MAX_RESOURCE_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const digest = async text => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))))
    .map(value => value.toString(16).padStart(2, "0")).join("");

export function getWtargRoute(pathname) {
    if (pathname === "/wtarg/v1/manifest") return { current: true };
    const match = /^\/wtarg\/v1\/releases\/([a-f0-9]{64})\/(manifest|resources\/([a-z0-9-]+)\/parts\/(0|[1-9]\d{0,2}))$/.exec(pathname);
    if (!match || match[3] && !RESOURCE.test(match[3])) return null;
    return { releaseId: match[1], resource: match[3] || null, part: match[4] === undefined ? null : Number(match[4]) };
}

export function validWtargManifest(manifest, releaseId) {
    if (!object(manifest) || manifest.schemaVersion !== 1 || manifest.releaseId !== releaseId ||
        !ID.test(manifest.applicationVersion) || !ID.test(manifest.sourceVersion) ||
        typeof manifest.sourceFrozenAt !== "string" || !Number.isFinite(Date.parse(manifest.sourceFrozenAt)) ||
        typeof manifest.preparedAt !== "string" || !Number.isFinite(Date.parse(manifest.preparedAt)) ||
        !object(manifest.resources) || !manifest.resources.bootstrap ||
        manifest.rankingAssets !== undefined && !validRankingAssetRef(manifest.rankingAssets)) return false;
    const entries = Object.entries(manifest.resources);
    if (!entries.length || entries.length > 64) return false;
    return entries.every(([name, resource]) => RESOURCE.test(name) && object(resource) &&
        ["d1", "asset"].includes(resource.storage) && (name !== "bootstrap" || resource.storage === "d1") &&
        (resource.assetStore === undefined || resource.assetStore === "rankings" && isRankingResource(name) &&
            resource.storage === "asset" && resource.assetReleaseId === manifest.rankingAssets?.bundleId) &&
        (manifest.rankingAssets === undefined || !isRankingResource(name) || resource.assetStore === "rankings") &&
        (resource.assetReleaseId === undefined || resource.storage === "asset" &&
            typeof resource.assetReleaseId === "string" && ID.test(resource.assetReleaseId)) &&
        (resource.d1ReleaseId === undefined || resource.storage === "d1" &&
            typeof resource.d1ReleaseId === "string" && ID.test(resource.d1ReleaseId)) &&
        ID.test(resource.sha256) &&
        Number.isInteger(resource.bytes) && resource.bytes > 0 && resource.bytes <= MAX_RESOURCE_BYTES &&
        Array.isArray(resource.parts) && resource.parts.length > 0 && resource.parts.length <= 256 &&
        resource.parts.every(part => object(part) && ID.test(part.sha256) &&
            Number.isInteger(part.bytes) && part.bytes > 0 && part.bytes <= MAX_PART_BYTES &&
            (part.storedBytes === undefined || Number.isInteger(part.storedBytes) &&
                part.storedBytes > 0 && part.storedBytes <= 1900000)) &&
        resource.parts.reduce((total, part) => total + part.bytes, 0) === resource.bytes);
}

export function validateWtargResourceBackings(_db, manifest, baseManifest) {
    if (!validWtargManifest(manifest, manifest?.releaseId) ||
        !validWtargManifest(baseManifest, baseManifest?.releaseId)) {
        throw new Error("Invalid WTARG resource backing manifest.");
    }
    // The caller supplies the already accepted base; references stay flat across later releases.
    for (const [name, resource] of Object.entries(manifest.resources)) {
        // Collector validation checks the separately published immutable ranking bundle.
        if (resource.assetStore === "rankings") continue;
        const reference = resource.storage === "asset" ? resource.assetReleaseId : resource.d1ReleaseId;
        if (resource.storage === "d1" && reference === undefined) continue;
        const original = baseManifest.resources[name];
        const owner = original?.storage === "asset" ? original.assetReleaseId || baseManifest.releaseId :
            original?.d1ReleaseId || baseManifest.releaseId;
        if (!ID.test(reference || "") || reference === manifest.releaseId || !original ||
            original.storage !== resource.storage || reference !== owner || original.sha256 !== resource.sha256 ||
            original.bytes !== resource.bytes || original.parts.length !== resource.parts.length ||
            original.parts.some((part, index) => part.sha256 !== resource.parts[index].sha256 ||
                part.bytes !== resource.parts[index].bytes || part.storedBytes !== resource.parts[index].storedBytes)) {
            throw new Error("WTARG resource reference is not the accepted matching base artifact.");
        }
    }
    return true;
}

const readWtargSnapshot = (db, kind, scope) => db.prepare(
    "SELECT payload_json FROM wta_snapshots WHERE kind = ? AND scope = ?").bind(kind, scope).first();

export async function acceptedWtargManifest(db, releaseId) {
    const [saved, accepted] = await Promise.all([
        readWtargSnapshot(db, "wtarg:read_manifest", releaseId), readWtargSnapshot(db, "wtarg:read_accepted", releaseId),
    ]);
    if (!saved || !accepted) return null;
    const marker = JSON.parse(accepted.payload_json);
    const manifest = JSON.parse(saved.payload_json);
    if (!object(marker) || marker.schemaVersion !== 1 || marker.releaseId !== releaseId ||
        !ID.test(marker.manifestSha256) || await digest(saved.payload_json) !== marker.manifestSha256 ||
        !validWtargManifest(manifest, releaseId)) throw new Error("Invalid accepted WTARG manifest.");
    return manifest;
}

async function assetPart(env, releaseId, resource, index) {
    if (!env.WTARG_ASSETS?.fetch) throw new Error("WTARG archive assets are unavailable.");
    const response = await env.WTARG_ASSETS.fetch(new Request(
        `https://wtarg-assets.invalid/wtarg-assets/${releaseId}/${resource}/${index}.json`));
    if (!response.ok || Number(response.headers.get("Content-Length")) > 1900000) {
        throw new Error("WTARG archive part is unavailable.");
    }
    // Bound memory even if a misconfigured asset binding ignores the manifest path.
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty WTARG archive response.");
    const chunks = [];
    let size = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1900000) { await reader.cancel(); throw new Error("Oversized WTARG archive response."); }
        chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

export async function wtargDataResponse(request, env, headers = {}) {
    const json = (data, status = 200) => Response.json(data, { status, headers });
    const route = getWtargRoute(new URL(request.url).pathname);
    if (!route) return json({ error: "Unknown WTARG resource." }, 404);
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, OPTIONS" } });
    if (!env.ENTRY_LISTS_DB) return json({ error: "WTARG data is not available yet." }, 503);
    try {
        let releaseId = route.releaseId;
        if (route.current) {
            const saved = await readWtargSnapshot(env.ENTRY_LISTS_DB, "wtarg:read_current", "global");
            const current = saved && JSON.parse(saved.payload_json);
            if (!object(current) || current.schemaVersion !== 1 || !ID.test(current.releaseId)) {
                return json({ error: "WTARG data is not available yet." }, 503);
            }
            releaseId = current.releaseId;
        }
        const manifest = await acceptedWtargManifest(env.ENTRY_LISTS_DB, releaseId);
        if (!manifest) return json({ error: "WTARG release is not available." }, route.current ? 503 : 404);
        if (!route.resource) return json(manifest);
        const resource = manifest.resources[route.resource];
        const descriptor = resource?.parts[route.part];
        if (!descriptor) return json({ error: "Unknown WTARG resource part." }, 404);
        let part;
        if (resource.assetStore === "rankings") part = await rankingPublicPart(env, manifest.rankingAssets, route.resource, route.part);
        else if (resource.storage === "asset") part = await assetPart(env, resource.assetReleaseId || releaseId, route.resource, route.part);
        else {
            const saved = await readWtargSnapshot(env.ENTRY_LISTS_DB, "wtarg:read_part",
                `${resource.d1ReleaseId || releaseId}:${route.resource}:${route.part}`);
            part = saved && JSON.parse(saved.payload_json);
        }
        if (!object(part) || typeof part.text !== "string" || encoder.encode(part.text).length !== descriptor.bytes ||
            await digest(part.text) !== descriptor.sha256) throw new Error("Invalid WTARG resource part.");
        return json({ text: part.text });
    } catch {
        return json({ error: "WTARG saved data could not be verified. Please try again." }, 503);
    }
}
import { isRankingResource, rankingPublicPart, validRankingAssetRef } from "./wtarg-ranking-assets.mjs";

