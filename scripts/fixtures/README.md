# Mensajes HL7 de muestra

Estos mensajes están **basados en el documento "BC-20S & 30S Communication Protocol V1.0"** del fabricante OEM (Mindray) y sirven como fixtures para:

- El simulador del XS 20 (`scripts/simulator/`).
- Los tests del parser.
- Validación end-to-end durante el desarrollo sin equipo físico.

## Ejemplo 1: ORU^R01 con CBC+DIFF normal

`fixtures/oru-r01-normal.hl7` — Mensaje completo con valores dentro del rango.

> Nota: en el archivo real los segmentos están separados por `\r` (CR), no por `\n`. Para verlo con un editor estándar, los archivos `.hl7` los guardamos con `\r\n` y el parser ignora los `\n`.

```
MSH|^~\&|||||20260427153211||ORU^R01|1001|P|2.3.1||||||UNICODE
PID|1||MR123456^^^^MR||Pérez^Juan||19820123000000|Male
PV1|1|Outpatient|||||||||
OBR|1||S20260427-0001|00001^Automated Count^99MRC||20260427150000|20260427153100|||operador1||||20260427150500||||||||||HM
OBX|1|IS|08001^Take Mode^99MRC||O||||||F
OBX|2|IS|08002^Blood Mode^99MRC||W||||||F
OBX|3|IS|08003^Test Mode^99MRC||CBC+DIFF||||||F
OBX|4|ST|01001^Ref Group^99MRC||General||||||F
OBX|5|NM|30525-0^Age^LN||44|yr|||||F
OBX|6|NM|6690-2^WBC^LN||7.2|10*9/L|4.0-10.0|N|||F
OBX|7|NM|731-0^LYM#^LN||2.5|10*9/L|0.8-4.0|N|||F
OBX|8|NM|736-9^LYM%^LN||34.7|%|20.0-40.0|N|||F
OBX|9|NM|10027^MID#^99MRC||0.5|10*9/L|0.1-1.5|N|||F
OBX|10|NM|10029^MID%^99MRC||6.9|%|3.0-15.0|N|||F
OBX|11|NM|10028^GRAN#^99MRC||4.2|10*9/L|2.0-7.0|N|||F
OBX|12|NM|10030^GRAN%^99MRC||58.4|%|50.0-70.0|N|||F
OBX|13|NM|789-8^RBC^LN||4.8|10*12/L|4.0-5.5|N|||F
OBX|14|NM|718-7^HGB^LN||145|g/L|120-160|N|||F
OBX|15|NM|4544-3^HCT^LN||43.5|%|36.0-50.0|N|||F
OBX|16|NM|787-2^MCV^LN||90.6|fL|80.0-99.0|N|||F
OBX|17|NM|785-6^MCH^LN||30.2|pg|26.0-32.0|N|||F
OBX|18|NM|786-4^MCHC^LN||333|g/L|320-360|N|||F
OBX|19|NM|788-0^RDW-CV^LN||12.8|%|11.0-16.0|N|||F
OBX|20|NM|21000-5^RDW-SD^LN||42.1|fL|35.0-56.0|N|||F
OBX|21|NM|777-3^PLT^LN||245|10*9/L|100-300|N|||F
OBX|22|NM|32623-1^MPV^LN||8.5|fL|6.5-12.0|N|||F
OBX|23|NM|32207-3^PDW^LN||15.2||9.0-17.0|N|||F
OBX|24|NM|10002^PCT^99MRC||0.21|%|0.10-0.30|N|||F
```

## Ejemplo 2: ORU^R01 con valores anormales (anemia + leucocitosis)

`fixtures/oru-r01-anormal.hl7` — Mensaje con flags H/L y morfológicas levantadas.

