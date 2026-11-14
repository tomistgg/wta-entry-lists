-- Mirrored from tenis-fem-arg/cloudflare/schema.sql for standalone tests and local previews.
-- Review draft only. Additive WTARG tables; existing shared wta_* tables are unchanged.
-- Import validation also enforces canonical keys, strict dates and publication completeness.

CREATE TABLE IF NOT EXISTS wtarg_players (
    player_key TEXT PRIMARY KEY NOT NULL CHECK (length(player_key) > 0),
    display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
    name_key TEXT NOT NULL UNIQUE CHECK (length(name_key) > 0),
    presentation_name TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    dob TEXT,
    profile_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(profile_json) AND json_type(profile_json) = 'object'
        AND length(CAST(profile_json AS BLOB)) <= 1900000),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS wtarg_player_ids (
    source TEXT NOT NULL CHECK (length(source) > 0),
    source_id TEXT NOT NULL CHECK (length(source_id) > 0),
    player_key TEXT NOT NULL REFERENCES wtarg_players(player_key),
    is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
    source_name TEXT NOT NULL DEFAULT '',
    profile_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(profile_json) AND json_type(profile_json) = 'object'
        AND length(CAST(profile_json AS BLOB)) <= 1900000),
    updated_at TEXT,
    PRIMARY KEY (source, source_id),
    CHECK (source != 'wta' OR source_id NOT GLOB '*[^0-9]*'),
    CHECK (source != 'itf' OR (source_id LIKE '800%' AND source_id NOT GLOB '*[^0-9]*'))
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS wtarg_player_primary_id
ON wtarg_player_ids(player_key, source) WHERE is_primary = 1;

CREATE TABLE IF NOT EXISTS wtarg_player_aliases (
    player_key TEXT NOT NULL REFERENCES wtarg_players(player_key),
    alias TEXT NOT NULL CHECK (length(trim(alias)) > 0),
    normalized_alias TEXT NOT NULL CHECK (length(normalized_alias) > 0),
    source TEXT NOT NULL DEFAULT 'import',
    PRIMARY KEY (player_key, alias)
) WITHOUT ROWID;

-- An alias can legitimately name multiple people; lookup must retain ambiguity.
CREATE INDEX IF NOT EXISTS wtarg_alias_lookup ON wtarg_player_aliases(normalized_alias);

