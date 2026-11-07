import { Brand } from "@/components/shared/brand";
import { LanguageSwitcher } from "@/components/shared/language-switcher";
import { ThemeToggle } from "@/components/shared/theme-toggle";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-dvh flex-col bg-[radial-gradient(60rem_30rem_at_50%_-10%,var(--mint),transparent)]">
      <header className="flex items-center justify-between px-4 py-3 sm:px-8">
        <Brand />
        <div className="flex items-center gap-1">
          <LanguageSwitcher />
          <ThemeToggle />
        </div>
      </header>
      <main id="main" className="flex flex-1 items-center justify-center px-4 pb-16">
        <div className="glass w-full max-w-md rounded-[var(--radius-card)] p-6 shadow-soft sm:p-8">{children}</div>
      </main>
    </div>
  );
}
