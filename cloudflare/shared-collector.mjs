import { bracketRounds, compactMatches, drawChampion, eligibleTournament, mergePlayerForm, parseMatch } from "./shared-models.mjs";

const DAY = 86400000;
const KINDS = new Set(["calendar", "players", "matches", "player_form"]);
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value;
const isoDate = value => new Date(value).toISOString().slice(0, 10);
const monday = value => {
    const date = new Date(value);
    date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
    return isoDate(date);
};

function madridDate(now) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en", { timeZone: "Europe/Madrid", year: "numeric",
        month: "2-digit", day: "2-digit" }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
    return `${parts.year}-${parts.month}-${parts.day}`;
}

function tournament(item) {
    const group = item?.tournamentGroup, start = String(item?.startDate || "").slice(0, 10), end = String(item?.endDate || "").slice(0, 10);
    if (!group || !/^[1-9]\d*$/.test(String(group.id)) || typeof group.name !== "string" || !group.name.trim() ||
        !/^\d{4}$/.test(String(item.year)) || typeof item.level !== "string" || !item.level ||
        !validDate(start) || !validDate(end) || start > end) throw new Error("WTA returned an invalid tournament.");
    return { tournamentGroup: { id: group.id, name: group.name, metadata: { cancelledSeasons: group.metadata?.cancelledSeasons || "" } },
        year: Number(item.year), level: item.level, startDate: start, endDate: end,
        title: item.title || group.name, city: item.city || "", surface: item.surface || "", country: item.country || "" };
}

function rankedPlayer(row, expectedDate) {
    const player = row?.player, id = String(player?.id || ""), name = player?.fullName ||
        [player?.firstName, player?.lastName].filter(Boolean).join(" ");
    if (!/^[1-9]\d*$/.test(id) || typeof name !== "string" || !name.trim() ||
        !Number.isInteger(row.ranking) || row.ranking <= 0 || !Number.isInteger(row.points) || row.points < 0 ||
        (row.rankedAt && String(row.rankedAt).slice(0, 10) !== expectedDate) ||
        (player.countryCode != null && typeof player.countryCode !== "string")) throw new Error("WTA returned an invalid ranked player.");
    const dob = player.dateOfBirth ? String(player.dateOfBirth).slice(0, 10) : null;
    if (dob && !validDate(dob)) throw new Error("WTA returned an invalid player birth date.");
    return { id, name: name.trim(), country: player.countryCode || "", dob, rank: row.ranking, points: row.points };
}

export function createSharedJob(kind, scope = "global", nowMs = Date.now(), titles = null) {
    if (!KINDS.has(kind) || (kind === "player_form" ? !/^[1-9]\d*$/.test(String(scope)) : scope !== "global") ||
        !Number.isFinite(nowMs)) throw new Error("Unknown shared WTA collection job.");
    const today = madridDate(nowMs), year = Number(today.slice(0, 4));
    const job = { kind, scope: String(scope), started_at: new Date(nowMs).toISOString(), now_ms: nowMs, today,
        stage: kind === "players" ? "rankings" : kind === "calendar" ? "calendar" : "calendar_lookup",
        progress: "Starting shared WTA refresh…" };
    if (kind === "players") return { ...job, ranking_date: monday(today), page: 0, total: null, rankings: [] };
    const created = { ...job, from: kind === "calendar" ? isoDate(Date.UTC(year, 0, 1) - 14 * DAY) : isoDate(nowMs - 30 * DAY),
        to: kind === "calendar" ? `${year + 1}-12-31` : isoDate(nowMs + 2 * DAY),
        page: 0, total: null, calendar_items: [], event_matches: [], index: 0,
        ...(kind === "player_form" ? { history: [], history_years: [new Date(nowMs).getUTCFullYear() - 1,
            new Date(nowMs).getUTCFullYear()], history_index: 0, history_page: 0, history_pages: [],
        history_total: null, history_count: 0 } : {}) };
    if (kind === "matches" && titles) {
        const since = titles.checked_through || `${year}-01-01`;
        if (!validDate(since) || since > today || !Array.isArray(titles.pending) || !Array.isArray(titles.known)) {
            throw new Error("The saved title checkpoint is invalid.");
        }
        const from = isoDate(Date.parse(since + "T00:00:00Z") - 30 * DAY);
        if (from < created.from) created.from = from;
        created.title_scan = { version: 1, since, pending: titles.pending.map(tournament), known: titles.known,
            work: [], index: 0, champions: [], attempted: [] };
    }
    return created;
}

const edition = item => String(item.tournamentGroup.id) + ":" + item.year;
const titleEdition = title => String(title.tournament_id) + ":" + title.year;

function selectEvents(job, source) {
    const firstDay = isoDate(job.now_ms - 2 * DAY), weekStart = monday(isoDate(job.now_ms));
    const earliest = firstDay < weekStart ? firstDay : weekStart;
    const items = source.items.map(tournament);
    if (job.title_scan) {
        const scan = job.title_scan, known = new Set(scan.known);
        const pending = new Map(scan.pending.filter(item => !known.has(edition(item))).map(item => [edition(item), item]));
        for (const item of items) {
            const key = edition(item);
            if (!eligibleTournament(item) || item.endDate > job.today || known.has(key)) pending.delete(key);
            else if (pending.has(key) || item.endDate >= scan.since) pending.set(key, item);
        }
        scan.pending = [...pending.values()];
    }
    return items.filter(item => eligibleTournament(item) && item.startDate <= job.to && item.endDate >= earliest);
}

