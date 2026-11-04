# WTA entry lists

The public site shows WTA singles entry lists collected by `.github/workflows/update_list.yml`,
which runs on a 30-minute schedule and can also be started manually in GitHub Actions.

The menu's **Refresh** button fetches current WTA singles entry lists through the shared endpoint
at `https://tennis-wta-api.schiter-tomas.workers.dev`. It discovers the next four weeks of events,
reads Singles and Qualifying separately, and attaches each list's deadline-week singles rankings.
Doubles players never enter these lists. Responses are transformed in the browser without writing
data files or triggering GitHub Actions. Historical ranking responses are reused in the current tab.

The selected tournament and view are retained when available. A successful refresh starts a
two-minute cooldown, remembered across reloads and tabs in the same browser. Failed or incomplete
requests leave the current lists visible and allow a retry. If browser storage is unavailable,
the cooldown lasts only in the current tab until reload. The cooldown is per browser, not global.

The saved change history still comes from the scheduled scraper. Browser refreshes preserve that
history; they do not create shared additions/removals. If WTA lists qualifying while removing its
main-draw list, a previously displayed main draw is retained with an explicit notice.

`main.py` generates `index.html`. Keep the refresh controls and the references to `refresh.css`
and `refresh.js` in its HTML template so scheduled updates retain the button.

See `cloudflare/SETUP.md` for relay deployment. Run the focused client/relay checks with
`node --test tests/entry-lists.test.mjs cloudflare/worker.test.mjs`.
