const SOURCE_TTL = 120000;
const CALENDAR_TTL = 1800000;
const HISTORICAL_TTL = 86400000;
const MAX_CACHE_BYTES = 1900000;
const MAX_RESPONSE_BYTES = 8000000;
const date = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const numericId = value => /^\d+$/.test(String(value ?? ""));
const bytes = value => new TextEncoder().encode(value).length;

function monday(now) {
    const today = new Date(now);
    today.setUTCDate(today.getUTCDate() - (today.getUTCDay() + 6) % 7);
    return today.toISOString().slice(0, 10);
}

function requestDetails(path, params, now) {
    const canonical = String(path).replace(/^\/api(?=\/tennis\/)/, "").replace(/\/$/, "");
    let kind, allowed;
    if (canonical === "/tennis/tournaments") {
        kind = "calendar"; allowed = ["from", "to", "page", "pageSize", "excludeLevels"];
    } else if (canonical === "/tennis/players/ranked") {
        kind = "rankings"; allowed = ["metric", "type", "sort", "at", "page", "pageSize"];
    } else if (/^\/tennis\/tournaments\/\d+\/\d{4}\/matches$/.test(canonical)) {
        kind = "matches"; allowed = ["states"];
    } else if (/^\/tennis\/players\/\d+\/matches$/.test(canonical)) {
        kind = "history"; allowed = ["year", "type", "page", "pageSize"];
    } else throw new Error("Unknown shared WTA source.");
    if (!object(params) && !(params instanceof URLSearchParams)) throw new Error("Invalid WTA query parameters.");
    const entries = params instanceof URLSearchParams ? [...params] : Object.entries(params);
    const query = new URLSearchParams();
    for (const [key, value] of entries) {
        if (!allowed.includes(key) || query.has(key) || !["string", "number"].includes(typeof value)) {
            throw new Error("Invalid WTA query parameter.");
        }
        query.set(key, String(value));
    }
    if (kind !== "matches") {
        if (!query.has("page")) query.set("page", "0");
        if (!query.has("pageSize")) query.set("pageSize", "100");
        if (!/^\d+$/.test(query.get("page")) || Number(query.get("page")) > 10000 ||
            !/^\d+$/.test(query.get("pageSize")) || Number(query.get("pageSize")) < 1 ||
            Number(query.get("pageSize")) > 1000) throw new Error("Invalid WTA pagination.");
    }
    if (kind === "calendar" && (!date(query.get("from")) || !date(query.get("to")) ||
        query.get("from") > query.get("to") || query.has("excludeLevels") && query.get("excludeLevels") !== "ITF")) {
        throw new Error("Invalid WTA calendar window.");
    }
    if (kind === "rankings") {
        for (const [key, value] of [["metric", "SINGLES"], ["type", "rankSingles"], ["sort", "asc"]]) {
            if (query.has(key) && query.get(key) !== value) throw new Error("Only singles rankings are supported.");
            query.set(key, value);
        }
        if (!date(query.get("at"))) throw new Error("A ranking date is required.");
    }
    if (kind === "history") {
        if (query.has("type") && query.get("type") !== "S") throw new Error("Only singles history is supported.");
        query.set("type", "S");
        if (!/^\d{4}$/.test(query.get("year") || "")) throw new Error("A player history year is required.");
    }
    if (kind === "matches" && query.has("states") && query.get("states") !== "C") {
        throw new Error("Unknown WTA match state filter.");
    }
    query.sort();
    const url = new URL("https://api.wtatennis.com");
    url.pathname = canonical + (kind === "calendar" ? "/" : "");
    url.search = query.toString();
    return { kind, query, url, scope: url.pathname + url.search,
        ttl: kind === "rankings" && query.get("at") < monday(now) ? HISTORICAL_TTL : SOURCE_TTL };
}

