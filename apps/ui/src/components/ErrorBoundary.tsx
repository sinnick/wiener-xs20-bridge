/**
 * Red de contencion de errores de render.
 *
 * Sin esto, cualquier excepcion (un histograma corrupto, un campo null que no
 * esperabamos) deja la ventana en blanco: el WebView de Tauri no tiene consola
 * ni forma de recuperarse, y la operadora no tiene nada que reportar.
 *
 * Con esto queda una pantalla que explica que paso, permite reintentar sin
 * cerrar la app, y ofrece copiar el detalle tecnico para mandarlo por WhatsApp.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Copy, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: string | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Sin consola visible en produccion: al menos queda en el log del WebView.
    console.error("Error de render", error, info);
    this.setState({ info: info.componentStack ?? null });
  }

  private readonly reset = () => {
    this.setState({ error: null, info: null, copied: false });
  };

  private readonly copyDetail = () => {
    const { error, info } = this.state;
    const detail = [
      `Wiener XS 20 — error en la aplicación`,
      new Date().toLocaleString("es-AR"),
      "",
      error?.stack ?? String(error),
      info ?? "",
    ].join("\n");
    void navigator.clipboard
      ?.writeText(detail)
      .then(() => {
        this.setState({ copied: true });
        setTimeout(() => this.setState({ copied: false }), 2500);
      })
      .catch(() => {
        /* portapapeles no disponible */
      });
  };

  override render(): ReactNode {
    const { error, copied } = this.state;
    if (!error) return this.props.children;

    return (
      <div role="alert" className="flex h-screen items-center justify-center bg-bg px-8">
        <div className="max-w-lg text-center">
          <AlertTriangle
            className="mx-auto h-12 w-12 text-high-text"
            strokeWidth={1.25}
            aria-hidden="true"
          />
          <h1 className="mt-4 text-2xl font-medium text-text-strong">
            La aplicación tuvo un problema
          </h1>
          <p className="mt-2 text-sm text-text-muted">
            No se perdió ningún resultado: todo lo que mandó el analizador ya está
            guardado. Probá volver a la pantalla principal; si vuelve a pasar,
            cerrá y abrí la app.
          </p>

          <div className="mt-6 flex items-center justify-center gap-3">
            <button
              onClick={this.reset}
              className="inline-flex items-center gap-2 rounded-sm bg-accent px-4 py-2 text-sm font-medium text-surface hover:bg-accent-hover"
            >
              <RefreshCw className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
              Volver a la pantalla principal
            </button>
            <button
              onClick={this.copyDetail}
              className="inline-flex items-center gap-2 rounded-sm px-4 py-2 text-sm text-text-muted hover:bg-border/30 hover:text-text"
            >
              <Copy className="h-4 w-4" strokeWidth={1.5} aria-hidden="true" />
              {copied ? "Copiado" : "Copiar el detalle"}
            </button>
          </div>

          <details className="mt-6 text-left">
            <summary className="cursor-pointer text-xs text-text-muted">
              Detalle técnico
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-sm border border-border bg-surface p-3 text-left font-mono text-xs text-text-muted">
              {error.stack ?? String(error)}
            </pre>
          </details>
        </div>
      </div>
    );
  }
}
