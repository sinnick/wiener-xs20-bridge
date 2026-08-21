# 11 — Exportación a .txt por muestra

Por cada resultado recibido del analizador, el servicio escribe un archivo de
texto plano en la carpeta que mira el laboratorio. **Este archivo es el producto
del bridge**: es lo único que la operadora abre. Todo lo demás (TCP, HL7, base,
interfaz) existe para que aparezca bien escrito.

```
LEUCOCITOS: 6.2
LINFOCITOS#: 2.1
LINFOCITOS%: 33.9
MEDIOS#: 0.5
MEDIOS%: 8.1
GRANULOCITOS#: 3.6
GRANULOCITOS%: 58.0
ERITROCITOS: 4.85
HEMOGLOBINA: 14.2
HEMATOCRITO: 42.6
VCM: 87.8
CHCM: 33.3
RDW-CV: 12.9
RDW-SD: 40.2
PLAQUETAS: 245
VPM: 9.4
PDW: 15.8
PLAQUETOCRITO: 0.230
HCM: 29.3
```

(Es el ejemplo exacto de `apps/service/src/export/fixtures/hemograma-completo.txt`,
el golden file contra el que corre el test de formato. Los valores son
inventados: los resultados reales de pacientes no se versionan.)

## Las 19 líneas, en orden

Siempre están las 19, siempre en este orden. La columna "decimales" es con
cuántos se escribe el número.

| # | Título | Parámetro | Decimales |
|---|--------|-----------|-----------|
| 1 | `LEUCOCITOS` | wbc | 1 |
| 2 | `LINFOCITOS#` | lym_abs | 1 |
| 3 | `LINFOCITOS%` | lym_pct | 1 |
| 4 | `MEDIOS#` | mid_abs | 1 |
| 5 | `MEDIOS%` | mid_pct | 1 |
| 6 | `GRANULOCITOS#` | gran_abs | 1 |
| 7 | `GRANULOCITOS%` | gran_pct | 1 |
| 8 | `ERITROCITOS` | rbc | 2 |
| 9 | `HEMOGLOBINA` | hgb | 1 |
| 10 | `HEMATOCRITO` | hct | 1 |
| 11 | `VCM` | mcv | 1 |
| 12 | `CHCM` | mchc | 1 |
| 13 | `RDW-CV` | rdw_cv | 1 |
| 14 | `RDW-SD` | rdw_sd | 1 |
| 15 | `PLAQUETAS` | plt | 0 |
| 16 | `VPM` | mpv | 1 |
| 17 | `PDW` | pdw | 1 |
| 18 | `PLAQUETOCRITO` | pct | 3 |
| 19 | `HCM` | mch | 1 |

Los 17 primeros son los de la nota original del laboratorio, en su orden.
`LINFOCITOS%` se intercaló al lado de `LINFOCITOS#` (queda junto a `MEDIOS%` y
`GRANULOCITOS%`) y `HCM` va al final, que es donde se agregan los parámetros que
la nota no pedía. Los dos los manda el equipo desde siempre.

> La nota escribía "NEDIOS#" y "MEDIOC%": son errores de tipeo de la nota escrita
> a mano. Los títulos correctos son `MEDIOS#` y `MEDIOS%`.

La tabla vive en `EXPORT_FORMAT` / `EXPORT_ORDER` de
`apps/service/src/export/txt-exporter.ts` y es un `Record` sobre todos los
parámetros del contrato: si mañana se agrega un parámetro al hemograma, el
servicio **no compila** hasta que se le elija título y decimales. Un parámetro
nuevo no se puede caer del archivo por olvido.

## Reglas del formato

- **Nombre del archivo**: `<idMuestra>.txt` — el OBR-3 del mensaje, que en el
  laboratorio es un número (`000015.txt`). Todo lo que no sirva para un nombre de
  archivo de Windows se reemplaza por `_`; un id vacío o de puros puntos escribe
  `sin_id.txt`; un nombre reservado de Windows (`CON`, `NUL`, `COM1`…) se
  desarma con un `_` adelante, porque `CON.txt` no se puede crear.
- **Contenido**: solo `TÍTULO: valor`, sin unidades ni rangos.
- **Fines de línea**: CRLF, incluida la última línea (la PC del laboratorio es
  Windows).
- **Parámetros faltantes**: si el equipo no mandó un parámetro, **la línea sale
  igual, con el valor vacío** (`VCM: `). Así todos los archivos tienen la misma
  cantidad de líneas y en las mismas posiciones, sin importar el modo en que se
  corrió la muestra. Un valor que no es un número también sale vacío: escribir
  `NaN` en un resultado clínico es peor que dejar el hueco.
