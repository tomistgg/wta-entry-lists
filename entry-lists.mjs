export const BASE = "https://tennis-wta-api.schiter-tomas.workers.dev";
const DAY = 86400000;
const LATAM = new Set("ARG BOL BRA CHI COL CRC CUB DOM ECU ESA GUA HON MEX NCA PAN PAR PER PUR URU VEN".split(" "));

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
                    flag.src = `assets/flags/${iso2.toLowerCase()}.svg`;
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

function changeHistory(events = []) {
    const view = element("div", "changes-view");
    const rows = events.map(event => {
        const row = element("tr");
        row.dataset.changeId = event.id;
        const date = element("td", "", event.date), description = element("td");
        date.title = event.id.startsWith("legacy:") ? "Recorded on " + event.date + " (date only)" : event.at;
        description.style.textAlign = "left";
        description.style.paddingLeft = "20px";
        description.append(element("strong", "", event.name.toUpperCase()),
            ` ${event.action} ${event.action === "added" ? "to" : "from"} ${event.draw === "main" ? "Main Draw" : "Qualifying"}`);
        row.append(date, description);
        return { row, time: Date.parse(event.at) };
    });
    if (!rows.length) {
        view.append(element("p", "entry-note", "No changes recorded yet."));
        return view;
    }
    const column = element("div", "table-column"), table = element("table", "entry-table");
    column.style.maxWidth = "550px";
    column.style.margin = "0 auto";
    table.innerHTML = '<thead><tr><th>DATE</th><th style="text-align:left; padding-left:20px;">CHANGE</th></tr></thead>';
    const body = element("tbody");
    rows.sort((a, b) => b.time - a.time).forEach(item => body.append(item.row));
    table.append(body);
    column.append(table);
    view.append(column);
    return view;
}

export function updateEntryChanges(models, content) {
    const panels = new Map([...content.querySelectorAll(".tabcontent")].map(panel => [panel.id, panel]));
    for (const model of models) {
        if (model.changes === undefined) continue;
        const panel = panels.get(model.id);
        if (!panel) continue;
        const previous = panel.querySelector(".changes-view");
        const next = changeHistory(model.changes);
        if (previous) previous.replaceChildren(...next.childNodes);
        else {
            next.style.display = "none";
            panel.append(next);
        }
    }
}

export function renderEntryLists(models) {
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
        const main = element("div", "main-draw-view");
        const qual = element("div", "qual-view");
        main.style.display = "flex";
        if (model.main_retained) {
            main.prepend(element("p", "entry-note previous-main-note", "WTA currently lists qualifying only. The previous main draw is shown."));
            main.style.flexWrap = "wrap";
        }
        main.append(drawTable(model.main, model.dates.mainAvailable, countryCodes));
        qual.append(drawTable(model.qualifying, model.dates.qualAvailable, countryCodes));
        qual.style.display = "none";
        const changes = changeHistory(model.changes);
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
