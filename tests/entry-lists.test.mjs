import assert from "node:assert/strict";
import test from "node:test";
import { monday, rankingDates, slug, parseEntryList, rankedPlayers, collectEntryLists } from "../entry-lists.mjs";

const player = (id, name) => ({
    getAttribute: key => key === "href" ? `/players/${id}/${name.toLowerCase().replaceAll(" ", "-")}` : name,
    textContent: name,
    closest: () => ({ getAttribute: () => name, querySelector: () => ({ textContent: "ARG" }) }),
});
const section = (name, people) => ({ getAttribute: () => name, querySelectorAll: () => people });
const page = sections => ({ querySelectorAll: selector => selector.startsWith("script") ? [] : sections });
const fixture = page([
    section("Singles", [player(1, "Main Player"), player(1, "Main Player")]),
    section("Doubles", [player(99, "Doubles Only")]),
    section("Qualifying", [player(2, "Qualifier")]),
]);
const tournament = { tournamentGroup: { id: 1, name: "EXAMPLE" }, year: 2026, level: "WTA 125",
    startDate: "2026-11-09", endDate: "2026-11-15", city: "EXAMPLE" };

test("deadline weeks handle weekday, weekend, year boundary and future deadlines", () => {
    assert.equal(monday("2027-01-03"), "2026-12-28");
    assert.equal(rankingDates("2026-11-09", "2026-11-05").main, "2026-10-12");
    assert.equal(rankingDates("2026-11-07", "2026-11-05").main, "2026-10-12");
    assert.equal(rankingDates("2026-12-28", "2026-11-05").main, "2026-11-02");
    assert.equal(slug("La Bisbal D'Empordá #2"), "la-bisbal-d-emporda-2");
});

test("qualifying after doubles is included, doubles are excluded, and players are deduplicated", () => {
    const data = parseEntryList(fixture, tournament);
    assert.deepEqual(data.main.map(p => p.id), ["1"]);
    assert.deepEqual(data.qualifying.map(p => p.id), ["2"]);
    assert.throws(() => parseEntryList(page([]), tournament), /unrecognized entry-list/);
});

test("ranking identity is matched by player ID and unranked entries remain visible", () => {
    const players = [{ id: "1", name: "Different spelling", country: "-" }, { id: "2", name: "Unranked", country: "ARG" }];
    const rows = rankedPlayers(players, new Map([["1", { player: { fullName: "Official Name", countryCode: "FRA" }, ranking: 10 }]]));
    assert.equal(rows[0].name, "Official Name");
    assert.equal(rows[0].rank, 10);
    assert.equal(rows[1].name, "Unranked");
    assert.equal(rows[1].rank, null);
});

test("live collection discovers tournaments and uses the correct singles deadline ranking dates", async t => {
    const saved = globalThis.DOMParser;
    globalThis.DOMParser = class { parseFromString() { return fixture; } };
    t.after(() => { globalThis.DOMParser = saved; });
    const dates = [];
    t.mock.method(globalThis, "fetch", async (url, options) => {
        url = new URL(url);
        assert.equal(options.cache, "no-store");
        assert.equal(url.origin, "https://tennis-wta-api.schiter-tomas.workers.dev");
        if (url.pathname.startsWith("/site/")) return new Response("WTA HTML fixture");
        if (url.pathname.endsWith("/ranked")) {
            dates.push(url.searchParams.get("at"));
            assert.equal(url.searchParams.get("metric"), "SINGLES");
            return Response.json([{ player: { id: 1, fullName: "Main Player", countryCode: "ARG" }, ranking: 10 }]);
        }
        return Response.json({ pageInfo: { page: 0, numEntries: 1 }, content: [tournament] });
    });
    const results = await collectEntryLists(new Date("2026-11-05T12:00:00Z"));
    assert.deepEqual(dates.sort(), ["2026-10-12", "2026-10-19"]);
    assert.equal(results[0].main[0].rank, 10);
    assert.equal(results[0].qualifying[0].id, "2");
    assert.equal(results[0].qualifying[0].rank, null);
});

test("a valid empty upcoming calendar is different from a truncated response", async t => {
    t.mock.method(globalThis, "fetch", async () => Response.json({ pageInfo: { page: 0, numEntries: 0 }, content: [] }));
    assert.deepEqual(await collectEntryLists(new Date("2026-11-05T12:00:00Z")), []);
    globalThis.fetch = async () => Response.json({ pageInfo: { page: 0, numEntries: 2 }, content: [] });
    await assert.rejects(collectEntryLists(new Date("2026-11-05T12:00:00Z")), /incomplete/);
});
