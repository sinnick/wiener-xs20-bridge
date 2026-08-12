# 11 — Exportación a .txt por muestra

Por cada resultado recibido del analizador, el servicio escribe un archivo de
texto plano con el formato que usa el laboratorio para transcribir:

```
LEUCOCITOS: 7.3
LINFOCITOS#: 1.7
MEDIOS#: 0.7
MEDIOS%: 9.1
GRANULOCITOS#: 4.9
GRANULOCITOS%: 68.1
ERITROCITOS: 3.24
HEMOGLOBINA: 8.9
HEMATOCRITO: 28.4
VCM: 87.5
CHCM: 31.4
RDW-CV: 13.3
RDW-SD: 41.5
PLAQUETAS: 110
VPM: 10.7
PDW: 16.6
PLAQUETOCRITO: 0.117
```

## Reglas

- **Nombre del archivo**: `<idMuestra>.txt` (el OBR-3 del mensaje, ej. `000015.txt`).
  Caracteres no aptos para nombre de archivo se reemplazan por `_`.
- **Contenido**: solo `TITULO: valor`, sin unidades ni rangos. Fines de línea CRLF.
- **Parámetros y orden**: los 17 de la nota del laboratorio (la lista vive en
  `EXPORT_LINES` de `apps/service/src/export/txt-exporter.ts`). El equipo manda
  además LINFOCITOS% y HCM; hoy no se escriben — agregar una línea a la tabla si
  el laboratorio los pide.
- **Unidades**: HEMOGLOBINA y CHCM se escriben en g/dL. Si el equipo manda g/L
  (según el OBX-6), el servicio divide por 10; si ya manda g/dL, pasa tal cual.
- **Re-corridas**: si vuelve a entrar la misma muestra, el archivo se pisa con
  el resultado más nuevo. Un mensaje duplicado (mismo MSH-10) no re-escribe.
- **Errores**: un fallo de escritura (disco lleno, sin permisos) se loguea como
  `export.txt_failed` pero nunca frena el procesamiento ni el ACK al equipo.

## Configuración

La carpeta de destino se cambia desde la app (**Estado → Configuración →
Carpeta de exportación de .txt**) o vía `PUT /api/config { "exportDir": "..." }`.
Vacío = exportación deshabilitada.

Default: `<dataDir>/exportes` (en Windows, `C:\ProgramData\WienerXS20\exportes`).
Ojo: `C:\ProgramData` es una carpeta oculta — para el uso real del laboratorio
conviene apuntarla a algo visible, ej. `C:\Users\<usuario>\Documents\Hemogramas`.

También existe el override por entorno `XS20_EXPORT_DIR` y el orden de
precedencia es el mismo del resto de la config (ver `config.ts`).
