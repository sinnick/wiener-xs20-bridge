# 01 — Protocolo HL7 v2.3.1 del Wiener XS 20

## Resumen

El XS 20 (Mindray BC-20s OEM) habla **HL7 v2.3.1 sobre MLLP/TCP**. Es un protocolo de texto,
delimitado por caracteres, con un framing binario muy simple por encima.

Flujo típico:

```
XS 20                           Servicio (nosotros)
  │                                    │
  │── conecta TCP ───────────────────► │  (XS 20 actúa como cliente)
  │                                    │
  │── ENQ (0x10) ───────────────────►  │
  │ ◄────────────────── ACK (0x06) ────│  (≤ 4 segundos)
  │                                    │
  │── <VT> MSH|...ORU^R01... <FS><CR>► │
  │                                    │  parseamos, persistimos
  │ ◄── <VT> MSH|...ACK^R01... <FS><CR>│  (≤ 4 segundos)
  │                                    │
  │── (heartbeat 0x02 cada 3 seg) ───► │
  │                                    │
```

## ¿Quién inicia la conexión TCP? — los dos modos

**Esto es lo primero que hay que verificar contra el equipo real.** El diagrama
de arriba asume que el XS 20 es el **cliente** TCP, pero el equipo también se
puede configurar al revés, y de fábrica suele venir así:

| Modo | Quién escucha | Quién disca | Config del servicio |
|------|---------------|-------------|---------------------|
| `listen` | el servicio, en `tcpHost:tcpPort` | el XS 20 | `connectionMode: "listen"` |
| `connect` | el XS 20, en su propia IP:5100 | el servicio | `connectionMode: "connect"` + `analyzerHost`/`analyzerPort` |

En los dos modos, una vez que hay socket el tratamiento de los bytes es idéntico
(MLLP → parseo → persistencia → ACK): lo hace `hl7/message-processor.ts`, que
comparten `listener/tcp-server.ts` (modo listen) y `listener/analyzer-client.ts`
(modo connect).

**[CONFIRMADO-CAMPO]** En la instalación de Wiener XS 20 verificada, el equipo
está en **modo servidor**: escucha en `<ip-del-equipo>:5100` y hay que discarle.
Se comprobó con un cliente TCP crudo, que estableció conexión contra el puerto
5100 del analizador. Por eso el servicio se configura en `connectionMode:
"connect"`.

Cómo saber en qué modo está tu equipo, sin abrir su menú: desde la PC del
laboratorio, con el analizador prendido, probá conectarte a él:

```powershell
Test-NetConnection -ComputerName <ip-del-equipo> -Port 5100
```

- Conecta → el equipo escucha → usá modo **`connect`**.
- No conecta pero los resultados igual aparecen → el equipo disca → modo **`listen`**.

En modo `connect` el servicio reconecta solo, con backoff exponencial (1s → 30s),
así que el apagado nocturno del equipo y sus reinicios no requieren intervención:
apenas el analizador vuelve a estar en red, la conexión se restablece. El estado
(`conectado` / `esperando al equipo` + último error) se ve en la pantalla
**Estado** de la app y en `GET /api/health` → `analyzerClient`.

## MLLP (Minimal Lower Layer Protocol)

Cada mensaje HL7 va envuelto entre tres bytes de control:

| Byte hex | Símbolo | Posición |
|----------|---------|----------|
| `0x0B` | `<VT>` | inicio |
| `0x1C` | `<FS>` | fin |
| `0x0D` | `<CR>` | después del `<FS>` |

Implementación: leer bytes del socket hasta encontrar la secuencia `<FS><CR>`, descartar el `<VT>` inicial, y todo lo de adentro es el mensaje HL7 en UTF-8.

## Estructura del mensaje HL7

Un mensaje HL7 es texto plano UTF-8 dividido en **segmentos** (líneas separadas por `\r`). Cada segmento empieza con un nombre de 3 letras y tiene **campos** separados por `|`. Cada campo puede tener **componentes** separados por `^`, **repeticiones** separadas por `~`, y **subcomponentes** separados por `&`.

```
SEGMENT|field1|field2^component1^component2|field3~rep1~rep2|...
```

Los delimitadores se **declaran en el propio mensaje** en MSH-1 y MSH-2, pero en la práctica HL7 v2 siempre usa `|^~\&`.

### Mensaje completo de ejemplo (ORU^R01 con resultado de hemograma)

```
MSH|^~\&|||||20150120161704||ORU^R01|1|P|2.3.1||||||UNICODE
PID|1||binglihao^^^^MR||^zhangsan||19820123000000|Male
PV1|1|Zhuyuan|ICU^^chuanghao
OBR|1||dz-1-19|00001^Automated Count^99MRC||20141013101300|20141013125435|||lisi||||20141013121200||||||||||HM
OBX|1|IS|08001^Take Mode^99MRC||O||||||F
OBX|2|IS|08002^Blood Mode^99MRC||W||||||F
OBX|3|IS|08003^Test Mode^99MRC||CBC+DIFF||||||F
OBX|4|ST|01001^Ref Group^99MRC||General||||||F
OBX|5|NM|30525-0^Age^LN||35|yr|||||F
OBX|6|NM|6690-2^WBC^LN||5.2|10*9/L|4.0-10.0|N|||F
OBX|7|NM|731-0^LYM#^LN||2.2|10*9/L|0.8-4.0|N|||F
...
OBX|33|ED|15000^WBC Histogram. Binary^99MRC||^Application^Octer-stream^Base64^AAAAAAABAwk...|||||F
```

