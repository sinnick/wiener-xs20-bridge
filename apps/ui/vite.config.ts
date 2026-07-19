import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// El servicio corre en http://127.0.0.1:7700. En dev, proxeamos /api hacia el
// para evitar CORS. En produccion (Tauri), la UI apunta directo al servicio.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 1420,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:7700",
        changeOrigin: true,
      },
    },
  },
  // Tauri espera los assets con base relativa.
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
