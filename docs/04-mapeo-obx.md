# 04 — Mapeo OBX → parámetros del hemograma

Esta es la tabla **autoritativa**: define cómo el parser convierte cada segmento OBX que envía el XS 20 en un campo de la estructura `HemogramResult`.

## Parámetros numéricos (CBC + 3-DIFF)

19 parámetros principales. La columna `Param canónico` es la key que usamos en `HemogramResult.values` y en la columna `result_values.param` de la DB.

| OBX-3 código | OBX-3 nombre | Coding | Param canónico | Unidad | Tipo |
|--------------|--------------|--------|----------------|--------|------|
| `6690-2` | WBC | LN (LOINC) | `wbc` | `10*9/L` | NM |
| `731-0` | LYM# | LN | `lym_abs` | `10*9/L` | NM |
| `736-9` | LYM% | LN | `lym_pct` | `%` | NM |
| `10027` | MID# | 99MRC | `mid_abs` | `10*9/L` | NM |
| `10029` | MID% | 99MRC | `mid_pct` | `%` | NM |
| `10028` | GRAN# | 99MRC | `gran_abs` | `10*9/L` | NM |
| `10030` | GRAN% | 99MRC | `gran_pct` | `%` | NM |
| `789-8` | RBC | LN | `rbc` | `10*12/L` | NM |
| `718-7` | HGB | LN | `hgb` | `g/L` | NM |
| `4544-3` | HCT | LN | `hct` | `%` | NM |
| `787-2` | MCV | LN | `mcv` | `fL` | NM |
| `785-6` | MCH | LN | `mch` | `pg` | NM |
| `786-4` | MCHC | LN | `mchc` | `g/L` | NM |
| `788-0` | RDW-CV | LN | `rdw_cv` | `%` | NM |
| `21000-5` | RDW-SD | LN | `rdw_sd` | `fL` | NM |
| `777-3` | PLT | LN | `plt` | `10*9/L` | NM |
| `32623-1` | MPV | LN | `mpv` | `fL` | NM |
| `32207-3` | PDW | LN | `pdw` | (s/u) | NM |
| `10002` | PCT | 99MRC | `pct` | `%` | NM |

**Nota sobre HGB**: el equipo manda en `g/L` por default. En Argentina muchos labs usan `g/dL`. La conversión es trivial (`g/dL = g/L / 10`), pero la guardamos en la unidad original tal como vino y la UI ofrece toggle de presentación. **No transformamos el valor en el servicio** — el principio es: persistir tal cual llegó, transformar solo al renderizar.

## Metadata del modo de toma (OBX `99MRC`, valueType=IS)

| OBX-3 código | Nombre | Campo en `SampleInfo` | Valores posibles |
|--------------|--------|------------------------|------------------|
| `08001` | Take Mode | `takeMode` | `O` (open), `C` (closed), etc. |
| `08002` | Blood Mode | `bloodMode` | `W` (whole), `P` (predilute) |
| `08003` | Test Mode | `testMode` | `CBC`, `CBC+DIFF` |
| `01001` | Ref Group | `refGroup` | string libre |
| `30525-0` | Age | `patient.ageYears` | número (LOINC) |

## Histogramas (OBX `99MRC`, valueType=ED)

| OBX-3 código | Nombre | Mapeo |
|--------------|--------|-------|
| `15000` | WBC Histogram. Binary | `histograms[type='wbc'].channels` (256 bytes) |
| `15010` | RBC Histogram. Binary | `histograms[type='rbc'].channels` |
| `15020` | PLT Histogram. Binary | `histograms[type='plt'].channels` |

### Discriminadores (líneas que separan poblaciones)

Vienen como OBX adicionales con tipo `NM` después del histograma. Los códigos exactos pueden variar entre firmwares; los tomamos como números enteros 0-255 (índice de canal) y los guardamos en `histograms.left_line / mid_line / right_line`:

