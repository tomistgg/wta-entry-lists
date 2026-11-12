import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeHTML } from "entities";
import { monday } from "../entry-lists.mjs";
import { createEntryJob } from "./entry-collector.mjs";

const quoteSQL = value => "'" + value.replaceAll("'", "''") + "'";
const validDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export function normalizeLegacyHistory(source, nowMs = Date.now()) {
    if (!Array.isArray(source)) throw new Error("Active history must be an array of tournament editions.");
    const window = createEntryJob(nowMs);
    const editions = new Set();
    return source.flatMap(record => {
        const tournamentId = record?.tournament_id;
        if (typeof tournamentId !== "string" || !/^[\p{Lu}\p{N}_]+$/u.test(tournamentId) || tournamentId.length > 256 ||
            !validDate(record.week) || monday(record.week) !== record.week || !validDate(record.deadline) ||
            record.deadline > record.week || !Array.isArray(record.rows)) throw new Error("Invalid active tournament history.");
        const key = tournamentId + ":" + record.week;
        if (editions.has(key)) throw new Error("Repeated tournament edition: " + key);
        editions.add(key);
        if (record.week < window.window_start || record.week >= window.window_end) return [];
        const occurrences = new Map();
        const events = record.rows.flatMap((row, index) => {
            const invalid = () => new Error(`Invalid active history row: ${key}[${index}]`);
            if (!row || !validDate(row.date) || typeof row.change !== "string") throw invalid();
            const parsed = /^<strong>([^<>]*)<\/strong>\s+(added to|removed from)\s+(Main Draw|Qualifying)\s*$/.exec(row.change);
            if (!parsed) throw invalid();
            const name = decodeHTML(parsed[1]).trim();
            if (!name) throw invalid();
            if (row.date < record.deadline || row.date > window.today) return [];
            const draw = parsed[3] === "Main Draw" ? "main" : "qualifying";
            const action = parsed[2] === "added to" ? "added" : "removed";
            const identity = JSON.stringify([tournamentId, record.week, row.date, draw, action, name]);
            const occurrence = occurrences.get(identity) || 0;
            occurrences.set(identity, occurrence + 1);
            const id = "legacy:" + createHash("sha256").update(JSON.stringify([identity, occurrence])).digest("hex");
            return [{ id, at: row.date + "T00:00:00.000Z", date: row.date, draw, action,
                player_id: null, name, source: "legacy" }];
        });
        return events.length ? [{ tournament_id: tournamentId, week: record.week, events }] : [];
    });
}

export function buildLegacyHistorySQL(source, nowMs = Date.now()) {
    const statements = ["CREATE TABLE IF NOT EXISTS entry_legacy_history " +
        "(tournament_id TEXT NOT NULL, week TEXT NOT NULL, rows_json TEXT NOT NULL, PRIMARY KEY (tournament_id, week));"];
    for (const record of normalizeLegacyHistory(source, nowMs)) {
        const id = quoteSQL(record.tournament_id), week = quoteSQL(record.week);
        const statement = "INSERT INTO entry_legacy_history (tournament_id, week, rows_json) " +
            `SELECT ${id}, ${week}, ${quoteSQL(JSON.stringify(record.events))} ` +
            "WHERE EXISTS (SELECT 1 FROM entry_list_state AS state, json_each(state.snapshot, '$.models') AS model " +
            `WHERE state.id = 1 AND json_extract(model.value, '$.id') = ${id} AND json_extract(model.value, '$.week') = ${week}) ` +
            "ON CONFLICT(tournament_id, week) DO UPDATE SET rows_json = excluded.rows_json;";
        if (Buffer.byteLength(statement) > 60000) throw new Error("Active history exceeds the one-time import limit.");
        statements.push(statement);
    }
    return statements.join("\n") + "\n";
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [sourcePath, outputPath, ...extra] = process.argv.slice(2);
    if (!sourcePath || !outputPath || extra.length) {
        console.error("Usage: node cloudflare/import-legacy-history.mjs <active-history.json> <output.sql>");
        process.exitCode = 1;
    } else {
        try {
            const source = JSON.parse(readFileSync(sourcePath, "utf8"));
            const nowMs = Date.now();
            const history = normalizeLegacyHistory(source, nowMs);
            writeFileSync(outputPath, buildLegacyHistorySQL(source, nowMs));
            console.log(`Prepared ${history.length} active tournaments and ${history.reduce((count, record) => count + record.events.length, 0)} Changes.`);
        } catch (error) {
            console.error(error.message);
            process.exitCode = 1;
        }
    }
}
