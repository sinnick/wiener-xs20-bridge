# 02 — Schema SQLite

## Filosofía

Tres tablas principales y una clara separación entre **lo crudo** (auditoría, lo que llegó tal cual) y **lo procesado** (lo que la UI consume).

- `raw_messages` — mensaje HL7 textual completo, para auditoría y reproceso.
- `results` — resultado parseado, con FK al raw.
- `result_values` — un row por parámetro (WBC, RBC, etc.) — diseño largo, no ancho.
- `histograms` — los 256 bytes de cada histograma, blob.
- `morphology_flags` — alarmas/sospechas levantadas por el equipo.
- `patients` — pacientes únicos (deduplicados por patient_id).
- `service_config` — configuración del servicio en filas key/value.
- `audit_log` — eventos relevantes (conexiones, errores, reinicios).

## ¿Por qué `result_values` en formato largo y no columnas anchas?

Si hiciéramos `results.wbc`, `results.rbc`, `results.hgb`, ..., serían 19 columnas que rara vez evolucionan limpiamente: un día Wiener saca un firmware con un parámetro nuevo y hay que migrar la tabla. Con formato largo (`result_id`, `param`, `value`, `unit`, `flags`), agregar parámetros es trivial y las queries son igual de rápidas con un índice por `(result_id, param)`.

Para la UI, el servicio devuelve los valores en un objeto plano (`{ wbc: {...}, rbc: {...} }`) — la conversión es trivial.

## DDL completo

