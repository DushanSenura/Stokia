export interface CategoryRow { id: string; name: string; description: string | null; parent_id: string | null }

export interface VariantRow {
  id: string; product_id: string; sku: string; size_value: string | null; size_unit: string | null;
  base_inventory_unit: string; barcode: string | null; low_stock_threshold: string; is_active: boolean;
}

export interface PriceRow {
  id: string; variant_id: string; price_type: "selling" | "purchase_cost"; amount_lkr: string;
  effective_from: string; effective_to: string | null;
}

export interface ProductRow {
  id: string; name: string; product_code: string; description: string | null; image_url: string | null;
  is_active: boolean; category_id: string | null; created_at: string; updated_at: string;
}
export interface ProductListRow extends ProductRow {
  categories: { name: string } | null;
  product_variants: Pick<VariantRow, "id" | "sku" | "size_value" | "size_unit" | "is_active">[];
}
