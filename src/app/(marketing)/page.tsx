import {
  AlertTriangle, ArrowRight, BarChart3, Boxes, CheckCircle2, ClipboardCheck, Languages, PackageCheck, ShieldCheck, Truck,
} from "lucide-react";
import Link from "next/link";
import { Brand } from "@/components/shared/brand";
import { LanguageSwitcher } from "@/components/shared/language-switcher";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { MorningStockCalculator } from "@/components/marketing/calculator";
import { ReportPreviewChart } from "@/components/marketing/report-preview";
import { Reveal } from "@/components/marketing/reveal";
import { ButtonLink } from "@/components/ui/button";
import { Badge } from "@/components/ui/feedback";
import { Card } from "@/components/ui/card";
import { getTranslator } from "@/i18n/server";
import type { MessageKey } from "@/i18n";

const FEATURES: { icon: typeof ClipboardCheck; k: "f1" | "f2" | "f3" | "f4" | "f5" | "f6" }[] = [
  { icon: ClipboardCheck, k: "f1" },
  { icon: BarChart3, k: "f2" },
  { icon: Boxes, k: "f3" },
  { icon: Truck, k: "f4" },
  { icon: ShieldCheck, k: "f5" },
  { icon: Languages, k: "f6" },
];

export default async function LandingPage() {
  const { t } = await getTranslator();
  const section = "mx-auto w-full max-w-6xl px-4 py-16 sm:px-6 sm:py-24";

  return (
    <div className="bg-background">
      {/* 1. Navigation */}
      <header className="glass sticky top-0 z-40 border-x-0 border-t-0">
        <div className="mx-auto flex min-h-16 max-w-6xl items-center justify-between gap-3 px-4 sm:px-6">
          <Brand />
          <nav aria-label="Main" className="hidden items-center gap-6 text-[15px] md:flex">
            {([["#features", "m.nav.features"], ["#how", "m.nav.how"], ["#try", "m.nav.calculator"], ["#faq", "m.nav.faq"]] as [string, MessageKey][]).map(([h, k]) => (
              <a key={h} href={h} className="text-muted transition-colors duration-150 hover:text-foreground">{t(k)}</a>
            ))}
          </nav>
          <div className="flex items-center gap-1">
            <LanguageSwitcher />
            <ThemeToggle />
            <ButtonLink href="/login" variant="secondary" className="hidden sm:inline-flex">{t("common.signIn")}</ButtonLink>
          </div>
        </div>
      </header>

      <main id="main">
        {/* 2-4. Hero + dashboard preview */}
        <section className="bg-[radial-gradient(70rem_32rem_at_50%_-10%,var(--mint),transparent)]">
          <div className={`${section} grid items-center gap-12 lg:grid-cols-2`}>
            <Reveal>
              <Badge tone="success" className="mb-5">{t("m.hero.badge")}</Badge>
              <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl lg:text-6xl">{t("m.hero.title")}</h1>
              <p className="mt-5 max-w-xl text-lg text-muted">{t("m.hero.body")}</p>
              <div className="mt-8 flex flex-wrap gap-3">
                <ButtonLink href="/login" size="lg">{t("common.getStarted")} <ArrowRight className="size-4" aria-hidden /></ButtonLink>
                <ButtonLink href="#features" variant="secondary" size="lg">{t("common.exploreFeatures")}</ButtonLink>
              </div>
              <p className="mt-5 max-w-xl text-sm text-muted">{t("m.hero.note")}</p>
            </Reveal>

            <Reveal delay={0.08}>
              <Card className="glass p-5 sm:p-6">
                <div className="mb-4 flex items-center justify-between gap-2">
                  <p className="font-semibold">{t("m.preview.title")}</p>
                  <Badge tone="success"><CheckCircle2 className="size-3" aria-hidden />{t("m.preview.status")}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-2xl bg-surface-soft p-4">
                    <p className="text-xs text-muted">{t("m.preview.sales")}</p>
                    <p className="num mt-1 text-2xl font-semibold">Rs. 4,200</p>
                  </div>
                  <div className="rounded-2xl bg-surface-soft p-4">
                    <p className="text-xs text-muted">{t("m.preview.units")}</p>
                    <p className="num mt-1 text-2xl font-semibold">28</p>
                  </div>
                  <div className="col-span-2 flex items-center justify-between rounded-2xl bg-warning-soft p-4 text-warning">
                    <span className="flex items-center gap-2 text-sm font-medium"><AlertTriangle className="size-4" aria-hidden />{t("m.preview.low")}</span>
                    <span className="num font-semibold">3</span>
                  </div>
                </div>
                <p className="mt-4 text-xs text-muted">{t("m.preview.label")}</p>
              </Card>
            </Reveal>
          </div>
        </section>

        {/* 5. Features */}
        <section id="features" className={section}>
          <Reveal className="mb-10 max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight">{t("m.features.title")}</h2>
            <p className="mt-2 text-lg text-muted">{t("m.features.subtitle")}</p>
          </Reveal>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, k }, i) => (
              <Reveal key={k} delay={i * 0.04}>
                <Card className="h-full transition-transform duration-150 hover:-translate-y-0.5">
                  <div className="mb-4 grid size-11 place-items-center rounded-xl bg-mint text-mint-foreground"><Icon className="size-5" aria-hidden /></div>
                  <h3 className="text-lg font-semibold">{t(`m.${k}.title` as MessageKey)}</h3>
                  <p className="mt-1.5 text-muted">{t(`m.${k}.body` as MessageKey)}</p>
                </Card>
              </Reveal>
            ))}
          </div>
        </section>

        {/* 6. How it works */}
        <section id="how" className="border-y border-border bg-surface">
          <div className={section}>
            <h2 className="mb-10 text-3xl font-semibold tracking-tight">{t("m.how.title")}</h2>
            <ol className="grid gap-6 md:grid-cols-3">
              {(["s1", "s2", "s3"] as const).map((s, i) => (
                <li key={s} className="flex gap-4">
                  <span className="num grid size-10 shrink-0 place-items-center rounded-full bg-action font-semibold text-action-foreground">{i + 1}</span>
                  <div>
                    <h3 className="font-semibold">{t(`m.how.${s}.title` as MessageKey)}</h3>
                    <p className="mt-1 text-muted">{t(`m.how.${s}.body` as MessageKey)}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 7. Calculator */}
        <section id="try" className={section}>
          <div className="mb-8 max-w-2xl">
            <h2 className="text-3xl font-semibold tracking-tight">{t("m.calc.title")}</h2>
            <p className="mt-2 text-muted">{t("m.calc.subtitle")}</p>
          </div>
          <MorningStockCalculator />
        </section>

        {/* 8. Packaging */}
        <section className="border-y border-border bg-surface">
          <div className={`${section} grid items-center gap-10 lg:grid-cols-2`}>
            <div>
              <h2 className="text-3xl font-semibold tracking-tight">{t("m.pack.title")}</h2>
              <p className="mt-3 text-lg text-muted">{t("m.pack.body")}</p>
            </div>
            <Card className="bg-surface-soft">
              <p className="mb-4 flex items-center gap-2 font-medium"><PackageCheck className="size-5 text-primary" aria-hidden />{t("m.pack.example")}</p>
              <dl className="num space-y-3">
                <div className="flex justify-between"><dt className="text-muted">{t("m.pack.row1")}</dt><dd className="font-semibold">120</dd></div>
                <div className="flex justify-between"><dt className="text-muted">{t("m.pack.row2")}</dt><dd className="font-semibold">89</dd></div>
                <div className="flex justify-between border-t border-border pt-3"><dt className="font-medium">{t("m.pack.sold")}</dt><dd className="font-semibold text-action dark:text-primary">31</dd></div>
              </dl>
            </Card>
          </div>
        </section>

        {/* 9. Reporting preview */}
        <section className={`${section} grid items-center gap-10 lg:grid-cols-2`}>
          <Card>
            <ReportPreviewChart />
            <p className="mt-2 text-xs text-muted">{t("m.rep.note")}</p>
          </Card>
          <div>
            <h2 className="text-3xl font-semibold tracking-tight">{t("m.rep.title")}</h2>
            <p className="mt-3 text-lg text-muted">{t("m.rep.body")}</p>
          </div>
        </section>

        {/* 10. FAQ (native <details>: accessible, no JS) */}
        <section id="faq" className="border-t border-border bg-surface">
          <div className={`${section} max-w-3xl`}>
            <h2 className="mb-8 text-3xl font-semibold tracking-tight">{t("m.faq.title")}</h2>
            <div className="divide-y divide-border rounded-[var(--radius-card)] border border-border">
              {([1, 2, 3, 4, 5] as const).map((n) => (
                <details key={n} className="group p-5">
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-4 font-medium">
                    {t(`m.faq.q${n}` as MessageKey)}
                    <span aria-hidden className="text-xl text-muted transition-transform duration-200 group-open:rotate-45">+</span>
                  </summary>
                  <p className="mt-2 text-muted">{t(`m.faq.a${n}` as MessageKey)}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        {/* 11. Final CTA */}
        <section className={section}>
          <div className="rounded-[2rem] bg-action px-6 py-14 text-center text-action-foreground sm:px-12">
            <h2 className="text-balance text-3xl font-semibold tracking-tight">{t("m.cta.title")}</h2>
            <p className="mx-auto mt-3 max-w-xl opacity-90">{t("m.cta.body")}</p>
            <ButtonLink href="/login" variant="secondary" size="lg" className="mt-8 border-0 !bg-[#F8FAF8] !text-[#1F2A24] hover:!bg-white">
              {t("common.getStarted")}
            </ButtonLink>
          </div>
        </section>
      </main>

      {/* 12. Footer */}
      <footer className="border-t border-border bg-surface">
        <div className="mx-auto flex max-w-6xl flex-col items-start justify-between gap-4 px-4 py-8 text-sm text-muted sm:flex-row sm:items-center sm:px-6">
          <div>
            <Brand />
            <p className="mt-2">{t("brand.tagline")}</p>
          </div>
          <div className="space-y-1 sm:text-right">
            <p>{t("m.footer.currency")}</p>
            <p>{t("m.footer.rights", { year: new Date().getFullYear() })}</p>
            <div className="flex flex-wrap gap-x-4 gap-y-1 sm:justify-end">
              <Link href="/install" className="text-action underline-offset-4 hover:underline dark:text-sage">{t("install.button")}</Link>
              <Link href="/login" className="text-action underline-offset-4 hover:underline dark:text-sage">{t("common.signIn")}</Link>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
