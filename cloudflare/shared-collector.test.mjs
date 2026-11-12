import assert from "node:assert/strict";
import test from "node:test";
import { advanceSharedJob, createSharedJob } from "./shared-collector.mjs";
import { bracketRounds, compactMatches, drawChampion, mergeCalendar, mergePlayerForm, parseMatch } from "./shared-models.mjs";

const now = Date.parse("2026-11-12T12:00:00Z");
const event = (id = 1, changes = {}) => ({ tournamentGroup: { id, name: "EXAMPLE " + id }, year: 2026, level: "WTA 250",
    title: "Example Open", city: "City", startDate: "2026-11-09", endDate: "2026-11-15", ...changes });
const match = (changes = {}) => ({ MatchID: "LS001", DrawMatchType: "S", DrawLevelType: "M", MatchState: "F", Winner: "2",
    RoundID: "F", PlayerIDA: "1", PlayerIDB: "2", PlayerNameFirstA: "First", PlayerNameLastA: "Player",
    PlayerNameFirstB: "Other", PlayerNameLastB: "Player", PlayerCountryA: "ARG", PlayerCountryB: "FRA",
    ScoreSet1A: "6", ScoreSet1B: "4", ScoreSet2A: "7", ScoreSet2B: "6", ScoreTbSet2: "4",
    MatchTimeStamp: "2026-11-12T09:00:00Z", MatchTimeTotal: "01:00:00", LastUpdated: "2026-11-12T11:59:00Z", ...changes });

async function finish(job, io) {
    for (let step = 0; step < 100; step++) {
        let calls = 0;
        const result = await advanceSharedJob(JSON.parse(JSON.stringify(job)), { ...io,
            fetchJSON: async (...args) => { calls++; return io.fetchJSON(...args); } });
        assert.ok(calls <= 4, "each resumed step must bound upstream work");
        if (result.done) return result;
        job = result.job;
    }
    throw new Error("Shared job did not finish");
}

test("server singles transforms preserve result timestamps, qualifying labels, scores, and actual bracket positions", () => {
    const parsed = parseMatch(match({ DrawLevelType: "Q", RoundID: "2" }), event(), now);
    assert.equal(parsed.completed_at, "2026-11-12T10:00:00.000Z");
    assert.equal(parsed.round, "Qualifying · 2nd Round");
    assert.deepEqual(parsed.sets, [{ winner: 6, loser: 4, tiebreak: "" }, { winner: 7, loser: 6, tiebreak: "4" }]);
    assert.equal(parseMatch(match({ DrawMatchType: "D" }), event(), now), null);
    assert.equal(parseMatch(match({ Winner: "6" }), event(), now), null);
    assert.equal(parseMatch(match({ MatchTimeStamp: "2026-11-11T09:00:00Z" }), event(), now), null);
    const rounds = bracketRounds([match({ MatchID: "LS002", RoundID: "1" }),
        match({ MatchID: "LS003", RoundID: "1", Winner: "3" }),
        match({ DrawMatchType: "D", MatchID: "LS001" })]);
    assert.equal(rounds.F[0].players[0].id, "1");
    assert.equal(rounds.F[0].players[1].id, "2");
    assert.equal(rounds.S[0].players[0].id, "1");
    assert.equal(drawChampion(event(), [match()], now).champion.id, "1");
    assert.equal(drawChampion(event(), [match({ Winner: "4", Message: "" })], now), null);
    assert.throws(() => drawChampion(event(), [match(), match({ MatchID: "LS0001" })], now), /multiple/);
    const compact = compactMatches([match({ unusedProviderField: "discard" }), match({ DrawMatchType: "D" })]);
    assert.equal(compact.length, 1);
    assert.equal(Object.hasOwn(compact[0], "unusedProviderField"), false);
    assert.deepEqual(parseMatch(compact[0], event(), now), parseMatch(match(), event(), now));
});

