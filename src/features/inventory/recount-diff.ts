import Decimal from "decimal.js";
import { entriesFor, type EntryItem, type FieldValues } from "@/features/inventory/count-entry";
import { normalizePackagingQuantity } from "@/lib/calculations/packaging";

/**
 * What an extra stock sheet would change, worked out with the same packaging engine the count uses. Pure: the web form and the phone
 * screen both call it, so what the person reviews is the same on both. The server works the figures out again from the stored packaging.
 */
export interface RecountChange {
  variantId: string;
  name: string;
  size: string;
  unit: string;
  /** The quantity (base unit) on today's sheet now, or null if the product was not counted. */
  was: string | null;
  /** The new quantity (base unit). */
  now: string;
}

export interface RecountReview {
  changes: RecountChange[];
  /** Products whose entry cannot be turned into a quantity (a half bundle, a wrong unit): they must be fixed first. */
  errors: string[];
}

export function reviewRecount(items: EntryItem[], values: Record<string, FieldValues>, currentBase: Record<string, string>): RecountReview {
  const changes: RecountChange[] = [];
  const errors: string[] = [];
  for (const item of items) {
    const v = values[item.variantId];
    if (!v) continue;
    const n = normalizePackagingQuantity(entriesFor(item, v), item.units, item.baseUnit);
    if (!n.ok) { errors.push(item.variantId); continue; }
    if (!n.counted) continue; // blank = not recounted: it keeps today's figure (and is never treated as zero)
    const was = currentBase[item.variantId] ?? null;
    if (was !== null && new Decimal(was).equals(n.baseQuantity)) continue;
    changes.push({ variantId: item.variantId, name: item.productName, size: item.sizeLabel, unit: item.baseUnit, was, now: new Decimal(n.baseQuantity).toString() });
  }
  return { changes, errors };
}
