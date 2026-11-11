# Save refreshed entry lists with Cloudflare D1

The existing Worker saves the latest complete WTA entry-list snapshot in D1. Every visitor can load
that snapshot, including after reloading the page or opening the website on another device.
The database also saves detected additions/removals for the Changes view and coordinates the shared
two-minute refresh cooldown.

Use the existing Cloudflare account and Worker:

- Worker: `tennis-wta-api`
- Address: `https://tennis-wta-api.schiter-tomas.workers.dev`
- Database name: `wta-entry-lists`
- Binding name: `ENTRY_LISTS_DB`

No new account, GitHub token, or Google credential is required for D1. Keep the Worker's existing
Google photo secrets and folder setting. D1 has a Free allowance; both D1 and Worker usage remain
subject to the account's limits. See [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

## 1. Create the database

In the [Cloudflare dashboard](https://dash.cloudflare.com/), open **Storage & databases → D1 SQL database**
and choose **Create Database**. Name it `wta-entry-lists` and create it in the same account as the Worker.
Cloudflare documents database creation and binding in its [D1 setup guide](https://developers.cloudflare.com/d1/get-started/).

## 2. Create the tables

Open `wta-entry-lists`, select **Console**, and paste the entire contents of [schema.sql](schema.sql).
Select **Execute**. This creates two tables for saved snapshots, refresh coordination, and the ranking cache.
Do not paste a service-account JSON or any private key into the SQL console.

## 3. Connect D1 to the existing Worker

Open **Workers & Pages → tennis-wta-api → Bindings → Add binding**. Choose **D1 database** and set:

| Setting | Value |
| --- | --- |
| Variable name | `ENTRY_LISTS_DB` |
| D1 database | `wta-entry-lists` |

Select **Add binding** and save/deploy any pending configuration change. This must be a D1 binding,
not a Text variable with the same name. Leave the database's default primary-read configuration in place.

## 4. Deploy the updated Worker code

Open **Edit code** on `tennis-wta-api`. Replace the editor's code with the entire contents of the generated
[worker.mjs](worker.mjs), then select **Deploy**. Use this complete file; the source modules and test files
are not standalone dashboard deployments.

The generated Worker includes the existing WTA relay and Google photo routes as well as the D1 routes.
Pushing the repository to GitHub does not deploy this Worker code to Cloudflare.

## 5. Add the background schedule

Open the Worker's **Settings → Triggers → Cron Triggers** and add this custom schedule:

```text
* * * * *
```

This wakes the Worker once per minute. It advances an unfinished refresh in bounded stages and starts
an automatic update when the saved data is at least 30 minutes old. It does not scrape every list on
every tick. The browser advances these same stages while someone is waiting for Refresh to finish.

Save the trigger. Cloudflare notes that [Cron Trigger changes](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
can take up to 15 minutes to propagate. The button works independently of that propagation; the schedule
also lets a refresh continue after its initiating page closes.

## 6. Check the Worker

Open [the saved entry-list endpoint](https://tennis-wta-api.schiter-tomas.workers.dev/entry-lists).
A working installation returns JSON containing `snapshot`, `refreshing`, `next_refresh_at`, `progress`, and `error`.
`snapshot: null` is normal before the first complete refresh. `/health` checks the Worker itself and does
not prove that the D1 tables and binding are ready.

| Response | What to check |
| --- | --- |
| 404 / unknown endpoint | Deploy the current complete `worker.mjs` to the production Worker. |
| 503 / database unavailable | Confirm the D1 binding name and run `schema.sql` in that database. |
| 502 during refresh | WTA collection failed; the previous successful snapshot remains saved. Inspect Worker logs. |

## 7. Publish and verify the website

Review and publish the WTA Tracker website changes through the repository's usual GitHub Pages deployment.
Worker deployment and website deployment are separate steps.

On the live WTA Tracker website:

1. Click **Refresh** and wait for **Updated and saved at …**.
2. Reload the page. The saved lists and shared cooldown should remain.
3. Open the website in another browser/device. It should load the same saved update.
4. Open `/entry-lists` again. Its snapshot should now contain `models`, `fetched_at`, and `saved_at`.

The first refresh can take longer while deadline-week rankings are cached. Later refreshes reuse completed
ranking dates. Incomplete or failed refreshes never replace a complete saved snapshot. The cooldown is
shared across visitors; another visitor receives the saved update while that cooldown is active.

Every complete refresh saves detected Main Draw and Qualifying additions/removals, comparing WTA
player IDs against the last observed list. The first observed list establishes its baseline. Missing
lists do not imply that every player withdrew. The recorded date is when the change was detected in
Europe/Madrid, not a claim about the exact withdrawal or entry time.

The existing GitHub workflow still maintains its repository archive. The website merges published
history with D1 Changes and compares source timestamps so older saved lists cannot hide a newer
scheduled publication. Shared history can still be displayed alongside those newer published lists.
Missing D1 data leaves the published page available with a refresh status explaining the problem.

## Updating an existing D1 installation

Changes history uses the existing snapshot storage, so no database migration or new binding is needed.
Deploy the rebuilt `worker.mjs` and publish the updated `entry-lists.mjs` and `refresh.js` website files.
The next successful refresh compares against the existing saved lists and starts saving change events.
Earlier GitHub history remains visible; the Worker cannot infer changes that happened before its saved
baseline. History and baselines are kept while each tournament remains in the upcoming four-week window,
including across temporary calendar removals. The GitHub archive remains the longer-term record.

## Development and checks

The dashboard steps above use the generated Worker file and do not require a terminal. When editing
the Worker source locally, run these commands from the `wta-tracker` directory:

```powershell
npm ci
npm run build:worker
npm run test:entries
```

If PowerShell blocks `npm.ps1`, use `npm.cmd` instead of `npm` in those commands.

Edit `cloudflare/worker-source.mjs` and its modules, then rebuild `cloudflare/worker.mjs` before copying it
into the dashboard. The build does not deploy anything. Local checks cannot verify the production D1
binding or real WTA connectivity; complete the deployed checks above after configuration.

The public refresh endpoint accepts an empty `POST /entry-lists/refresh` from the website. It fetches
authoritative WTA data itself and does not accept player lists supplied by visitors. Each call advances
a small part of the job, keeping collection within Workers request limits. The database lease prevents
simultaneous visitors from publishing competing updates.
