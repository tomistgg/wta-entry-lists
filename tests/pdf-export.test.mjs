import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const page = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = page.match(/<script>\s*([\s\S]*?)<\/script>/)[1];

function editor(library) {
    const classes = new Set();
    const status = { textContent: "" };
    const content = {};
    const context = {
        document: {
            body: { classList: { add: name => classes.add(name), remove: name => classes.delete(name) } },
            getElementById: id => { assert.equal(id, "pdf-status"); return status; },
            querySelector: selector => { assert.equal(selector, ".main-content"); return content; },
        },
        html2pdf: library,
    };
    vm.createContext(context);
    vm.runInContext(source, context);
    return { context, classes, status, content, export: () => context.exportToPDF() };
}

test("missing PDF library reports a visible error and leaves the controls available", async () => {
    const browser = editor(undefined);
    await browser.export();
    assert.equal(browser.classes.has("is-exporting"), false);
    assert.match(browser.status.textContent, /unavailable.*Reload/);
    assert.match(page, /id="pdf-status"[^>]*role="status"/);
});

test("synchronous PDF errors restore controls and allow a later retry", async () => {
    const browser = editor(() => { throw new Error("Canvas setup failed"); });
    await browser.export();
    assert.equal(browser.classes.has("is-exporting"), false);
    assert.match(browser.status.textContent, /could not be created/);
    browser.context.html2pdf = () => ({ set() { return this; }, from() { return this; }, save: async () => {} });
    await browser.export();
    assert.equal(browser.status.textContent, "PDF saved.");
});

test("a rejected PDF save always restores the page without an unhandled rejection", async () => {
    const browser = editor(() => ({ set() { return this; }, from() { return this; },
        save: () => Promise.reject(new Error("PDF save failed")) }));
    await browser.export();
    assert.equal(browser.classes.has("is-exporting"), false);
    assert.match(browser.status.textContent, /could not be created/);
});

test("PDF export preserves its layout and ignores duplicate clicks while saving", async () => {
    let release, calls = 0, options;
    const browser = editor(() => ({
        set(value) { options = value; return this; },
        from(value) { assert.equal(value, browser.content); return this; },
        save() { calls++; return new Promise(resolve => { release = resolve; }); },
    }));
    const first = browser.export();
    assert.equal(browser.classes.has("is-exporting"), true);
    assert.match(browser.status.textContent, /Preparing PDF/);
    await browser.export();
    assert.equal(calls, 1);
    assert.equal(options.filename, "entry-list.pdf");
    assert.equal(options.html2canvas.scale, 1.5);
    assert.deepEqual(Array.from(options.jsPDF.format), [418, 244]);
    assert.equal(options.jsPDF.orientation, "landscape");
    release();
    await first;
    assert.equal(browser.classes.has("is-exporting"), false);
    assert.equal(browser.status.textContent, "PDF saved.");
});
