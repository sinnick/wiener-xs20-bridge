import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { initToken } from "./lib/api";
import "./index.css";

// Resolvemos el token (Tauri o localStorage) antes de montar la app.
initToken().finally(() => {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
});
