import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { createEntryJob } from "./entry-collector.mjs";

const tournament = { tournamentGroup: { id: 1, name: "EXAMPLE" }, year: 2026, level: "WTA 125",
    startDate: "2026-11-09", endDate: "2026-11-15", city: "EXAMPLE" };
const person = (id, name, country = "ARG") => `<article class="tournament-player-card" data-player-name="${name}">
    <a href="/players/${id}/example"><span>${name}</span></a>
    <span class="tournament-player-card__country-text">${country}</span></article>`;
const html = `<div class="tournament-player-list__tab" data-ui-tab="Singles">${person(1, "Main Player")}</div>
    <div class="tournament-player-list__tab" data-ui-tab="Doubles">${person(99, "Doubles Only")}</div>
    <div class="tournament-player-list__tab" data-ui-tab="Qualifying">${person(2, "Qualifier")}</div>`;
const page = (content, index = 0, total = content.length) => ({ pageInfo: { page: index, numEntries: total }, content });
const ranking = (id, rank = id, name = "Player " + id) => ({ player: { id, fullName: name, countryCode: "ARG" }, ranking: rank });
const compact = (id, rank = Number(id)) => ({ id: String(id), name: "Cached " + id, country: "FRA", rank });
let runtime;

test.before(async () => {
    const output = await build({ bundle: true, format: "esm", platform: "browser", write: false,
        stdin: { resolveDir: process.cwd(), contents: `
            import {parseWorkerEntryList, advanceEntryJob} from './cloudflare/entry-collector.mjs';
            export default {async fetch(request) {
                const input = await request.json(), calls = [], saved = {};
                try {
                    if (input.action === 'parse') return Response.json(await parseWorkerEntryList(input.html, input.tournament));
                    const result = await advanceEntryJob(input.job, {
                        async fetchJSON(path, params) {
                            calls.push({path, params});
                            const pages = path.endsWith('/ranked') ? input.rankPages : input.calendarPages;
                            if (!pages?.[params.page]) throw new Error('Unexpected fixture request');
                            return pages[params.page];
                        },
                        async fetchHTML(path) { calls.push({path}); return input.html; },
                        async loadRankings(date) { return input.cache?.[date] || null; },
                        async saveRankings(date, rows) { saved[date] = rows; },
                    });
                    return Response.json({...result, calls, saved});
                } catch (error) { return Response.json({error: error.message, calls, saved}, {status: 422}); }
            }};
        ` } });
    runtime = new Miniflare({ modules: true, script: output.outputFiles[0].text, compatibilityDate: "2026-07-30" });
});
test.after(async () => { await runtime?.dispose(); });

async function run(input) {
    const response = await runtime.dispatchFetch("https://collector.test/", { method: "POST", body: JSON.stringify(input) });
    return { status: response.status, ...await response.json() };
}

test("native Worker parser isolates Singles and Qualifying, preserves accents and reads matching event metadata", async () => {
    const structured = `<script type="application/ld+json">{bad JSON}</script>
        <script type="application/ld+json">${JSON.stringify({ "@type": "SportsEvent", "@id": "/tournaments/99/other", name: "Other event" })}</script>
        <script type="application/ld+json">${JSON.stringify({ "@type": "SportsEvent", "@id": "/tournaments/1/example/2026/player-list", name: "Player page" })}</script>
        <script type="application/ld+json">${JSON.stringify({ "@type": "SportsEvent", "@id": "/tournaments/1/example/2026", name: "Actual Event", startDate: "2026-11-07T12:00:00Z" })}</script>`;
    const result = await run({ action: "parse", tournament, html: structured + html.replace("Main Player", "Léolia Jeanjean") +
        `<div class="tournament-player-list__tab" data-ui-tab="Singles">${person(1, "Léolia Jeanjean")}</div>` });
    assert.equal(result.status, 200);
    assert.deepEqual(result.main, [{ id: "1", name: "Léolia Jeanjean", country: "ARG" }]);
    assert.deepEqual(result.qualifying, [{ id: "2", name: "Qualifier", country: "ARG" }]);
    assert.equal(result.name, "Actual Event");
    assert.equal(result.start, "2026-11-07");
});

