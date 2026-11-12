import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare } from "miniflare";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const text = value => typeof value === "string" && value.trim().length > 0;
const id = value => typeof value === "string" && /^\d+$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const rank = value => Number.isSafeInteger(value) && value > 0;
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const timestamp = value => typeof value === "string" && /T.*(?:Z|\+00:00)$/.test(value) && Number.isFinite(Date.parse(value));
const check = (condition, message) => { if (!condition) throw new Error(message); };
const titleKey = title => title.tournament_id + ":" + title.year;
const tourTitle = title => !["WTA 125", "125K"].includes(title.category);
const titleOrder = title => [title.end_date, title.start_date, title.tournament_id].join("|");

function titleSummaries(titles) {
    const summaries = new Map();
    for (const title of titles) {
        const summary = summaries.get(title.champion.id) || { count: 0, ids: [], tour: null, wta125: null };
        const kind = tourTitle(title) ? "tour" : "wta125";
        if (kind === "tour") { summary.count++; summary.ids.push(titleKey(title)); }
        if (!summary[kind] || titleOrder(title) > titleOrder(summary[kind])) summary[kind] = title;
        summaries.set(title.champion.id, summary);
    }
    return summaries;
}

export function validateBundle(bundle) {
    check(object(bundle) && bundle.schema_version === 1 && timestamp(bundle.prepared_at), "Invalid import bundle/version/time.");
    check(object(bundle.players) && date(bundle.players.snapshot_date) && Array.isArray(bundle.players.players) &&
        bundle.players.players.length > 0, "Missing player snapshot.");
    const playerIds = new Set();
    for (const player of bundle.players.players) {
        check(object(player) && id(player.id) && !playerIds.has(player.id), "Invalid or repeated player ID.");
        playerIds.add(player.id);
        check(text(player.name) && text(player.display_name) && typeof player.country === "string" && date(player.dob) &&
            player.dob <= bundle.players.snapshot_date && Array.isArray(player.aliases) && player.aliases.every(text),
        "Invalid player profile: " + player.id);
        check((player.rank === null || rank(player.rank)) && (player.previous_rank === null || rank(player.previous_rank)) &&
            integer(player.points) && rank(player.last_rank) && date(player.last_rank_date) &&
            player.last_rank_date <= bundle.players.snapshot_date && rank(player.best_rank) &&
            player.best_rank <= player.last_rank && Number.isInteger(player.best_rank_year) && player.best_rank_year >= 1900 &&
            player.best_rank_year <= Number(bundle.players.snapshot_date.slice(0, 4)) &&
            (player.rank === null || player.last_rank_date === bundle.players.snapshot_date),
        "Invalid ranking baseline: " + player.id);
    }
    const names = bundle.players.player_names;
    check(object(names) && object(names.by_wta_id) && object(names.by_name), "Missing curated name index.");
    for (const [key, value] of Object.entries(names.by_wta_id)) check(id(key) && text(value), "Invalid WTA name index.");
    for (const [key, value] of Object.entries(names.by_name)) check(text(key) && text(value), "Invalid alias index.");

    check(object(bundle.champions) && Array.isArray(bundle.champions.champions), "Missing champion history.");
    const editions = new Set();
    for (const title of bundle.champions.champions) {
        check(object(title) && id(title.tournament_id) && Number.isInteger(title.year) && title.year >= 1900 && title.year <= 9999 &&
            object(title.champion) && id(title.champion.id) && text(title.champion.name) && text(title.category) &&
            date(title.start_date) && date(title.end_date) && title.start_date <= title.end_date,
        "Invalid title record.");
        check(!editions.has(titleKey(title)), "Repeated tournament title: " + titleKey(title));
        editions.add(titleKey(title));
    }
    check(bundle.champions.champion_count === bundle.champions.champions.length, "Champion count does not match saved records.");
    const summaries = titleSummaries(bundle.champions.champions);
    for (const player of bundle.players.players) {
        const summary = summaries.get(player.id) || { count: 0, ids: [] };
        assert.deepEqual(player.tour_title_count, summary.count, "Title count differs for player " + player.id);
        assert.deepEqual(player.tour_title_ids, summary.ids, "Title IDs differ for player " + player.id);
        assert.deepEqual(player.latest_title, summary.tour || summary.wta125 || null, "Latest title differs for player " + player.id);
    }

    const calendar = bundle.calendar;
    check(object(calendar) && Array.isArray(calendar.fields) && object(calendar.weeks) &&
        calendar.fields.every(text) && new Set(calendar.fields).size === calendar.fields.length &&
        ["name", "level", "startDate", "endDate", "calendarKey"].every(field => calendar.fields.includes(field)), "Invalid calendar fields.");
    const calendarKeys = new Set();
    for (const [week, rows] of Object.entries(calendar.weeks)) {
        check(date(week) && Array.isArray(rows), "Invalid calendar week.");
        for (const row of rows) {
            check(Array.isArray(row) && row.length === calendar.fields.length, "Invalid calendar row shape.");
            const item = Object.fromEntries(calendar.fields.map((field, index) => [field, row[index]]));
            const start = String(item.startDate).slice(0, 10), end = String(item.endDate).slice(0, 10);
            check(text(item.name) && text(item.level) && text(item.calendarKey) && date(start) && date(end) && start <= end &&
                !calendarKeys.has(item.calendarKey), "Invalid or repeated calendar record: " + item.calendarKey);
            calendarKeys.add(item.calendarKey);
        }
    }
    check(Array.isArray(bundle.sources) && bundle.sources.length > 0 && bundle.sources.every(source => object(source) &&
        text(source.path) && /^[a-f0-9]{64}$/.test(source.sha256) && integer(source.bytes)), "Invalid source manifest.");
    return { players: playerIds.size, titles: editions.size, calendar_rows: calendarKeys.size,
        name_ids: Object.keys(names.by_wta_id).length, aliases: Object.keys(names.by_name).length };
}