test("calendar refresh preserves ITF/custom and uncovered rows while removing cancelled or missing WTA editions", () => {
    const fields = ["calendarKey", "name", "level", "startDate", "endDate", "source"];
    const previous = { fields, weeks: { "2026-11-09": [
        ["wta:1:2026", "Old name", "WTA 250", "2026-11-09", "2026-11-15", "WTA"],
        ["wta:2:2026", "Removed", "WTA 250", "2026-11-09", "2026-11-15", "WTA"],
        ["wta:2:2026|qualifying", "Removed qualifying", "WTA 250", "2026-11-08", "2026-11-09", "WTA"],
        ["itf:existing", "ITF (Cancelled)", "W15", "2026-11-09", "2026-11-15", "ITF"],
        ["custom:bjkc", "BJKC", "BJKC", "2026-11-09", "2026-11-15", ""],
        ["wta:9:2025", "Old season", "WTA 250", "2025-11-09", "2025-11-15", "WTA"],
    ] } };
    const updated = mergeCalendar(previous, { from: "2026-01-01", to: "2027-12-31", items: [event(),
        event(3, { tournamentGroup: { id: 3, name: "Cancelled", metadata: { cancelledSeasons: "2026" } } })] });
    const rows = Object.values(updated.weeks).flat().map(row => Object.fromEntries(updated.fields.map((field, i) => [field, row[i]])));
    assert.deepEqual(rows.map(row => row.calendarKey).sort(), ["custom:bjkc", "itf:existing", "wta:1:2026", "wta:9:2025"]);
    assert.equal(rows.find(row => row.calendarKey === "wta:1:2026").name, "Example Open");
    assert.equal(previous.weeks["2026-11-09"][0][1], "Old name");
});

test("calendar pagination resumes bounded jobs and rejects repeated/truncated responses", async () => {
    let calls = 0;
    const io = { async fetchJSON(path, params) {
        calls++; assert.equal(path, "/api/tennis/tournaments/");
        const length = Math.min(100, 450 - params.page * 100);
        return { pageInfo: { page: params.page, numEntries: 450 },
            content: Array.from({ length }, (_, index) => event(params.page * 100 + index + 1)) };
    } };
    const first = await advanceSharedJob(createSharedJob("calendar", "global", now), io);
    assert.equal(first.done, false); assert.equal(calls, 4);
    const complete = await finish(first.job, io);
    assert.equal(complete.result.calendar_source.items.length, 450);
    assert.equal(complete.result.calendar_source.from, "2025-12-18");
    assert.equal(complete.result.calendar_source.to, "2027-12-31");
    const bad = { fetchJSON: async (_, params) => ({ pageInfo: { page: params.page, numEntries: 2 }, content: [event()] }) };
    await assert.rejects(finish(createSharedJob("calendar", "global", now), bad), /repeated/);
    await assert.rejects(finish(createSharedJob("calendar", "global", now), { fetchJSON: async () =>
        ({ pageInfo: { page: 0, numEntries: 2 }, content: [] }) }), /incomplete/);
});

test("rankings validate real dateOfBirth/rankedAt fields and never publish partial or repeated pages", async () => {
    const ranked = id => ({ ranking: id, points: 1000 - id, rankedAt: "2026-11-09T00:00:00Z",
        player: { id, fullName: "Player " + id, countryCode: "ARG", dateOfBirth: "2000-01-01" } });
    const io = { fetchJSON: async (path, params) => {
        assert.equal(path, "/api/tennis/players/ranked"); assert.equal(params.metric, "SINGLES");
        assert.equal(params.at, "2026-11-09");
        return Array.from({ length: params.page === 0 ? 100 : 1 }, (_, i) => ranked(params.page * 100 + i + 1));
    } };
    const result = await finish(createSharedJob("players", "global", now), io);
    assert.equal(result.result.rankings.length, 101);
    assert.deepEqual(result.result.rankings[0], { id: "1", name: "Player 1", rank: 1, points: 999, country: "ARG", dob: "2000-01-01" });
    assert.equal(Object.hasOwn(result.result.rankings[0], "best_rank"), false);
    await assert.rejects(finish(createSharedJob("players", "global", now), { fetchJSON: async () =>
        Array.from({ length: 100 }, (_, i) => ranked(i + 1)) }), /repeated/);
    await assert.rejects(finish(createSharedJob("players", "global", now), { fetchJSON: async () =>
        [ranked(1), { ...ranked(2), rankedAt: "2026-11-02T00:00:00Z" }] }), /invalid ranked/);
});

