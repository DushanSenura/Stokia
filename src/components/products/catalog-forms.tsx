"use client";

import { Field, FormMessages, SubmitButton, useActionForm } from "@/components/shared/form-bits";
import { FieldError, Input, Label, Select, Textarea } from "@/components/ui/input";
import { Alert } from "@/components/ui/feedback";
import { Button, ButtonLink } from "@/components/ui/button";
import {
  createCategoryAction, createProductAction, createVariantAction, importProductsAction, renameCategoryAction,
  setPriceAction, updateProductAction, updateVariantAction, uploadProductImageAction, type ImportState,
} from "@/server/actions/catalog";
import type { FormState } from "@/server/actions/auth";
import { BASE_INVENTORY_UNITS, SIZE_UNITS } from "@/lib/formatting/units";
import { useT } from "@/providers/i18n-provider";
import type { CategoryRow, ProductRow, VariantRow } from "@/types/catalog";
import type { MessageKey } from "@/i18n";

const initial: FormState = {};

function SelectField({ name, label, state, children, ...props }: { name: string; label: MessageKey; state: FormState } & React.SelectHTMLAttributes<HTMLSelectElement>) {
  const t = useT();
  const err = state.fieldErrors?.[name];
  return (
    <div>
      <Label htmlFor={name}>{t(label)}</Label>
      <Select id={name} name={name} aria-invalid={!!err} {...props}>{children}</Select>
      <FieldError>{err && t(err)}</FieldError>
    </div>
  );
}

export function ProductForm({ product, categories }: { product?: ProductRow; categories: CategoryRow[] }) {
  const t = useT();
  const action = product ? updateProductAction.bind(null, product.id) : createProductAction;
  const { state, onSubmit, pending } = useActionForm(action, initial);
  return (
    <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2" noValidate>
      <div className="sm:col-span-2"><FormMessages state={state} /></div>
      <Field name="name" label="cat.form.name" state={state} defaultValue={product?.name} required maxLength={120} />
      <div>
        <Field name="product_code" label="cat.form.code" state={state} defaultValue={product?.product_code} required maxLength={40} autoCapitalize="characters" />
        <p className="mt-1 text-xs text-muted">{t("cat.form.codeHint")}</p>
      </div>
      <SelectField name="category_id" label="cat.form.category" state={state} defaultValue={product?.category_id ?? ""}>
        <option value="">{t("cat.form.noCategory")}</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </SelectField>
      <div className="sm:col-span-2">
        <Label htmlFor="description">{t("cat.form.description")}</Label>
        <Textarea id="description" name="description" rows={3} defaultValue={product?.description ?? ""} maxLength={1000} />
      </div>
      <div className="sm:col-span-2 sm:max-w-xs"><SubmitButton pending={pending}>{product ? t("cat.form.saveChanges") : t("cat.form.create")}</SubmitButton></div>
    </form>
  );
}

export function ImageForm({ productId }: { productId: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(uploadProductImageAction.bind(null, productId), initial, { resetOnSuccess: true });
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <FormMessages state={state} />
      <Label htmlFor="image">{t("cat.form.image")}</Label>
      <Input id="image" name="image" type="file" accept="image/jpeg,image/png,image/webp" className="py-2.5" required />
      <p className="text-xs text-muted">{t("cat.form.imageHint")}</p>
      <SubmitButton pending={pending}>{t("cat.form.upload")}</SubmitButton>
    </form>
  );
}

