import {
  BarChart3,
  Boxes,
  ClipboardCheck,
  FileText,
  History,
  LayoutDashboard,
  Package,
  Repeat,
  Settings,
  type LucideIcon,
} from "lucide-react";
import type { MessageKey } from "@/i18n";

export interface NavItem {
  href: string;
  label: MessageKey;
  icon: LucideIcon;
  /** Shown in the mobile bottom bar (the rest go under "More"). */
  primaryOnMobile?: boolean;
  /** Development phase in which the module becomes functional. */
  phase?: number;
}

export const NAV_ITEMS: NavItem[] = [
  { href: "/dashboard", label: "nav.dashboard", icon: LayoutDashboard, primaryOnMobile: true },
  { href: "/morning-stock", label: "nav.morningStock", icon: ClipboardCheck, primaryOnMobile: true, phase: 4 },
  { href: "/products", label: "nav.products", icon: Package, primaryOnMobile: true, phase: 2 },
  { href: "/packaging", label: "nav.packaging", icon: Boxes, phase: 3 },
  { href: "/movements", label: "nav.movements", icon: Repeat, phase: 5 },
  { href: "/stock-history", label: "nav.history", icon: History, phase: 4 },
  { href: "/analytics", label: "nav.analytics", icon: BarChart3, phase: 7 },
  { href: "/reports", label: "nav.reports", icon: FileText, primaryOnMobile: true, phase: 7 },
  { href: "/settings", label: "nav.settings", icon: Settings, phase: 8 },
];
