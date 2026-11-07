/**
 * Historical price lookup. A sales estimate must use the price that was in force on the
 * SALES date, never the latest price (Test I). Periods are half-open: [from, to).
 */
export interface PricePeriod {
  price_type: "selling" | "purchase_cost";
  amount_lkr: string;
  effective_from: string; // ISO timestamp
  effective_to: string | null;
}

export function priceAt(history: PricePeriod[], type: PricePeriod["price_type"], at: Date | string): PricePeriod | null {
  const t = new Date(at).getTime();
  return (
    history.find(
      (p) =>
        p.price_type === type &&
        new Date(p.effective_from).getTime() <= t &&
        (p.effective_to === null || t < new Date(p.effective_to).getTime()),
    ) ?? null
  );
}
