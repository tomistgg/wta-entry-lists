(() => {
    "use strict";

    const button = document.getElementById("refresh-lists");
    const status = document.getElementById("refresh-status");
    const menu = document.querySelector(".tournament-menu");
    const content = document.querySelector(".main-content");
    const initialNote = document.getElementById("entry-state");
    const initialMenu = document.getElementById("menu-state");
    let displayedAt = 0;
    let displayedWindow = "";
    let savedAt = 0;
    let nextRefresh = 0;
    let pending = false;
    let checking = false;
    let lastChecked = 0;
    let checkedExpiry = 0;
    let module;
    let moduleRetry = 0;

    function entryModule() {
        // Browsers remember failed module URLs, so a retry needs a fresh URL.
        const moduleURL = "./entry-lists.mjs?v=3" + (moduleRetry ? "&retry=" + moduleRetry : "");
        return module ||= import(moduleURL).catch(error => {
            module = undefined;
            moduleRetry++;
            throw error;
        });
    }

    function validDate(value) {
        return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
            Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    }

    function showInitial(message) {
        if (displayedAt) return;
        if (initialNote) initialNote.textContent = message;
        if (initialMenu) initialMenu.textContent = "";
    }

    function validateSnapshot(snapshot, live) {
        if (!snapshot || snapshot.schema_version !== 1 || !Array.isArray(snapshot.models) ||
            typeof snapshot.fetched_at !== "string" || typeof snapshot.saved_at !== "string" ||
            !Number.isFinite(Date.parse(snapshot.fetched_at)) || !Number.isFinite(Date.parse(snapshot.saved_at)) ||
            Date.parse(snapshot.saved_at) < Date.parse(snapshot.fetched_at) ||
            !validDate(snapshot.window_start) || !validDate(snapshot.window_end)) {
            throw new Error("Invalid saved entry lists");
        }
        const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
            timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
        }).formatToParts(new Date()).map(part => [part.type, part.value]));
        const start = live.addDays(live.monday(`${parts.year}-${parts.month}-${parts.day}`), 7);
        if (snapshot.window_start !== start || snapshot.window_end !== live.addDays(start, 28)) return false;
        const ids = new Set();
        for (const model of snapshot.models) {
            if (!model || typeof model.id !== "string" || !model.id || ids.has(model.id) ||
                typeof model.label !== "string" || !model.label || typeof model.name !== "string" || !model.name ||
                !validDate(model.week) || live.monday(model.week) !== model.week ||
                model.week < snapshot.window_start || model.week >= snapshot.window_end ||
                !model.dates || !["main", "qualifying", "mainAvailable", "qualAvailable"].every(key => validDate(model.dates[key])) ||
                (model.main_retained !== undefined && typeof model.main_retained !== "boolean")) {
                throw new Error("Invalid saved tournament");
            }
            ids.add(model.id);
            if (model.changes !== undefined) {
                if (!Array.isArray(model.changes)) throw new Error("Invalid saved changes");
                const changes = new Set();
                for (const change of model.changes) {
                    if (!change || typeof change.id !== "string" || !change.id || changes.has(change.id) ||
                        typeof change.at !== "string" || !Number.isFinite(Date.parse(change.at)) ||
                        Date.parse(change.at) > Date.parse(snapshot.saved_at) || !validDate(change.date) ||
                        !["main", "qualifying"].includes(change.draw) || !["added", "removed"].includes(change.action) ||
                        !(change.player_id === null && change.id.startsWith("legacy:") ||
                            typeof change.player_id === "string" && /^\d+$/.test(change.player_id)) ||
                        typeof change.name !== "string" || !change.name.trim()) throw new Error("Invalid saved change");
                    changes.add(change.id);
                }
            }
            for (const draw of [model.main, model.qualifying]) {
                if (!Array.isArray(draw)) throw new Error("Invalid saved draw");
                const players = new Set();
                for (const player of draw) {
                    if (!player || typeof player.id !== "string" || !/^\d+$/.test(player.id) || players.has(player.id) ||
                        typeof player.name !== "string" || !player.name.trim() || typeof player.country !== "string" ||
                        !(player.rank === null || Number.isInteger(player.rank) && player.rank > 0)) {
                        throw new Error("Invalid saved player");
                    }
                    players.add(player.id);
                }
            }
        }
        return true;
    }

    function renderModels(live, models) {
        const active = Array.from(content.querySelectorAll(".tabcontent")).find(tab => tab.style.display !== "none");
        const activeId = active?.id;
        const previousView = active?.querySelector(".changes-view")?.style.display === "flex" ? "changes"
            : active?.querySelector(".qual-view")?.style.display === "flex" ? "qualifying" : "main";
        const rendered = live.renderEntryLists(models);
        menu.replaceChildren(rendered.menu);
        content.replaceChildren(rendered.content);
        const activeIndex = Array.from(content.querySelectorAll(".tabcontent")).findIndex(tab => tab.id === activeId);
        const activeButton = menu.querySelectorAll(".tablinks")[activeIndex];
        if (activeButton) {
            window.openTourney({ currentTarget: activeButton }, activeId);
            const panel = document.getElementById(activeId);
            if (previousView === "qualifying") window.toggleView(panel.querySelector(".main-qual-toggle"));
            if (previousView === "changes") window.showChanges(panel.querySelector(".changes-btn"), activeId);
        }
    }

    async function applySnapshot(snapshot) {
        if (snapshot === null) {
            const message = "No entry lists have been saved yet. Click Refresh to fetch and save them.";
            showInitial(message);
            return message;
        }
        const live = await entryModule();
        if (!validateSnapshot(snapshot, live)) {
            const message = "Saved lists cover an earlier period. Click Refresh for the upcoming tournaments.";
            showInitial(message);
            return message;
        }
        const fetchedAt = Date.parse(snapshot.fetched_at);
        const historyAt = Date.parse(snapshot.saved_at);
        if (fetchedAt > displayedAt || fetchedAt === displayedAt && historyAt >= savedAt &&
            snapshot.window_start !== displayedWindow) {
            renderModels(live, snapshot.models);
            displayedAt = fetchedAt;
            displayedWindow = snapshot.window_start;
            savedAt = historyAt;
        } else if (fetchedAt === displayedAt && historyAt > savedAt) {
            live.updateEntryChanges(snapshot.models, content);
            savedAt = historyAt;
        }
        return "Updated and saved at " + new Date(savedAt).toLocaleString([], {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
        }) + ".";
    }

    function updateButton() {
        const seconds = Math.max(0, Math.ceil((nextRefresh - Date.now()) / 1000));
        button.disabled = pending || checking || seconds > 0;
        button.textContent = pending ? "Refreshing\u2026" : seconds > 0
            ? `Refresh (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})`
            : "Refresh";
        if (!pending && !checking && nextRefresh > 0 && !seconds && checkedExpiry !== nextRefresh) {
            checkedExpiry = nextRefresh;
            void checkSaved();
        }
    }

    async function requestState(method) {
        const live = await entryModule();
        const response = await fetch(live.BASE + "/entry-lists" + (method === "POST" ? "/refresh" : "") + "?history=1", {
            method, cache: "no-store", signal: AbortSignal.timeout(method === "POST" ? 90000 : 20000),
        });
        const state = await response.json();
        if (!state || typeof state !== "object") throw new Error("Invalid shared update");
        if (Number.isFinite(state.next_refresh_at) && state.next_refresh_at >= 0) {
            nextRefresh = state.next_refresh_at;
            if (nextRefresh <= Date.now()) checkedExpiry = nextRefresh;
        }
        if (Object.hasOwn(state, "snapshot")) {
            const message = await applySnapshot(state.snapshot);
            status.textContent = state.refreshing ? state.progress || "Updating entry lists\u2026" : message;
            if (state.refreshing) showInitial(status.textContent);
        } else if (response.ok) throw new Error("Missing saved entry lists");
        if (!response.ok || state.error) throw new Error("Shared refresh unavailable");
        if (typeof state.refreshing !== "boolean") throw new Error("Invalid refresh status");
        return state;
    }

    async function refreshShared(resume = false) {
        if (pending || checking || !resume && nextRefresh > Date.now()) return;
        pending = true;
        updateButton();
        status.textContent = "Fetching and saving entry lists from WTA\u2026";
        try {
            let state;
            do {
                state = await requestState("POST");
                if (state.refreshing) await new Promise(resolve => window.setTimeout(resolve, 250));
            } while (state.refreshing);
        } catch {
            status.textContent = displayedAt ? "Refresh failed. Your current lists are still shown. Please try again."
                : "Refresh failed. Please try again.";
            showInitial(status.textContent);
        } finally {
            pending = false;
            lastChecked = Date.now();
            updateButton();
        }
    }

    async function checkSaved() {
        if (pending || checking) return;
        checking = true;
        updateButton();
        let resume = false;
        try {
            resume = (await requestState("GET")).refreshing;
        } catch {
            status.textContent = displayedAt ? "Saved updates are unavailable. Your current lists are still shown."
                : "Entry lists could not be loaded. Click Refresh to try again.";
            showInitial(status.textContent);
        } finally {
            checking = false;
            lastChecked = Date.now();
            updateButton();
        }
        if (resume) await refreshShared(true);
    }

    button.addEventListener("click", () => refreshShared());
    window.setInterval(updateButton, 1000);
    window.addEventListener("focus", () => {
        if (Date.now() - lastChecked > 15000) void checkSaved();
    });
    void checkSaved();
})();
