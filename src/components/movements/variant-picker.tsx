"use client";

import { Search } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldError, Input, Label } from "@/components/ui/input";
import { useT } from "@/providers/i18n-provider";
import type { VariantHit } from "@/app/api/variants/search/route";
import type { MessageKey } from "@/i18n";

/**
 * Type-ahead product picker (works for catalogs of thousands: the server returns at most 15 matches).
 * Submits the chosen variant id through a hidden input named `name`.
 */
export function VariantPicker({ name, label, error, selected, onPick }: {
  name: string;
  label: MessageKey;
  error?: MessageKey;
  selected: VariantHit | null;
  onPick: (hit: VariantHit | null) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<VariantHit[]>([]);
  const [loading, setLoading] = useState(false);
  const inputId = `${name}-search`;

  useEffect(() => {
    const q = query.trim();
    if (!q || selected) return;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(`/api/variants/search?q=${encodeURIComponent(q)}`, { signal: ctl.signal });
        if (res.ok) setHits(((await res.json()) as { hits: VariantHit[] }).hits);
      } catch { /* aborted or offline: keep the previous list */ } finally { setLoading(false); }
    }, 250);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [query, selected]);

  const shown = query.trim() && !selected ? hits : [];

  return (
    <div>
      <Label htmlFor={inputId}>{t(label)}</Label>
      <input type="hidden" name={name} value={selected?.id ?? ""} />
      {selected ? (
        <div className="flex min-h-11 items-center justify-between gap-3 rounded-xl border border-primary/50 bg-mint px-3.5 text-mint-foreground">
          <span className="min-w-0 truncate font-medium">{selected.label} <span className="num font-normal opacity-80">· {selected.sku}</span></span>
          <Button variant="ghost" className="min-h-9 px-2" onClick={() => { onPick(null); setQuery(""); setHits([]); }}>{t("common.edit")}</Button>
        </div>
      ) : (
        <>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input id={inputId} type="search" autoComplete="off" className="pl-10" placeholder={t("mv.form.search")} value={query}
              onChange={(e) => setQuery(e.target.value)} aria-invalid={!!error} aria-controls={query.trim() ? `${name}-list` : undefined} />
          </div>
          {query.trim() && (
            <ul id={`${name}-list`} role="listbox" aria-label={t(label)} className="mt-1 max-h-64 overflow-y-auto rounded-xl border border-border bg-surface shadow-soft">
              {shown.map((h) => (
                <li key={h.id} role="option" aria-selected={false}>
                  <button type="button" className="flex min-h-11 w-full items-center justify-between gap-3 px-3.5 text-left transition-colors duration-150 hover:bg-surface-soft"
                    onClick={() => onPick(h)}>
                    <span className="truncate">{h.label}</span><span className="num shrink-0 text-sm text-muted">{h.sku}</span>
                  </button>
                </li>
              ))}
              {!loading && shown.length === 0 && <li className="px-3.5 py-3 text-sm text-muted">{t("mv.form.noResults")}</li>}
            </ul>
          )}
        </>
      )}
      <FieldError>{error && t(error)}</FieldError>
    </div>
  );
}