const definitions = {
    wta_players: { columns: ["player_id", "profile_json", "updated_at"], keys: 1 },
    wta_titles: { columns: ["tournament_id", "year", "champion_id", "end_date", "title_json"], keys: 2 },
    wta_snapshots: { columns: ["kind", "scope", "payload_json", "fetched_at", "expires_at"], keys: 2 },
};

export function buildImportPlan(bundle) {
    const counts = validateBundle(bundle);
    const statements = [];
    const add = (table, params) => {
        const { columns, keys } = definitions[table];
        const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")}) ` +
            `ON CONFLICT (${columns.slice(0, keys).join(", ")}) DO UPDATE SET ` +
            columns.slice(keys).map(column => `${column} = excluded.${column}`).join(", ");
        check(Buffer.byteLength(sql) <= 100000 && params.length <= 100 &&
            params.reduce((sum, value) => sum + (typeof value === "string" ? Buffer.byteLength(value) : 8), 0) <= 2000000,
        "Import record exceeds D1 query or row limits: " + table);
        statements.push({ table, sql, params });
    };
    for (const player of bundle.players.players) add("wta_players", [player.id, JSON.stringify(player), bundle.prepared_at]);
    for (const title of bundle.champions.champions) add("wta_titles", [title.tournament_id, title.year,
        title.champion.id, title.end_date, JSON.stringify(title)]);
    const { champions, ...championMetadata } = bundle.champions;
    for (const [kind, scope, payload] of [["players", "metadata", { snapshot_date: bundle.players.snapshot_date }],
        ["player_names", "global", bundle.players.player_names], ["calendar", "global", bundle.calendar],
        ["champions", "metadata", championMetadata]]) {
        add("wta_snapshots", [kind, scope, JSON.stringify(payload), bundle.prepared_at, null]);
    }
    return { schema_version: 1, prepared_at: bundle.prepared_at, ranking_date: bundle.players.snapshot_date,
        sources: bundle.sources, counts, statements };
}

export async function applyImportPlan(db, plan) {
    // Local baseline rehearsal only: retries may fill identical rows, never replace different shared data.
    check((await db.prepare("SELECT count(*) AS count FROM wta_refresh_state").first()).count === 0,
        "Refusing baseline import while shared refresh state exists.");
    for (const [table, { columns, keys }] of Object.entries(definitions)) {
        const expected = new Map(plan.statements.filter(statement => statement.table === table)
            .map(statement => [JSON.stringify(statement.params.slice(0, keys)), Object.fromEntries(columns.map((column, index) =>
                [column, statement.params[index]]))]));
        const existing = (await db.prepare(`SELECT * FROM ${table}`).all()).results;
        for (const row of existing) {
            const key = JSON.stringify(columns.slice(0, keys).map(column => row[column]));
            assert.deepEqual(row, expected.get(key), "Refusing to replace existing shared data in " + table);
        }
    }
    for (let start = 0; start < plan.statements.length; start += 100) {
        await db.batch(plan.statements.slice(start, start + 100).map(statement => db.prepare(statement.sql).bind(...statement.params)));
    }
}

