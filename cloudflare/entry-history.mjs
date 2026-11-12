const baseline = players => players.map(({ id, name }) => ({ id, name }));

function signature(date, change) {
    const name = change.name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
        .toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    return [date, change.draw, change.action, name].join("|");
}

export function withLegacyHistory(model, legacy, savedAt) {
    const changes = model.changes || [];
    const known = new Set(changes.flatMap(change => [change.date, change.at.slice(0, 10)]
        .map(date => signature(date, change))));
    // The log's tournament IDs were reused; only this edition's deadline onward belongs to its history.
    const imported = legacy.filter(change => change.date >= model.dates.main && change.at <= savedAt &&
        !known.has(signature(change.date, change)));
    return { ...model, changes: [...changes, ...imported].sort((a, b) => b.at.localeCompare(a.at)) };
}

export function previousEntryModels(snapshot) {
    return snapshot?.models || [];
}

export function withEntryHistory(models, previous, detectedAt) {
    const at = new Date(detectedAt).toISOString();
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en", {
        timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date(at)).map(part => [part.type, part.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const saved = new Map(previousEntryModels(previous).map(model => [model.id + ":" + model.week, model]));
    return models.map(model => {
        const old = saved.get(model.id + ":" + model.week);
        const changes = [], baselines = {};
        for (const draw of ["main", "qualifying"]) {
            const before = old?.change_baselines?.[draw] || baseline(old?.[draw] || []);
            const current = model[draw];
            // An absent list is not evidence that every player withdrew.
            if (!current.length || draw === "main" && model.main_retained) {
                baselines[draw] = before.length ? before : baseline(current);
                continue;
            }
            if (before.length) {
                const previousIds = new Set(before.map(player => player.id));
                const currentIds = new Set(current.map(player => player.id));
                const record = (player, action) => changes.push({ id: `${at}:${draw}:${action}:${player.id}`,
                    at, date, draw, action, player_id: player.id, name: player.name });
                for (const player of before) if (!currentIds.has(player.id)) record(player, "removed");
                for (const player of current) if (!previousIds.has(player.id)) record(player, "added");
            }
            baselines[draw] = baseline(current);
        }
        return { ...model, changes: [...changes, ...(old?.changes || [])], change_baselines: baselines };
    });
}