```
MSH|^~\&|||||20260427160000||ORU^R01|1002|P|2.3.1||||||UNICODE
PID|1||MR789012^^^^MR||González^María||19550612000000|Female
OBR|1||S20260427-0002|00001^Automated Count^99MRC||20260427155500|20260427160000|||operador1||||20260427155800||||||||||HM
OBX|1|IS|08001^Take Mode^99MRC||O||||||F
OBX|2|IS|08002^Blood Mode^99MRC||W||||||F
OBX|3|IS|08003^Test Mode^99MRC||CBC+DIFF||||||F
OBX|6|NM|6690-2^WBC^LN||14.8|10*9/L|4.0-10.0|H|||F
OBX|7|NM|731-0^LYM#^LN||1.8|10*9/L|0.8-4.0|N|||F
OBX|11|NM|10028^GRAN#^99MRC||11.2|10*9/L|2.0-7.0|H|||F
OBX|13|NM|789-8^RBC^LN||3.2|10*12/L|4.0-5.5|L|||F
OBX|14|NM|718-7^HGB^LN||92|g/L|120-160|L|||F
OBX|15|NM|4544-3^HCT^LN||28.5|%|36.0-50.0|L|||F
OBX|16|NM|787-2^MCV^LN||72.4|fL|80.0-99.0|L|||F
OBX|21|NM|777-3^PLT^LN||455|10*9/L|100-300|H|||F
OBX|30|ST|^Anemia^99MRC||Anemia||||||F
OBX|31|ST|^Microcytes^99MRC||Microcytes||||||F
OBX|32|ST|^Leukocytosis^99MRC||Leukocytosis||||||F
OBX|33|ST|^Neutrophilia^99MRC||Neutrophilia||||||F
OBX|34|ST|^Thrombocytosis^99MRC||Thrombocytosis||||||F
```

## Ejemplo 3: ORU^R01 con histogramas

`fixtures/oru-r01-with-histograms.hl7` — Igual que ejemplo 1 + segmentos OBX con histogramas WBC/RBC/PLT.

Los payloads base64 reales tienen ~344 caracteres cada uno (256 bytes * 4/3 ≈ 342 + padding). Para los fixtures generamos histogramas sintéticos con distribución realista usando un script (ver `scripts/simulator/generate-histograms.ts` cuando lleguemos a Fase 1).

```
...
OBX|33|ED|15000^WBC Histogram. Binary^99MRC||^Application^Octer-stream^Base64^<344-char-base64>|||||F
OBX|34|NM|15001^WBC Left Line^99MRC||35||||||F
OBX|35|NM|15002^WBC Mid Line^99MRC||120||||||F
OBX|36|NM|15003^WBC Right Line^99MRC||220||||||F
OBX|37|ED|15010^RBC Histogram. Binary^99MRC||^Application^Octer-stream^Base64^<344-char-base64>|||||F
OBX|38|NM|15011^RBC Left Line^99MRC||45||||||F
OBX|39|NM|15012^RBC Right Line^99MRC||225||||||F
OBX|40|ED|15020^PLT Histogram. Binary^99MRC||^Application^Octer-stream^Base64^<344-char-base64>|||||F
OBX|41|NM|15021^PLT Left Line^99MRC||10||||||F
OBX|42|NM|15022^PLT Right Line^99MRC||80||||||F
```

## Ejemplo 4: ACK^R01 (lo que devolvemos nosotros)

`fixtures/ack-r01-aa.hl7` — Application Accept (todo OK).

```
MSH|^~\&|||||20260427153212||ACK^R01|2001|P|2.3.1||||||UNICODE
MSA|AA|1001
```

`fixtures/ack-r01-ae.hl7` — Application Error (parseo falló pero seguimos vivos).

```
MSH|^~\&|||||20260427153212||ACK^R01|2002|P|2.3.1||||||UNICODE
MSA|AE|1001|Parse error: missing OBR segment
```

## Casos edge a cubrir en Fase 1

- Mensaje truncado a mitad (sin `<FS><CR>`).
- MSH-10 duplicado (idempotencia).
- OBX con código desconocido (warn pero no fail).
- Histograma con base64 inválido.
- Múltiples mensajes en una sola conexión TCP.
- Caracteres especiales en el nombre del paciente (acentos, ñ, espacios escapados con `\E\`).
- Conexión que se cierra mid-mensaje.
- ENQ inicial sin mensaje subsiguiente.
- Heartbeat 0x02 entre mensajes.
