# WTA entry lists

The public site starts with WTA singles entry lists collected by `.github/workflows/update_list.yml`,
which runs on a 30-minute schedule and can also be started manually in GitHub Actions. It also loads
newer complete snapshots saved by the shared Cloudflare Worker in D1.

The menu's **Refresh** button asks the Worker at `https://tennis-wta-api.schiter-tomas.workers.dev`
to fetch and save current WTA singles entry lists. It discovers the next four weeks of events,
reads Singles and Qualifying separately, and attaches each list's deadline-week singles rankings.
Doubles players never enter these lists. Collection runs in bounded server-side stages, reusing
completed ranking dates. A complete snapshot is saved in D1 before success is reported.

The selected tournament and view are retained when available. Saved lists survive page reloads and
are shared with other visitors. A successful refresh starts a global two-minute cooldown stored in D1.
Failed or incomplete requests retain the previous complete snapshot; short failure backoff prevents
repeated failing requests. A one-minute Cron Trigger advances unfinished jobs and starts automatic
updates when the saved data is at least 30 minutes old.

Every successful shared refresh also compares Main Draw and Qualifying entries by WTA player ID and
saves detected additions/removals in D1 alongside the lists. Manual and background refreshes use the
same history. The first observed list establishes its baseline; ranking or spelling changes do not
create entry changes. Temporarily unavailable lists do not create mass withdrawals, and their last
nonempty baselines are retained. History also survives a temporarily missing tournament within the
current four-week window.

The Changes view merges this shared history with the published GitHub scraper history, avoiding
duplicate published records. GitHub continues maintaining its repository archive independently.
If WTA lists qualifying while removing its main-draw list, the previous main draw is retained with
an explicit notice. Source timestamps prevent older D1 lists from hiding a newer publication, while
its saved Changes can still be displayed.

`main.py` generates `index.html`. Keep the refresh controls and the references to `refresh.css`
and `refresh.js` in its HTML template so scheduled updates retain the button.

Follow [the D1 setup guide](cloudflare/D1_SETUP.md) to create the database, bind it to the existing Worker,
deploy its code, add the schedule, and verify saved updates. See [the shared Worker guide](cloudflare/SETUP.md)
for WTA relay and Haute Cadence photo setup. Build the standalone dashboard Worker with
`npm run build:worker`; run the focused entry-list checks with `npm run test:entries`.

Direct deployments are configured in [cloudflare/wrangler.json](cloudflare/wrangler.json) for the existing
Worker, D1 database, and schedule. After a one-time Wrangler login, `npm run deploy:worker` builds,
tests, and deploys the Worker. `npm run deploy:worker:dry-run` checks the upload without publishing.
Dashboard variables and encrypted secrets are retained. Website changes publish separately through
GitHub Pages after review. See [DEPLOY.md](cloudflare/DEPLOY.md).
