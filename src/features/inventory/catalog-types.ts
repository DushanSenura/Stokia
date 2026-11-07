/** What the phone's Products tab receives. Pure types (no server imports), shared by the API and the apps. */
export interface CatalogItem {
  variantId: string;
  productName: string;
  productCode: string;
  category: string | null;
  size: string;
  sku: string;
  baseUnit: string;
  /** The selling price in force today (decimal string), or null if none is set. */
  sellingPrice: string | null;
  /** Quantity at the latest CONFIRMED count, in the base unit; null if this product was never counted. */
  lastCounted: string | null;
  lowStockLevel: string;
  /** Counted quantity is at or below a low-stock level that has been set (> 0). Never guessed for uncounted products. */
  low: boolean;
  /** How the packaging nests, e.g. "1 Carton = 4 Bundle = 48 packet". */
  packaging: string[];
  /** The active packaging units (what the phone needs to enter a quantity in bundles, cartons...). `factor` = how many of the parent (or base) unit one contains. */
  units: { id: string; name: string; parentId: string | null; factor: string }[];
}

export interface ProductCatalog {
  /** Date of the latest confirmed count that "lastCounted" refers to. */
  asOf: string | null;
  items: CatalogItem[];
  truncated: boolean;
}
