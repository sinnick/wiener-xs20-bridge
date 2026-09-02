-- =============================================================================
-- WIENER XS 20 BRIDGE — SQLite schema v1 (LINEA BASE — CONGELADA)
-- Mantener sincronizado con docs/02-schema-db.md
-- =============================================================================
--
-- >>> NO AGREGAR NI MODIFICAR COLUMNAS/TABLAS/INDICES EN ESTE ARCHIVO. <<<
--
-- Este es el schema version 1 y ya esta instalado en el laboratorio. Todo
-- cambio posterior va como una entrada nueva en el array MIGRATIONS de
-- db/migrate.ts, que corre con PRAGMA user_version.
--
-- Motivo: la app se auto-actualiza sola. En una instalacion que ya existe, el
-- "CREATE TABLE IF NOT EXISTS" de abajo se saltea la tabla ENTERA, asi que una
-- columna agregada aca nunca llegaria a esa PC y el codigo nuevo romperia en
-- runtime. Ver el comentario largo en db/migrate.ts.
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

-- Cuanto espera una escritura bloqueada por otro lock antes de rendirse.
-- DEBE quedar por debajo de ACK_DEADLINE_MS (4000, ver hl7/protocol-map.ts):
-- si la DB esta trabada (antivirus, backup, checkpoint del WAL) preferimos
-- fallar rapido y responder un ACK negativo dentro del plazo del equipo —
-- que el equipo puede reintentar, y el reintento se deduplica por muestra +
-- instante de analisis (ver XsRepo.insertResult) — antes que mandar un ACK
-- positivo tarde, que el equipo ya dio por perdido.
PRAGMA busy_timeout = 2500;

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
    -- OJO: el MSH-10 del XS 20 NO es unico — el equipo reinicia el contador en
    -- 1 en cada arranque. Este UNIQUE quedo de un supuesto equivocado y no se
    -- puede sacar (schema congelado). La deduplicacion real pasa por muestra +
    -- instante de analisis; cuando el valor se repite, XsRepo le agrega un
    -- sufijo interno para no chocar aca. Ver XsRepo.insertResult.
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
