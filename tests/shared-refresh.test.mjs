import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { addDays, monday } from "../entry-lists.mjs";

const source = fs.readFileSync(new URL("../refresh.js", import.meta.url), "utf8")
    .replace("import(moduleURL)", "testImport(moduleURL)");
const tick = () => new Promise(resolve => setImmediate(resolve));
const settle = async () => { for (let count = 0; count < 5; count++) await tick(); };
const referenceTime = Date.parse("2026-11-11T10:00:00Z");
const example = {
    id: "WTA_125_EXAMPLE", label: "WTA 125 Example", name: "Example Open", week: "2026-11-16",
    dates: { main: "2026-10-19", qualifying: "2026-10-26", mainAvailable: "2026-10-23", qualAvailable: "2026-10-30" },
    main: [{ id: "1", name: "Main Player", country: "ARG", rank: 20 }],
    qualifying: [{ id: "2", name: "Qualifier", country: "FRA", rank: null }],
};
const snapshot = (models = [example], fetchedAt = "2026-11-11T09:58:00Z") => ({
    schema_version: 1, fetched_at: fetchedAt, saved_at: "2026-11-11T09:59:00Z",
    window_start: "2026-11-16", window_end: "2026-12-14", models: structuredClone(models),
});
const state = (saved = null, extra = {}) => ({ snapshot: saved, refreshing: false, next_refresh_at: 0, progress: "", error: null, ...extra });

function panel(id, view = "main") {
    const views = new Map([".changes-view", ".qual-view"].map(key => [key, {
        style: { display: key === ".changes-view" && view === "changes" || key === ".qual-view" && view === "qualifying" ? "flex" : "none" },
    }]));
    return { id, style: { display: "block" }, querySelector: key => views.get(key) || { id, selector: key }, views };
}

function tab(handler, { view = null, loadModule } = {}) {
    let now = referenceTime;
    let panels = view ? [panel(example.id, view)] : [];
    let buttons = [];
    const intervals = [];
    const listeners = {};
    const requests = [];
    const moduleRequests = [];
    const renderCalls = [];
    const historyCalls = [];
    const status = { textContent: "Loading saved entry lists" };
    const initialNote = { textContent: "Loading saved entry lists" };
    const initialMenu = { textContent: "Loading tournaments" };
    const button = { addEventListener(name, listener) { this[name] = listener; } };
    const content = {
        querySelectorAll: () => panels,
        replaceChildren(fragment) { panels = fragment.panels; },
    };
    const menu = { querySelectorAll: () => buttons, replaceChildren(fragment) { buttons = fragment.buttons; } };
    const context = {
        AbortSignal, Intl, console,
        Date: class extends Date {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
        },
        document: {
            getElementById: id => id === "refresh-lists" ? button : id === "refresh-status" ? status
                : id === "entry-state" ? initialNote : id === "menu-state" ? initialMenu : panels.find(item => item.id === id),
            querySelector: selector => selector === ".main-content" ? content : menu,
        },
        testEntryModule: { BASE: "https://example.workers.dev", addDays, monday,
            updateEntryChanges(models, content) { historyCalls.push({ models, content }); },
            renderEntryLists(models) {
                renderCalls.push({ models });
                return { menu: { buttons: models.map(model => ({ id: model.id })) },
                    content: { panels: models.map(model => panel(model.id)) } };
            },
        },
        testImport(url) {
            moduleRequests.push(url);
            return loadModule ? loadModule(url, context.testEntryModule) : Promise.resolve(context.testEntryModule);
        },
        fetch: async (url, options) => {
            requests.push({ url, options });
            assert.equal(new URL(url).searchParams.get("history"), "1", "the current client requests imported history");
            assert.equal(options.body, undefined, "the client must never submit its own player data");
            return handler(options.method, requests.length);
        },
        localStorage: { getItem() { throw new Error("The old per-browser cooldown must not be read"); } },
        window: {
            setInterval(listener) { intervals.push(listener); },
            setTimeout(listener) { queueMicrotask(listener); },
            addEventListener(name, listener) { listeners[name] = listener; },
            openTourney(event, id) { panels.forEach(item => { item.style.display = item.id === id ? "block" : "none"; }); },
            toggleView() { panels[0].views.get(".qual-view").style.display = "flex"; },
            showChanges() { panels[0].views.get(".changes-view").style.display = "flex"; },
        },
    };
    vm.runInNewContext(source, context);
    return { status, initialNote, initialMenu, button, requests, moduleRequests, renderCalls, historyCalls, content, listeners,
        panels: () => panels,
        advance(ms) { now += ms; intervals.forEach(listener => listener()); },
    };
}

