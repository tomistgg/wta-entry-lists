import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, verify } from "node:crypto";

// Ephemeral test credentials; no Google account or network access is used.
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const env = { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: "service_account",
    client_email: "photos@example.test", private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }) }),
    PLAYER_PHOTOS_FOLDER_ID: "photos-folder" };
const origin = "https://tomistgg.github.io";
const request = path => new Request("https://example.workers.dev" + path, { headers: { Origin: origin } });
const image = { id: "photo-1", name: "330332.png", mimeType: "image/png", size: "68",
    modifiedTime: "2026-11-05T10:53:37.236Z" };
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1cAAAAASUVORK5CYII=", "base64");
let version = 0;
const worker = async () => (await import("./worker.mjs?photos-test=" + version++)).default;

function mockDrive(t, files = [image]) {
    const storage = new Map();
    const previousCaches = globalThis.caches;
    globalThis.caches = { default: {
        async match(key) { return storage.get(key.url)?.clone(); },
        async put(key, response) { storage.set(key.url, response.clone()); },
    } };
    t.after(() => {
        if (previousCaches === undefined) delete globalThis.caches;
        else globalThis.caches = previousCaches;
    });
    const calls = { token: 0, list: 0, media: 0 };
    const upstream = t.mock.method(globalThis, "fetch", async (input, options) => {
        const url = new URL(input);
        assert.equal(options.redirect, "manual");
        if (url.hostname === "oauth2.googleapis.com") {
            calls.token++;
            const [header, claims, signature] = options.body.get("assertion").split(".");
            assert.equal(verify("RSA-SHA256", Buffer.from(header + "." + claims), keys.publicKey,
                Buffer.from(signature, "base64url")), true);
            const payload = JSON.parse(Buffer.from(claims, "base64url"));
            assert.equal(payload.scope, "https://www.googleapis.com/auth/drive.readonly");
            assert.equal(payload.aud, "https://oauth2.googleapis.com/token");
            assert.equal(payload.exp - payload.iat, 3600);
            return Response.json({ access_token: "test-access-token", expires_in: 3600 });
        }
        assert.equal(url.hostname, "www.googleapis.com");
        assert.equal(options.headers.Authorization, "Bearer test-access-token");
        if (url.pathname === "/drive/v3/files") {
            calls.list++;
            assert.equal(url.searchParams.get("q"), "'photos-folder' in parents and trashed = false");
            return Response.json({ files });
        }
        assert.equal(url.pathname, "/drive/v3/files/photo-1");
        assert.equal(url.searchParams.get("alt"), "media");
        calls.media++;
        return new Response(png, { headers: { "Content-Type": "image/png", "Set-Cookie": "private=value" } });
    });
    return { storage, calls, upstream };
}

test("photo configuration errors and arbitrary file IDs cannot expose Drive files", async t => {
    const relay = await worker();
    const { calls } = mockDrive(t);
    assert.equal((await relay.fetch(request("/photos"))).status, 503);
    assert.equal((await relay.fetch(request("/photos"), { ...env, PLAYER_PHOTOS_FOLDER_ID: "bad' query" })).status, 503);
    assert.equal((await relay.fetch(request("/photos/photo-elsewhere"), env)).status, 404);
    assert.equal((await relay.fetch(request("/photos/photo-1/extra"), env)).status, 404);
    assert.equal((await relay.fetch(new Request("https://example.workers.dev/photos", {
        headers: { Origin: "https://other.example" },
    }), env)).status, 403);
    assert.equal(calls.media, 0);
});

test("signed OAuth, concurrent token reuse, private index caching and safe image exports", async t => {
    const relay = await worker();
    const { calls } = mockDrive(t);
    const [first, second] = await Promise.all([relay.fetch(request("/photos"), env), relay.fetch(request("/photos"), env)]);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(calls.token, 1);
    assert.deepEqual(await first.json(), { photos: [{ name: image.name,
        path: "/photos/photo-1?v=" + encodeURIComponent(image.modifiedTime) }] });
    const lists = calls.list;
    await relay.fetch(request("/photos"), env);
    assert.equal(calls.list, lists);
    const response = await relay.fetch(request("/photos/photo-1"), env);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.equal(response.headers.get("Set-Cookie"), null);
    assert.equal(response.headers.get("Authorization"), null);
    const cached = await relay.fetch(request("/photos/photo-1?v=untrusted"), env);
    assert.equal(cached.status, 200);
    assert.equal(calls.media, 1, "query parameters must not bypass the canonical photo cache");
});