test("native parser handles link fallbacks and rejects unrecognized pages without rejecting unpublished lists", async () => {
    const result = await run({ action: "parse", tournament, html: `<div class="tournament-player-list__tab" data-ui-tab="Singles">
        <a href="/players/3/renata-zarazua"><span>Renata Zarazúa</span></a>
        <a href="/players/4/alina-charaeva" aria-label="Alina Charaeva"></a></div>` });
    assert.equal(result.status, 200);
    assert.equal(result.main[0].name, "Renata Zarazúa");
    assert.equal(result.main[1].name, "Alina Charaeva");
    const empty = await run({ action: "parse", tournament, html: '<div class="tournament-player-list__tab" data-ui-tab="Qualifying"></div>' });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.main, []);
    assert.deepEqual(empty.qualifying, []);
    const unknown = await run({ action: "parse", tournament, html: '<div class="tournament-player-list__tab" data-ui-tab="Doubles"></div>' });
    assert.equal(unknown.status, 422);
    assert.match(unknown.error, /unrecognized/);
});

test("native parser decodes player-name attributes and text references consistently", async () => {
    const result = await run({ action: "parse", tournament, html: `<div class="tournament-player-list__tab" data-ui-tab="Singles">
        ${person(5, "Ana &amp; Mar&#237;a")}
        <a href="/players/6/ana-maria">Ana &amp; Mar&#237;a</a></div>` });
    assert.equal(result.status, 200);
    assert.equal(result.main[0].name, "Ana & María");
    assert.equal(result.main[1].name, "Ana & María");
});

test("Madrid date boundaries and weekend tournament weeks use the same four-week window", async () => {
    const job = createEntryJob(Date.parse("2026-11-08T23:15:00Z"));
    assert.equal(job.today, "2026-11-09");
    assert.equal(job.window_start, "2026-11-16");
    assert.equal(job.window_end, "2026-12-14");
    const result = await run({ job, html: '<div class="tournament-player-list__tab" data-ui-tab="Singles"></div>',
        calendarPages: [page([{ ...tournament, startDate: "2026-11-15" },
            { ...tournament, tournamentGroup: { id: 2, name: "CURRENT WEEK" }, startDate: "2026-11-09" },
            { ...tournament, tournamentGroup: { id: 3, name: "CANCELLED", metadata: { cancelledSeasons: "2026" } }, startDate: "2026-11-16" },
            { ...tournament, tournamentGroup: { id: 4, name: "ITF" }, level: "ITF W75", startDate: "2026-11-16" }])] });
    assert.equal(result.status, 200);
    const completed = await run({ job: result.job });
    assert.equal(completed.done, true);
    assert.equal(completed.models.length, 1);
    assert.equal(completed.models[0].week, "2026-11-16");
    assert.equal(completed.models[0].dates.main, "2026-10-19");
});

test("full collection reuses cached deadline dates and saves only complete rankings", async () => {
    const job = createEntryJob(Date.parse("2026-11-05T12:00:00Z"));
    const first = await run({ job, html, calendarPages: [page([tournament])] });
    assert.equal(first.status, 200);
    assert.equal(first.done, false);
    assert.equal(first.calls.filter(call => call.path.startsWith('/site/')).length, 1);
    const result = await run({ job: first.job,
        cache: { "2026-10-12": [compact(1, 10)] }, rankPages: [[ranking(2, 30, "Qualifier Official")]] });
    assert.equal(result.status, 200);
    assert.equal(result.done, true);
    assert.ok(result.calls.length <= 4);
    assert.deepEqual(result.models[0].main, [compact(1, 10)]);
    assert.deepEqual(result.models[0].qualifying, [{ id: "2", name: "Qualifier Official", country: "ARG", rank: 30 }]);
    const ranked = result.calls.filter(call => call.path.endsWith("/ranked"));
    assert.equal(ranked.length, 1);
    assert.equal(ranked[0].params.at, "2026-10-19");
    assert.equal(ranked[0].params.metric, "SINGLES");
    assert.deepEqual(Object.keys(result.saved), ["2026-10-19"]);
});

