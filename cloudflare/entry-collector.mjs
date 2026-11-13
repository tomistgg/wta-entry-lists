import { addDays, monday, rankingDates, slug } from "../entry-lists.mjs";
import { decodeHTML } from "entities";

const LEVELS = new Set(["WTA 125", "WTA 250", "WTA 500", "WTA 1000", "Finals", "WTA Finals", "Grand Slam"]);
const titleCase = value => String(value).toLowerCase().replace(/(^|[\s'-])\p{L}/gu, letter => letter.toUpperCase());
const legacyId = label => label.replaceAll(" ", "_").replaceAll(".", "").replaceAll("-", "_").replaceAll("'", "").toUpperCase();
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date;

export function createEntryJob(nowMs = Date.now()) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
        timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(nowMs)).map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const start = addDays(monday(today), 7);
    return { started_at: new Date(nowMs).toISOString(), today, window_start: start, window_end: addDays(start, 28),
        stage: "calendar", progress: "Loading WTA calendar…", calendar_page: 0, calendar_count: 0,
        calendar_total: null, tournaments: [], entry_index: 0, models: [], ranking_dates: [], ranking_index: 0,
        ranking_page: 0, ranking_rows: [], ranking_total: null };
}

export async function parseWorkerEntryList(html, tournament) {
    const lists = { Singles: new Map(), Qualifying: new Map() };
    const events = [];
    let section = null, card = null, link = null, jsonText = null, recognized = false;
    const save = (item, target, country) => {
        const match = /^\/players\/(\d+)\/([^/?#]+)/.exec(item.href || "");
        if (!match || !lists[target]) return;
        const name = decodeHTML(item.name || item.label || item.text.trim() || titleCase(match[2].replaceAll("-", " ")));
        lists[target].set(match[1], { id: match[1], name, country: decodeHTML(country).trim() || "-" });
    };
    const rewriter = new HTMLRewriter()
        .on(".tournament-player-list__tab[data-ui-tab]", {
            element(element) {
                const previous = section;
                section = element.getAttribute("data-ui-tab");
                if (lists[section]) recognized = true;
                element.onEndTag(() => { section = previous; });
            },
        })
        .on(".tournament-player-card", {
            element(element) {
                const previous = card;
                const current = { name: element.getAttribute("data-player-name") || "", country: "", links: [], section };
                card = current;
                element.onEndTag(() => {
                    for (const item of current.links) save(item, current.section, current.country);
                    card = previous;
                });
            },
        })
        .on('a[href^="/players/"]', {
            element(element) {
                const previous = link;
                const current = { href: element.getAttribute("href"), name: card?.name || "",
                    label: element.getAttribute("aria-label") || "", text: "", section, card };
                link = current;
                if (card) card.links.push(current);
                element.onEndTag(() => {
                    if (!current.card) save(current, current.section, "-");
                    link = previous;
                });
            },
            text(chunk) { if (link) link.text += chunk.text; },
        })
        .on(".tournament-player-card__country-text", {
            text(chunk) { if (card) card.country += chunk.text; },
        })
        .on('script[type="application/ld+json"]', {
            element(element) {
                jsonText = "";
                element.onEndTag(() => {
                    try {
                        const event = JSON.parse(jsonText);
                        if (event?.["@type"] === "SportsEvent" &&
                            String(event["@id"] || "").includes(`/tournaments/${tournament.tournamentGroup.id}/`)) events.push(event);
                    } catch { /* Ignore unrelated or invalid structured page metadata. */ }
                    jsonText = null;
                });
            },
            text(chunk) { if (jsonText !== null) jsonText += chunk.text; },
        });
    await rewriter.transform(new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })).text();
    if (!recognized) throw new Error("WTA returned an unrecognized entry-list page.");
    const event = events.find(item => !String(item["@id"]).includes("player-list")) || events[0];
    const start = String(event?.startDate || tournament.startDate).slice(0, 10);
    if (!validDate(start)) throw new Error("WTA returned an invalid tournament date.");
    return { main: [...lists.Singles.values()], qualifying: [...lists.Qualifying.values()], start,
        name: event?.name || tournament.title || tournament.tournamentGroup.name };
}

function calendarTournament(tournament, job) {
    if (!LEVELS.has(tournament?.level)) return null;
    const group = tournament.tournamentGroup;
    if (!group || !/^\d+$/.test(String(group.id)) || typeof group.name !== "string" ||
        !/^\d{4}$/.test(String(tournament.year))) throw new Error("WTA returned an invalid tournament identity.");
    if (String(group.metadata?.cancelledSeasons || "").includes(String(tournament.year))) return null;
    const start = String(tournament.startDate).slice(0, 10);
    if (!validDate(start)) throw new Error("WTA returned an invalid tournament date.");
    const week = [0, 6].includes(new Date(start).getUTCDay()) ? addDays(monday(start), 7) : monday(start);
    if (week < job.window_start || week >= job.window_end) return null;
    return { tournamentGroup: { id: group.id, name: group.name }, year: tournament.year,
        level: tournament.level, startDate: start, title: tournament.title || group.name, city: tournament.city || "", week };
}

function compactRanking(row) {
    const id = String(row?.player?.id || "");
    if (!/^\d+$/.test(id) || (row.player.fullName != null && typeof row.player.fullName !== "string") ||
        (row.player.countryCode != null && typeof row.player.countryCode !== "string")) {
        throw new Error("WTA returned an invalid ranked player.");
    }
    return { id, name: String(row.player.fullName || ""), country: String(row.player.countryCode || "-"),
        rank: Number(row.ranking) > 0 ? Number(row.ranking) : null };
}

function applyRankings(job, date, rows) {
    if (!Array.isArray(rows) || !rows.length) throw new Error("The WTA deadline-week rankings are unavailable.");
    const ranked = new Map(rows.map(row => [row.id, row]));
    if (ranked.size !== rows.length || rows.some(row => !/^\d+$/.test(row.id) || typeof row.name !== "string" ||
        typeof row.country !== "string" || (row.rank !== null && !(Number.isFinite(row.rank) && row.rank > 0)))) {
        throw new Error("WTA returned invalid cached rankings.");
    }
    for (const model of job.models) {
        for (const side of ["main", "qualifying"]) {
            if (model.dates[side] !== date) continue;
            model[side] = model[side].map(player => {
                const row = ranked.get(player.id);
                const name = row?.name || player.name;
                return { id: player.id, name, country: name.toUpperCase() === "CATHERINE HARRISON"
                    ? "USA" : row?.country && row.country !== "-" ? row.country : player.country || "-", rank: row?.rank ?? null };
            }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
        }
    }
}

// Each call makes at most four WTA requests; the JSON job resumes in the next Worker invocation.
export async function advanceEntryJob(job, io) {
    let requests = 0;
    while (requests < 4) {
        if (job.stage === "calendar") {
            const page = job.calendar_page;
            const data = await io.fetchJSON("/api/tennis/tournaments/", {
                from: addDays(job.window_start, -7), to: job.window_end, excludeLevels: "ITF", pageSize: 100, page,
            });
            requests++;
            const total = data?.pageInfo?.numEntries;
            if (!Array.isArray(data?.content) || !Number.isInteger(total) || total < 0 || total > 10000 ||
                Number(data.pageInfo.page) !== page || (job.calendar_total !== null && job.calendar_total !== total)) {
                throw new Error("The WTA calendar response is incomplete.");
            }
            job.calendar_total = total;
            job.calendar_count += data.content.length;
            if (job.calendar_count > total || (!data.content.length && job.calendar_count !== total)) {
                throw new Error("The WTA calendar response is incomplete.");
            }
            for (const item of data.content) {
                const tournament = calendarTournament(item, job);
                if (tournament) job.tournaments.push(tournament);
            }
            job.calendar_page++;
            if (job.calendar_count === total) {
                job.tournaments = [...new Map(job.tournaments.map(item => [item.tournamentGroup.id + ":" + item.year, item])).values()];
                job.stage = "entries";
            }
        } else if (job.stage === "entries") {
            if (job.entry_index === job.tournaments.length) {
                job.ranking_dates = [...new Set(job.models.flatMap(model => ["main", "qualifying"]
                    .filter(side => model[side].length).map(side => model.dates[side])))].sort();
                job.stage = "rankings";
                continue;
            }
            const tournament = job.tournaments[job.entry_index], group = tournament.tournamentGroup;
            const path = `/site/tournaments/${group.id}/${slug(group.name)}/${tournament.year}/player-list`;
            const parsed = await parseWorkerEntryList(await io.fetchHTML(path), tournament);
            requests++;
            const edition = /#\s*(\S+)/.exec(group.name)?.[1];
            const label = tournament.level + " " + titleCase(tournament.city || group.name) + (edition ? " " + edition : "");
            job.models.push({ id: legacyId(label), label, week: tournament.week, name: parsed.name,
                dates: rankingDates(parsed.start, job.today), main: parsed.main, qualifying: parsed.qualifying });
            job.entry_index++;
            job.progress = `Loading WTA entry lists (${job.entry_index}/${job.tournaments.length})…`;
            // WTA HTML pages can approach a megabyte; parse one per invocation to bound CPU work.
            return { job, done: false };
        } else if (job.stage === "rankings") {
            if (job.ranking_index === job.ranking_dates.length) {
                job.models.sort((a, b) => a.week.localeCompare(b.week) || a.label.localeCompare(b.label));
                job.stage = "complete";
                job.progress = "Entry lists are ready to save.";
                return { job, done: true, models: job.models };
            }
            const date = job.ranking_dates[job.ranking_index];
            if (!job.ranking_page) {
                const cached = await io.loadRankings(date);
                if (cached) {
                    applyRankings(job, date, cached);
                    job.ranking_index++;
                    continue;
                }
            }
            const page = job.ranking_page;
            if (page >= 100) throw new Error("The WTA rankings response is incomplete.");
            const data = await io.fetchJSON("/api/tennis/players/ranked", {
                metric: "SINGLES", type: "rankSingles", sort: "asc", at: date, pageSize: 100, page,
            });
            requests++;
            const rows = Array.isArray(data) ? data : data?.content;
            if (!Array.isArray(rows) || (!page && !rows.length) || rows.length > 100) {
                throw new Error("The WTA deadline-week rankings are unavailable.");
            }
            if (data?.pageInfo) {
                const total = data.pageInfo.numEntries;
                if (Number(data.pageInfo.page) !== page || !Number.isInteger(total) || total < 0 ||
                    (job.ranking_total !== null && job.ranking_total !== total)) throw new Error("The WTA rankings response is incomplete.");
                job.ranking_total = total;
            }
            const found = new Set(job.ranking_rows.map(row => row.id));
            for (const row of rows) {
                const player = compactRanking(row);
                if (found.has(player.id)) throw new Error("WTA returned incomplete or repeated ranking pages.");
                found.add(player.id);
                job.ranking_rows.push(player);
            }
            const count = job.ranking_rows.length;
            if (job.ranking_total !== null && (count > job.ranking_total ||
                (rows.length < 100 && count !== job.ranking_total))) throw new Error("The WTA rankings response is incomplete.");
            job.ranking_page++;
            job.progress = `Loading deadline-week rankings (${job.ranking_index + 1}/${job.ranking_dates.length}, page ${job.ranking_page})…`;
            if (rows.length < 100 || count === job.ranking_total) {
                await io.saveRankings(date, job.ranking_rows);
                applyRankings(job, date, job.ranking_rows);
                job.ranking_index++;
                job.ranking_page = 0;
                job.ranking_rows = [];
                job.ranking_total = null;
            }
        } else if (job.stage === "complete") return { job, done: true, models: job.models };
        else throw new Error("Invalid entry-list refresh stage.");
    }
    return { job, done: false };
}