function validatePage(data, query) {
    if (!object(data) || !Array.isArray(data.content) || !object(data.pageInfo) ||
        !Number.isInteger(data.pageInfo.numEntries) || data.pageInfo.numEntries < 0 ||
        Number(data.pageInfo.page) !== Number(query.get("page"))) throw new Error("Incomplete WTA page.");
    const size = Number(query.get("pageSize")), start = Number(query.get("page")) * size;
    if (data.content.length > size || start + data.content.length > data.pageInfo.numEntries ||
        data.content.length < size && start + data.content.length < data.pageInfo.numEntries) {
        throw new Error("Incomplete WTA page.");
    }
    return data.content;
}

function validateResponse(data, details) {
    if (details.kind === "calendar") {
        const rows = validatePage(data, details.query);
        if (rows.some(row => !validTournament(row, false))) {
            throw new Error("Invalid WTA tournament identity.");
        }
    } else if (details.kind === "rankings") {
        const rows = Array.isArray(data) ? data : validatePage(data, details.query);
        if (!Number(details.query.get("page")) && !rows.length || rows.length > Number(details.query.get("pageSize")) ||
            rows.some(row => !object(row) || !numericId(row.player?.id))) {
            throw new Error("Invalid WTA ranking response.");
        }
    } else {
        if (!object(data) || !Array.isArray(data.matches) || data.matches.some(row => !object(row))) {
            throw new Error("Invalid WTA match response.");
        }
        if (object(data.pageInfo) && (Number(data.pageInfo.page) !== Number(details.query.get("page") || 0) ||
            !Number.isInteger(data.pageInfo.numEntries) || data.pageInfo.numEntries < data.matches.length ||
            details.kind === "matches" && data.pageInfo.numEntries !== data.matches.length)) {
            throw new Error("Incomplete WTA match response.");
        }
    }
    return data;
}

function validTournament(row, requireEnd = true) {
    if (!object(row) || !numericId(row.tournamentGroup?.id) || typeof row.tournamentGroup?.name !== "string" ||
        !row.tournamentGroup.name.trim() || !/^\d{4}$/.test(String(row.year)) || typeof row.level !== "string" ||
        !row.level.trim() || typeof row.startDate !== "string" || requireEnd && typeof row.endDate !== "string") return false;
    const start = row.startDate.slice(0, 10), end = typeof row.endDate === "string" ? row.endDate.slice(0, 10) : "";
    return date(start) && (!requireEnd && row.endDate == null || date(end) && start <= end);
}

function compactRankings(rows) {
    const seen = new Set();
    if (!Array.isArray(rows) || !rows.length || rows.some(row => {
        if (!object(row) || typeof row.id !== "string" || !numericId(row.id) || seen.has(row.id) || typeof row.name !== "string" ||
            typeof row.country !== "string" || row.rank !== null && !(Number.isSafeInteger(row.rank) && row.rank > 0)) return true;
        seen.add(row.id);
        return false;
    })) throw new Error("Invalid completed singles ranking cache.");
    return rows;
}

async function responseJSON(response) {
    if (Number(response.headers.get("Content-Length")) > MAX_RESPONSE_BYTES) throw new Error("WTA response exceeds the collection limit.");
    const reader = response.body?.getReader(), chunks = [];
    let length = 0;
    if (reader) {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            length += value.byteLength;
            if (length > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new Error("WTA response exceeds the collection limit.");
            }
            chunks.push(value);
        }
    }
    const data = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); }
    catch { text = new TextDecoder("windows-1252").decode(data); }
    try { return JSON.parse(text); }
    catch { throw new Error("WTA returned invalid JSON."); }
}

