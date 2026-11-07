"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useT } from "@/providers/i18n-provider";
import type { ProductHit } from "@/app/api/products/search/route";

/**
 * Type-ahead product filter for a plain GET form: submits the chosen product id through a hidden input named `name`,
 * so the filter lives in the URL like every other filter. `initial` is the already-selected product (from the URL).
 */
export function ProductPicker({ name, initial }: { name: string; initial: { id: string; label: string } | null }) {
  const t = useT();
  const [selected, setSelected] = useState(initial);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ProductHit[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q || selected) return;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/products/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
        if (res.ok) setHits(((await res.json()) as { hits: ProductHit[] }).hits);
      } catch { /* aborted/offline: keep the previous list */ } finally { setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [query, selected]);

  const shown = query.trim() && !selected ? hits : [];

  return (
    <div className="min-w-56">
      <Label htmlFor={`${name}-search`}>{t("an.product")}</Label>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      {selected ? (
        <div className="flex min-h-11 items-center justify-between gap-2 rounded-xl border border-primary/50 bg-mint px-3.5 text-mint-foreground">
          <span className="min-w-0 truncate font-medium">{selected.label}</span>
          <Button variant="ghost" className="min-h-9 px-2" onClick={() => { setSelected(null); setQuery(""); setHits([]); }}>{t("an.clearProduct")}</Button>
        </div>
      ) : (
        <div className="relative">
          <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
          <Input id={`${name}-search`} type="search" autoComplete="off" className="pl-10" placeholder={t("an.pickProduct")} value={query} onChange={(e) => setQuery(e.target.value)} aria-controls={query.trim() ? `${name}-list` : undefined} />
          {query.trim() && (
            <ul id={`${name}-list`} role="listbox" className="absolute z-20 mt-1 max-h-60 w-full overflow-y-auto rounded-xl border border-border bg-surface shadow-soft">
              {shown.map((h) => (
                <li key={h.id} role="option" aria-selected={false}>
                  <button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 px-3.5 text-left transition-colors duration-150 hover:bg-surface-soft" onClick={() => setSelected({ id: h.id, label: h.name })}>
                    <span className="truncate">{h.name}</span><span className="num shrink-0 text-sm text-muted">{h.code}</span>
                  </button>
                </li>
              ))}
              {!loading && shown.length === 0 && <li className="px-3.5 py-3 text-sm text-muted">{t("mv.form.noResults")}</li>}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
