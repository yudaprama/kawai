/**
 * The civitai generation panel's exact Mantine-dark palette (their
 * tailwind.config.js `dark` + `yellow` scales) — the panel is ALWAYS
 * dark, an island of the civitai look inside whatever theme kawai
 * runs. Shared by the generator page and its field components.
 */
export const C = {
  surface: "#1A1B1E", // dark-7 — panel bg
  deep: "#141517", // dark-8 — results pane bg
  input: "#25262B", // dark-6 — controls bg
  hover: "#2C2E33", // dark-5 — hover bg
  border: "#373A40", // dark-4 — borders
  text: "#C1C2C5", // dark-0 — body text
  muted: "#8c8fa3", // dark-2 — secondary text
  faint: "#5C5F66", // dark-3 — disabled text
  heading: "#f8f9fa", // gray-0 — headings
  buzz: "#FFD43B", // yellow-4 — Buzz currency color
  blue: "#4263EB", // generate button
  blueHover: "#3B5BDB",
} as const;
