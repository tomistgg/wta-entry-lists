# Cloudflare as the only entry-list data source

GitHub Pages hosts the static website. The existing Cloudflare Worker collects the tournament menu,
entry lists, rankings, and Changes, saves them in D1, and serves them to visitors. The Python scraper
and GitHub update schedule have been removed.

| Resource | Value |
| --- | --- |
| Worker | `tennis-wta-api` |
| Public address | `https://tennis-wta-api.schiter-tomas.workers.dev` |
| D1 database | `wta-entry-lists` |
| Worker binding | `ENTRY_LISTS_DB` |

## Retention

Only tournaments in the website's upcoming four-week view are stored. Its window starts next Monday,
as before. Entry lists, Changes, baselines, and imported history are deleted when their tournament
leaves that view. A successful complete calendar update also removes tournaments no longer listed.
There is no permanent tournament archive or repository history feed.

The one-minute scheduled task cleans up expired data before contacting WTA, so an upstream outage
does not keep past tournaments indefinitely. Cleanup preserves valid remaining lists and the real
WTA fetch timestamps. It respects an active refresh lease rather than racing another visitor.
The browser rebuilds the menu when the retained window changes, even without a newer WTA fetch.

| Table | Purpose |
| --- | --- |
| `entry_list_state` | Current visible models, Changes, baselines, refresh job, lease, and shared cooldown. |
| `entry_ranking_cache` | Temporary deadline-week rankings with a 24-hour expiry. |
| `entry_legacy_history` | Imported Changes keyed by active tournament and week; deleted with that edition. |

## Existing installation: publish the migration

Apply the additive schema before deploying the Worker. Existing current lists and D1 Changes remain
in their snapshot; the schema does not reset them.

```powershell
npm.cmd exec --yes --package=wrangler@4.160.1 -- wrangler d1 execute wta-entry-lists --remote --config cloudflare/wrangler.json --file cloudflare/schema.sql
```

The completed migration imported 22 older Changes across three currently shown editions, using a
temporary ignored `.wrangler/active-legacy-history.json` seed. The complete old history file, temporary
seed, and generated import SQL have been removed. They are not website or repository data feeds.
For a similar one-time import with a separately prepared active-edition seed, the commands are:

```powershell
node cloudflare/import-legacy-history.mjs .wrangler/active-legacy-history.json .wrangler/active-history-import.sql
npm.cmd exec --yes --package=wrangler@4.160.1 -- wrangler d1 execute wta-entry-lists --remote --config cloudflare/wrangler.json --file .wrangler/active-history-import.sql
```

The importer validates dates, names, and markup, preserves repeated records with stable IDs, and
escapes SQL values. It excludes editions outside the current window and only inserts when the exact
tournament/week remains in the current D1 snapshot. Rerunning it cannot revive a past edition or replace
newer D1 events. A fresh checkout has no legacy seed; skip this optional one-time import in that case.

Deploy the rebuilt Worker and publish the reviewed website changes following [DEPLOY.md](DEPLOY.md).
Removing `.github/workflows/update_list.yml` stops both scheduled and manual GitHub scraping after
publication. Once an optional import is verified, delete its temporary seed and generated SQL.

## New installation

1. Create `wta-entry-lists` in Cloudflare D1 and run [schema.sql](schema.sql).
2. Add a **D1 database binding** named `ENTRY_LISTS_DB` to `tennis-wta-api`.
3. Build and deploy the complete [worker.mjs](worker.mjs), or use the direct deployment command.
4. Set the Cron Trigger to `* * * * *`; the Wrangler configuration already includes it.
5. Publish the static website through GitHub Pages and verify its saved-data loading and Refresh.

Keep the existing `GOOGLE_SERVICE_ACCOUNT_JSON` secret and `PLAYER_PHOTOS_FOLDER_ID` setting.
The shared Worker still serves Haute Cadence photos and WTA relay requests.

## Updates and verification

A successful refresh starts a shared two-minute cooldown. Incomplete or failed requests preserve
valid current data. The one-minute trigger advances unfinished jobs and starts automatic updates
when saved data is at least 30 minutes old or the displayed window rolls over. Browser Refresh
advances that same job while waiting. Ordinary data updates create no GitHub commits.

1. Check `/health`, `/entry-lists?history=1`, and `/photos` on the public Worker.
2. Open the website and verify that its menu, lists, and Changes load without clicking Refresh.
3. Refresh, then reload or open another browser. Verify the saved update and shared cooldown.
4. Check that expired editions and imported history are removed, while active histories remain.
5. Check loading, empty data, unavailable data, and failed refresh behavior locally.

The current client opts into imported date-only history using `?history=1` on GET and POST. The bare
endpoint retains numeric player IDs for cached older clients. Imported dates do not imply exact
detection times. Versioned assets load the new renderer.

`snapshot: null` is normal before the first completed collection. The website offers Refresh instead
of showing obsolete embedded lists. Existing valid lists stay visible if a later request fails.
The public refresh endpoint accepts only an empty website-origin POST, not visitor-supplied players.

Run `npm.cmd run build:worker` and `npm.cmd run test:entries` before deployments. Mocked checks do not
prove production bindings or WTA connectivity; complete the deployed checks after publication.
