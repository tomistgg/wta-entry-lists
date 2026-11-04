// Both GitHub Pages websites share this origin, even though their paths differ.
const ALLOWED_ORIGIN = "https://tomistgg.github.io";

export default {
    async fetch(request) {
        const origin = request.headers.get("Origin");
        const headers = {
            "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
            "Access-Control-Allow-Methods": "GET, OPTIONS",
            "Access-Control-Allow-Headers": "Accept",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Vary": "Origin",
        };
        const json = (data, status = 200) => Response.json(data, { status, headers });

        if (origin && origin !== ALLOWED_ORIGIN) {
            return json({ error: "Website origin is not allowed." }, 403);
        }
        if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers });
        }
        if (request.method !== "GET") {
            return new Response(null, { status: 405, headers: { ...headers, Allow: "GET, OPTIONS" } });
        }

        const url = new URL(request.url);
        if (url.pathname === "/health") {
            return json({ ok: true });
        }

        const apiPath = url.pathname.slice("/api".length);
        const isApi = url.pathname.startsWith("/api/") && (
            /^\/tennis\/tournaments\/?$/.test(apiPath) ||
            /^\/tennis\/tournaments\/\d+\/\d{4}\/matches\/?$/.test(apiPath) ||
            /^\/tennis\/players\/ranked\/?$/.test(apiPath) ||
            /^\/tennis\/players\/\d+\/matches\/?$/.test(apiPath)
        );
        const sitePath = url.pathname.slice("/site".length);
        const isEntryList = url.pathname.startsWith("/site/") &&
            /^\/tournaments\/\d+\/[a-z0-9-]+\/\d{4}\/player-list\/?$/i.test(sitePath);
        if (!isApi && !isEntryList) {
            return json({ error: "Unknown WTA endpoint." }, 404);
        }

        const upstream = new URL(isApi ? "https://api.wtatennis.com" : "https://www.wtatennis.com");
        upstream.pathname = isApi ? apiPath : sitePath;
        upstream.search = url.search;

        try {
            const response = await fetch(upstream, {
                headers: {
                    "Accept": isApi ? "application/json" : "text/html",
                    "Origin": "https://www.wtatennis.com",
                    "Referer": "https://www.wtatennis.com/",
                    "account": "wta",
                },
                redirect: "manual",
                signal: AbortSignal.timeout(20000),
                cache: "no-store",
            });
            if (!response.ok) {
                return json({ error: "WTA request failed.", upstream_status: response.status }, 502);
            }
            return new Response(response.body, {
                headers: {
                    ...headers,
                    // Entry-list HTML is data for DOMParser, never an executable page on this host.
                    "Content-Type": isApi ? "application/json" : "text/plain; charset=utf-8",
                },
            });
        } catch (error) {
            console.error("WTA relay fetch failed:", error);
            return json({ error: "WTA could not be reached. Please try again." }, 502);
        }
    },
};
