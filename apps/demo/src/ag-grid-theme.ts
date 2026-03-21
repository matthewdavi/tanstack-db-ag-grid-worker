import { colorSchemeDark, themeBalham } from "ag-grid-community";

/**
 * Zinc / indigo palette aligned with the demo shell (shadcn-style dark).
 * Balham base + dark scheme, then tuned text and surfaces.
 */
const shadcnZincGridParams = {
  accentColor: "#6366f1",
  backgroundColor: "#09090b",
  foregroundColor: "#fafafa",
  borderColor: "rgb(39 39 42)",
  borderWidth: 1,
  borderRadius: 6,
  wrapperBorderRadius: 8,
  chromeBackgroundColor: "#18181b",
  headerBackgroundColor: "#18181b",
  headerTextColor: "#a1a1aa",
  textColor: "#e4e4e7",
  cellTextColor: "#e4e4e7",
  subtleTextColor: "#71717a",
  iconColor: "#a1a1aa",
  dataFontSize: 13,
  fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
  rowHoverColor: "rgb(39 39 42 / 0.65)",
  selectedRowBackgroundColor: "rgb(99 102 241 / 0.14)",
  oddRowBackgroundColor: "rgb(24 24 27 / 0.45)",
  rangeSelectionBackgroundColor: "rgb(99 102 241 / 0.18)",
  rangeSelectionBorderColor: "#6366f1",
  columnHoverColor: "rgb(39 39 42 / 0.35)",
  menuBackgroundColor: "#18181b",
  menuTextColor: "#e4e4e7",
  menuSeparatorColor: "rgb(39 39 42)",
  panelBackgroundColor: "#18181b",
  panelTitleBarBackgroundColor: "#09090b",
  panelTitleBarTextColor: "#fafafa",
  tooltipBackgroundColor: "#27272a",
  browserColorScheme: "dark" as const,
  focusShadow: {
    radius: 3,
    spread: 0,
    color: "rgb(99 102 241 / 0.35)",
  },
  statusBarLabelColor: "#71717a",
  headerFontWeight: "600",
} as const;

export const demoGridTheme = themeBalham
  .withPart(colorSchemeDark)
  .withParams(shadcnZincGridParams);
