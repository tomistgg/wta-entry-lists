# Shared WTA endpoint for Haute Cadence and WTA Tracker

This Worker relays live WTA calendar, match, ranking, player-identity, and entry-list requests.
It returns upstream responses without saving them to repository files. It does not trigger GitHub Actions.
Both websites can keep their current GitHub Pages addresses.

The current public Worker base URL is `https://tennis-wta-api.schiter-tomas.workers.dev`.
Use this assigned address for checks, rather than copying a placeholder subdomain from an example.

## Deploy from the Cloudflare dashboard

1. Create a Cloudflare account and use Workers Free. A custom domain is not required.
2. In the dashboard, open **Workers & Pages**, choose **Create application**, then
   **Create Worker** or the **Hello World** template, depending on the dashboard layout.
3. Name the Worker `tennis-wta-api` and deploy the initial example. If asked for a
   Workers subdomain, choose one; it is the middle part of your `workers.dev` address.
4. Open the Worker's code editor (**Edit code**). Replace the example with the entire contents
   of `worker.mjs` from this directory. Do not paste `worker.test.mjs`.
5. The `ALLOWED_ORIGIN` constant is `https://tomistgg.github.io`. This covers both websites
   when they use that GitHub Pages hostname. Website paths are not part of an origin.
   If the websites use a different hostname, this value must be adjusted before integration.
6. Click **Deploy**. Copy the Worker's production address from its overview/settings,
   for example `https://tennis-wta-api.your-subdomain.workers.dev`.
7. Visit that address plus `/health`. The response should be `{"ok":true}`.
8. Visit that address plus `/api/tennis/tournaments/1110/2026/matches?states=C`.
   A working WTA connection returns JSON containing a `matches` array. This example is a
   known tournament edition, not the dynamically selected list of current events.
   A 502 response means the Worker was reached but WTA returned an error or could not be reached.
9. Supply the public Worker base URL for the website integration. No password, API token,
   GitHub token, custom domain, or additional storage binding is needed for this relay.

When updating the code, paste the latest `worker.mjs` into **Edit code** and deploy again.
Cloudflare supports `redirect: "manual"` here; `redirect: "error"` throws before contacting WTA.
If the relay reports a connection failure after updating, inspect the Worker's logs for
`WTA relay fetch failed:` and the underlying error. An upstream redirect is reported as a
502 with `upstream_status` set to the 3xx status; it is not followed automatically.

## Website integration

Both website clients are configured for the public Worker address above. Deploying the Worker alone
does not publish website changes: their updated source files must also be published through GitHub Pages.

Haute Cadence's `wta-live.mjs` discovers current events through `/api/tennis/tournaments/`, fetches their
`/api/tennis/tournaments/{id}/{year}/matches?states=C` responses, and transforms the completed
singles matches in browser memory using the existing last-24-hours rules. It also collects current
singles brackets for Draw refreshes. Its existing player
names, rankings, and calendar labels can still use the WTARG files. Failures should leave the
currently displayed results in place and show an error.

WTA Tracker's `entry-lists.mjs` discovers upcoming events through the calendar route, loads entry-list HTML from
`/site/tournaments/{id}/{slug}/{year}/player-list`, parses only main-draw and qualifying singles
entries, and attaches the relevant deadline-week rankings from `/api/tennis/players/ranked`.
Player identities use ranking IDs and the singles entry cards. This moves the existing Python
parsing/rendering into browser code; the live page cannot run `main.py`.
The two-minute button cooldown is browser state; this simple relay does not impose a global
cooldown across every visitor. A global cooldown needs shared server state in addition to this relay.

Tracker's historical additions/removals still require a previous saved list. Live entries can be
fetched without saving them, while the existing scheduled scraper retains the shared change log.
An unsaved browser refresh alone cannot add changes to that shared history.

After integration, publish the website changes and verify Refresh from both live website origins.
A direct visit to the Worker tests connectivity, but does not by itself test browser CORS.
Also verify failure behavior and the Tracker cooldown. The scheduled feeds can remain available
as an explicitly labelled fallback if a live WTA request fails.

## Local checks of the relay code

Run `node --test cloudflare/worker.test.mjs` from the WTA Tracker directory.
These checks mock WTA responses; a deployed Worker still needs the live connectivity checks above.

Official references:

- https://developers.cloudflare.com/learning-paths/workers/get-started/first-worker/
- https://developers.cloudflare.com/workers/examples/cors-header-proxy/
- https://developers.cloudflare.com/workers/platform/limits/