- **Unidades**: `HEMOGLOBINA` y `CHCM` se escriben en g/dL. Si el equipo las
  manda en g/L (según el OBX-6) el servicio divide por 10; si ya vienen en g/dL
  pasan tal cual. La comparación ignora mayúsculas y espacios. Si llegaran en
  otra unidad (por ejemplo mmol/L, que no sabemos convertir), el número se
  escribe tal cual y queda un `export.unexpected_unit` en la actividad: un 10x
  de más en la hemoglobina es un dato clínicamente peligroso y tiene que
  notarse.
- **Re-corridas**: si vuelve a entrar la misma muestra, el archivo se pisa con
  el resultado más nuevo (lo viejo sigue en la base). Un mensaje duplicado
  (mismo MSH-10) no re-escribe nada.
- **Escritura atómica**: primero se escribe un temporal en la misma carpeta, se
  baja a disco (fsync) y recién ahí se renombra sobre el destino. Si se corta la
  luz o se cae la unidad de red a mitad, el archivo anterior queda intacto y
  nunca se publica uno truncado — que sería indistinguible de un hemograma con
  menos parámetros.

## Cuando falla

Un fallo de escritura **nunca** frena el procesamiento del mensaje ni el ACK al
equipo: el resultado se guarda igual en la base. Pero tampoco es invisible, que
era el problema serio: antes, una carpeta con un typo o una unidad de red caída
hacían que cada muestra fallara en silencio y la aplicación seguía diciendo que
todo estaba bien.

- La carpeta se prueba (se escribe y se borra un archivo) **al arrancar el
  servicio** y **cada vez que se cambia desde la app**, no recién cuando llega
  una muestra.
- `GET /api/health` trae el bloque `export` con: si está habilitada, la carpeta,
  si la carpeta acepta escrituras, la última escritura exitosa, el último error
  (y de qué muestra), cuántas exportaciones seguidas vienen fallando y los
  contadores desde el arranque. Mientras no se pueda escribir, el servicio
  reporta `status: "degraded"`.
- La app lo muestra en **Estado → Exportación de .txt**, con el motivo del fallo
  y qué revisar.
- En la actividad quedan `export.dir_unavailable`, `export.txt_failed` y
  `export.unexpected_unit`.

El chequeo de la carpeta **no** se hace en cada `/api/health`: la app consulta
ese endpoint cada 3 segundos y una unidad de red caída puede colgar una
escritura de prueba varios segundos. El health devuelve la última foto conocida.

## Regenerar los .txt que faltaron

Si la carpeta estuvo mal configurada unos días, los resultados igual quedaron
guardados: se pueden volver a escribir los archivos sin re-correr las muestras
en el analizador.

- Desde la app: **Estado → Exportación de .txt → Regenerar .txt** (los últimos
  200 resultados).
- Por API:

```
POST /api/export/rerun
{ "ids": ["r_123"] }                 // resultados puntuales
{ "fromDate": "2026-08-01T00:00:00Z", "toDate": "2026-08-08T00:00:00Z" }
{ "limit": 500 }                     // los N más nuevos (default 200, tope 500)
```

Responde `{ dir, attempted, written, failed, notFound, errors }`. Si la
exportación está deshabilitada responde 409 `EXPORT_DISABLED`, y si la carpeta
no acepta escrituras 409 `EXPORT_DIR_UNAVAILABLE` con el motivo — un solo error
claro en lugar de doscientos iguales.

El archivo regenerado se arma exactamente igual que el de la exportación en vivo
(mismo formato, misma conversión de unidades), así que es indistinguible del
original.

## Configuración

La carpeta de destino se cambia desde la app (**Estado → Configuración →
Carpeta de exportación de .txt**) o vía `PUT /api/config { "exportDir": "..." }`.
Vacío = exportación deshabilitada (y eso no cuenta como falla: el health lo
muestra como "Apagada").

Default: `<dataDir>/exportes` (en Windows, `C:\ProgramData\WienerXS20\exportes`).
Ojo: `C:\ProgramData` es una carpeta oculta — para el uso real del laboratorio
conviene apuntarla a algo visible, ej. `C:\Users\<usuario>\Documents\Hemogramas`.

También existe el override por entorno `XS20_EXPORT_DIR` y el orden de
precedencia es el mismo del resto de la config (ver `config.ts`).
