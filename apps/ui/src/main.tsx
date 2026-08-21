import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ServiceStatusProvider } from "./hooks/useServiceStatus";
import { initToken } from "./lib/api";
import "./index.css";

// El token se resuelve en segundo plano: `get_api_token` puede tardar varios
// segundos cuando el servicio arranca en frio, y bloquear el montaje con eso
// deja la ventana en blanco todo ese rato. Montamos ya, y cada request
// reintenta el token por su cuenta si el servicio contesta 401.
void initToken();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <ServiceStatusProvider>
        <App />
      </ServiceStatusProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
