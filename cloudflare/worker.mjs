// Both GitHub Pages websites share this origin, even though their paths differ.
const ALLOWED_ORIGIN = "https://tomistgg.github.io";
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
let driveToken;

function base64url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function googleAccessToken(credentials) {
    if (driveToken?.credentials === credentials && driveToken.expires > Date.now()) return driveToken.promise;
    const session = { credentials, expires: Date.now() + 3500000 };
    session.promise = (async () => {
        const account = JSON.parse(credentials);
        if (account.type !== "service_account" || !account.client_email || !account.private_key) {
            throw new Error("Invalid service account configuration");
        }
        const encode = value => base64url(new TextEncoder().encode(JSON.stringify(value)));
        const now = Math.floor(Date.now() / 1000);
        const unsigned = encode({ alg: "RS256", typ: "JWT" }) + "." + encode({
            iss: account.client_email, scope: "https://www.googleapis.com/auth/drive.readonly",
            aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
        });
        const pem = account.private_key.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, "");
        const key = await crypto.subtle.importKey("pkcs8", Uint8Array.from(atob(pem), c => c.charCodeAt(0)),
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
        const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
        const response = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: unsigned + "." + base64url(new Uint8Array(signature)) }),
            redirect: "manual", signal: AbortSignal.timeout(20000),
        });
        if (!response.ok) throw new Error("Google authentication failed");
        const token = await response.json();
        if (typeof token.access_token !== "string" || !(token.expires_in > 60)) throw new Error("Invalid Google token");
        session.expires = Date.now() + Math.min(token.expires_in - 60, 3500) * 1000;
        return token.access_token;
    })();
    driveToken = session;
    try { return await session.promise; }
    catch (error) { session.expires = 0; throw error; }
}

async function driveFetch(url, env) {
    const token = await googleAccessToken(env.GOOGLE_SERVICE_ACCOUNT_JSON);
    const response = await fetch(url, {
        headers: { Authorization: "Bearer " + token }, redirect: "manual", signal: AbortSignal.timeout(20000),
    });
    if (response.status === 401) driveToken.expires = 0;
    if (!response.ok) throw new Error("Google Drive request failed");
    return response;
}

async function cachePhotoResponse(key, response, ctx) {
    if (!globalThis.caches?.default) return;
    const pending = caches.default.put(key, response.clone()).catch(() => {});
    if (ctx) ctx.waitUntil(pending);
    else await pending;
}

async function playerPhotoIndex(env, base, ctx) {
    const key = new Request(base + "/_photo-cache/" + env.PLAYER_PHOTOS_FOLDER_ID + "/index");
    const cached = await globalThis.caches?.default.match(key);
    if (cached) return cached.json();
    const files = [];
    const pages = new Set();
    let pageToken = "";
    do {
        const url = new URL("https://www.googleapis.com/drive/v3/files");
        url.search = new URLSearchParams({
            q: "'" + env.PLAYER_PHOTOS_FOLDER_ID + "' in parents and trashed = false",
            fields: "nextPageToken,incompleteSearch,files(id,name,mimeType,size,modifiedTime)",
            pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true",
        });
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const data = await (await driveFetch(url, env)).json();
        if (!Array.isArray(data.files) || data.incompleteSearch) throw new Error("Incomplete photo index");
        files.push(...data.files.filter(file => PHOTO_TYPES.has(file.mimeType) &&
            typeof file.name === "string" && typeof file.modifiedTime === "string" &&
            /^[A-Za-z0-9_-]+$/.test(file.id) && /\.(png|jpe?g|webp)$/i.test(file.name) &&
            Number(file.size) > 0 && Number(file.size) <= MAX_PHOTO_BYTES));
        pageToken = data.nextPageToken || "";
        if (pages.has(pageToken)) throw new Error("Repeated Drive page");
        pages.add(pageToken);
    } while (pageToken);
    // Drive permits duplicate filenames; the latest modified photo wins in the client.
    files.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime) || a.id.localeCompare(b.id));
    await cachePhotoResponse(key, Response.json(files, { headers: { "Cache-Control": "public, max-age=300" } }), ctx);
    return files;
}

async function playerPhotos(request, env, ctx, headers) {
    const json = (data, status) => Response.json(data, { status, headers });
    const url = new URL(request.url);
    const match = /^\/photos\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (url.pathname !== "/photos" && !match) return json({ error: "Unknown photo endpoint." }, 404);
    if (!env.GOOGLE_SERVICE_ACCOUNT_JSON || !/^[A-Za-z0-9_-]+$/.test(env.PLAYER_PHOTOS_FOLDER_ID || "")) {
        return json({ error: "Player photos are not configured on the Worker." }, 503);
    }
    try {
        const files = await playerPhotoIndex(env, url.origin, ctx);
        if (!match) return json({ photos: files.map(file => ({ name: file.name,
            path: "/photos/" + file.id + "?v=" + encodeURIComponent(file.modifiedTime) })) }, 200);
        // Only image files in the configured folder may be downloaded, even if another ID is known.
        const file = files.find(item => item.id === match[1]);
        if (!file) return json({ error: "Player photo not found." }, 404);
        const key = new Request(url.origin + "/_photo-cache/" + env.PLAYER_PHOTOS_FOLDER_ID + "/" + file.id +
            "?v=" + encodeURIComponent(file.modifiedTime));
        const cached = await globalThis.caches?.default.match(key);
        if (cached) return new Response(cached.body, { headers: { ...headers,
            "Content-Type": file.mimeType, "Cache-Control": "public, max-age=300" } });
        const response = await driveFetch("https://www.googleapis.com/drive/v3/files/" + file.id +
            "?alt=media&supportsAllDrives=true", env);
        const type = response.headers.get("Content-Type")?.split(";")[0].trim();
        if (type !== file.mimeType || !PHOTO_TYPES.has(type) || Number(response.headers.get("Content-Length")) > MAX_PHOTO_BYTES) {
            throw new Error("Unsupported player image");
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        const png = bytes[0] === 137 && bytes[1] === 80 && bytes[2] === 78 && bytes[3] === 71;
        const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
        const webp = String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
            String.fromCharCode(...bytes.slice(8, 12)) === "WEBP";
        if (bytes.length > MAX_PHOTO_BYTES || !({ "image/png": png, "image/jpeg": jpeg, "image/webp": webp })[type]) {
            throw new Error("Invalid player image");
        }
        const photo = new Response(bytes, { headers: { ...headers, "Content-Type": type,
            "Cache-Control": "public, max-age=300" } });
        await cachePhotoResponse(key, photo, ctx);
        return photo;
    } catch {
        return json({ error: "Player photos could not be loaded. Check the Google Drive API, secret, and folder access." }, 502);
    }
}

export default {
    async fetch(request, env = {}, ctx) {
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
        if (url.pathname === "/photos" || url.pathname.startsWith("/photos/")) {
            return playerPhotos(request, env, ctx, headers);
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
