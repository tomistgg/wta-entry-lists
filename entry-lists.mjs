export const BASE = "https://tennis-wta-api.schiter-tomas.workers.dev";
const DAY = 86400000;
const LEVELS = new Set(["WTA 125", "WTA 250", "WTA 500", "WTA 1000", "Finals", "WTA Finals", "Grand Slam"]);
const LATAM = new Set("ARG BOL BRA CHI COL CRC CUB DOM ECU ESA GUA HON MEX NCA PAN PAR PER PUR URU VEN".split(" "));
const rankingCache = new Map();

async function request(path, params = {}) {
    const url = new URL(BASE + path);
    url.search = new URLSearchParams(params);
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error("WTA could not be reached. Please try again.");
    const bytes = await response.arrayBuffer();
    try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return new TextDecoder("windows-1252").decode(bytes); }
}

export const dateString = date => new Date(date).toISOString().slice(0, 10);
export const addDays = (date, days) => dateString(Date.parse(date) + days * DAY);
export function monday(date) {
    return addDays(date, -((new Date(date).getUTCDay() + 6) % 7));
}
export function rankingDates(start, today) {
    const weekend = [0, 6].includes(new Date(start).getUTCDay());
    const main = addDays(monday(start), -7 * (weekend ? 3 : 4));
    const qualifying = addDays(monday(start), -7 * (weekend ? 2 : 3));
    const current = monday(today);
    return {
        main: main < current ? main : current, qualifying: qualifying < current ? qualifying : current,
        mainAvailable: addDays(main, 4), qualAvailable: addDays(qualifying, 4),
    };
}
export function slug(name) {
    return name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim()
        .replace(/\s*#\s*/g, "-").replace(/[ ']/g, "-").replace(/[()]/g, "").toLowerCase();
}
const titleCase = value => String(value).toLowerCase().replace(/(^|[\s'-])\p{L}/gu, letter => letter.toUpperCase());
const legacyId = label => label.replaceAll(" ", "_").replaceAll(".", "").replaceAll("-", "_").replaceAll("'", "").toUpperCase();

export function parseEntryList(page, tournament) {
    const sections = [...page.querySelectorAll(".tournament-player-list__tab[data-ui-tab]")];
    const singles = sections.filter(section => section.getAttribute("data-ui-tab") === "Singles");
    const qualifying = sections.filter(section => section.getAttribute("data-ui-tab") === "Qualifying");
    if (!singles.length && !qualifying.length) throw new Error("WTA returned an unrecognized entry-list page.");
    const entries = tabs => {
        const players = new Map();
        for (const tab of tabs) {
            for (const link of tab.querySelectorAll('a[href^="/players/"]')) {
                const match = /^\/players\/(\d+)\/([^/?#]+)/.exec(link.getAttribute("href"));
                if (!match) continue;
                const card = link.closest(".tournament-player-card");
                const name = card?.getAttribute("data-player-name") || link.getAttribute("aria-label") || link.textContent.trim();
                const country = card?.querySelector(".tournament-player-card__country-text")?.textContent.trim() || "-";
                players.set(match[1], { id: match[1], name: name || titleCase(match[2].replaceAll("-", " ")), country });
            }
        }
        return [...players.values()];
    };
    const events = [];
    for (const script of page.querySelectorAll('script[type="application/ld+json"]')) {
        try {
            const event = JSON.parse(script.textContent);
            if (event?.["@type"] === "SportsEvent" && String(event["@id"] || "").includes(`/tournaments/${tournament.tournamentGroup.id}/`)) {
                events.push(event);
            }
        } catch { /* Unrelated page metadata is not part of an entry list. */ }
    }
    const event = events.find(item => !String(item["@id"]).includes("player-list")) || events[0];
    const start = String(event?.startDate || tournament.startDate).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !Number.isFinite(Date.parse(start))) throw new Error("WTA returned an invalid tournament date.");
    return { main: entries(singles), qualifying: entries(qualifying), start, name: event?.name || tournament.title || tournament.tournamentGroup.name };
}

async function rankings(date) {
    if (!rankingCache.has(date)) {
        const task = (async () => {
            const found = new Map();
            // This endpoint caps pages at 100 even when a larger pageSize is requested.
            for (let page = 0; page < 100; page += 1) {
                const data = JSON.parse(await request("/api/tennis/players/ranked", {
                    metric: "SINGLES", type: "rankSingles", sort: "asc", at: date, pageSize: 100, page,
                }));
                const rows = Array.isArray(data) ? data : data.content;
                if (!Array.isArray(rows) || (!page && !rows.length)) throw new Error("The WTA deadline-week rankings are unavailable.");
                for (const row of rows) {
                    const id = String(row.player?.id || "");
                    if (!id || found.has(id)) throw new Error("WTA returned incomplete or repeated ranking pages.");
                    found.set(id, row);
                }
                if (rows.length < 100) return found;
            }
            throw new Error("The WTA rankings response is incomplete.");
        })();
        rankingCache.set(date, task);
        task.catch(() => rankingCache.delete(date));
    }
    return rankingCache.get(date);
}

export function rankedPlayers(players, ranked) {
    return players.map(player => {
        const row = ranked.get(player.id);
        const name = row?.player?.fullName || player.name;
        return {
            id: player.id, name,
            country: name.toUpperCase() === "CATHERINE HARRISON" ? "USA" : row?.player?.countryCode || player.country || "-",
            rank: Number(row?.ranking) > 0 ? Number(row.ranking) : null,
        };
    }).sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
}

export async function collectEntryLists(now = new Date(), progress = () => {}) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
        timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(now).map(part => [part.type, part.value]));
    const today = `${parts.year}-${parts.month}-${parts.day}`;
    const next = addDays(monday(today), 7), end = addDays(next, 28);
    const tournaments = [];
    let total;
    for (let page = 0; ; page += 1) {
        const data = JSON.parse(await request("/api/tennis/tournaments/", {
            from: addDays(next, -7), to: end, excludeLevels: "ITF", pageSize: 100, page,
        }));
        const count = data.pageInfo?.numEntries;
        if (!Array.isArray(data.content) || !Number.isInteger(count) || count < 0 || Number(data.pageInfo.page) !== page ||
            (total !== undefined && total !== count)) throw new Error("The WTA calendar response is incomplete.");
        total = count;
        tournaments.push(...data.content);
        if (tournaments.length === total) break;
        if (!data.content.length || tournaments.length > total) throw new Error("The WTA calendar response is incomplete.");
    }
    const active = [...new Map(tournaments.filter(t => LEVELS.has(t.level) && t.tournamentGroup?.id &&
        !String(t.tournamentGroup.metadata?.cancelledSeasons || "").includes(String(t.year)))
        .map(t => [t.tournamentGroup.id + ":" + t.year, t])).values()].filter(t => {
        const start = String(t.startDate).slice(0, 10);
        const week = [0, 6].includes(new Date(start).getUTCDay()) ? addDays(monday(start), 7) : monday(start);
        return week >= next && week < end;
    });
    const results = new Array(active.length);
    let index = 0, completed = 0;
    progress(`Loading WTA entry lists (0/${active.length})…`);
    await Promise.all(Array.from({ length: Math.min(3, active.length) }, async () => {
        while (index < active.length) {
            const position = index++, tournament = active[position], group = tournament.tournamentGroup;
            const html = await request(`/site/tournaments/${group.id}/${slug(group.name)}/${tournament.year}/player-list`);
            const parsed = parseEntryList(new DOMParser().parseFromString(html, "text/html"), tournament);
            const dates = rankingDates(parsed.start, today);
            const [mainRanks, qualRanks] = await Promise.all([
                parsed.main.length ? rankings(dates.main) : new Map(),
                parsed.qualifying.length ? rankings(dates.qualifying) : new Map(),
            ]);
            const edition = /#\s*(\S+)/.exec(group.name)?.[1];
            const label = tournament.level + " " + titleCase(tournament.city || group.name) + (edition ? " " + edition : "");
            const week = [0, 6].includes(new Date(tournament.startDate).getUTCDay())
                ? addDays(monday(tournament.startDate), 7) : monday(tournament.startDate);
            results[position] = {
                id: legacyId(label), label, week, name: parsed.name, dates,
                main: rankedPlayers(parsed.main, mainRanks), qualifying: rankedPlayers(parsed.qualifying, qualRanks),
            };
            progress(`Loading WTA entry lists (${++completed}/${active.length})…`);
        }
    }));
    return results.sort((a, b) => a.week.localeCompare(b.week) || a.label.localeCompare(b.label));
}

function element(tag, className = "", text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

function drawTable(players, available, countryCodes) {
    const view = document.createDocumentFragment();
    if (!players.length) {
        const date = new Intl.DateTimeFormat("en", { dateStyle: "long", timeZone: "UTC" }).format(new Date(available));
        const note = element("p", "entry-note", "WTA has not published this singles entry list. Estimated publication: " + date + ".");
        view.append(note);
        return view;
    }
    const size = Math.ceil(players.length / (players.length > 50 ? 3 : players.length > 25 ? 2 : 1));
    for (let start = 0; start < players.length; start += size) {
        const column = element("div", "table-column"), table = element("table", "entry-table");
        table.innerHTML = "<thead><tr><th>Pos.</th><th>Player</th><th>Country</th><th>Rank</th></tr></thead>";
        const body = element("tbody");
        players.slice(start, start + size).forEach((player, offset) => {
            const row = element("tr", LATAM.has(player.country) ? "latam-row" : "");
            row.dataset.playerId = player.id;
            [start + offset + 1, player.name, player.country, player.rank ?? "-"].forEach((value, index) => {
                const cell = element("td", "", value);
                const iso2 = index === 2 ? countryCodes[player.country] : null;
                if (iso2 && /^[A-Z]{2}$/.test(iso2)) {
                    const flag = element("img", "country-flag");
                    flag.src = `https://purecatamphetamine.github.io/country-flag-icons/3x2/${iso2}.svg`;
                    flag.alt = player.country + " flag";
                    flag.title = player.country;
                    flag.width = 20;
                    flag.height = 14;
                    flag.onerror = () => { cell.textContent = player.country; };
                    cell.replaceChildren(flag);
                }
                row.append(cell);
            });
            body.append(row);
        });
        table.append(body);
        column.append(table);
        view.append(column);
    }
    return view;
}

export function renderEntryLists(models, previousContent) {
    const menu = document.createDocumentFragment(), content = document.createDocumentFragment();
    const countryCodes = JSON.parse(document.getElementById("country-flag-codes")?.textContent || "{}");
    let week = "";
    for (const [index, model] of models.entries()) {
        if (model.week !== week) {
            week = model.week;
            const month = new Intl.DateTimeFormat("es", { month: "long", timeZone: "UTC" }).format(new Date(week));
            menu.append(element("div", "week-title", `Semana ${new Date(week).getUTCDate()} ${titleCase(month)}`));
        }
        const tab = element("button", "tablinks" + (index ? "" : " active"), model.label);
        tab.type = "button";
        tab.addEventListener("click", event => window.openTourney(event, model.id));
        menu.append(tab);
        const panel = element("div", "tabcontent");
        panel.id = model.id;
        panel.style.display = index ? "none" : "block";
        panel.innerHTML = `<div class="top-row">
            <div class="header-controls">
                <button type="button" class="toggle-btn main-qual-toggle">Qualifying</button>
                <button type="button" class="toggle-btn changes-btn">Changes</button>
                <button type="button" class="toggle-btn back-to-qual-btn" style="display:none;">Qualifying</button>
            </div>
            <div class="title-stack"><div class="sub-title">MAIN DRAW ENTRY LIST</div><h1 class="main-title"></h1></div>
            <div class="pdf-container"><button type="button" class="toggle-btn pdf-btn">PDF</button></div>
        </div>`;
        panel.querySelector(".main-title").textContent = model.name;
        const oldPanel = [...previousContent.querySelectorAll(".tabcontent")].find(item => item.id === model.id);
        const previousMain = oldPanel?.querySelector(".main-draw-view");
        const keepMain = !model.main.length && model.qualifying.length && previousMain?.querySelector("tbody tr");
        const main = keepMain ? previousMain.cloneNode(true) : element("div", "main-draw-view");
        const qual = element("div", "qual-view");
        main.style.display = "flex";
        if (keepMain || model.main_retained) {
            main.querySelector(".previous-main-note")?.remove();
            main.prepend(element("p", "entry-note previous-main-note", "WTA currently lists qualifying only. The previous main draw is shown."));
            main.style.flexWrap = "wrap";
        }
        if (!keepMain) main.append(drawTable(model.main, model.dates.mainAvailable, countryCodes));
        qual.append(drawTable(model.qualifying, model.dates.qualAvailable, countryCodes));
        qual.style.display = "none";
        const changes = oldPanel?.querySelector(".changes-view")?.cloneNode(true) || element("div", "changes-view");
        if (!changes.childNodes.length) changes.append(element("p", "entry-note", "No changes recorded yet."));
        changes.style.display = "none";
        panel.append(main, qual, changes);
        const logo = element("div", "logo-container"), image = element("img", "tournament-logo");
        image.src = "LOGO.png";
        image.alt = "WTA Tracker";
        logo.append(image);
        panel.append(logo);
        panel.querySelector(".main-qual-toggle").addEventListener("click", event => window.toggleView(event.currentTarget));
        panel.querySelector(".changes-btn").addEventListener("click", event => window.showChanges(event.currentTarget, model.id));
        panel.querySelector(".back-to-qual-btn").addEventListener("click", event => window.showQualFromChanges(event.currentTarget));
        panel.querySelector(".pdf-btn").addEventListener("click", () => window.exportToPDF(model.id));
        content.append(panel);
    }
    if (!models.length) {
        menu.append(element("p", "entry-note", "No upcoming tournaments."));
        content.append(element("p", "entry-note", "There are no WTA tournaments scheduled in the next four weeks."));
    }
    return { menu, content };
}
