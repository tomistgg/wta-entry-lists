import assert from "node:assert/strict";
import test from "node:test";
import { retainHiddenModels, withEntryHistory } from "./entry-history.mjs";

const time = Date.parse("2026-11-11T12:00:00Z");
const player = (id, name = "Player " + id) => ({ id: String(id), name, country: "ARG", rank: Number(id) });
const model = (main = [player(1)], qualifying = [player(2)]) => ({ id: "EXAMPLE", week: "2026-11-16", main, qualifying });
const snapshot = models => ({ models });

test("the first snapshot and newly published lists establish baselines without fake additions", () => {
    const first = withEntryHistory([model()], null, time);
    assert.deepEqual(first[0].changes, []);
    assert.deepEqual(first[0].change_baselines.main, [{ id: "1", name: "Player 1" }]);
    const old = model([player(1)], []);
    assert.deepEqual(withEntryHistory([model()], snapshot([old]), time)[0].changes, []);
});

test("additions/removals are identified by WTA ID separately for both draws", () => {
    const old = model([player(1), player(3)], [player(2)]);
    const current = model([player(1), player(4)], [player(5)]);
    const result = withEntryHistory([current], snapshot([old]), time)[0];
    assert.deepEqual(result.changes.map(({ player_id, draw, action }) => [player_id, draw, action]), [
        ["3", "main", "removed"], ["4", "main", "added"],
        ["2", "qualifying", "removed"], ["5", "qualifying", "added"],
    ]);
    assert.ok(result.changes.every(change => change.date === "2026-11-11" && change.at === new Date(time).toISOString()));
});

test("rank, order, spelling and country changes do not become entry changes", () => {
    const old = model([player(1), player(3)]);
    const current = model([{ ...player(3, "New Spelling"), rank: 99, country: "FRA" }, player(1)]);
    const result = withEntryHistory([current], snapshot([old]), time)[0];
    assert.deepEqual(result.changes, []);
    assert.equal(result.change_baselines.main[0].name, "New Spelling");
});

test("qualifying promotions record both the main-draw addition and qualifying removal", () => {
    const old = model([player(1)], [player(2), player(3)]);
    const current = model([player(1), player(2)], [player(3)]);
    assert.deepEqual(withEntryHistory([current], snapshot([old]), time)[0].changes.map(change =>
        [change.player_id, change.draw, change.action]), [["2", "main", "added"], ["2", "qualifying", "removed"]]);
});

test("retained main draws and disappeared lists never create mass withdrawals", () => {
    const first = withEntryHistory([model()], null, time);
    const retained = { ...model(), main_retained: true };
    assert.deepEqual(withEntryHistory([retained], snapshot(first), time + 1000)[0].changes, []);
    const absent = withEntryHistory([model([], [])], snapshot(first), time + 1000);
    assert.deepEqual(absent[0].changes, []);
    const restored = withEntryHistory([model([player(3)], [player(2)])], snapshot(absent), time + 2000)[0];
    assert.deepEqual(restored.changes.map(change => [change.player_id, change.action]), [["1", "removed"], ["3", "added"]]);
});

test("unchanged refreshes retain history and repeated real transitions stay distinct", () => {
    const first = withEntryHistory([model()], null, time);
    const second = withEntryHistory([model([player(3)])], snapshot(first), time + 1000);
    const stable = withEntryHistory([model([player(3)])], snapshot(second), time + 2000);
    assert.deepEqual(stable[0].changes, second[0].changes);
    const back = withEntryHistory([model()], snapshot(stable), time + 3000);
    const again = withEntryHistory([model([player(3)])], snapshot(back), time + 4000);
    assert.equal(again[0].changes.length, 6);
    assert.equal(new Set(again[0].changes.map(change => change.id)).size, 6);
    assert.ok(again[0].changes[0].at > again[0].changes.at(-1).at);
});

test("a reused tournament ID in another week does not inherit entries or history", () => {
    const before = withEntryHistory([model([player(3)])], snapshot([model()]), time);
    const changedWeek = { ...model(), week: "2027-01-04" };
    assert.deepEqual(withEntryHistory([changedWeek], snapshot(before), time + 1000)[0].changes, []);
});

test("history uses the Madrid detection date and does not mutate the previous snapshot", () => {
    const old = snapshot(withEntryHistory([model()], null, time));
    const untouched = structuredClone(old);
    const result = withEntryHistory([model([player(3)])], old, Date.parse("2026-11-11T23:30:00Z"));
    assert.equal(result[0].changes[0].date, "2026-11-12");
    assert.deepEqual(old, untouched);
});

test("temporarily missing tournaments and empty calendars preserve history until the week leaves the window", () => {
    const models = withEntryHistory([model([player(3)])], snapshot([model()]), time);
    const hidden = retainHiddenModels([], snapshot(models), "2026-11-16", "2026-12-14");
    const emptySnapshot = { models: [], hidden_models: hidden };
    assert.equal(hidden.length, 1);
    const restored = withEntryHistory([model([player(3)])], emptySnapshot, time + 1000);
    assert.deepEqual(restored[0].changes, models[0].changes);
    assert.deepEqual(retainHiddenModels(restored, emptySnapshot, "2026-11-16", "2026-12-14"), []);
    assert.deepEqual(retainHiddenModels([], emptySnapshot, "2026-11-23", "2026-12-21"), []);
});
