# Direct Worker deployments

The existing Worker can be deployed from this workspace without copying its code into the dashboard.
`wrangler.json` targets `tennis-wta-api`, its existing D1 database, and the one-minute Cron Trigger.
The configuration contains resource identifiers, never credentials or the Google private key.

## Authentication

Wrangler is authorized on this Windows account. Its OAuth credentials are encrypted, with the encryption
key stored in Windows Credential Manager. Credentials belong to the local Cloudflare tooling and are
not committed to the repository.

If another computer needs authorization, use Cloudflare's [Wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/#login):

```powershell
npx.cmd --yes wrangler@4.160.1 login --scopes account:read user:read workers:write workers_scripts:write d1:write
```

The separate `workers_scripts:write` permission is required for the existing Worker. The broader legacy
`workers:write` scope alone does not allow this deployment. Sign in directly with Cloudflare; no token
needs to be pasted into chat or source files. On this computer, the OS credential backend is already installed.

## Check and deploy

From the repository root:

```powershell
npm.cmd run deploy:worker:dry-run
npm.cmd run deploy:worker
```

The first command builds a preview upload without changing production. The second builds the standalone
Worker, runs the focused tests, and deploys only if they pass. It uses Wrangler's strict mode to stop if
the deployment would conflict with dashboard configuration. Run the real deployment after the change
has been reviewed and approved.

`keep_vars: true` retains dashboard variables such as `PLAYER_PHOTOS_FOLDER_ID`. Cloudflare retains
encrypted secrets such as `GOOGLE_SERVICE_ACCOUNT_JSON`; this file does not need their values. The D1
binding and Cron schedule are explicitly configured because `keep_vars` does not preserve those settings.

If the database, schedule, or another managed setting changes in the dashboard, compare it with
`wrangler.json` before deploying. Keep the configuration in sync rather than bypassing a strict-mode error.

Publishing the website remains a separate GitHub Pages release. A Worker deployment does not push or
commit repository files. The review-before-pushing preference still applies.

## Verify a release

After deployment, check `/health` and `/entry-lists` on
`https://tennis-wta-api.schiter-tomas.workers.dev`, verify that the saved snapshot is still available,
and check the existing photo routes. Once the website release is published, verify Refresh, Changes,
page reloads, and the shared cooldown from the live site.
