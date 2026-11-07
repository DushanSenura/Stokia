export const SIZE_UNITS = ["g", "kg", "ml", "l", "pcs"] as const;
export type SizeUnit = (typeof SIZE_UNITS)[number];

/** Measurement dimension — quantities of different dimensions must never be added together. */
export const UNIT_DIMENSION: Record<SizeUnit, "mass" | "volume" | "count"> = {
  g: "mass", kg: "mass", ml: "volume", l: "volume", pcs: "count",
};

export const BASE_INVENTORY_UNITS = ["packet", "bottle", "box", "item", "bundle", "carton"] as const;

export function sizeLabel(value: string | number | null, unit: string | null): string {
  if (value === null || value === undefined || !unit) return "";
  const n = Number(value);
  return `${Number.isInteger(n) ? n : n.toString()} ${unit === "l" ? "L" : unit}`;
}