test("pagination completes before publishing the index and rejects unsupported files", async t => {
    const relay = await worker();
    let pages = 0;
    mockDrive(t);
    const original = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input, options) => {
        const url = new URL(input);
        if (url.pathname !== "/drive/v3/files") return original(input, options);
        pages++;
        if (!url.searchParams.has("pageToken")) return Response.json({ files: [image], nextPageToken: "second" });
        assert.equal(url.searchParams.get("pageToken"), "second");
        return Response.json({ files: [
            { ...image, id: "newer", name: "leylah_fernandez.png", modifiedTime: "2026-11-06T00:00:00Z" },
            { ...image, id: "svg", name: "bad.svg", mimeType: "image/svg+xml" },
            { ...image, id: "large", size: String(11 * 1024 * 1024) },
            { ...image, id: "shortcut", mimeType: "application/vnd.google-apps.shortcut" },
        ] });
    });
    const response = await relay.fetch(request("/photos"), env);
    assert.deepEqual((await response.json()).photos.map(item => item.name), ["leylah_fernandez.png", "330332.png"]);
    assert.equal(pages, 2);
});

test("replacements change cache keys and removed files stop serving after index expiry", async t => {
    const relay = await worker();
    const files = [{ ...image }];
    const { storage, calls } = mockDrive(t, files);
    await relay.fetch(request("/photos/photo-1"), env);
    files[0].modifiedTime = "2026-11-06T00:00:00Z";
    storage.delete("https://example.workers.dev/_photo-cache/photos-folder/index");
    await relay.fetch(request("/photos/photo-1"), env);
    assert.equal(calls.media, 2);
    files.length = 0;
    storage.delete("https://example.workers.dev/_photo-cache/photos-folder/index");
    assert.equal((await relay.fetch(request("/photos/photo-1"), env)).status, 404);
});

test("Google errors and non-image media never leak provider responses or credentials", async t => {
    const relay = await worker();
    const { storage } = mockDrive(t);
    await relay.fetch(request("/photos"), env);
    const original = globalThis.fetch;
    t.mock.method(globalThis, "fetch", async (input, options) => {
        if (String(input).includes("alt=media")) return new Response("<script>private</script>", {
            headers: { "Content-Type": "image/png" },
        });
        return original(input, options);
    });
    assert.equal((await relay.fetch(request("/photos/photo-1"), env)).status, 502);
    storage.clear();
    t.mock.method(globalThis, "fetch", async () => new Response("private provider failure", { status: 403 }));
    const response = await relay.fetch(request("/photos"), env);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /test-access-token|private provider failure|PRIVATE KEY/);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
});

test("expired tokens recover on retry and replacement secrets start a fresh Google session", async t => {
    const relay = await worker();
    const { storage, calls } = mockDrive(t);
    const original = globalThis.fetch;
    let expired = true;
    t.mock.method(globalThis, "fetch", async (input, options) => {
        if (new URL(input).pathname === "/drive/v3/files" && expired) {
            expired = false;
            return new Response("expired token", { status: 401 });
        }
        return original(input, options);
    });
    assert.equal((await relay.fetch(request("/photos"), env)).status, 502);
    assert.equal((await relay.fetch(request("/photos"), env)).status, 200);
    assert.equal(calls.token, 2);
    storage.clear();
    const replacement = { ...env, GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({
        ...JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON), private_key_id: "replacement-test-key",
    }) };
    assert.equal((await relay.fetch(request("/photos"), replacement)).status, 200);
    assert.equal(calls.token, 3);
});

test("repeated pages and incomplete searches fail without publishing a partial index", async t => {
    const relay = await worker();
    const { storage } = mockDrive(t);
    const original = globalThis.fetch;
    let incomplete = false;
    t.mock.method(globalThis, "fetch", async (input, options) => {
        if (new URL(input).pathname !== "/drive/v3/files") return original(input, options);
        return Response.json({ files: [image], nextPageToken: "repeat", incompleteSearch: incomplete });
    });
    assert.equal((await relay.fetch(request("/photos"), env)).status, 502);
    assert.equal(storage.size, 0);
    incomplete = true;
    assert.equal((await relay.fetch(request("/photos"), env)).status, 502);
    assert.equal(storage.size, 0);
});
