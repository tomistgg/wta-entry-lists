CREATE TABLE IF NOT EXISTS entry_list_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    snapshot TEXT,
    next_refresh_at INTEGER NOT NULL DEFAULT 0,
    job TEXT,
    job_expires_at INTEGER NOT NULL DEFAULT 0,
    lease_token TEXT,
    lease_until INTEGER NOT NULL DEFAULT 0,
    error TEXT
);

INSERT OR IGNORE INTO entry_list_state (id) VALUES (1);

CREATE TABLE IF NOT EXISTS entry_ranking_cache (
    ranking_date TEXT PRIMARY KEY,
    rows_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
