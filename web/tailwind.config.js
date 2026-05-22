/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: "#0a0f16",
          deep: "#070b12",
          elevated: "#12171f",
          hover: "#1a2029",
        },
        border: {
          DEFAULT: "#1f2733",
          strong: "#283848",
        },
        fg: {
          DEFAULT: "#e8eaef",
          muted: "#8b95a3",
          subtle: "#5a6170",
        },
        accent: {
          DEFAULT: "#22d3ee",
          hover: "#67e8f9",
          dim: "#0e7490",
          soft: "#0d2a30",
        },
        success: "#22c55e",
        warning: "#f59e0b",
        danger: "#ef4444",
        // Agent role colors
        agent: {
          manager: "#22d3ee",
          kol: "#fbbf24",
          seo: "#34d399",
          social: "#a78bfa",
        },
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          '"SF Pro Display"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          "system-ui",
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          '"SF Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      boxShadow: {
        "glow-accent": "0 0 12px rgba(34, 211, 238, 0.25)",
        "glow-accent-sm": "0 0 6px rgba(34, 211, 238, 0.2)",
        "glow-danger": "0 0 12px rgba(239, 68, 68, 0.3)",
        "glow-warning": "0 0 10px rgba(245, 158, 11, 0.25)",
        "glow-success": "0 0 8px rgba(34, 197, 94, 0.3)",
      },
      animation: {
        "pulse-soft": "pulse-soft 1.5s ease-in-out infinite",
        "blink-cursor": "blink-cursor 0.8s step-end infinite",
      },
      keyframes: {
        "pulse-soft": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.4" },
        },
        "blink-cursor": {
          "50%": { opacity: "0" },
        },
      },
    },
  },
  plugins: [],
};
