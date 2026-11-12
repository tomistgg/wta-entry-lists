# WTA entry lists

Cloudflare is the website's only data updater. GitHub Pages hosts the permanent `index.html`
shell, styles, fonts, images, and JavaScript. Opening the site loads the saved tournament menu,
Main Draw and Qualifying lists, deadline-week singles rankings, and Changes from Cloudflare D1.
There is no Python scraper, scheduled GitHub data workflow, or generated tournament HTML.

The menu's **Refresh** button asks `https://tennis-wta-api.schiter-tomas.workers.dev` to fetch
and save current WTA singles entry lists for the next four weeks. Collection runs in bounded
server-side stages, reusing completed ranking dates. Doubles players never enter these lists.
A complete snapshot is saved before success is reported, with a global two-minute cooldown.
Other visitors and page reloads use that same saved update.

A one-minute Cloudflare Cron Trigger advances unfinished jobs and starts an automatic refresh
when the saved data is at least 30 minutes old. It does not collect every tournament every minute.
Failed requests preserve the previous complete snapshot. The page shows loading and unavailable
states when it cannot initially obtain saved data, and keeps already displayed lists on a failure.
The selected tournament and Main Draw, Qualifying, or Changes view survive refreshes when available.

Each successful refresh compares WTA player IDs and records additions/removals separately for each
draw. The first observed list establishes its baseline; ranking and spelling changes do not create
entry events. Missing lists do not imply mass withdrawals. If WTA publishes qualifying while removing
the main draw, the previous main draw is retained with an explanatory notice.

Only tournaments in the displayed upcoming four-week window are retained. Their entry lists, Changes,
and comparison baselines are deleted when they leave that view; no permanent archive is maintained.
Scheduled cleanup also runs when WTA is unavailable, without discarding valid remaining tournaments.
Temporarily missing tournaments are removed from storage after a successful complete calendar update.

The one-time migration keeps only the old Changes belonging to currently displayed tournament editions.
Imported records are deleted with their tournament and never carried into another year's edition.
They have dates only; their placeholder timestamps do not represent exact detection times. The old
full-history JSON is removed. Current Changes avoid duplicates of matching D1 events.

See [D1_SETUP.md](cloudflare/D1_SETUP.md) for initial setup and migration from the old scraper,
[DEPLOY.md](cloudflare/DEPLOY.md) for direct deployments, and [SETUP.md](cloudflare/SETUP.md)
for the shared WTA relay and Haute Cadence photo routes.

```powershell
npm.cmd ci
npm.cmd run build:worker
npm.cmd run test:entries
npm.cmd run deploy:worker:dry-run
npm.cmd run deploy:worker
```

Edit `cloudflare/worker-source.mjs` and its modules, then rebuild the standalone `cloudflare/worker.mjs`.
Website releases and Worker deployments are separate. Publishing code changes still uses GitHub Pages;
ordinary data updates only write to D1 and never create repository commits.

The shared-data backend for Haute Cadence is deployed. Its read/refresh
routes, jobs, and shared-cache behavior are documented in [SHARED_DATA.md](cloudflare/SHARED_DATA.md).
Haute Cadence reads the shared saved feeds; WTA Tracker keeps its entry-list routes and shares the source caches.