test("one event response supplies results, draws and champions while cached calendar avoids refetch", async () => {
    let calls = 0;
    const io = { cachedCalendar: async () => ({ from: "2026-01-01", to: "2027-12-31", items: [event()] }),
        fetchJSON: async (path, params) => { calls++; assert.equal(path, "/api/tennis/tournaments/1/2026/matches");
            assert.equal(params, undefined); return { matches: [match(), match({ DrawMatchType: "D" })] }; } };
    const { result } = await finish(createSharedJob("matches", "global", now), io);
    assert.equal(calls, 1);
    assert.equal(result.results.matches.length, 1);
    assert.equal(result.draws.tournaments.length, 1);
    assert.equal(result.champions.length, 1);
    assert.equal(result.event_matches[0].matches.length, 1);
    await assert.rejects(finish(createSharedJob("matches", "global", now), { ...io,
        fetchJSON: async () => ({ wrong: [] }) }), /incomplete/);
});

test("player form uses singles history plus shared current matches without duplicate active-event results", async () => {
    let histories = 0, eventCalls = 0;
    const io = { cachedCalendar: async () => ({ from: "2026-01-01", to: "2027-12-31", items: [event()] }),
        fetchJSON: async (path, params) => {
            if (path.endsWith("players/1/matches")) {
                histories++; assert.equal(params.type, "S");
                return { matches: params.year === 2026 ? [
                    { tourn_nbr: 1, tourn_year: 2026, player_1: "1", player_2: "2", StartDate: "2026-11-09", s_d_flag: "S", winner: 2, scores: "6-4 6-4" },
                    { tourn_nbr: 9, tourn_year: 2026, player_1: "1", player_2: "3", StartDate: "2026-10-01", s_d_flag: "S", winner: 2, scores: "6-4 6-4" },
                    { tourn_nbr: 10, tourn_year: 2026, player_1: "1", player_2: "4", StartDate: "2026-10-02", s_d_flag: "D", winner: 1, scores: "6-4 6-4" },
                ] : [] };
            }
            eventCalls++; return { matches: [match()] };
        } };
    const { result } = await finish(createSharedJob("player_form", "1", now), io);
    assert.equal(histories, 2); assert.equal(eventCalls, 1);
    assert.deepEqual(result.results, ["", "", "", "", "", "", "", "", "loss", "win"]);
    assert.equal(result.player_id, "1");
    assert.throws(() => createSharedJob("player_form", "../secrets", now), /Unknown/);
    assert.throws(() => createSharedJob("doubles", "global", now), /Unknown/);
    assert.deepEqual(mergePlayerForm("1", [], [], now), Array(10).fill(""));
});

test("player history follows provider pagination totals even when the provider caps its page size", async () => {
    let calls = 0;
    const io = { cachedCalendar: async () => ({ from: "2026-01-01", to: "2027-12-31", items: [] }),
        fetchJSON: async (_, params) => {
            calls++;
            return { pageInfo: { page: params.page, numEntries: 2 }, matches: [{ tourn_nbr: params.page + 1,
                tourn_year: params.year, player_1: "1", player_2: "2", StartDate: `${params.year}-11-01`,
                s_d_flag: "S", winner: 1, scores: "6-4 6-4" }] };
        } };
    const { result } = await finish(createSharedJob("player_form", "1", now), io);
    assert.equal(calls, 4);
    assert.deepEqual(result.results, ["", "", "", "", "", "", "", "", "win", "win"]);
    await assert.rejects(finish(createSharedJob("player_form", "1", now), { ...io,
        fetchJSON: async (_, params) => ({ pageInfo: { page: params.page, numEntries: 2 }, matches: [] }) }), /incomplete/);
});
