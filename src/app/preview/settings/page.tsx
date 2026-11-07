import { notFound } from "next/navigation";
import { DataHealth } from "@/components/settings/data-health";
import { CorrectionForm, DecisionButtons } from "@/components/settings/correction-controls";
import { PasswordForm, ProfileForm, ShopSettingsForm } from "@/components/settings/account-forms";
import { Brand } from "@/components/shared/brand";
import { Card } from "@/components/ui/card";

/** Static preview of the settings forms (404 unless STOKIA_PREVIEW=1), used for accessibility checks. */
export default function SettingsPreview() {
  if (process.env.STOKIA_PREVIEW !== "1") notFound();
  const units = [{ id: "00000000-0000-4000-8000-0000000000a1", name: "Box", parentId: null, factor: 12 }];
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 sm:px-6">
      <Brand href="/preview/dashboard" />
      <h1 className="text-2xl font-semibold">Settings</h1>
      <Card className="space-y-4 p-5"><ProfileForm displayName="Nimal" language="en" /></Card>
      <Card className="space-y-4 p-5"><PasswordForm /></Card>
      <Card className="space-y-4 p-5">
        <ShopSettingsForm name="Perera Stores" timezone="Asia/Colombo" timezones={["Asia/Colombo", "Asia/Kolkata"]} timezoneLocked={false} policy="cost_at_count" />
      </Card>
      <Card className="space-y-4 p-5">
        <CorrectionForm sessionId="s" variantId="v" units={units} baseUnit="pcs" isOwner={false} idPrefix="pv" />
      </Card>
      <Card className="space-y-4 p-5"><DecisionButtons correctionId="c" /></Card>
      <DataHealth initialReport={{
        checked_at: "2026-11-06T04:00:00Z", from: "2026-08-08", days: 90, errors: 1, warnings: 1,
        checks: [
          { key: "stored_sales_differ_from_recalculation", severity: "error", count: 3, sample: [] },
          { key: "active_products_without_selling_price", severity: "warning", count: 2, sample: ["00000000-0000-4000-8000-000000000001"] },
        ],
      }} />
    </main>
  );
}
