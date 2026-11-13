// Server-side equivalents of the existing Haute Cadence singles transforms.
const DAY = 86400000;
const LEVELS = new Set(["WTA 125", "WTA 250", "WTA 500", "WTA 1000", "Finals", "WTA Finals", "Grand Slam"]);
const ROUNDS = {
    "1": ["1st Round", "premier"], "2": ["2nd Round", "deuxieme"], "3": ["3rd Round", "troisieme"],
    Q: ["Quarterfinals", "quartdefinale"], S: ["Semifinals", "demifinale"], F: ["Final", "finale"],
};
const EXTRA = { "4": "QUATRIÈME TOUR", "5": "CINQUIÈME TOUR", R: "PHASE DE GROUPES", RR: "PHASE DE GROUPES" };

export function eligibleTournament(tournament) {
    const group = tournament.tournamentGroup;
    return LEVELS.has(tournament.level) && group?.id &&
        !String(group.metadata?.cancelledSeasons || "").includes(String(tournament.year));
}

function person(match, side) {
    const first = String(match["PlayerNameFirst" + side] || "").trim();
    const last = String(match["PlayerNameLast" + side] || "").trim();
    return {
        id: String(match["PlayerID" + side] || ""), first_name: first, last_name: last,
        name: [first, last].filter(Boolean).join(" "), country: String(match["PlayerCountry" + side] || "").toUpperCase(),
    };
}