| OBX-3 código | Histograma | Discriminador |
|--------------|------------|---------------|
| `15001` | WBC | left line (LYM/MID) |
| `15002` | WBC | mid line (MID/GRAN) |
| `15003` | WBC | right line |
| `15011` | RBC | left line |
| `15012` | RBC | right line |
| `15021` | PLT | left line |
| `15022` | PLT | right line |

> **Caveat**: estos códigos están documentados en el protocolo Mindray pero pueden cambiar entre firmwares. El parser debe ser tolerante: si llega un código `15xxx` desconocido, loggearlo en `audit_log` con el evento `hl7.unknown_obx` pero no fallar el parseo del resto.

## Flags morfológicas / sospechas (OBX `99MRC`, valueType=ST)

Vienen como OBX con OBX-5 = código de la flag y OBX-3.2 que la describe. Cada flag presente significa "el equipo levantó esta alarma".

Lista no exhaustiva (los códigos exactos del XS 20 pueden variar — los descubrimos en pruebas reales):

| Código | Significado |
|--------|-------------|
| `Leukocytosis` | Leucocitosis (WBC alto) |
| `Leukopenia` | Leucopenia (WBC bajo) |
| `Neutrophilia` | Neutrofilia |
| `Neutropenia` | Neutropenia |
| `Lymphocytosis` | Linfocitosis |
| `Lymphopenia` | Linfopenia |
| `Monocytosis` | Monocitosis |
| `Eosinophilia` | Eosinofilia |
| `Basophilia` | Basofilia |
| `Imm Granulocytes?` | Sospecha de granulocitos inmaduros |
| `Atypical Lymphs?` | Sospecha de linfocitos atípicos |
| `Erythrocytosis` | Eritrocitosis |
| `Anemia` | Anemia |
| `Anisocytosis` | Anisocitosis |
| `Microcytes` | Microcitos |
| `Macrocytes` | Macrocitos |
| `Hypochromia` | Hipocromía |
| `RBC Abnormal Distribution` | Distribución anormal de RBC |
| `HGB Abn./Interfere` | HGB anormal / interferencia |
| `Thrombocytosis` | Trombocitosis (PLT alto) |
| `Thrombopenia` | Trombocitopenia (PLT bajo) |
| `PLT Clump?` | Sospecha de cúmulos plaquetarios |

Mapeo: cada flag se persiste como un row en `morphology_flags(result_id, code)`. El contador `results.morphology_flag_count` se calcula en el insert para evitar count en la lista.

## Algoritmo del parser (pseudo)

```
1. Recibir trama MLLP, extraer payload HL7.
2. Split por \r → segmentos.
3. Para cada segmento:
   a. Tomar las primeras 3 letras → nombre de segmento.
   b. Split del resto por |.
   c. Para cada campo: split por ~ (repeticiones), luego ^ (componentes), luego & (subcomponentes).
4. Validar que existe MSH y que MSH-12 = "2.3.1".
5. Extraer MSH-10 (messageControlId) — lo necesitamos para el ACK.
6. Construir `HemogramResult`:
   - patient ← PID
   - sample ← OBR + OBX[08001..08003, 01001]
   - values ← OBX donde valueType=NM y código está en la tabla de arriba
   - histograms ← OBX donde valueType=ED + discriminadores adyacentes
   - morphologyFlags ← OBX donde valueType=ST y código no es uno de los reservados
7. Cualquier OBX con código no reconocido: loggear con event="hl7.unknown_obx", continuar.
8. Si hay un error fatal (MSH ausente, versión incorrecta): persistir solo en raw_messages con parse_status='failed' y devolver ACK con MSA|AE|...
```

## Tabla LOINC vs 99MRC — por qué importa

LOINC es internacional y estable. 99MRC es propietario. Si en el futuro queremos integrar con un LIS estándar, los parámetros con código LOINC se mapean directo, los `99MRC` necesitan tabla de traducción. Por eso guardamos el coding system en el OBX original (campo `result_values` no lo guarda hoy, pero `raw_messages` sí lo conserva textualmente, así que siempre podemos reconstruir).