/** Create (no `variant`) or edit a variant. The counting unit is fixed once created. */
export function VariantForm({ productId, variant }: { productId: string; variant?: VariantRow }) {
  const t = useT();
  const action = variant ? updateVariantAction.bind(null, productId, variant.id) : createVariantAction.bind(null, productId);
  const { state, onSubmit, pending } = useActionForm(action, initial, { resetOnSuccess: !variant });
  return (
    <form onSubmit={onSubmit} className="grid grid-cols-2 gap-4 lg:grid-cols-4" noValidate>
      <div className="col-span-2 lg:col-span-4"><FormMessages state={state} /></div>
      <div className="col-span-2"><Field name="sku" label="cat.variants.sku" state={state} defaultValue={variant?.sku} required maxLength={40} /></div>
      <Field name="size_value" label="cat.variants.sizeValue" state={state} defaultValue={variant?.size_value ? String(Number(variant.size_value)) : ""} inputMode="decimal" />
      <SelectField name="size_unit" label="cat.variants.sizeUnit" state={state} defaultValue={variant?.size_unit ?? ""}>
        <option value="">—</option>
        {SIZE_UNITS.map((u) => <option key={u} value={u}>{u === "l" ? "L" : u}</option>)}
      </SelectField>
      <div>
        <SelectField name="base_inventory_unit" label="cat.variants.baseUnit" state={state} defaultValue={variant?.base_inventory_unit ?? "packet"} disabled={!!variant}>
          {BASE_INVENTORY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
        </SelectField>
        {/* disabled selects are not submitted, so send the fixed value explicitly for edits */}
        {variant && <input type="hidden" name="base_inventory_unit" value={variant.base_inventory_unit} />}
        <p className="mt-1 text-xs text-muted">{t("cat.variants.baseUnitHint")}</p>
      </div>
      <Field name="low_stock_threshold" label="cat.variants.threshold" state={state} defaultValue={variant ? String(Number(variant.low_stock_threshold)) : "0"} inputMode="decimal" />
      <div className="col-span-2"><Field name="barcode" label="cat.variants.barcode" state={state} defaultValue={variant?.barcode ?? ""} maxLength={64} /></div>
      <div className="col-span-2 lg:col-span-4 sm:max-w-xs"><SubmitButton pending={pending}>{variant ? t("cat.form.saveChanges") : t("cat.variants.add")}</SubmitButton></div>
    </form>
  );
}

export function PriceForm({ productId, variantId }: { productId: string; variantId: string }) {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm(setPriceAction.bind(null, productId), initial, { resetOnSuccess: true });
  return (
    <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end" noValidate>
      <div className="sm:col-span-3"><FormMessages state={state} /></div>
      <input type="hidden" name="variant_id" value={variantId} />
      <SelectField name="price_type" label="cat.price.type" state={state} defaultValue="selling">
        <option value="selling">{t("cat.price.selling")}</option>
        <option value="purchase_cost">{t("cat.price.cost")}</option>
      </SelectField>
      <Field name="amount" label="cat.price.amount" state={state} inputMode="decimal" placeholder="0.00" required />
      <SubmitButton pending={pending}>{t("cat.price.set")}</SubmitButton>
    </form>
  );
}

export function CategoryForm({ category }: { category?: CategoryRow }) {
  const t = useT();
  const action = category ? renameCategoryAction.bind(null, category.id) : createCategoryAction;
  const { state, onSubmit, pending } = useActionForm(action, initial, { resetOnSuccess: !category });
  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start" noValidate>
      <div className="flex-1">
        <label className="sr-only" htmlFor={`cat-${category?.id ?? "new"}`}>{t("cat.categories.name")}</label>
        <Input id={`cat-${category?.id ?? "new"}`} name="name" defaultValue={category?.name} placeholder={t("cat.categories.name")} required maxLength={60} aria-invalid={!!state.fieldErrors?.name} />
        <FieldError>{state.fieldErrors?.name && t(state.fieldErrors.name)}</FieldError>
        {state.error && <FieldError>{t(state.error)}</FieldError>}
        {state.success && <p className="mt-1.5 text-sm text-success">{t(state.success)}</p>}
      </div>
      <Button type="submit" variant={category ? "secondary" : "primary"} disabled={pending}>{category ? t("common.save") : t("cat.categories.add")}</Button>
    </form>
  );
}

export function ImportForm() {
  const t = useT();
  const { state, onSubmit, pending } = useActionForm<ImportState>(importProductsAction, {});
  const r = state.result;
  const ok = r && r.errors.filter((e) => !e.message.startsWith("Unknown column")).length === 0 && r.productCount > 0;
  return (
    <form onSubmit={onSubmit} className="space-y-5">
      {state.error && <Alert tone="danger">{t(state.error)}</Alert>}
      {state.committed && <Alert tone="success">{t("cat.import.done")}</Alert>}
      <div>
        <Label htmlFor="file">{t("cat.import.file")}</Label>
        <Input id="file" name="file" type="file" accept=".csv,text/csv" className="py-2.5" required />
      </div>
      {r && !state.committed && (ok ? (
        <Alert tone="success">{t("cat.import.ready", { products: r.productCount, variants: r.variantCount })}</Alert>
      ) : (
        <Alert tone="danger">
          <p className="mb-1 font-medium">{t("cat.import.problems")}</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {r.errors.map((e, i) => <li key={i}>{e.row ? `${t("cat.import.row", { row: e.row })}: ` : ""}{e.message}</li>)}
          </ul>
        </Alert>
      ))}
      <div className="flex flex-wrap gap-3">
        <Button type="submit" name="mode" value="preview" variant="secondary" disabled={pending}>{t("cat.import.preview")}</Button>
        {ok && !state.committed && (
          <Button type="submit" name="mode" value="commit" disabled={pending}>
            {t("cat.import.commit", { products: r!.productCount, variants: r!.variantCount })}
          </Button>
        )}
        <ButtonLink href="/api/exports/products?template=1" variant="ghost" prefetch={false}>{t("cat.import.template")}</ButtonLink>
      </div>
    </form>
  );
}