## Segmentos relevantes

### MSH — Message Header (siempre primero)

| Campo | Posición | Contenido | Uso |
|-------|----------|-----------|-----|
| Field Separator | MSH-1 | `\|` | Validar |
| Encoding Chars | MSH-2 | `^~\&` | Validar |
| Sending App | MSH-3 | (vacío en BC-20s) | Ignorar |
| Timestamp | MSH-7 | `YYYYMMDDHHMMSS` | Timestamp del mensaje |
| Message Type | MSH-9 | `ORU^R01` | Determinar tipo |
| Message Control ID | MSH-10 | número | **Crítico**: usar para construir el ACK |
| Processing ID | MSH-11 | `P` o `T` | Producción vs test |
| Version ID | MSH-12 | `2.3.1` | Validar |
| Character Set | MSH-18 | `UNICODE` | Confirmar UTF-8 |

### PID — Patient Identification

| Campo | Contenido |
|-------|-----------|
| PID-3 | Patient ID (historia clínica) |
| PID-5 | Nombre `apellido^nombre` |
| PID-7 | Fecha de nacimiento `YYYYMMDDHHMMSS` |
| PID-8 | Sexo: `Male` / `Female` / `Unknown` |

### OBR — Observation Request

| Campo | Contenido |
|-------|-----------|
| OBR-3 | **Sample ID** — identificador de la muestra |
| OBR-4 | Universal Service ID, ej `00001^Automated Count^99MRC` |
| OBR-6 | Requested DateTime |
| OBR-7 | Observation DateTime (cuando se procesó) |
| OBR-10 | Operador |
| OBR-25 | Result Status (ej `HM` = hematology) |

### OBX — Observation/Result (uno por cada parámetro)

Ver [`04-mapeo-obx.md`](04-mapeo-obx.md) para el mapeo completo de los 19+ parámetros.

Estructura general:

```
OBX|<setId>|<valueType>|<code>^<name>^<codingSystem>||<value>|<unit>|<refRange>|<flags>|||<resultStatus>
```

Tipos de valor (`OBX-2`):
- `NM` — número (ej WBC, RBC, HGB)
- `IS` — código de tabla (ej Take Mode, Blood Mode)
- `ST` — string
- `ED` — encapsulated data (histogramas en base64)

Flags de anormalidad (`OBX-8`), separadas por `~`:
- `N` normal
- `H` alto / `L` bajo
- `HH` crítico alto / `LL` crítico bajo
- `A` anormal genérico

## Histogramas (OBX con valueType=ED)

WBC, RBC y PLT envían cada uno **256 bytes** con la altura de cada canal del histograma, codificados en base64 dentro del OBX-5:

```
OBX|33|ED|15000^WBC Histogram. Binary^99MRC||^Application^Octer-stream^Base64^<BASE64>|||||F
```

Estructura del campo OBX-5 (separado por `^`):

| Componente | Valor |
|------------|-------|
| Source App | (vacío) |
| Type of Data | `Application` |
| Data Subtype | `Octer-stream` (sic — typo del fabricante, así viene) |
| Encoding | `Base64` |
| Data | el payload base64 |

Decodificar el base64 da exactamente 256 bytes. Cada byte (0-255) es la altura del canal en esa posición. Los discriminadores (líneas que separan poblaciones celulares) vienen en OBX adicionales con códigos `15001`, `15002`, etc.

## Códigos OBX-3 — Coding Systems

El XS 20 usa dos sistemas de codificación:

- **`LN`** — LOINC (estándar internacional). Para parámetros de CBC universales.
- **`99MRC`** — código propietario Mindray. Para flags morfológicas y datos específicos del equipo (modo de toma, modo de sangre, histogramas).

## ACK^R01 — La respuesta que tenemos que devolver

Después de cada `ORU^R01` el XS 20 espera un `ACK^R01` en menos de **4 segundos**. Si no llega, reintenta o abandona la conexión.

Mensaje mínimo de ACK:

```
MSH|^~\&|||||<TIMESTAMP_AHORA>||ACK^R01|<NUEVO_ID>|P|2.3.1||||||UNICODE
MSA|AA|<MESSAGE_CONTROL_ID_DEL_ORIGINAL>
```

Donde:
- `<TIMESTAMP_AHORA>` es `YYYYMMDDHHMMSS` actual.
- `<NUEVO_ID>` es un ID que generamos (puede ser `1`, un counter, o un ULID).
- `<MESSAGE_CONTROL_ID_DEL_ORIGINAL>` es el MSH-10 que recibimos en el ORU.
- `AA` significa "Application Accept" (todo OK). Otras opciones: `AE` (error), `AR` (rechazado).

Y se envuelve en MLLP igual que el mensaje original: `<VT>...mensaje...<FS><CR>`.

## Referencias

- "BC-20S & 30S Communication Protocol V1.0 EN" (Mindray) — disponible en repos públicos.
- Manual de operador del Mindray BC-20s (Keul GmbH publica el PDF).
- HL7 v2.3.1 standard (oficial, hl7.org).
- MLLP: ver capítulo 10 de la HL7 Implementation Guide.
