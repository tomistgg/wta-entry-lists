import assert from "node:assert/strict";
import test from "node:test";
import { previousEntryModels, withEntryHistory, withLegacyHistory } from "./entry-history.mjs";

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

test("removed and hidden tournaments do not retain history or player baselines", () => {
    const models = withEntryHistory([model([player(3)])], snapshot([model()]), time);
    const emptySnapshot = { models: [], hidden_models: models };
    assert.deepEqual(previousEntryModels(emptySnapshot), []);
    const restored = withEntryHistory([model([player(3)])], emptySnapshot, time + 1000);
    assert.deepEqual(restored[0].changes, []);
    assert.deepEqual(restored[0].change_baselines.main, [{ id: "3", name: "Player 3" }]);
});

test("legacy history merges by edition and never changes player baselines", () => {
    const current = withEntryHistory([{ ...model(), dates: { main: "2026-10-19" } }], null, time)[0];
    const unchanged = structuredClone(current);
    const imported = (id, date) => ({ id: "legacy:" + id, at: date + "T00:00:00.000Z", date,
        draw: "main", action: "added", player_id: null, name: "Old Entry", source: "legacy" });
    const result = withLegacyHistory(current, [imported("old-edition", "2025-11-01"),
        imported("first", "2026-11-01"), imported("repeat", "2026-11-01"), imported("future", "2026-11-12")],
    new Date(time).toISOString());
    assert.deepEqual(result.changes.map(change => change.id), ["legacy:first", "legacy:repeat"]);
    assert.deepEqual(result.change_baselines, current.change_baselines);
    assert.deepEqual(current, unchanged);
});

test("legacy duplicates use both Madrid and UTC dates while distinct real transitions remain", () => {
    const real = (id, at) => ({ id, at, date: "2026-11-12", draw: "qualifying", action: "added",
        player_id: "3", name: "Leolia Jeanjean" });
    const current = { ...model(), dates: { main: "2026-10-19" },
        changes: [real("one", "2026-11-11T23:30:00.000Z"), real("two", "2026-11-11T23:40:00.000Z")] };
    const legacy = [{ id: "legacy:duplicate", at: "2026-11-11T00:00:00.000Z", date: "2026-11-11",
        draw: "qualifying", action: "added", player_id: null, name: "Léolia Jeanjean", source: "legacy" }];
    assert.deepEqual(withLegacyHistory(current, legacy, "2026-11-12T01:00:00.000Z").changes.map(change => change.id),
        ["two", "one"]);
});