export function completedAt(match) {
    // WTA's LastUpdated can move after a score correction, without another match being played.
    const duration = /^(\d+):(\d{2}):(\d{2})$/.exec(String(match.MatchTimeTotal || ""));
    const start = Date.parse(match.MatchTimeStamp);
    if (Number.isFinite(start) && duration && Number(duration[2]) < 60 && Number(duration[3]) < 60) {
        return start + (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000;
    }
    return Date.parse(match.LastUpdated);
}

export function parseMatch(match, tournament, now) {
    const code = String(match.Winner || "");
    if (match.DrawMatchType !== "S" || match.MatchState !== "F" || !["2", "3", "4", "5"].includes(code)) return null;
    const finished = completedAt(match);
    if (!Number.isFinite(finished) || finished < now - DAY || finished > now) return null;
    const [a, b] = ["2", "4"].includes(code) ? ["A", "B"] : ["B", "A"];
    const winner = person(match, a), loser = person(match, b);
    if (!winner.id || !winner.name || !loser.id || !loser.name || !match.MatchID) {
        throw new Error("A completed WTA singles match has missing player or match details.");
    }
    const sets = [];
    for (let n = 1; n <= 3; n += 1) {
        const x = match["ScoreSet" + n + a], y = match["ScoreSet" + n + b];
        if ([null, undefined, ""].includes(x) && [null, undefined, ""].includes(y)) continue;
        if (!/^\d+$/.test(String(x)) || !/^\d+$/.test(String(y))) throw new Error("WTA returned an invalid set score.");
        sets.push({ winner: Number(x), loser: Number(y), tiebreak: String(match["ScoreTbSet" + n] ?? "") });
    }
    if (!sets.length) return null;
    const round = String(match.RoundID || ""), qualifying = match.DrawLevelType === "Q";
    const [name, art] = ROUNDS[round] || [EXTRA[round] || "Round " + round, "premier"];
    const group = tournament.tournamentGroup;
    return {
        id: `${group.id}:${tournament.year}:${match.MatchID}`, completed_at: new Date(finished).toISOString(),
        round: (qualifying ? "Qualifying · " : "") + name, round_art: art,
        round_heading: qualifying ? "QUALIFICATIONS" : ROUNDS[round] ? "" : name.toUpperCase(),
        tournament: {
            id: String(group.id), name: tournament.title || group.name || "WTA",
            city: tournament.city || group.name || "", category: tournament.level, surface: tournament.surface || "",
        },
        winner, loser, sets,
        status: /def/i.test(String(match.ScoreString || "")) ? "DEF." : ["4", "5"].includes(code) ? "RET." : "",
    };
}

export function bracketRounds(matches) {
    if (!Array.isArray(matches)) throw new Error("The WTA bracket response is incomplete.");
    const nodes = new Map();
    for (const match of matches) {
        if (match.DrawMatchType !== "S" || match.DrawLevelType !== "M" || ["R", "RR"].includes(String(match.RoundID))) continue;
        const number = /^LS0*([1-9]\d*)$/.exec(String(match.MatchID || ""));
        if (number) nodes.set(Number(number[1]), match);
    }
    const player = (match, side) => {
        const value = person(match, side);
        return value.id && value.id !== "0" && value.name && !["BYE", "TBD"].includes(value.name.toUpperCase()) ? value : null;
    };
    const winner = number => {
        const match = nodes.get(number) || {}, code = String(match.Winner || "");
        return match.MatchState === "F" && ["2", "3", "4", "5", "6", "7"].includes(code)
            ? player(match, ["2", "4", "6"].includes(code) ? "A" : "B") : null;
    };
    const rounds = {};
    for (const [round, start, end] of [["F", 1, 2], ["S", 2, 4], ["Q", 4, 8]]) {
        rounds[round] = [];
        for (let n = start; n < end; n += 1) {
            const match = nodes.get(n) || {};
            rounds[round].push({
                id: "LS" + String(n).padStart(3, "0"), position: n - start,
                players: [player(match, "A") || winner(n * 2), player(match, "B") || winner(n * 2 + 1)],
                state: match.MatchState || "U",
            });
        }
    }
    return rounds;
}

export function mergePlayerForm(playerId, history, draws, now = Date.now()) {
    playerId = String(playerId);
    const cutoff = new Date(now);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    cutoff.setUTCHours(0, 0, 0, 0);
    const activeEvents = new Set(draws.map(({ tournament: t }) => t.tournamentGroup.id + ":" + t.year));
    const matches = new Map();
    for (const match of history) {
        const event = match.tourn_nbr + ":" + match.tourn_year;
        const side = String(match.player_1) === playerId ? 1 : String(match.player_2) === playerId ? 2 : 0;
        const time = Date.parse(match.StartDate);
        // History dates are tournament start dates; active draws supply actual completion times.
        if (activeEvents.has(event) || match.s_d_flag !== "S" || !side || ![1, 2].includes(Number(match.winner)) ||
            !Number.isFinite(time) || time < cutoff.getTime() || time > now ||
            !/\d/.test(match.scores || "") || /w\s*\/\s*o|walkover|bye/i.test(match.scores || "")) continue;
        const round = Number(match.tourn_round) || ({ Q: 90, S: 91, F: 92 }[match.round_name] || 0);
        const order = (match.qpm_flag === "Q" ? 0 : 100) + round;
        const key = [event, match.qpm_flag, match.round_name, match.tourn_round, match.player_1, match.player_2].join(":");
        matches.set(key, { time, order, result: Number(match.winner) === side ? "win" : "loss" });
    }
    for (const { tournament, matches: rows } of draws) {
        for (const match of rows) {
            const side = String(match.PlayerIDA) === playerId ? "A" : String(match.PlayerIDB) === playerId ? "B" : "";
            const code = String(match.Winner || ""), time = completedAt(match);
            if (!side || match.DrawMatchType !== "S" || match.MatchState !== "F" ||
                !["2", "3", "4", "5"].includes(code) || !match.MatchID ||
                !Number.isFinite(time) || time < cutoff.getTime() || time > now) continue;
            const key = tournament.tournamentGroup.id + ":" + tournament.year + ":" + match.MatchID;
            matches.set(key, { time, order: 0, result: (["2", "4"].includes(code) ? "A" : "B") === side ? "win" : "loss" });
        }
    }
    const results = [...matches.values()].sort((a, b) => a.time - b.time || a.order - b.order)
        .slice(-10).map(match => match.result);
    return [...Array(10 - results.length).fill(""), ...results];
}

export function drawChampion(tournament, matches, now = Date.now()) {
    const finals = matches.filter(match => match.DrawMatchType === "S" && match.DrawLevelType === "M" &&
        !["R", "RR"].includes(String(match.RoundID)) &&
        (String(match.RoundID) === "F" || /^LS0*1$/.test(String(match.MatchID))) && match.MatchState === "F");
    if (!finals.length) return null;
    if (finals.length !== 1) throw new Error("WTA returned multiple completed singles finals.");
    const match = finals[0], code = String(match.Winner || "");
    if (completedAt(match) > now) return null;
    let side = { "2": "A", "3": "B", "6": "A", "7": "B" }[code];
    if (["4", "5"].includes(code)) {
        // Match the saved champions collector: retired finals require an explicit winner message.
        const message = /\{11\|([^}]+)\}/.exec(match.Message || "");
        const sides = message ? ["A", "B"].filter(s => match["PlayerNameLast" + s] &&
            message[1].toLocaleLowerCase().endsWith(match["PlayerNameLast" + s].toLocaleLowerCase())) : [];
        if (sides.length === 1) side = sides[0];
    }
    if (!side) return null;
    const player = person(match, side);
    if (!player.id || player.id === "0" || !player.name) throw new Error("A WTA singles champion has missing player details.");
    const group = tournament.tournamentGroup;
    return {
        tournament_id: String(group.id), year: tournament.year,
        start_date: tournament.startDate.slice(0, 10), end_date: tournament.endDate.slice(0, 10),
        name: tournament.title || group.name || "WTA", city: tournament.city || group.name || "WTA",
        category: tournament.level, surface: tournament.surface || "",
        champion: { id: player.id, name: player.name, country: player.country },
    };
}

