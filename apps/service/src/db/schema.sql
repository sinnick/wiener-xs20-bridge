-- =============================================================================
-- WIENER XS 20 BRIDGE — SQLite schema v1
-- Mantener sincronizado con docs/02-schema-db.md
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS raw_messages (
    id                  TEXT PRIMARY KEY,
    received_at         TEXT NOT NULL,
    message_control_id  TEXT NOT NULL,
    message_type        TEXT NOT NULL,
    sender_address      TEXT,
    raw_hl7             TEXT NOT NULL,
    byte_size           INTEGER NOT NULL,
    parse_status        TEXT NOT NULL CHECK(parse_status IN ('parsed', 'failed', 'partial')),
    parse_error         TEXT,
    UNIQUE(message_control_id)
);

CREATE INDEX IF NOT EXISTS idx_raw_messages_received_at ON raw_messages(received_at DESC);

CREATE TABLE IF NOT EXISTS patients (
    id                  TEXT PRIMARY KEY,
    external_id         TEXT,
    name                TEXT,
    birth_date          TEXT,
    sex                 TEXT CHECK(sex IN ('M', 'F', 'U') OR sex IS NULL),
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    UNIQUE(external_id)
);

CREATE INDEX IF NOT EXISTS idx_patients_name ON patients(name);

CREATE TABLE IF NOT EXISTS results (
    id                  TEXT PRIMARY KEY,
    raw_message_id      TEXT NOT NULL REFERENCES raw_messages(id) ON DELETE CASCADE,
    patient_id          TEXT REFERENCES patients(id) ON DELETE SET NULL,
    sample_id           TEXT NOT NULL,
    take_mode           TEXT,
    blood_mode          TEXT CHECK(blood_mode IN ('W', 'P') OR blood_mode IS NULL),
    test_mode           TEXT,
    ref_group           TEXT,
    drawn_at            TEXT,
    analyzed_at         TEXT,
    operator            TEXT,
    comments            TEXT,
    received_at         TEXT NOT NULL,
    abnormal_count      INTEGER NOT NULL DEFAULT 0,
    morphology_flag_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_results_received_at ON results(received_at DESC);
CREATE INDEX IF NOT EXISTS idx_results_sample_id ON results(sample_id);
CREATE INDEX IF NOT EXISTS idx_results_patient_id ON results(patient_id);

CREATE TABLE IF NOT EXISTS result_values (
    result_id           TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
    param               TEXT NOT NULL,
    value               REAL NOT NULL,
    unit                TEXT NOT NULL,
    ref_range           TEXT,
    flags               TEXT,
    PRIMARY KEY (result_id, param)
);

CREATE TABLE IF NOT EXISTS histograms (
    result_id           TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
    type                TEXT NOT NULL CHECK(type IN ('wbc', 'rbc', 'plt')),
    channels            BLOB NOT NULL,
    left_line           INTEGER,
    mid_line            INTEGER,
    right_line          INTEGER,
    PRIMARY KEY (result_id, type)
);

CREATE TABLE IF NOT EXISTS morphology_flags (
    result_id           TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
    code                TEXT NOT NULL,
    PRIMARY KEY (result_id, code)
);

CREATE TABLE IF NOT EXISTS service_config (
    key                 TEXT PRIMARY KEY,
    value               TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at         TEXT NOT NULL,
    level               TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
    event_type          TEXT NOT NULL,
    message             TEXT NOT NULL,
    context             TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_occurred_at ON audit_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_event_type ON audit_log(event_type);
