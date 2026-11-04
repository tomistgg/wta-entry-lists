(() => {
    "use strict";

    const button = document.getElementById("refresh-lists");
    const status = document.getElementById("refresh-status");
    const menu = document.querySelector(".tournament-menu");
    const content = document.querySelector(".main-content");
    const storageKey = "wta-entry-lists:next-refresh";
    const cooldown = 120000;
    let nextRefresh = 0;
    let pending = false;

    function readCooldown() {
        try {
            nextRefresh = Number(localStorage.getItem(storageKey)) || 0;
        } catch {
            // Keep the cooldown in memory if browser storage is unavailable.
        }
    }

    function saveCooldown(value) {
        nextRefresh = value;
        try {
            localStorage.setItem(storageKey, String(value));
        } catch {
            // Refresh still works when browser storage is unavailable.
        }
    }

    function updateButton() {
        const seconds = Math.max(0, Math.ceil((nextRefresh - Date.now()) / 1000));
        button.disabled = pending || seconds > 0;
        button.textContent = pending ? "Refreshing…" : seconds > 0
            ? `Refresh (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})`
            : "Refresh";
    }

    button.addEventListener("click", async () => {
        readCooldown();
        if (pending || nextRefresh > Date.now()) {
            updateButton();
            return;
        }

        pending = true;
        saveCooldown(Date.now() + cooldown);
        updateButton();
        status.textContent = "Fetching entry lists from WTA…";

        try {
            const active = Array.from(content.querySelectorAll(".tabcontent")).find(tab => tab.style.display !== "none");
            const activeId = active?.id;
            const previousView = active?.querySelector(".changes-view")?.style.display === "flex" ? "changes"
                : active?.querySelector(".qual-view")?.style.display === "flex" ? "qualifying" : "main";
            const live = await import("./entry-lists.mjs");
            const models = await live.collectEntryLists(new Date(), message => { status.textContent = message; });
            const rendered = live.renderEntryLists(models, content);
            menu.replaceChildren(rendered.menu);
            content.replaceChildren(rendered.content);
            const activeIndex = Array.from(content.querySelectorAll(".tabcontent"))
                .findIndex(tab => tab.id === activeId);
            const activeButton = menu.querySelectorAll(".tablinks")[activeIndex];
            if (activeButton) {
                window.openTourney({ currentTarget: activeButton }, activeId);
                const panel = document.getElementById(activeId);
                if (previousView === "qualifying") window.toggleView(panel.querySelector(".main-qual-toggle"));
                if (previousView === "changes") window.showChanges(panel.querySelector(".changes-btn"), activeId);
            }
            saveCooldown(Date.now() + cooldown);
            status.textContent = "Entry lists updated from WTA at " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) + ".";
        } catch {
            saveCooldown(0);
            status.textContent = "Refresh failed. Your current lists are still shown. Please try again.";
        } finally {
            pending = false;
            updateButton();
        }
    });

    readCooldown();
    updateButton();
    window.setInterval(updateButton, 1000);
    window.addEventListener("storage", event => {
        if (event.key === storageKey || event.key === null) {
            readCooldown();
            updateButton();
        }
    });
})();