export function mergeCalendar(existing, source) {
    if (!source || !Array.isArray(source.items)) throw new Error("The shared WTA calendar is incomplete.");
    const fields = [...new Set([...(existing?.fields || ["column", "name", "level", "startDate", "endDate", "calendarKey"]),
        "city", "year", "source", "surface", "country", "tournamentKey", "tournamentId"])];
    const rows = new Map();
    for (const batch of Object.values(existing?.weeks || {})) {
        for (const row of batch) {
            if (!Array.isArray(row) || row.length !== existing.fields.length) throw new Error("The saved calendar has an invalid row.");
            const item = Object.fromEntries(existing.fields.map((field, index) => [field, row[index]]));
            rows.set(item.calendarKey, item);
        }
    }
    const active = new Set(source.items.filter(t => !String(t.tournamentGroup.metadata?.cancelledSeasons || "")
        .includes(String(t.year))).map(t => `wta:${t.tournamentGroup.id}:${t.year}`));
    for (const [key, row] of rows) {
        const mainKey = String(key).replace(/\|qualifying$/, "");
        if (String(key).startsWith("wta:") && String(row.startDate).slice(0, 10) >= source.from &&
            String(row.startDate).slice(0, 10) <= source.to && !active.has(mainKey)) rows.delete(key);
    }
    for (const tournament of source.items) {
        if (tournament.level === "ITF") continue;
        const group = tournament.tournamentGroup, key = `wta:${group.id}:${tournament.year}`;
        if (String(group.metadata?.cancelledSeasons || "").includes(String(tournament.year))) {
            rows.delete(key); rows.delete(key + "|qualifying"); continue;
        }
        rows.set(key, { ...rows.get(key), column: tournament.level === "WTA 125" ? "wta_125"
            : tournament.level.includes("Grand Slam") ? "gs" : "wta_tour",
        name: tournament.title || group.name, level: tournament.level, startDate: tournament.startDate,
        endDate: tournament.endDate, calendarKey: key, city: tournament.city || group.name, year: tournament.year,
        source: "WTA", surface: tournament.surface || "", country: tournament.country || "", tournamentId: group.id });
    }
    const weeks = {};
    for (const row of [...rows.values()].sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)) ||
        String(a.calendarKey).localeCompare(String(b.calendarKey)))) {
        const week = String(row.startDate).slice(0, 10);
        (weeks[week] ||= []).push(fields.map(field => row[field] ?? ""));
    }
    return { fields, weeks };
}

const MATCH_FIELDS = ["MatchID", "DrawMatchType", "DrawLevelType", "RoundID", "MatchState", "Winner", "Message",
    "MatchTimeStamp", "MatchTimeTotal", "LastUpdated", "ScoreString",
    ...["A", "B"].flatMap(side => ["PlayerID", "PlayerNameFirst", "PlayerNameLast", "PlayerCountry"].map(field => field + side)),
    ...[1, 2, 3].flatMap(number => ["ScoreSet" + number + "A", "ScoreSet" + number + "B", "ScoreTbSet" + number])];

export function compactMatches(matches) {
    if (!Array.isArray(matches) || matches.some(match => !match || typeof match !== "object" || Array.isArray(match))) {
        throw new Error("The WTA match response is incomplete.");
    }
    return matches.filter(match => match.DrawMatchType === "S")
        .map(match => Object.fromEntries(MATCH_FIELDS.filter(field => Object.hasOwn(match, field)).map(field => [field, match[field]])));
}
