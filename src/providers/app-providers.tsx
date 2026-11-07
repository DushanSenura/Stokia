"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import type { Locale } from "@/i18n";
import { PwaRegistrar } from "@/components/pwa/pwa-registrar";
import { ToastProvider } from "@/components/ui/toast";
import { I18nProvider } from "./i18n-provider";
import { ThemeProvider } from "./theme-provider";

export function AppProviders({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: 1 } } }));
  return (
    <ThemeProvider>
      <I18nProvider locale={locale}>
        <QueryClientProvider client={client}>
          <ToastProvider>
            {children}
            <PwaRegistrar />
          </ToastProvider>
        </QueryClientProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