function completeMatches(job) {
    const now = job.now_ms, today = isoDate(now), matches = new Map(), champions = [...(job.title_scan?.champions || [])];
    const tournaments = [];
    for (const event of job.event_matches) {
        for (const row of event.matches) {
            const match = parseMatch(row, event.tournament, now);
            if (match) matches.set(match.id, match);
        }
        const title = drawChampion(event.tournament, event.matches, now);
        if (title) champions.push(title);
        const item = event.tournament;
        if (item.startDate <= today && item.endDate >= today) tournaments.push({ id: item.tournamentGroup.id + ":" + item.year,
            wta_id: String(item.tournamentGroup.id), year: item.year, name: item.title || item.tournamentGroup.name,
            city: item.city || item.tournamentGroup.name, category: item.level, surface: item.surface,
            start_date: item.startDate, end_date: item.endDate, rounds: bracketRounds(event.matches) });
    }
    tournaments.sort((a, b) => a.category.localeCompare(b.category) || a.city.localeCompare(b.city) || a.id.localeCompare(b.id));
    const result = { results: { updated_at: job.started_at, window_start: new Date(now - DAY).toISOString(),
        matches: [...matches.values()].sort((a, b) => b.completed_at.localeCompare(a.completed_at) || b.id.localeCompare(a.id)) },
    draws: { updated_at: job.started_at, date: today, tournaments }, champions, event_matches: job.event_matches };
    if (job.title_scan) {
        const scan = job.title_scan, confirmed = new Set([...scan.known, ...champions.map(titleEdition)]);
        const attempted = new Set(scan.attempted);
        const pending = scan.pending.filter(item => !confirmed.has(edition(item)));
        result.title_tracking = { version: 1, checked_through: job.today,
            pending: [...pending.filter(item => !attempted.has(edition(item))), ...pending.filter(item => attempted.has(edition(item)))] };
    }
    return result;
}

function compactHistory(rows) {
    const fields = ["tourn_nbr", "tourn_year", "player_1", "player_2", "StartDate", "s_d_flag", "winner", "scores",
        "tourn_round", "round_name", "qpm_flag"];
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
        throw new Error("The WTA player history response is incomplete.");
    }
    return rows.map(row => Object.fromEntries(fields.filter(field => Object.hasOwn(row, field)).map(field => [field, row[field]])));
}