```sql
-- =============================================================================
-- WIENER XS 20 BRIDGE — SQLite schema v1
-- =============================================================================

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;          -- mejor concurrencia (lecturas paralelas)
PRAGMA synchronous = NORMAL;        -- balance entre durabilidad y performance
PRAGMA busy_timeout = 5000;         -- 5s de tolerancia ante locks


-- ─── Mensajes crudos (auditoría) ─────────────────────────────────────────────
-- Guardamos el HL7 textual original tal cual llegó. Sirve para:
--  1. Auditoría regulatoria (poder demostrar qué dijo el equipo).
--  2. Reproceso si encontramos un bug en el parser.
--  3. Debug.
CREATE TABLE raw_messages (
    id                  TEXT PRIMARY KEY,        -- ULID generado por el servicio
    received_at         TEXT NOT NULL,           -- ISO 8601 con TZ
    message_control_id  TEXT NOT NULL,           -- MSH-10 (OJO: el equipo lo reinicia en 1)
    message_type        TEXT NOT NULL,           -- "ORU^R01", etc.
    sender_address      TEXT,                    -- IP:puerto del peer
    raw_hl7             TEXT NOT NULL,           -- mensaje completo (sin framing MLLP)
    byte_size           INTEGER NOT NULL,
    parse_status        TEXT NOT NULL CHECK(parse_status IN ('parsed', 'failed', 'partial')),
    parse_error         TEXT,                    -- NULL si parse_status='parsed'
    UNIQUE(message_control_id)                   -- heredado; ver "Idempotencia" mas abajo
);

CREATE INDEX idx_raw_messages_received_at ON raw_messages(received_at DESC);


-- ─── Pacientes (deduplicados por patient_id externo) ─────────────────────────
CREATE TABLE patients (
    id                  TEXT PRIMARY KEY,        -- ULID interno
    external_id         TEXT,                    -- PID-3 (historia clínica), puede ser NULL
    name                TEXT,                    -- PID-5 reformateado "Apellido, Nombre"
    birth_date          TEXT,                    -- ISO YYYY-MM-DD
    sex                 TEXT CHECK(sex IN ('M', 'F', 'U') OR sex IS NULL),
    first_seen_at       TEXT NOT NULL,
    last_seen_at        TEXT NOT NULL,
    UNIQUE(external_id)                          -- un mismo external_id no se duplica
);

CREATE INDEX idx_patients_name ON patients(name);


-- ─── Resultados (un row por hemograma completo) ──────────────────────────────
CREATE TABLE results (
    id                  TEXT PRIMARY KEY,        -- ULID
    raw_message_id      TEXT NOT NULL REFERENCES raw_messages(id) ON DELETE CASCADE,
    patient_id          TEXT REFERENCES patients(id) ON DELETE SET NULL,

    -- Sample info (de OBR)
    sample_id           TEXT NOT NULL,           -- OBR-3
    take_mode           TEXT,                    -- de OBX 08001
    blood_mode          TEXT CHECK(blood_mode IN ('W', 'P') OR blood_mode IS NULL),
    test_mode           TEXT,                    -- "CBC", "CBC+DIFF"
    ref_group           TEXT,
    drawn_at            TEXT,                    -- ISO, OBR-7
    analyzed_at         TEXT,                    -- ISO, OBR-8
    operator            TEXT,                    -- OBR-10
    comments            TEXT,

    received_at         TEXT NOT NULL,           -- cuando llegó al servicio

    -- Contadores precalculados (evita JOIN para listados)
    abnormal_count      INTEGER NOT NULL DEFAULT 0,
    morphology_flag_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_results_received_at ON results(received_at DESC);
CREATE INDEX idx_results_sample_id ON results(sample_id);
CREATE INDEX idx_results_patient_id ON results(patient_id);


-- ─── Valores de cada parámetro (formato largo) ───────────────────────────────
CREATE TABLE result_values (
    result_id           TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
    param               TEXT NOT NULL,           -- "wbc" | "rbc" | "hgb" | ...
    value               REAL NOT NULL,           -- valor numérico
    unit                TEXT NOT NULL,           -- "10*9/L", "g/L", "fL", "%"
    ref_range           TEXT,                    -- "4.0-10.0"
    flags               TEXT,                    -- JSON array: ["H"], ["L","A"], etc.
    PRIMARY KEY (result_id, param)
);


-- ─── Histogramas (256 bytes cada uno, blob) ──────────────────────────────────
CREATE TABLE histograms (
    result_id           TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
    type                TEXT NOT NULL CHECK(type IN ('wbc', 'rbc', 'plt')),
    channels            BLOB NOT NULL,           -- 256 bytes
    -- Discriminadores (líneas que separan poblaciones celulares)
    left_line           INTEGER,
    mid_line            INTEGER,
    right_line          INTEGER,
    PRIMARY KEY (result_id, type)
);


-- ─── Banderas morfológicas / sospechas ───────────────────────────────────────
CREATE TABLE morphology_flags (
    result_id           TEXT NOT NULL REFERENCES results(id) ON DELETE CASCADE,
    code                TEXT NOT NULL,           -- "Leukocytosis", "Anemia", etc.
    PRIMARY KEY (result_id, code)
);


-- ─── Configuración del servicio (key/value) ──────────────────────────────────
CREATE TABLE service_config (
    key                 TEXT PRIMARY KEY,
    value               TEXT NOT NULL,           -- JSON-encoded
    updated_at          TEXT NOT NULL
);


-- ─── Log de auditoría / eventos del servicio ─────────────────────────────────
CREATE TABLE audit_log (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at         TEXT NOT NULL,
    level               TEXT NOT NULL CHECK(level IN ('info', 'warn', 'error')),
    event_type          TEXT NOT NULL,           -- "service.started", "tcp.connection", "hl7.parse_error", etc.
    message             TEXT NOT NULL,
    context             TEXT                     -- JSON con detalles
);

CREATE INDEX idx_audit_log_occurred_at ON audit_log(occurred_at DESC);
CREATE INDEX idx_audit_log_event_type ON audit_log(event_type);
```

## Tamaño esperado

Estimación para un laboratorio que procesa ~200 muestras/día durante 5 años:

| Tabla | Filas | Bytes/fila | Total |
|-------|-------|------------|-------|
| `raw_messages` | 365.000 | ~3 KB | ~1 GB |
| `results` | 365.000 | ~500 B | ~180 MB |
| `result_values` | 6.9M (19 × 365k) | ~80 B | ~550 MB |
| `histograms` | 1.1M (3 × 365k) | ~280 B | ~310 MB |
| Total | | | **~2 GB en 5 años** |

