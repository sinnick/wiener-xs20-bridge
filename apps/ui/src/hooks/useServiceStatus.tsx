/**
 * Estado de salud del servicio, compartido por toda la app.
 *
 * Antes el fetch de /api/health vivia adentro de StatusView, con dos problemas:
 *  - el resto de la app (sidebar, Resultados) no tenia forma de saber si el
 *    servicio estaba vivo;
 *  - un fallo posterior no invalidaba el ultimo health, asi que la pantalla
 *    seguia diciendo "En línea" con el servicio muerto.
 *
 * Aca guardamos el ultimo dato conocido PERO tambien cuando se obtuvo y si el
 * ultimo intento fallo, para que la UI pueda distinguir "dato fresco" de
 * "ultimo dato conocido hace N minutos".
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { apiErrorMessage, getHealth, type HealthResponse } from "../lib/api";

const POLL_MS = 3000;
/** Cuantos intentos fallidos seguidos hacen falta para declarar "sin conexión". */
const FAILURES_BEFORE_OFFLINE = 2;
/** A partir de aca el dato mostrado ya no se considera fresco. */
export const STALE_AFTER_MS = 10000;

export type ServicePhase =
  /** Todavia no hubo ninguna respuesta: la app recien arranca. */
  | "booting"
  /** El ultimo chequeo salio bien. */
  | "online"
  /** Varios chequeos seguidos fallaron. */
  | "offline";

/** Estado del vinculo con el analizador (distinto de la salud del servicio). */
export type LinkState = "connected" | "waiting" | "down" | "unknown";

export interface ServiceStatus {
  /** Ultimo health conocido (puede ser viejo: mirar `staleMs`). */
  health: HealthResponse | null;
  /** Timestamp del ultimo health OK, o null si nunca hubo uno. */
  lastOkAt: number | null;
  /** Hace cuanto se obtuvo el ultimo health, o null. */
  staleMs: number | null;
  /** True si el dato mostrado ya no es fresco. */
  stale: boolean;
  /** Error del ultimo intento, o null si el ultimo intento salio bien. */
  error: string | null;
  phase: ServicePhase;
  /** Vinculo con el analizador, ya interpretado segun el modo de conexion. */
  link: { state: LinkState; label: string };
  /** Fuerza un chequeo inmediato. */
  refresh: () => void;
}

const Ctx = createContext<ServiceStatus | null>(null);

interface InternalState {
  health: HealthResponse | null;
  lastOkAt: number | null;
  error: string | null;
  phase: ServicePhase;
  /** Cambia en cada poll para que "hace N minutos" se refresque solo. */
  tick: number;
}

export function ServiceStatusProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<InternalState>({
    health: null,
    lastOkAt: null,
    error: null,
    phase: "booting",
    tick: 0,
  });
  const failuresRef = useRef(0);
  const activeRef = useRef(true);
  const pollRef = useRef<() => void>(() => {});

  useEffect(() => {
    activeRef.current = true;

    const poll = () => {
      getHealth()
        .then((h) => {
          if (!activeRef.current) return;
          failuresRef.current = 0;
          setState((prev) => ({
            health: h,
            lastOkAt: Date.now(),
            error: null, // <- el bug viejo: el error nunca se limpiaba
            phase: "online",
            tick: prev.tick + 1,
          }));
        })
        .catch((e) => {
          if (!activeRef.current) return;
          failuresRef.current++;
          const offline = failuresRef.current >= FAILURES_BEFORE_OFFLINE;
          setState((prev) => ({
            ...prev,
            error: apiErrorMessage(e),
            // Conservamos el ultimo health conocido, pero la fase deja de ser
            // "online" para que nadie lo muestre como si fuera de ahora.
            phase: offline ? "offline" : prev.phase === "booting" ? "booting" : prev.phase,
            tick: prev.tick + 1,
          }));
        });
    };

    pollRef.current = poll;
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      activeRef.current = false;
      clearInterval(timer);
    };
  }, []);

  const refresh = useCallback(() => pollRef.current(), []);

  const value = useMemo<ServiceStatus>(() => {
    const staleMs = state.lastOkAt === null ? null : Date.now() - state.lastOkAt;
    return {
      health: state.health,
      lastOkAt: state.lastOkAt,
      staleMs,
      // Basta con que el ULTIMO intento haya fallado para que el dato deje de
      // ser fresco. No esperamos al umbral de "offline": ese umbral es para no
      // pintar todo de rojo por un hipo, no para seguir diciendo "al día".
      stale:
        state.error !== null ||
        state.phase !== "online" ||
        (staleMs !== null && staleMs > STALE_AFTER_MS),
      error: state.error,
      phase: state.phase,
      link: describeLink(state.health, state.phase),
      refresh,
    };
    // `tick` entra a proposito: obliga a recalcular staleMs en cada poll.
  }, [state, refresh]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useServiceStatus(): ServiceStatus {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useServiceStatus tiene que usarse adentro de ServiceStatusProvider");
  }
  return ctx;
}

/**
 * Traduce el health a "como esta el vinculo con el equipo".
 *
 * Ojo con el modo: escuchando, que no haya conexion abierta es NORMAL (el
 * XS 20 conecta solo cuando manda una muestra). En modo "nos conectamos", en
 * cambio, no estar conectado si es un problema.
 */
function describeLink(health: HealthResponse | null, phase: ServicePhase): ServiceStatus["link"] {
  if (phase === "offline") return { state: "down", label: "Sin conexión con el servicio" };
  if (!health) return { state: "unknown", label: "Conectando con el servicio…" };

  if (health.connectionMode === "connect" && health.analyzerClient) {
    if (health.analyzerClient.connected) return { state: "connected", label: "Conectado al equipo" };
    return { state: "down", label: "Sin conexión con el equipo" };
  }

  if (!health.tcpListener.listening) {
    return { state: "down", label: "No se está escuchando al equipo" };
  }
  if (health.tcpListener.activeConnections > 0) {
    return { state: "connected", label: "Conectado al equipo" };
  }
  return { state: "waiting", label: "Escuchando al equipo" };
}

/** "hace 3 minutos", "recién", etc. Para el indicador de frescura. */
export function formatAgo(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 10) return "recién";
  if (s < 60) return `hace ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m} ${m === 1 ? "minuto" : "minutos"}`;
  const h = Math.floor(m / 60);
  return `hace ${h} ${h === 1 ? "hora" : "horas"}`;
}