export function createSharedIO(db, { now = Date.now, fetch: upstream = globalThis.fetch } = {}) {
    async function cached(kind, scope, ttl) {
        try {
            const row = await db.prepare("SELECT payload_json, fetched_at, expires_at FROM wta_snapshots " +
                "WHERE kind = ? AND scope = ? AND expires_at > ?").bind(kind, scope, now()).first();
            const fetched = Date.parse(row?.fetched_at);
            if (!row || !Number.isFinite(fetched) || fetched > now() + 1000 || now() - fetched >= ttl) return null;
            return JSON.parse(row.payload_json);
        } catch { return null; }
    }
    async function cache(kind, scope, payload, ttl) {
        const json = JSON.stringify(payload);
        if (bytes(json) > MAX_CACHE_BYTES) return false;
        try {
            const fetched = now();
            await db.prepare("INSERT INTO wta_snapshots (kind, scope, payload_json, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?) " +
                "ON CONFLICT(kind, scope) DO UPDATE SET payload_json = excluded.payload_json, " +
                "fetched_at = excluded.fetched_at, expires_at = excluded.expires_at")
                .bind(kind, scope, json, new Date(fetched).toISOString(), fetched + ttl).run();
            return true;
        } catch (error) { return /no such table: wta_snapshots/i.test(String(error?.message)) ? null : false; }
    }
    return {
        async fetchJSON(path, params = {}) {
            const details = requestDetails(path, params, now());
            const saved = await cached("source", details.scope, details.ttl);
            if (saved !== null) {
                try { return validateResponse(saved, details); } catch { /* Refetch corrupt or incomplete cache entries. */ }
            }
            const response = await upstream(details.url, { headers: { Accept: "application/json", account: "wta",
                Origin: "https://www.wtatennis.com", Referer: "https://www.wtatennis.com/" },
                redirect: "manual", signal: AbortSignal.timeout(12000), cache: "no-store" });
            if (!response.ok) throw new Error("WTA returned an unsuccessful collection response.");
            const data = validateResponse(await responseJSON(response), details);
            await cache("source", details.scope, data, details.ttl);
            return data;
        },
        async cachedCalendar(from, to) {
            if (!date(from) || !date(to) || from > to) throw new Error("Invalid WTA calendar window.");
            const saved = await cached("calendar_source", "global", CALENDAR_TTL);
            if (!object(saved) || !date(saved.from) || !date(saved.to) || saved.from > from || saved.to < to || !Array.isArray(saved.items)) return null;
            const seen = new Set();
            if (saved.items.some(row => {
                const key = row?.tournamentGroup?.id + ":" + row?.year;
                if (!validTournament(row) || seen.has(key)) return true;
                seen.add(key);
                return false;
            })) return null;
            return saved;
        },
        async loadRankings(at) {
            if (!date(at)) throw new Error("Invalid singles ranking date.");
            const ttl = at < monday(now()) ? HISTORICAL_TTL : SOURCE_TTL;
            const saved = await cached("rankings", "singles:" + at, ttl);
            if (saved !== null) { try { return compactRankings(saved); } catch { /* Try the prior complete cache. */ } }
            // Legacy rows do not record fetch time, so current-week freshness cannot be established.
            if (at >= monday(now())) return null;
            try {
                const row = await db.prepare("SELECT rows_json FROM entry_ranking_cache WHERE ranking_date = ? AND expires_at > ?")
                    .bind(at, now()).first();
                return row ? compactRankings(JSON.parse(row.rows_json)) : null;
            } catch { return null; }
        },
        async saveRankings(at, rows) {
            if (!date(at)) throw new Error("Invalid singles ranking date.");
            compactRankings(rows);
            const ttl = at < monday(now()) ? HISTORICAL_TTL : SOURCE_TTL;
            if (await cache("rankings", "singles:" + at, rows, ttl) === null && at < monday(now())) {
                // The original entry-list schema can keep working before shared tables are applied.
                const json = JSON.stringify(rows);
                if (bytes(json) <= MAX_CACHE_BYTES) {
                    try {
                        await db.prepare("INSERT INTO entry_ranking_cache VALUES (?, ?, ?) ON CONFLICT(ranking_date) " +
                            "DO UPDATE SET rows_json = excluded.rows_json, expires_at = excluded.expires_at")
                            .bind(at, json, now() + ttl).run();
                    } catch { /* A completed ranking cache is optional; the collector still has its verified rows. */ }
                }
            }
        },
    };
}