SQLite maneja esto sin esfuerzo. Para hacer crecer menos rápido podemos purgar `raw_messages` después de N días (ya está el campo `rawRetentionDays` en config).

## Migraciones

Para Fase 1: ejecutar el DDL completo si la DB no existe. Sin sistema de migraciones por ahora — cuando lo necesitemos, agregamos `schema_migrations(version, applied_at)` y un runner simple.

## Idempotencia

Un resultado se identifica por **muestra + instante de análisis** (`results.sample_id` + `results.analyzed_at`). Si ese par ya está guardado, el mensaje se descarta y se responde el ACK igual: el XS 20 puede reenviar sin miedo, tanto por timeout del ACK como con un "enviar todo" del histórico.

> **Por qué NO se deduplica por MSH-10.** El UNIQUE en `raw_messages.message_control_id` viene del supuesto (equivocado) de que ese campo identifica un mensaje. El XS 20 **reinicia el contador en 1 cada vez que arranca**, así que los ids de hoy chocan con los de ayer. Con esa deduplicación, los primeros N resultados de cada jornada se descartaban en silencio — sin fila y sin `.txt`. Pasó en el laboratorio: 25 hemogramas perdidos el 01/09/2026 y 35 el 02/09, hasta que el contador superaba la marca del día anterior. Desde afuera se veía como "tarda unos minutos en empezar a andar".
>
> El UNIQUE sigue en el schema porque la versión 1 está congelada (ver `db/migrate.ts`). Cuando el MSH-10 se repite, `XsRepo` guarda el valor con un sufijo interno (`1#r_...`) para no chocar contra la restricción; el MSH-10 original queda intacto en `raw_hl7` y la lectura lo devuelve limpio.

Si el mensaje no trae instante de análisis no hay con qué identificarlo, así que se inserta igual: una fila repetida se borra después, un hemograma perdido no se recupera.

## Borrado total

`POST /api/maintenance/wipe-database` (ver `docs/03-contrato-http.md`) vacía las seis tablas
clínicas para que el analizador pueda reenviar todo desde cero. `XsRepo.wipeClinicalData`.

Borra **filas, no el schema**: nada de `DROP TABLE` + reaplicar `schema.sql`, que dejaría
`PRAGMA user_version` mintiendo y rompe el contrato de `migrate.ts`.

El orden es hijo → padre y es **explícito**:

```
result_values → histograms → morphology_flags → results → raw_messages → patients
```

No se apoya en el `ON DELETE CASCADE`, por dos razones independientes:

1. `patients` no cascadea nunca — el FK es `results.patient_id` con `ON DELETE SET NULL`, y
   además apunta en la dirección contraria.
2. `PRAGMA foreign_keys` es **por conexión**. Hoy queda encendido solo porque `openDb`
   ejecuta `schema.sql` en cada apertura; con `initialize: false` los cascades no corren y
   quedarían filas huérfanas.

Hay un test que abre la base con `PRAGMA foreign_keys = OFF` justamente para que nadie
"simplifique" esto a un solo `DELETE FROM results`.

**Sobrevive**: `service_config` (la configuración del servicio) y `audit_log`, donde queda
una fila `db.wiped` con los contadores. La auditoría se escribe **dentro** de la misma
transacción: si el borrado se revierte, el rastro se revierte con él.

Después del commit corre `VACUUM` + `PRAGMA wal_checkpoint(TRUNCATE)`, fuera de la
transacción porque SQLite no permite `VACUUM` adentro. Es por lo que ve la operadora:
`databaseSizeBytes()` es `page_count * page_size`, así que sin compactar la app seguiría
mostrando "30 MB" con cero resultados, y sin truncar el `-wal` el disco seguiría ocupado
aunque la app muestre 32 KB. Si falla (típicamente por falta de espacio: necesita un
temporal del tamaño de la base) se reporta `vacuumed: false` y nada más — a esa altura los
datos ya están borrados y commiteados.

