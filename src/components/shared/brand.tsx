import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils/cn";

/** Logo mark + live wordmark (works in light and dark; the PNG wordmark is dark-only). */
export function Brand({ href = "/", className, showText = true }: { href?: string; className?: string; showText?: boolean }) {
  return (
    <Link href={href} className={cn("inline-flex items-center gap-2.5", className)} aria-label="Stokia">
      <Image src="/branding/stokia-mark-256.png" alt="" width={36} height={36} priority className="size-9 rounded-lg" />
      {showText && <span className="text-xl font-bold tracking-tight">Stokia</span>}
    </Link>
  );
}