CREATE TABLE IF NOT EXISTS wtarg_ranking_weeks (
    series TEXT NOT NULL CHECK (length(series) > 0),
    week_date TEXT NOT NULL CHECK (
        length(week_date) = 10 AND date(week_date, '+0 days') IS NOT NULL
        AND date(week_date, '+0 days') = week_date),
    status TEXT NOT NULL CHECK (
        status IN ('pending', 'imported', 'confirmed_changed', 'confirmed_frozen', 'archived')),
    row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
    content_hash TEXT CHECK (content_hash IS NULL OR length(content_hash) = 64),
    archive_path TEXT,
    checked_at TEXT,
    accepted_at TEXT,
    PRIMARY KEY (series, week_date),
    CHECK (status != 'archived' OR (archive_path IS NOT NULL AND length(archive_path) > 0))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS wtarg_rankings (
    series TEXT NOT NULL,
    week_date TEXT NOT NULL,
    row_key TEXT NOT NULL CHECK (length(row_key) > 0),
    player_key TEXT REFERENCES wtarg_players(player_key),
    source_player_id TEXT,
    rank INTEGER CHECK (rank IS NULL OR (typeof(rank) = 'integer' AND rank > 0)),
    rank_label TEXT NOT NULL DEFAULT '',
    points INTEGER CHECK (points IS NULL OR (typeof(points) = 'integer' AND points >= 0)),
    name TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    dob TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    PRIMARY KEY (series, week_date, row_key),
    FOREIGN KEY (series, week_date) REFERENCES wtarg_ranking_weeks(series, week_date),
    CHECK (series != 'wta_singles' OR (
        player_key IS NOT NULL AND source_player_id IS NOT NULL AND length(source_player_id) > 0
        AND source_player_id NOT GLOB '*[^0-9]*' AND rank IS NOT NULL))
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS wtarg_ranking_player_week
ON wtarg_rankings(series, week_date, player_key) WHERE player_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS wtarg_rankings_by_player ON wtarg_rankings(player_key, week_date);
CREATE INDEX IF NOT EXISTS wtarg_rankings_in_order ON wtarg_rankings(series, week_date, rank);

CREATE TABLE IF NOT EXISTS wtarg_tournaments (
    tournament_key TEXT PRIMARY KEY NOT NULL CHECK (length(tournament_key) > 0),
    source TEXT NOT NULL CHECK (length(source) > 0),
    source_id TEXT,
    season INTEGER CHECK (season IS NULL OR season BETWEEN 1800 AND 9999),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    start_date TEXT,
    end_date TEXT,
    category TEXT NOT NULL DEFAULT '',
    surface TEXT NOT NULL DEFAULT '',
    country TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    updated_at TEXT NOT NULL,
    CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date)
);

-- Provider IDs can be reused; the canonical tournament key remains authoritative.
CREATE INDEX IF NOT EXISTS wtarg_tournaments_by_source ON wtarg_tournaments(source, source_id, season);
CREATE INDEX IF NOT EXISTS wtarg_tournaments_by_start ON wtarg_tournaments(start_date);

CREATE TABLE IF NOT EXISTS wtarg_tournament_sources (
    source TEXT NOT NULL CHECK (length(source) > 0),
    source_event_key TEXT NOT NULL CHECK (length(source_event_key) > 0),
    tournament_key TEXT NOT NULL REFERENCES wtarg_tournaments(tournament_key),
    event_id TEXT,
    source_url TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    updated_at TEXT,
    PRIMARY KEY (source, source_event_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS wtarg_tournament_source_lookup ON wtarg_tournament_sources(tournament_key);

CREATE TABLE IF NOT EXISTS wtarg_matches (
    source TEXT NOT NULL CHECK (length(source) > 0),
    source_match_key TEXT NOT NULL CHECK (length(source_match_key) > 0),
    tournament_key TEXT NOT NULL REFERENCES wtarg_tournaments(tournament_key),
    played_on TEXT,
    draw_code TEXT NOT NULL DEFAULT 'MDS',
    discipline TEXT NOT NULL DEFAULT 'S' CHECK (discipline IN ('S', 'D', 'UNKNOWN')),
    round_name TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'completed',
    winner_side INTEGER CHECK (winner_side IS NULL OR winner_side IN (0, 1)),
    score_text TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source, source_match_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS wtarg_matches_by_date ON wtarg_matches(played_on);
CREATE INDEX IF NOT EXISTS wtarg_matches_by_event ON wtarg_matches(tournament_key, draw_code);

CREATE TABLE IF NOT EXISTS wtarg_match_participants (
    source TEXT NOT NULL,
    source_match_key TEXT NOT NULL,
    side INTEGER NOT NULL CHECK (side IN (0, 1)),
    position INTEGER NOT NULL CHECK (position IN (1, 2)),
    player_key TEXT REFERENCES wtarg_players(player_key),
    source_player_id TEXT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    country TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    PRIMARY KEY (source, source_match_key, side, position),
    FOREIGN KEY (source, source_match_key) REFERENCES wtarg_matches(source, source_match_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS wtarg_matches_by_participant
ON wtarg_match_participants(player_key, source, source_match_key);

-- Publication pointers live in shared snapshots; readers select only the published version.
CREATE TABLE IF NOT EXISTS wtarg_entry_lists (
    list_key TEXT NOT NULL CHECK (length(list_key) > 0),
    version INTEGER NOT NULL CHECK (version > 0),
    tournament_key TEXT NOT NULL REFERENCES wtarg_tournaments(tournament_key),
    source TEXT NOT NULL,
    discipline TEXT NOT NULL DEFAULT 'S' CHECK (discipline IN ('S', 'D')),
    publication_date TEXT,
    first_seen_at TEXT,
    wtn_observed_on TEXT,
    wtn_consumed_at TEXT,
    last_am_attempt_on TEXT,
    last_pm_attempt_on TEXT,
    last_checked_at TEXT,
    is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
    is_open INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1)),
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    expires_at INTEGER CHECK (expires_at IS NULL OR expires_at >= 0),
    PRIMARY KEY (list_key, version)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS wtarg_entry_lists_by_event ON wtarg_entry_lists(tournament_key, version);

CREATE TABLE IF NOT EXISTS wtarg_entries (
    list_key TEXT NOT NULL,
    list_version INTEGER NOT NULL,
    row_key TEXT NOT NULL CHECK (length(row_key) > 0),
    list_type TEXT NOT NULL CHECK (list_type IN ('MAIN', 'QUAL', 'ALT', 'UNKNOWN')),
    player_key TEXT REFERENCES wtarg_players(player_key),
    source_player_id TEXT,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    country TEXT NOT NULL DEFAULT '',
    position_label TEXT NOT NULL DEFAULT '',
    entry_rank INTEGER CHECK (entry_rank IS NULL OR entry_rank > 0),
    rank_label TEXT NOT NULL DEFAULT '',
    priority_label TEXT NOT NULL DEFAULT '',
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    PRIMARY KEY (list_key, list_version, row_key),
    FOREIGN KEY (list_key, list_version) REFERENCES wtarg_entry_lists(list_key, version)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS wtarg_entries_by_player ON wtarg_entries(player_key, list_key);

CREATE TABLE IF NOT EXISTS wtarg_entry_changes (
    change_key TEXT PRIMARY KEY NOT NULL CHECK (length(change_key) > 0),
    tournament_key TEXT NOT NULL REFERENCES wtarg_tournaments(tournament_key),
    list_key TEXT NOT NULL,
    observed_version INTEGER CHECK (observed_version IS NULL OR observed_version > 0),
    source TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('withdrawn', 'added', 'removed', 'promoted', 'baseline')),
    list_type TEXT NOT NULL CHECK (list_type IN ('MAIN', 'QUAL', 'ALT', 'UNKNOWN')),
    player_key TEXT REFERENCES wtarg_players(player_key),
    source_player_id TEXT,
    name TEXT NOT NULL,
    provider_date TEXT,
    detected_at TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000)
);

CREATE INDEX IF NOT EXISTS wtarg_entry_changes_by_event ON wtarg_entry_changes(tournament_key, detected_at);

CREATE TABLE IF NOT EXISTS wtarg_draws (
    tournament_key TEXT NOT NULL REFERENCES wtarg_tournaments(tournament_key),
    draw_code TEXT NOT NULL CHECK (draw_code IN ('MDS', 'QS', 'MDD', 'QD')),
    week_number INTEGER NOT NULL DEFAULT 0 CHECK (week_number >= 0),
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL CHECK (status IN ('unpublished', 'pending', 'active', 'complete', 'unavailable')),
    roster_hash TEXT,
    is_complete INTEGER NOT NULL DEFAULT 0 CHECK (is_complete IN (0, 1)),
    payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND length(CAST(payload_json AS BLOB)) <= 1900000),
    fetched_at TEXT,
    expires_at INTEGER CHECK (expires_at IS NULL OR expires_at >= 0),
    PRIMARY KEY (tournament_key, draw_code, week_number, version)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS wtarg_player_wtn (
    source TEXT NOT NULL CHECK (source IN ('itf', 'wta')),
    source_player_id TEXT NOT NULL CHECK (length(source_player_id) > 0),
    player_key TEXT REFERENCES wtarg_players(player_key),
    discipline TEXT NOT NULL DEFAULT 'S' CHECK (discipline = 'S'),
    value REAL CHECK (value IS NULL OR (value > 0 AND value <= 40)),
    observed_on TEXT,
    observation_source TEXT NOT NULL DEFAULT 'import',
    source_url TEXT,
    checked_at TEXT,
    retry_after INTEGER NOT NULL DEFAULT 0 CHECK (retry_after >= 0),
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    PRIMARY KEY (source, source_player_id),
    CHECK (value IS NULL OR observed_on IS NOT NULL)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS wtarg_wtn_by_player ON wtarg_player_wtn(player_key);

-- Evidence survives expiry of the active draw and must not be replaced by today's WTN.
CREATE TABLE IF NOT EXISTS wtarg_draw_wtn (
    tournament_key TEXT NOT NULL REFERENCES wtarg_tournaments(tournament_key),
    draw_code TEXT NOT NULL CHECK (draw_code IN ('MDS', 'QS')),
    week_number INTEGER NOT NULL DEFAULT 0 CHECK (week_number >= 0),
    roster_hash TEXT NOT NULL CHECK (length(roster_hash) > 0),
    row_key TEXT NOT NULL CHECK (length(row_key) > 0),
    player_key TEXT REFERENCES wtarg_players(player_key),
    source_player_id TEXT,
    name TEXT NOT NULL,
    value REAL CHECK (value IS NULL OR (value > 0 AND value <= 40)),
    observed_on TEXT,
    observation_source TEXT NOT NULL DEFAULT 'import',
    status TEXT NOT NULL DEFAULT 'unresolved' CHECK (status IN ('observed', 'unavailable', 'unresolved', 'qualifier')),
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    PRIMARY KEY (tournament_key, draw_code, week_number, roster_hash, row_key),
    CHECK (status != 'observed' OR (value IS NOT NULL AND observed_on IS NOT NULL))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS wtarg_tournament_metrics (
    tournament_key TEXT NOT NULL REFERENCES wtarg_tournaments(tournament_key),
    draw_code TEXT NOT NULL CHECK (draw_code IN ('MDS', 'QS')),
    week_number INTEGER NOT NULL DEFAULT 0 CHECK (week_number >= 0),
    metric TEXT NOT NULL CHECK (metric IN ('ranking_strength', 'wtn_gm', 'draw_size')),
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'unavailable')),
    value REAL,
    expected_count INTEGER NOT NULL DEFAULT 0 CHECK (expected_count >= 0),
    covered_count INTEGER NOT NULL DEFAULT 0 CHECK (covered_count BETWEEN 0 AND expected_count),
    frozen INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1)),
    roster_hash TEXT,
    formula_version TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    computed_at TEXT,
    PRIMARY KEY (tournament_key, draw_code, week_number, metric, version),
    CHECK (frozen = 0 OR status = 'complete'),
    CHECK (metric != 'wtn_gm' OR status != 'complete' OR (
        value IS NOT NULL AND value > 0 AND value <= 40 AND expected_count > 0
        AND covered_count = expected_count AND roster_hash IS NOT NULL AND length(roster_hash) > 0))
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS wtarg_calendar_changes (
    change_key TEXT PRIMARY KEY NOT NULL CHECK (length(change_key) > 0),
    tournament_key TEXT NOT NULL REFERENCES wtarg_tournaments(tournament_key),
    detected_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
    payload_json TEXT NOT NULL CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000)
);

CREATE INDEX IF NOT EXISTS wtarg_calendar_changes_by_expiry ON wtarg_calendar_changes(expires_at);

CREATE TABLE IF NOT EXISTS wtarg_jobs (
    job_key TEXT PRIMARY KEY NOT NULL CHECK (length(job_key) > 0),
    source TEXT NOT NULL CHECK (length(source) > 0),
    kind TEXT NOT NULL CHECK (length(kind) > 0),
    scope TEXT NOT NULL CHECK (length(scope) > 0),
    tournament_key TEXT REFERENCES wtarg_tournaments(tournament_key),
    player_key TEXT REFERENCES wtarg_players(player_key),
    discipline TEXT CHECK (discipline IS NULL OR discipline IN ('S', 'D')),
    draw_code TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'waiting', 'complete', 'failed')),
    due_at INTEGER NOT NULL DEFAULT 0 CHECK (due_at >= 0),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0 CHECK (lease_until >= 0),
    job_expires_at INTEGER NOT NULL DEFAULT 0 CHECK (job_expires_at >= 0),
    last_success_at TEXT,
    error TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    CHECK ((lease_token IS NULL AND lease_until = 0) OR (lease_token IS NOT NULL AND lease_until > 0)),
    CHECK (kind NOT IN ('wtn_profile', 'wtn_refresh', 'wtn_gm') OR (
        discipline IS NOT NULL AND discipline = 'S' AND (draw_code IS NULL OR draw_code IN ('MDS', 'QS'))))
);

CREATE INDEX IF NOT EXISTS wtarg_jobs_due ON wtarg_jobs(status, due_at);

CREATE TABLE IF NOT EXISTS wtarg_source_state (
    source TEXT NOT NULL CHECK (length(source) > 0),
    scope TEXT NOT NULL CHECK (length(scope) > 0),
    not_before INTEGER NOT NULL DEFAULT 0 CHECK (not_before >= 0),
    backoff_until INTEGER NOT NULL DEFAULT 0 CHECK (backoff_until >= 0),
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0 CHECK (lease_until >= 0),
    last_checked_at TEXT,
    last_success_at TEXT,
    -- Edition/list scopes retain these markers even after entry-row versions expire.
    first_seen_at TEXT,
    publication_date TEXT,
    wtn_observed_on TEXT,
    wtn_consumed_at TEXT,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (
        json_valid(payload_json) AND json_type(payload_json) = 'object'
        AND length(CAST(payload_json AS BLOB)) <= 1900000),
    PRIMARY KEY (source, scope),
    CHECK ((lease_token IS NULL AND lease_until = 0) OR (lease_token IS NOT NULL AND lease_until > 0))
) WITHOUT ROWID;
