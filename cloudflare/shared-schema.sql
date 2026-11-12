CREATE TABLE IF NOT EXISTS wta_players (
    player_id TEXT PRIMARY KEY NOT NULL CHECK (length(player_id) > 0),
    profile_json TEXT NOT NULL CHECK (json_valid(profile_json) AND json_type(profile_json) = 'object'),
    updated_at TEXT NOT NULL
);

-- Historical champions may be outside the current player directory.
CREATE TABLE IF NOT EXISTS wta_titles (
    tournament_id TEXT NOT NULL CHECK (length(tournament_id) > 0),
    year INTEGER NOT NULL CHECK (year >= 1900 AND year <= 9999),
    champion_id TEXT NOT NULL CHECK (length(champion_id) > 0),
    end_date TEXT NOT NULL,
    title_json TEXT NOT NULL CHECK (json_valid(title_json) AND json_type(title_json) = 'object'),
    PRIMARY KEY (tournament_id, year)
);

CREATE INDEX IF NOT EXISTS wta_titles_by_player ON wta_titles (champion_id, end_date);

CREATE TABLE IF NOT EXISTS wta_snapshots (
    kind TEXT NOT NULL CHECK (length(kind) > 0),
    scope TEXT NOT NULL DEFAULT 'global' CHECK (length(scope) > 0),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    fetched_at TEXT NOT NULL,
    expires_at INTEGER CHECK (expires_at IS NULL OR expires_at >= 0),
    PRIMARY KEY (kind, scope)
);

CREATE INDEX IF NOT EXISTS wta_snapshots_by_expiry ON wta_snapshots (expires_at) WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS wta_refresh_state (
    kind TEXT NOT NULL CHECK (length(kind) > 0),
    scope TEXT NOT NULL DEFAULT 'global' CHECK (length(scope) > 0),
    next_refresh_at INTEGER NOT NULL DEFAULT 0 CHECK (next_refresh_at >= 0),
    job_json TEXT CHECK (job_json IS NULL OR json_valid(job_json)),
    job_expires_at INTEGER NOT NULL DEFAULT 0 CHECK (job_expires_at >= 0),
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0 CHECK (lease_until >= 0),
    last_success_at TEXT,
    error TEXT,
    PRIMARY KEY (kind, scope)
);
