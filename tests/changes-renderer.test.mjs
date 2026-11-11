import assert from "node:assert/strict";
import test from "node:test";
import { updateEntryChanges } from "../entry-lists.mjs";

// A small DOM fixture exercises safe element construction and history merging without a browser dependency.
class Node {
    constructor(tag = "div") {
        this.tagName = tag.toUpperCase(); this.childNodes = []; this.dataset = {}; this.style = {}; this.className = "";
    }
    append(...nodes) {
        for (const node of nodes) {
            if (node instanceof Node) {
                node.remove();
                node.parentElement = this;
            }
            this.childNodes.push(node);
        }
    }
    remove() {
        if (this.parentElement) this.parentElement.childNodes.splice(this.parentElement.childNodes.indexOf(this), 1);
        this.parentElement = null;
    }
    replaceChildren(...nodes) { this.childNodes.forEach(node => { if (node instanceof Node) node.parentElement = null; }); this.childNodes = []; this.append(...nodes); }
    set textContent(text) { this.replaceChildren(String(text)); }
    get textContent() { return this.childNodes.map(node => node instanceof Node ? node.textContent : node).join(""); }
    set innerHTML(html) { this.constantHTML = html; }
    cloneNode(deep) {
        const clone = new Node(this.tagName);
        clone.className = this.className; clone.dataset = { ...this.dataset }; clone.style = { ...this.style };
        if (deep) clone.append(...this.childNodes.map(node => node instanceof Node ? node.cloneNode(true) : node));
        return clone;
    }
    querySelectorAll(selector) {
        const matches = node => selector.startsWith(".") ? node.className.split(" ").includes(selector.slice(1))
            : selector === "tbody tr" ? node.tagName === "TR" && node.parentElement?.tagName === "TBODY"
                : node.tagName === selector.toUpperCase();
        const descendants = this.childNodes.filter(node => node instanceof Node)
            .flatMap(node => [node, ...node.querySelectorAll("*")]);
        return selector === "*" ? descendants : descendants.filter(matches);
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function fixture(legacy = []) {
    const content = new Node(), panel = new Node(), view = new Node(), table = new Node("table"), body = new Node("tbody");
    panel.className = "tabcontent"; panel.id = "EVENT"; view.className = "changes-view"; view.style.display = "flex";
    for (const [dateText, descriptionText] of legacy) {
        const row = new Node("tr"), date = new Node("td"), description = new Node("td");
        date.textContent = dateText; description.textContent = descriptionText; row.append(date, description); body.append(row);
    }
    table.append(body); view.append(table); panel.append(view); content.append(panel);
    return { content, panel, view };
}
const event = extra => ({ id: "event-1", at: "2026-11-11T10:32:00Z", date: "2026-11-11", draw: "main",
    action: "removed", player_id: "1", name: "Main Player", ...extra });

test.before(() => { globalThis.document = { createElement: tag => new Node(tag) }; });
test.after(() => { delete globalThis.document; });

test("D1 Changes merge published history, remove matching legacy duplicates and stay stable on repeated updates", () => {
    const { content, view } = fixture([
        ["2026-11-11", "MAIN PLAYER removed from Main Draw"],
        ["2026-11-10", "ANOTHER PLAYER added to Qualifying"],
    ]);
    const model = { id: "EVENT", changes: [event()] };
    updateEntryChanges([model], content);
    let rows = view.querySelectorAll("tbody tr");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dataset.changeId, "event-1");
    assert.match(rows[1].textContent, /ANOTHER PLAYER added to Qualifying/);
    updateEntryChanges([model], content);
    rows = view.querySelectorAll("tbody tr");
    assert.equal(rows.length, 2);
    assert.equal(view.style.display, "flex", "updating history must keep the user's Changes view open");
});

test("distinct D1 events remain distinct and player names are inserted as text, never HTML", () => {
    const { content, view } = fixture();
    const name = '<img src=x onerror="alert(1)">';
    updateEntryChanges([{ id: "EVENT", changes: [event({ id: "late", name, at: "2026-11-11T12:32:00Z" }),
        event({ id: "early", name })] }], content);
    const rows = view.querySelectorAll("tbody tr");
    assert.equal(rows.length, 2);
    assert.equal(rows[0].dataset.changeId, "late");
    assert.match(rows[0].querySelector("strong").textContent, /<IMG SRC=X ONERROR=/);
    assert.equal(view.querySelectorAll("img").length, 0);
});

test("UTC-dated GitHub duplicates merge correctly with a Madrid event after midnight", () => {
    const { content, view } = fixture([["2026-11-11", "LÉOLIA JEANJEAN added to Qualifying"]]);
    updateEntryChanges([{ id: "EVENT", changes: [event({ name: "Leolia Jeanjean", draw: "qualifying", action: "added",
        at: "2026-11-11T23:32:00Z", date: "2026-11-12" })] }], content);
    const rows = view.querySelectorAll("tbody tr");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].querySelector("td").textContent, "2026-11-12");
});

test("old snapshots without Changes preserve published history and an explicit empty history adds no noise", () => {
    const { content, view } = fixture([["2026-11-10", "ANOTHER PLAYER added to Qualifying"]]);
    updateEntryChanges([{ id: "EVENT" }], content);
    assert.equal(view.querySelectorAll("tbody tr").length, 1);
    updateEntryChanges([{ id: "EVENT", changes: [] }], content);
    assert.equal(view.querySelectorAll("tbody tr").length, 1);
    updateEntryChanges([{ id: "MISSING", changes: [event()] }], content);
    assert.equal(view.querySelectorAll("tbody tr").length, 1);
});
