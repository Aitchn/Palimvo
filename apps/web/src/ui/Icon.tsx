import type { CSSProperties } from "react";

const paths = {
  files: "M4 5h6l2 2h8v13H4V5Z",
  note: "M5 3h9l5 5v13H5V3Zm9 0v5h5M8 12h8M8 16h6",
  canvas: "M3 4h7v6H3V4Zm11 10h7v6h-7v-6ZM7 10v7h7",
  base: "M3 5h18v14H3V5Zm0 5h18M9 5v14",
  search: "M16 16l5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
  settings: "M9 3h6l1 4 4 2v6l-4 2-1 4H9l-1-4-4-2V9l4-2 1-4Zm6 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  add: "M12 4v16M4 12h16",
  close: "M6 6l12 12M18 6 6 18",
  check: "m5 12 5 5 9-10",
  chevron: "m9 5 7 7-7 7",
  caret: "m7 10 5 5 5-5",
  menu: "M4 6h16M4 12h16M4 18h16",
  globe: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
  sun: "M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z",
  monitor: "M3 4h18v12H3V4Zm6 16h6M12 16v4",
  sidebar: "M3 4h18v16H3V4Zm6 0v16",
  inspector: "M3 4h18v16H3V4Zm12 0v16M17.5 8h1.5M17.5 11h1.5M17.5 14h1.5",
  info: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 11v5M12 8h.01",
  warning: "M12 3 2 20h20L12 3Zm0 6v5M12 17h.01",
  offline:
    "M3 3l18 18M8.5 8.8A9 9 0 0 0 3 12M21 12a9 9 0 0 0-4.6-3.6M12 18h.01M8 15a5 5 0 0 1 3-1.5",
} as const;

export type IconName = keyof typeof paths;

/** Small native SVG family: stroked outlines in `currentColor`, decorative unless the button around them is labelled. */
export function Icon({ name, style }: { name: IconName; style?: CSSProperties }) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      <path d={paths[name]} />
    </svg>
  );
}
