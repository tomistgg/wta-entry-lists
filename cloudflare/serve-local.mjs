import { createServer } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const host = "127.0.0.1", port = 8766;
const staticFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/index.html", ["index.html", "text/html; charset=utf-8"]],
    ["/refresh.css", ["refresh.css", "text/css; charset=utf-8"]],
    ["/refresh.js", ["refresh.js", "text/javascript; charset=utf-8"]],
    ["/entry-lists.mjs", ["entry-lists.mjs", "text/javascript; charset=utf-8"]],
    ["/FondoDegradado.png", ["FondoDegradado.png", "image/png"]],
    ["/LOGO.png", ["LOGO.png", "image/png"]],
    ["/Montserrat-ExtraBold.ttf", ["Montserrat-ExtraBold.ttf", "font/ttf"]],
    ["/Montserrat-SemiBold.ttf", ["Montserrat-SemiBold.ttf", "font/ttf"]],
    ["/assets/vendor/html2pdf-0.10.1.bundle.min.js", ["assets/vendor/html2pdf-0.10.1.bundle.min.js", "text/javascript; charset=utf-8"]],
    ["/assets/vendor/html2pdf-LICENSE", ["assets/vendor/html2pdf-LICENSE", "text/plain; charset=utf-8"]],
    ["/assets/vendor/html2pdf.bundle.min.js.LICENSE.txt", ["assets/vendor/html2pdf.bundle.min.js.LICENSE.txt", "text/plain; charset=utf-8"]],
    ["/assets/flags/LICENSE", ["assets/flags/LICENSE", "text/plain; charset=utf-8"]],
]);
for (const entry of await readdir(resolve(root, "assets/flags"), { withFileTypes: true })) {
    if (entry.isFile() && /^[a-z]{2}\.svg$/.test(entry.name)) {
        const path = "assets/flags/" + entry.name;
        staticFiles.set("/" + path, [path, "image/svg+xml"]);
    }
}

function send(response, status, type, body) {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Content-Length": Buffer.byteLength(body) });
    response.end(body);
}
const json = (response, status, body) => send(response, status, "application/json; charset=utf-8", JSON.stringify(body));

export function createLocalSiteServer(fetchBackend = fetch) {
    const server = createServer(async (request, response) => {
        try {
            const url = new URL(request.url, `http://${host}:${port}`);
            const shared = url.pathname === "/entry-lists" || url.pathname === "/entry-lists/refresh";
            if (shared) {
                const method = url.pathname.endsWith("/refresh") ? "POST" : "GET";
                if (request.method !== method) return json(response, 405, { error: "Method not allowed." });
                if (method === "POST") {
                    const boundPort = server.address().port;
                    const origins = new Set([undefined, `http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`]);
                    if (!origins.has(request.headers.origin)) return json(response, 403, { error: "Origin not allowed." });
                    if ((request.headers["content-length"] || "0") !== "0" || request.headers["transfer-encoding"]) {
                        request.resume();
                        return json(response, 400, { error: "Refresh accepts an empty request only." });
                    }
                }
                const upstream = await fetchBackend("http://127.0.0.1:8787" + url.pathname + url.search, {
                    method, headers: { Origin: "https://tomistgg.github.io", Accept: "application/json" },
                    signal: AbortSignal.timeout(method === "POST" ? 90000 : 30000), redirect: "error",
                });
                const body = await upstream.text();
                const value = JSON.parse(body);
                if (Buffer.byteLength(body) > 8 * 1024 * 1024 || !value || typeof value !== "object" || Array.isArray(value)) {
                    throw new Error("Invalid local backend response.");
                }
                return json(response, upstream.status, value);
            }
            if (request.method !== "GET" && request.method !== "HEAD") return json(response, 405, { error: "Method not allowed." });
            const asset = staticFiles.get(url.pathname);
            if (!asset) return json(response, 404, { error: "Not found." });
            let body = await readFile(resolve(root, asset[0]));
            if (asset[0] === "entry-lists.mjs") {
                const source = body.toString("utf8");
                const original = 'export const BASE = "https://tennis-wta-api.schiter-tomas.workers.dev";';
                if (!source.startsWith(original)) throw new Error("The entry-list API configuration changed.");
                body = Buffer.from(source.replace(original, "export const BASE = window.location.origin;"));
            }
            response.writeHead(200, { "Content-Type": asset[1], "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff", "Content-Length": body.length });
            response.end(request.method === "HEAD" ? undefined : body);
        } catch (error) {
            console.error("Local preview request failed:", error.message);
            if (!response.headersSent) json(response, 503, { error: "Local preview backend is unavailable. Please try again." });
            else response.end();
        }
    });
    return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const server = createLocalSiteServer();
    server.listen(port, host, () => console.log(`WTA Tracker: http://${host}:${port}/`));
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit(0)));
}
