import assert from "node:assert/strict";
import test from "node:test";
import worker from "./worker.mjs";

const origin = "https://tomistgg.github.io";
const request = (path, options = {}) => new Request("https://example.workers.dev" + path, options);

test("health check, allowed origins, preflight, and read-only methods", async () => {
    const health = await worker.fetch(request("/health"));
    assert.deepEqual(await health.json(), { ok: true });
    assert.equal((await worker.fetch(request("/health", { headers: { Origin: "https://other.example" } }))).status, 403);
    const preflight = await worker.fetch(request("/health", { method: "OPTIONS", headers: { Origin: origin } }));
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal((await worker.fetch(request("/health", { method: "POST" }))).status, 405);
});

test("unknown paths cannot turn the Worker into an arbitrary URL proxy", async t => {
    const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected fetch"); });
    for (const path of ["/api/https://example.com/", "/api/tennis/players/123/private", "/site/", "/site/tournaments/1/%2F/2026/player-list"]) {
        assert.equal((await worker.fetch(request(path))).status, 404);
    }
    assert.equal(upstream.mock.callCount(), 0);
});

test("match requests use the fixed WTA host, pass queries, and supply the WTA origin", async t => {
    t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(String(url), "https://api.wtatennis.com/tennis/tournaments/1110/2026/matches?states=C");
        assert.equal(options.headers.Origin, "https://www.wtatennis.com");
        assert.equal(options.headers.account, "wta");
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.redirect, "manual");
        assert.equal(options.cache, "no-store");
        return Response.json({ matches: [] });
    });
    const response = await worker.fetch(request("/api/tennis/tournaments/1110/2026/matches?states=C", {
        headers: { Origin: origin, Authorization: "must-not-be-forwarded" },
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { matches: [] });
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("entry-list HTML is returned as text for parsing, with no upstream scripts or cookies executed", async t => {
    t.mock.method(globalThis, "fetch", async url => {
        assert.equal(String(url), "https://www.wtatennis.com/tournaments/1038/madrid/2026/player-list");
        return new Response("<html>Entry list</html>", { headers: { "Set-Cookie": "upstream=value" } });
    });
    const response = await worker.fetch(request("/site/tournaments/1038/madrid/2026/player-list"));
    assert.equal(await response.text(), "<html>Entry list</html>");
    assert.equal(response.headers.get("Content-Type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(response.headers.get("Set-Cookie"), null);
});

test("upstream errors produce an actionable response without leaking upstream pages", async t => {
    t.mock.method(globalThis, "fetch", async () => new Response("Upstream error page", { status: 503 }));
    const response = await worker.fetch(request("/api/tennis/tournaments/"));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "WTA request failed.", upstream_status: 503 });
});

test("upstream redirects are not followed or exposed as successful WTA data", async t => {
    const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
        assert.equal(options.redirect, "manual");
        return new Response(null, { status: 302, headers: { Location: "https://other.example" } });
    });
    const response = await worker.fetch(request("/api/tennis/tournaments/"));
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "WTA request failed.", upstream_status: 302 });
    assert.equal(response.headers.get("Location"), null);
    assert.equal(upstream.mock.callCount(), 1);
});

test("unreachable upstream and timeouts return an error with CORS headers", async t => {
    const log = t.mock.method(console, "error", () => {});
    t.mock.method(globalThis, "fetch", async () => { throw new TypeError("Network failure"); });
    const response = await worker.fetch(request("/api/tennis/players/ranked?metric=SINGLES"));
    assert.equal(response.status, 502);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
    assert.match((await response.json()).error, /WTA could not be reached/);
    assert.equal(log.mock.callCount(), 1);
});
