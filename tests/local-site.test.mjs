import assert from "node:assert/strict";
import test from "node:test";
import { createLocalSiteServer } from "../cloudflare/serve-local.mjs";

async function setup(t, relay = async () => Response.json({ snapshot: null, refreshing: false })) {
    const calls = [];
    const server = createLocalSiteServer((...args) => { calls.push(args); return relay(...args); });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const origin = "http://127.0.0.1:" + server.address().port;
    return { calls, origin, request: (path, options) => fetch(origin + path, options) };
}

test("local preview serves public assets and rewrites only its served module to the local API", async t => {
    const { request, calls } = await setup(t);
    const page = await request("/");
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /assets\/vendor\/html2pdf-0\.10\.1\.bundle\.min\.js/);
    assert.match(await (await request("/entry-lists.mjs?v=3")).text(), /^export const BASE = window.location.origin;/);
    const pdf = await request("/assets/vendor/html2pdf-0.10.1.bundle.min.js");
    assert.equal(pdf.status, 200);
    assert.match(pdf.headers.get("Content-Type"), /^text\/javascript/);
    const flag = await request("/assets/flags/ar.svg");
    assert.equal(flag.status, 200);
    assert.match(await flag.text(), /<svg/);
    const countryCodes = JSON.parse(pageText.match(/id="country-flag-codes">(.*?)<\/script>/)[1]);
    assert.equal(countryCodes.AFG, "AF", "flag coverage extends beyond the current ranking-directory countries");
    for (const code of new Set(Object.values(countryCodes))) {
        assert.equal((await request(`/assets/flags/${code.toLowerCase()}.svg`)).status, 200, code);
    }
    assert.equal(calls.length, 0);
});

test("local preview never exposes private files or traversal paths", async t => {
    const { request, calls } = await setup(t);
    for (const path of ["/.git/config", "/cloudflare/wrangler.json", "/.dev.vars", "/package.json",
        "/assets/flags/../../package.json", "/assets/flags/%2e%2e%2f%2e%2e%2fpackage.json", "/assets/flags/zz.svg"]) {
        assert.equal((await request(path)).status, 404, path);
    }
    assert.equal(calls.length, 0);
});

test("local preview rejects foreign refresh origins, bodies and wrong methods before relaying", async t => {
    const { request, origin, calls } = await setup(t);
    assert.equal((await request("/entry-lists/refresh", { method: "POST", headers: { Origin: "https://elsewhere.example" } })).status, 403);
    assert.equal((await request("/entry-lists/refresh", { method: "POST", headers: { Origin: origin }, body: "x" })).status, 400);
    assert.equal((await request("/entry-lists/refresh")).status, 405);
    assert.equal((await request("/entry-lists", { method: "POST" })).status, 405);
    assert.equal(calls.length, 0);
});

test("local preview forwards only saved entry routes to the fixed loopback backend", async t => {
    const state = { snapshot: { models: [] }, refreshing: false };
    const { request, origin, calls } = await setup(t, async () => Response.json(state));
    assert.deepEqual(await (await request("/entry-lists?history=1")).json(), state);
    const refreshed = await request("/entry-lists/refresh?history=1", { method: "POST", headers: { Origin: origin } });
    assert.deepEqual(await refreshed.json(), state);
    assert.deepEqual(calls.map(([url, options]) => [url, options.method, options.headers.Origin]), [
        ["http://127.0.0.1:8787/entry-lists?history=1", "GET", "https://tomistgg.github.io"],
        ["http://127.0.0.1:8787/entry-lists/refresh?history=1", "POST", "https://tomistgg.github.io"],
    ]);
});
