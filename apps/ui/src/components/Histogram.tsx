/**
 * Histograma renderizado con tick bars segmentadas.
 *
 * Es el elemento de firma de la UI: en vez de una curva/area solida, cada canal
 * del histograma (256 valores 0-255) se dibuja como una barra vertical compuesta
 * por ticks redondeados apilados. Los discriminadores (lineas que separan
 * poblaciones celulares) se dibujan como lineas verticales punteadas encima.
 *
 * Para 256 canales seria demasiado denso, asi que agregamos (downsample) a ~64
 * columnas promediando, y cada columna se dibuja con ticks proporcionales a la
 * altura.
 */

interface HistogramProps {
  type: "wbc" | "rbc" | "plt";
  /** Base64 de los 256 bytes (como viene de la API). */
  channelsBase64: string;
  discriminators: {
    leftLine?: number;
    midLine?: number;
    rightLine?: number;
  };
}

const TYPE_LABEL: Record<HistogramProps["type"], string> = {
  wbc: "Leucocitos (WBC)",
  rbc: "Eritrocitos (RBC)",
  plt: "Plaquetas (PLT)",
};

// Cada columna se compone de hasta N ticks; la altura del canal decide cuantos.
const COLUMNS = 64;
const MAX_TICKS = 10;

function decodeBase64(b64: string): number[] {
  try {
    const bin = atob(b64);
    const out: number[] = new Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return [];
  }
}

/** Reduce 256 canales a COLUMNS promediando bloques. */
function downsample(channels: number[]): number[] {
  if (channels.length === 0) return [];
  const block = Math.ceil(channels.length / COLUMNS);
  const cols: number[] = [];
  for (let c = 0; c < COLUMNS; c++) {
    let sum = 0;
    let n = 0;
    for (let i = c * block; i < (c + 1) * block && i < channels.length; i++) {
      sum += channels[i]!;
      n++;
    }
    cols.push(n > 0 ? sum / n : 0);
  }
  return cols;
}

export function Histogram({ type, channelsBase64, discriminators }: HistogramProps) {
  const channels = decodeBase64(channelsBase64);
  const cols = downsample(channels);
  const max = Math.max(1, ...cols);

  // Posiciones de los discriminadores en el eje de columnas (0-255 → 0-COLUMNS).
  const discLines = [
    discriminators.leftLine,
    discriminators.midLine,
    discriminators.rightLine,
  ]
    .filter((v): v is number => v !== undefined)
    .map((v) => (v / 256) * COLUMNS);

  return (
    <div className="rounded-lg border border-border bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-mono text-xs uppercase tracking-wider text-text-muted">
          {TYPE_LABEL[type]}
        </span>
        <span className="font-mono text-xs text-text-muted tnum">256 canales</span>
      </div>

      <div className="relative flex h-32 items-end gap-[2px]">
        {cols.map((v, i) => {
          const heightFrac = v / max;
          const ticks = Math.max(v > 0 ? 1 : 0, Math.round(heightFrac * MAX_TICKS));
          return (
            <div key={i} className="flex flex-1 flex-col-reverse gap-[2px]">
              {Array.from({ length: MAX_TICKS }).map((_, t) => (
                <div
                  key={t}
                  className={`h-[6px] rounded-[2px] ${
                    t < ticks ? tickColor(type) : "bg-border/40"
                  }`}
                />
              ))}
            </div>
          );
        })}

        {/* Discriminadores: lineas verticales punteadas */}
        {discLines.map((pos, i) => (
          <div
            key={`disc-${i}`}
            className="pointer-events-none absolute top-0 bottom-0 border-l border-dashed border-text-muted/50"
            style={{ left: `${(pos / COLUMNS) * 100}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function tickColor(type: HistogramProps["type"]): string {
  // Un tono por tipo, dentro de la familia del acento.
  switch (type) {
    case "wbc":
      return "bg-accent";
    case "rbc":
      return "bg-high-text";
    case "plt":
      return "bg-warn-text";
  }
}