function rankingJob() {
    return { ...createEntryJob(Date.parse("2026-11-05T12:00:00Z")), stage: "rankings", ranking_dates: ["2026-10-12"],
        models: [{ id: "EXAMPLE", label: "Example", name: "Example", week: "2026-11-09", dates: { main: "2026-10-12" },
            main: [{ id: "1", name: "Main Player", country: "ARG" }, { id: "9999", name: "Unranked", country: "URU" }], qualifying: [] }] };
}

test("large ranking collections resume from JSON across invocations without exceeding four upstream requests", async () => {
    const pages = Array.from({ length: 6 }, (_, p) => Array.from({ length: p === 5 ? 1 : 100 }, (_, i) => ranking(p * 100 + i + 1)));
    const first = await run({ job: rankingJob(), rankPages: pages });
    assert.equal(first.status, 200);
    assert.equal(first.done, false);
    assert.equal(first.calls.length, 4);
    assert.equal(first.job.ranking_page, 4);
    assert.equal(first.job.ranking_rows.length, 400);
    assert.deepEqual(first.saved, {});
    const second = await run({ job: JSON.parse(JSON.stringify(first.job)), rankPages: pages });
    assert.equal(second.status, 200);
    assert.equal(second.done, true);
    assert.equal(second.calls.length, 2);
    assert.equal(second.saved["2026-10-12"].length, 501);
    assert.equal(second.models[0].main[0].rank, 1);
    assert.equal(second.models[0].main[1].rank, null);
    assert.equal(second.job.ranking_rows.length, 0);
});

test("repeated or truncated ranking pages never become a completed cached date", async () => {
    const hundred = Array.from({ length: 100 }, (_, i) => ranking(i + 1));
    const repeated = await run({ job: rankingJob(), rankPages: [hundred, hundred] });
    assert.equal(repeated.status, 422);
    assert.match(repeated.error, /repeated/);
    assert.deepEqual(repeated.saved, {});
    const truncated = await run({ job: rankingJob(), rankPages: [page(hundred, 0, 250),
        page(Array.from({ length: 50 }, (_, i) => ranking(i + 101)), 1, 250)] });
    assert.equal(truncated.status, 422);
    assert.match(truncated.error, /incomplete/);
    assert.deepEqual(truncated.saved, {});
});

test("cached rankings are validated and the existing country correction is preserved", async () => {
    const good = await run({ job: rankingJob(), cache: { "2026-10-12": [{ ...compact(1), name: "Catherine Harrison", country: "AUS" }] } });
    assert.equal(good.status, 200);
    assert.equal(good.models[0].main[0].country, "USA");
    const bad = await run({ job: rankingJob(), cache: { "2026-10-12": [compact(1), compact(1)] } });
    assert.equal(bad.status, 422);
    assert.match(bad.error, /cached rankings/);
});

test("empty calendars are valid but pagination truncation and malformed WTA identities fail", async () => {
    const empty = await run({ job: createEntryJob(), calendarPages: [page([])] });
    assert.equal(empty.status, 200);
    assert.equal(empty.done, true);
    assert.deepEqual(empty.models, []);
    const truncated = await run({ job: createEntryJob(), calendarPages: [page([], 0, 2)] });
    assert.equal(truncated.status, 422);
    assert.match(truncated.error, /incomplete/);
    const malformed = await run({ job: createEntryJob(), calendarPages: [page([{ ...tournament,
        tournamentGroup: { id: "../../bad", name: "BAD" } }])] });
    assert.equal(malformed.status, 422);
    assert.match(malformed.error, /identity/);
});

test("calendar pagination also yields after four upstream requests", async () => {
    const pages = Array.from({ length: 5 }, (_, index) => page(Array.from({ length: 100 }, () => ({ level: "ITF" })), index, 500));
    const first = await run({ job: createEntryJob(), calendarPages: pages });
    assert.equal(first.status, 200);
    assert.equal(first.done, false);
    assert.equal(first.calls.length, 4);
    assert.equal(first.job.calendar_page, 4);
    const second = await run({ job: first.job, calendarPages: pages });
    assert.equal(second.status, 200);
    assert.equal(second.calls.length, 1);
    assert.equal(second.done, true);
    assert.deepEqual(second.models, []);
});