test("manual refresh saves server results and another page load restores them with the shared cooldown", async () => {
    let saved = null, posts = 0;
    const service = method => {
        if (method === "POST") {
            posts++;
            if (posts === 1) return Response.json(state(null, { refreshing: true, progress: "Loading WTA entry lists (1/2)" }), { status: 202 });
            saved = snapshot();
        }
        return Response.json(state(saved, { next_refresh_at: saved ? referenceTime + 120000 : 0 }));
    };
    const first = tab(service, { view: "qualifying" });
    await settle();
    assert.equal(first.renderCalls.length, 0);
    assert.match(first.initialNote.textContent, /No entry lists have been saved/);
    await first.button.click();
    assert.equal(posts, 2);
    assert.match(first.status.textContent, /^Updated and saved at /);
    assert.equal(first.renderCalls.length, 1);
    assert.equal(first.panels()[0].views.get(".qual-view").style.display, "flex");
    assert.equal(first.button.disabled, true);
    assert.equal(first.button.textContent, "Refresh (2:00)");
    await first.button.click();
    assert.equal(posts, 2);
    const reload = tab(service);
    await settle();
    assert.equal(reload.renderCalls.length, 1);
    assert.equal(reload.button.disabled, true);
    assert.equal(reload.requests.length, 1);
    assert.equal(reload.requests[0].options.method, "GET");
    reload.advance(120001);
    await settle();
    assert.equal(reload.button.disabled, false);
    assert.equal(reload.requests.length, 2, "cooldown expiry checks the latest shared state once");
});

test("reload joins an existing refresh, while ordinary opening only reads the saved copy", async () => {
    const active = tab(method => Response.json(method === "GET"
        ? state(snapshot(), { refreshing: true, progress: "Fetching rankings" })
        : state(snapshot(), { next_refresh_at: referenceTime + 120000 })));
    await settle();
    assert.deepEqual(active.requests.map(request => request.options.method), ["GET", "POST"]);
    assert.equal(active.renderCalls.length, 1);
    const idle = tab(() => Response.json(state(snapshot())));
    await settle();
    assert.deepEqual(idle.requests.map(request => request.options.method), ["GET"]);
});

test("Refresh retries a failed module download without reusing the browser's failed module URL", async () => {
    let attempts = 0;
    const browser = tab(() => Response.json(state(snapshot())), {
        loadModule(url, module) {
            attempts++;
            return attempts === 1 ? Promise.reject(new Error("Network unavailable")) : Promise.resolve(module);
        },
    });
    await settle();
    assert.equal(browser.requests.length, 0);
    assert.match(browser.status.textContent, /Click Refresh to try again/);
    assert.equal(browser.button.disabled, false);
    await browser.button.click();
    assert.equal(browser.renderCalls.length, 1);
    assert.match(browser.status.textContent, /^Updated and saved at /);
    assert.equal(browser.moduleRequests.length, 2);
    assert.match(browser.moduleRequests[0], /^\.\/entry-lists\.mjs\?v=\d+$/);
    assert.equal(browser.moduleRequests[1], browser.moduleRequests[0] + "&retry=1");
    await browser.button.click();
    assert.equal(attempts, 2, "a successful module is reused without further cache busting");
});

test("older shared responses cannot replace newer D1 lists or history", async () => {
    let current = snapshot();
    const browser = tab(() => Response.json(state(current)));
    await settle();
    assert.equal(browser.renderCalls.length, 1);
    current = snapshot([{ ...example, name: "Old tournament data" }], "2026-11-11T09:57:00Z");
    browser.advance(16000);
    browser.listeners.focus();
    await settle();
    assert.equal(browser.renderCalls.length, 1);
    assert.equal(browser.historyCalls.length, 0);
    assert.match(browser.status.textContent, /^Updated and saved at /);
});

test("retention removes expired tournaments even when WTA freshness timestamps have not changed", async () => {
    const next = { ...example, id: "WTA_125_NEXT", week: "2026-11-23" };
    let current = snapshot([example, next]);
    const browser = tab(() => Response.json(state(current)));
    await settle();
    assert.equal(browser.renderCalls[0].models.length, 2);
    current = snapshot([next]);
    current.window_start = "2026-11-23";
    current.window_end = "2026-12-21";
    browser.advance(7 * 86400000);
    browser.listeners.focus();
    await settle();
    assert.equal(browser.renderCalls.length, 2);
    assert.deepEqual(browser.renderCalls[1].models.map(model => model.id), ["WTA_125_NEXT"]);
    assert.equal(browser.historyCalls.length, 0);
});

test("stale periods and corrupt player data preserve the current page; a valid empty calendar is rendered", async () => {
    const stale = snapshot();
    stale.window_start = "2026-11-09";
    stale.window_end = "2026-12-07";
    const old = tab(() => Response.json(state(stale)));
    await settle();
    assert.equal(old.renderCalls.length, 0);
    assert.match(old.status.textContent, /earlier period/);
    const corrupt = snapshot();
    corrupt.models[0].main[0].rank = "20";
    const broken = tab(() => Response.json(state(corrupt)));
    await settle();
    assert.equal(broken.renderCalls.length, 0);
    assert.match(broken.status.textContent, /Click Refresh to try again/);
    assert.equal(broken.initialNote.textContent, broken.status.textContent);
    const empty = tab(() => Response.json(state(snapshot([]))));
    await settle();
    assert.equal(empty.renderCalls.length, 1);
    assert.equal(empty.renderCalls[0].models.length, 0);
});

