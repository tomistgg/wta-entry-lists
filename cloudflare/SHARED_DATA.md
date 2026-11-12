# Shared data backend

The Worker source now includes shared collection and read/refresh routes using the existing
`ENTRY_LISTS_DB` binding and `shared-schema.sql`. The shared schema and reviewed baseline were imported
and the Worker deployed on 2026-11-12. Haute Cadence uses these saved feeds and shared refresh jobs.

## Routes

| Read | Refresh | Saved content |
| --- | --- | --- |
| `GET /data/players` | `POST /data/players/refresh` | Player directory, ranking date, names, career bests, and derived title statistics. |
| `GET /data/calendar` | `POST /data/calendar/refresh` | Merged calendar preserving ITF/custom rows while updating WTA events. |
| `GET /data/results` | `POST /data/results/refresh` | Completed singles matches from the rolling last 24 hours. |
| `GET /data/draws` | `POST /data/draws/refresh` | Active singles knockout brackets. |
| `GET /data/champions` | `POST /data/champions/refresh` | Saved singles champions and coverage metadata. |
| `GET /data/players/{id}/form` | `POST /data/players/{id}/form/refresh` | Ten form slots from singles history and current tournament matches. |

Every route returns `{snapshot, refreshing, next_refresh_at, progress, error}`. The snapshot contains
the corresponding existing Haute Cadence payload shape; `null` means no usable saved feed exists.
Reads do not start collection or write to D1. Refresh requires an empty POST from
`https://tomistgg.github.io`, so visitors cannot upload their own players or results.

An incomplete refresh returns 202 with progress; further POSTs advance the same job. Success returns
200 and starts a shared two-minute cooldown. Results, draws, and champions share one match job and
cooldown because one event response supplies all three. Calendar and rankings have separate global
jobs, while form jobs are scoped by WTA player ID.

## Collection and storage

Each shared step has at most four upstream-request opportunities, counting cache hits. Jobs and
pagination state survive between invocations. Leases coordinate visitors. Complete public feeds,
profiles, and title changes publish atomically; errors keep the previous good data with a short
retry delay. Raw source caches hold completed individual pages, not partial published feeds.

`shared-io.mjs` uses allowlisted WTA routes, fixed headers/host, bounded responses, and validated
envelopes. Raw calendar, match, history, and current-week ranking responses cache for two minutes,
so the next allowed manual refresh can fetch new match data. Historical ranking dates can cache
for 24 hours. The complete shared calendar source is valid for 30 minutes.

Entry Lists reuses that complete calendar and date-scoped singles ranking cache. It keeps its own
four-week selection and entry-specific cleanup; player-list HTML still comes from WTA. Missing shared
tables leave the existing entry-list routes operational during migration.

Calendar collection covers WTA's current and following seasons. Merging preserves ITF/custom records,
qualifying labels, and records outside the refreshed range, while cancelled or removed WTA editions
inside that range disappear. Preserved ITF rows are not presented as freshly collected WTA data.

Rankings preserve curated labels, aliases, and known career bests, without advancing previous ranks
twice in the same week. Newly discovered players can have unknown historical fields; current rank is
not invented as a career high. `wta_titles` remains authoritative for title counts and latest titles.
Finals upsert by edition, retain saved metadata, and correct changed winners without duplicating titles.

## Background updates and expiry

The existing one-minute trigger advances one bounded shared job step and then the existing Entry Lists
step. Due shared feeds are selected fairly so one failing source does not prevent other updates.
Calendars refresh after 30 minutes, match feeds after five minutes, and rankings when a new Madrid
ranking week is due. Form caches are collected on request, not by scanning every player.

Reads filter expired result matches and inactive draws. Scheduled cleanup trims old feeds, expires
source/form caches and abandoned jobs, and retains career/title statistics and curated names.
Active brackets remain available through tournament end dates if a later request fails.

## Validation and publication

```powershell
npm.cmd run build:worker
npm.cmd run test:entries
```

These commands build and test locally. Tests cover pagination, concurrent visitors, rollback, expiry,
title corrections, route security, shared caches, and existing entry-list/photo behavior. A separate
temporary-D1 rehearsal imports the full step 2 baseline and uses mocked ranking responses to verify
the real directory, names, career bests, and title statistics survive a complete bounded update.
A read-only source check also completed calendar, results, ranking, and player-form jobs against real
WTA responses through the existing relay. All resulting snapshots and job writes stayed in a temporary
local D1 database. Its report is `.wrangler/shared-public-source-check.json`.

The production import was verified against all 2,179 profiles, 1,800 titles, 870 calendar rows, and
the full name index. Entry-list tables were preserved. Worker version
`9f96cd79-e5e7-4727-8b6b-2ee653f980df` serves the shared routes and existing entry-list/photo endpoints.
Live calendar, results, and player-form refreshes completed and saved successfully; the photo index
still contains 126 photos. Future deployments must apply schema changes before dependent clients.
