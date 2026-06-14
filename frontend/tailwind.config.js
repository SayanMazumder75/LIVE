/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  // Class-based dark mode so the in-app theme toggle controls it
  // (instead of following the OS preference).
  darkMode: "class",
  theme: {
    extend: {
      // The "professional" palette — slate neutrals + indigo accent.
      // Centralised so component code can reach for these via
      // arbitrary-value classes (e.g. `bg-[var(--surface)]`) when a
      // single utility doesn't fit the design.
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica Neue",
          "Arial",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