export async function verifyImport(db, bundle) {
    const players = (await db.prepare("SELECT player_id, profile_json FROM wta_players").all()).results;
    const titles = (await db.prepare("SELECT tournament_id, year, champion_id, end_date, title_json FROM wta_titles").all()).results;
    const snapshots = (await db.prepare("SELECT kind, scope, payload_json FROM wta_snapshots").all()).results;
    const compare = (actual, expected) => assert.deepEqual(new Map(actual), new Map(expected));
    compare(players.map(row => [row.player_id, JSON.parse(row.profile_json)]), bundle.players.players.map(player => [player.id, player]));
    compare(titles.map(row => [row.tournament_id + ":" + row.year,
        { champion_id: row.champion_id, end_date: row.end_date, title: JSON.parse(row.title_json) }]),
    bundle.champions.champions.map(title => [titleKey(title),
        { champion_id: title.champion.id, end_date: title.end_date, title }]));
    const saved = new Map(snapshots.map(row => [row.kind + ":" + row.scope, JSON.parse(row.payload_json)]));
    assert.deepEqual(saved.get("player_names:global"), bundle.players.player_names);
    assert.deepEqual(saved.get("calendar:global"), bundle.calendar);
    assert.deepEqual(saved.get("players:metadata"), { snapshot_date: bundle.players.snapshot_date });
    const { champions, ...championMetadata } = bundle.champions;
    assert.deepEqual(saved.get("champions:metadata"), championMetadata);
    const counts = new Map((await db.prepare("SELECT champion_id, count(*) AS count FROM wta_titles " +
        "WHERE json_extract(title_json, '$.category') NOT IN ('WTA 125', '125K') GROUP BY champion_id").all()).results
        .map(row => [row.champion_id, row.count]));
    const latest = new Map((await db.prepare("SELECT champion_id, title_json FROM (SELECT champion_id, title_json, " +
        "row_number() OVER (PARTITION BY champion_id ORDER BY " +
        "CASE WHEN json_extract(title_json, '$.category') IN ('WTA 125', '125K') THEN 1 ELSE 0 END, " +
        "end_date DESC, json_extract(title_json, '$.start_date') DESC, tournament_id DESC) AS position FROM wta_titles) " +
        "WHERE position = 1").all()).results.map(row => [row.champion_id, JSON.parse(row.title_json)]));
    for (const player of bundle.players.players) {
        assert.equal(counts.get(player.id) || 0, player.tour_title_count, "SQL title count differs for " + player.id);
        assert.deepEqual(latest.get(player.id) || null, player.latest_title, "SQL latest title differs for " + player.id);
    }
    return { ...validateBundle(bundle), snapshots: snapshots.length, roundtrip_verified: true, title_statistics_verified: true };
}

export async function prepareLocalImport(bundle, outputDirectory) {
    const plan = buildImportPlan(bundle);
    const mf = new Miniflare({ script: "export default { fetch() { return new Response('local import only'); } }", modules: true,
        compatibilityDate: "2026-07-30", d1Databases: { TEST_DB: "shared-import-rehearsal" } });
    let verified;
    try {
        const db = await mf.getD1Database("TEST_DB");
        for (const name of ["schema.sql", "shared-schema.sql"]) {
            const schema = await readFile(new URL(name, import.meta.url), "utf8");
            for (const statement of schema.split(";").filter(value => value.trim())) await db.prepare(statement).run();
        }
        const before = (await db.prepare("SELECT * FROM entry_list_state").all()).results;
        await applyImportPlan(db, plan);
        verified = await verifyImport(db, bundle);
        assert.deepEqual((await db.prepare("SELECT * FROM entry_list_state").all()).results, before);
        assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_ranking_cache").first()).count, 0);
        assert.equal((await db.prepare("SELECT count(*) AS count FROM entry_legacy_history").first()).count, 0);
    } finally { await mf.dispose(); }
    const report = { schema_version: 1, prepared_at: bundle.prepared_at, ranking_date: bundle.players.snapshot_date,
        ...verified, source_files: bundle.sources.length, statements: plan.statements.length,
        largest_bound_payload_bytes: Math.max(...plan.statements.flatMap(statement => statement.params
            .filter(value => typeof value === "string").map(value => Buffer.byteLength(value)))),
        entry_lists_preserved: true, local_only: true,
        timestamp_note: "Feed timestamps mark local import preparation, not a new WTA fetch; source snapshot dates and coverage are preserved." };
    await mkdir(outputDirectory, { recursive: true });
    await writeFile(path.join(outputDirectory, "import-plan.json"), JSON.stringify(plan, null, 2) + "\n");
    await writeFile(path.join(outputDirectory, "verification-report.json"), JSON.stringify(report, null, 2) + "\n");
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const [input, output, ...extra] = process.argv.slice(2);
        check(input && output && !extra.length, "Usage: node cloudflare/prepare-shared-import.mjs <bundle.json> <output-directory>");
        const report = await prepareLocalImport(JSON.parse(await readFile(input, "utf8")), output);
        console.log(JSON.stringify(report, null, 2));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
