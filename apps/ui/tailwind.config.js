/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Neutros calidos (tint hacia el azul-frio del acento clinico)
        bg: "#f7f6f3",
        surface: "#fefdfb",
        border: "#e6e3dd",
        "text-strong": "#141414",
        "text": "#3a3a38",
        "text-muted": "#6b6a66",
        // Acento: azul clinico
        accent: "#2563a8",
        "accent-hover": "#1e4f89",
        "accent-soft": "#eaf1f9",
        // Semanticos (pastel bg + saturated text)
        "high-bg": "#fbeae7",
        "high-text": "#b5453a",
        "low-bg": "#e9f2fb",
        "low-text": "#2f6bb0",
        "normal-bg": "#e7f4ec",
        "normal-text": "#2e7d54",
        "warn-bg": "#fbf3e2",
        "warn-text": "#a8791f",
      },
      fontFamily: {
        sans: ["Geist", "system-ui", "sans-serif"],
        mono: ["'Geist Mono'", "ui-monospace", "monospace"],
      },
      borderRadius: {
        sm: "8px",
        DEFAULT: "12px",
        lg: "16px",
        xl: "24px",
      },
    },
  },
  plugins: [],
};