// Counting cache hits too keeps every resumed step within four upstream-request opportunities.
export async function advanceSharedJob(job, io) {
    let requests = 0;
    while (requests < 4) {
        if (job.stage === "calendar_lookup") {
            const cached = await io.cachedCalendar?.(job.from, job.to);
            if (cached && cached.from <= job.from && cached.to >= job.to && Array.isArray(cached.items)) {
                job.tournaments = selectEvents(job, cached);
                job.stage = job.kind === "player_form" ? "history" : "events";
            } else job.stage = "calendar";
        } else if (job.stage === "calendar") {
            const data = await io.fetchJSON("/api/tennis/tournaments/", { from: job.from, to: job.to,
                excludeLevels: "ITF", page: job.page, pageSize: 100 });
            requests++;
            const total = data?.pageInfo?.numEntries;
            if (!Array.isArray(data?.content) || !Number.isInteger(total) || total < 0 || total > 10000 ||
                Number(data.pageInfo.page) !== job.page || (job.total !== null && total !== job.total) ||
                data.content.length > 100 || (!data.content.length && job.calendar_items.length !== total)) {
                throw new Error("The WTA calendar response is incomplete.");
            }
            job.total = total;
            const seen = new Set(job.calendar_items.map(item => item.tournamentGroup.id + ":" + item.year));
            for (const row of data.content) {
                const item = tournament(row), key = item.tournamentGroup.id + ":" + item.year;
                if (seen.has(key)) throw new Error("WTA repeated a calendar tournament.");
                seen.add(key); job.calendar_items.push(item);
            }
            if (job.calendar_items.length > total) throw new Error("The WTA calendar response is incomplete.");
            job.page++;
            job.progress = `Loading shared WTA calendar (page ${job.page})…`;
            if (job.calendar_items.length === total) {
                if (job.kind === "calendar") {
                    job.stage = "complete";
                    return { job, done: true, result: { calendar_source: { from: job.from, to: job.to, items: job.calendar_items } } };
                }
                job.tournaments = selectEvents(job, { items: job.calendar_items });
                job.calendar_items = [];
                job.stage = job.kind === "player_form" ? "history" : "events";
            }
        } else if (job.stage === "rankings") {
            if (job.page >= 100) throw new Error("The WTA rankings response is incomplete.");
            const data = await io.fetchJSON("/api/tennis/players/ranked", { metric: "SINGLES", type: "rankSingles", sort: "asc",
                at: job.ranking_date, page: job.page, pageSize: 100 });
            requests++;
            const rows = Array.isArray(data) ? data : data?.content;
            if (!Array.isArray(rows) || rows.length > 100 || (!job.page && !rows.length)) throw new Error("The WTA rankings are unavailable.");
            if (data?.pageInfo) {
                if (Number(data.pageInfo.page) !== job.page || !Number.isInteger(data.pageInfo.numEntries) ||
                    data.pageInfo.numEntries < 0 || (job.total !== null && data.pageInfo.numEntries !== job.total)) {
                    throw new Error("The WTA rankings response is incomplete.");
                }
                job.total = data.pageInfo.numEntries;
            }
            const found = new Set(job.rankings.map(row => row.id));
            for (const row of rows) {
                const player = rankedPlayer(row, job.ranking_date);
                if (found.has(player.id)) throw new Error("WTA repeated a ranking page.");
                found.add(player.id); job.rankings.push(player);
            }
            if (job.total !== null && (job.rankings.length > job.total || rows.length < 100 && job.rankings.length !== job.total)) {
                throw new Error("The WTA rankings response is incomplete.");
            }
            job.page++;
            job.progress = `Loading shared singles rankings (page ${job.page})…`;
            if (rows.length < 100 || job.rankings.length === job.total) {
                job.stage = "complete";
                return { job, done: true, result: { ranking_date: job.ranking_date, rankings: job.rankings } };
            }
        } else if (job.stage === "history") {
            if (job.history_index === job.history_years.length) { job.stage = "events"; continue; }
            if (job.history_page >= 100) throw new Error("The WTA player history response is incomplete.");
            const year = job.history_years[job.history_index];
            const data = await io.fetchJSON(`/api/tennis/players/${job.scope}/matches`, {
                year, type: "S", page: job.history_page, pageSize: 1000,
            });
            requests++;
            const rows = compactHistory(data?.matches);
            if (rows.length > 1000) throw new Error("The WTA player history response is incomplete.");
            if (data?.pageInfo) {
                const total = data.pageInfo.numEntries;
                if (Number(data.pageInfo.page) !== job.history_page || !Number.isInteger(total) || total < 0 ||
                    (job.history_total !== null && total !== job.history_total)) {
                    throw new Error("The WTA player history response is incomplete.");
                }
                job.history_total = total;
            }
            job.history_count += rows.length;
            if (job.history_total !== null && (job.history_count > job.history_total ||
                !rows.length && job.history_count !== job.history_total)) throw new Error("The WTA player history response is incomplete.");
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(rows)));
            const signature = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
            if (job.history_pages.includes(signature)) throw new Error("WTA repeated a player history page.");
            job.history_pages.push(signature);
            job.history.push(...rows);
            job.history_page++;
            job.progress = `Loading player form (${year}, page ${job.history_page})…`;
            if (job.history_total === null ? rows.length < 1000 : job.history_count === job.history_total) {
                job.history_index++; job.history_page = 0; job.history_pages = [];
                job.history_total = null; job.history_count = 0;
            }
        } else if (job.stage === "events") {
            if (job.index === job.tournaments.length) {
                if (job.title_scan) {
                    const current = new Set(job.tournaments.map(edition));
                    // Two past editions per update keep missing old finals from delaying current feeds.
                    job.title_scan.work = job.title_scan.pending.filter(item => !current.has(edition(item))).slice(0, 2);
                    job.stage = "titles";
                    continue;
                }
                job.stage = "complete";
                return { job, done: true, result: job.kind === "matches" ? completeMatches(job)
                    : { updated_at: job.started_at, player_id: job.scope,
                        results: mergePlayerForm(job.scope, job.history, job.event_matches, job.now_ms) } };
            }
            const item = job.tournaments[job.index];
            const data = await io.fetchJSON(`/api/tennis/tournaments/${item.tournamentGroup.id}/${item.year}/matches`);
            requests++;
            job.event_matches.push({ tournament: item, matches: compactMatches(data?.matches) });
            job.index++;
            job.progress = `Loading shared singles matches (${job.index}/${job.tournaments.length})…`;
        } else if (job.stage === "titles") {
            const scan = job.title_scan;
            if (scan.index === scan.work.length) {
                job.stage = "complete";
                return { job, done: true, result: completeMatches(job) };
            }
            const item = scan.work[scan.index++];
            scan.attempted.push(edition(item));
            requests++;
            try {
                const data = await io.fetchJSON(`/api/tennis/tournaments/${item.tournamentGroup.id}/${item.year}/matches`);
                const title = drawChampion(item, compactMatches(data?.matches), job.now_ms);
                if (title) scan.champions.push(title);
            } catch { /* Keep unavailable or unconfirmed old editions queued without losing current feeds. */ }
            job.progress = `Checking saved title history (${scan.index}/${scan.work.length})…`;
        } else if (job.stage === "complete") {
            throw new Error("A completed shared job must be published before starting another.");
        } else throw new Error("Invalid shared WTA collection stage.");
    }
    return { job, done: false };
}