test("failed refresh keeps the previous saved result and honors the server retry delay", async () => {
    const browser = tab(method => Response.json(state(snapshot(), method === "POST"
        ? { next_refresh_at: referenceTime + 15000, error: "WTA unavailable" } : {}), { status: method === "POST" ? 502 : 200 }));
    await settle();
    await browser.button.click();
    assert.equal(browser.renderCalls.length, 1);
    assert.match(browser.status.textContent, /^Refresh failed/);
    assert.equal(browser.button.textContent, "Refresh (0:15)");
    assert.equal(browser.button.disabled, true);
    const unavailable = tab(() => Response.json({ error: "D1 not configured" }, { status: 503 }));
    await settle();
    assert.equal(unavailable.renderCalls.length, 0);
    assert.match(unavailable.status.textContent, /Click Refresh to try again/);
    assert.equal(unavailable.initialNote.textContent, unavailable.status.textContent);
    const savedDuringError = tab(() => Response.json(state(snapshot(), { error: "WTA unavailable" }), { status: 502 }));
    await settle();
    assert.equal(savedDuringError.renderCalls.length, 1, "a provider failure can still carry the last good D1 snapshot");
    assert.match(savedDuringError.status.textContent, /current lists are still shown/);
});

test("focus retrieves a newer shared version and keeps the selected Changes view", async () => {
    let current = snapshot();
    const browser = tab(() => Response.json(state(current)), { view: "changes" });
    await settle();
    assert.equal(browser.panels()[0].views.get(".changes-view").style.display, "flex");
    current = snapshot([{ ...example, main_retained: true }], "2026-11-11T09:59:00Z");
    browser.advance(16000);
    browser.listeners.focus();
    await settle();
    assert.equal(browser.renderCalls.length, 2);
    assert.equal(browser.renderCalls[1].models[0].main_retained, true);
    assert.equal(browser.panels()[0].views.get(".changes-view").style.display, "flex");
});

const change = (extra = {}) => ({ id: "change-1", at: "2026-11-11T09:58:30Z", date: "2026-11-11",
    draw: "main", action: "removed", player_id: "1", name: "Main Player", ...extra });

test("D1 provides imported Changes on a clean page load without any embedded player data", async () => {
    const imported = change({ id: "legacy:record-1", player_id: null, source: "legacy", at: "2026-11-10T00:00:00.000Z", date: "2026-11-10" });
    const saved = snapshot([{ ...example, changes: [change(), imported] }]);
    const browser = tab(() => Response.json(state(saved)));
    await settle();
    assert.equal(browser.renderCalls.length, 1);
    assert.equal(browser.renderCalls[0].models[0].changes[1].id, "legacy:record-1");
    assert.match(browser.status.textContent, /^Updated and saved at /);
});

test("reload restores saved Changes and same-entry-time history updates do not rebuild lists", async () => {
    let current = snapshot([{ ...example, changes: [change()] }]);
    const browser = tab(() => Response.json(state(current)), { view: "changes" });
    await settle();
    assert.equal(browser.renderCalls[0].models[0].changes[0].id, "change-1");
    const reload = tab(() => Response.json(state(current)));
    await settle();
    assert.equal(reload.renderCalls[0].models[0].changes[0].id, "change-1");
    current = snapshot([{ ...example, changes: [change({ id: "change-2", action: "added", at: "2026-11-11T09:59:15Z" }), change()] }]);
    current.saved_at = "2026-11-11T09:59:30Z";
    browser.advance(16000);
    browser.listeners.focus();
    await settle();
    assert.equal(browser.renderCalls.length, 1);
    assert.equal(browser.historyCalls.length, 1);
    assert.equal(browser.historyCalls[0].models[0].changes.length, 2);
    assert.equal(browser.panels()[0].views.get(".changes-view").style.display, "flex");
    current = snapshot([{ ...example, changes: [change()] }]);
    browser.advance(16000);
    browser.listeners.focus();
    await settle();
    assert.equal(browser.historyCalls.length, 1, "older saved history must not erase newer events");
});

test("invalid saved Changes reject the whole snapshot before changing tables or history", async () => {
    for (const changes of [[change({ draw: "doubles" })], [change({ action: "edited" })],
        [change({ player_id: "not-a-player-id" })], [change({ player_id: null })],
        [change({ at: "invalid" })], [change(), change()], "wrong"]) {
        const browser = tab(() => Response.json(state(snapshot([{ ...example, changes }]))));
        await settle();
        assert.equal(browser.renderCalls.length, 0);
        assert.equal(browser.historyCalls.length, 0);
        assert.match(browser.status.textContent, /Click Refresh to try again/);
    }
});
