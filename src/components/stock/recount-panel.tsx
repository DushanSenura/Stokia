"use client";

import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, Badge } from "@/components/ui/feedback";
import { Input, Label } from "@/components/ui/input";
import type { RecountRequestView, RecountState } from "@/features/inventory/recount-types";
import { formatShopDateTime } from "@/lib/dates/format";
import { useI18n } from "@/providers/i18n-provider";
import { cancelRecountAction, decideRecountAction, requestRecountAction } from "@/server/actions/recount";
import type { MessageKey } from "@/i18n";

const tone = { pending: "warning", approved: "success", rejected: "danger", used: "info", cancelled: "neutral" } as const;

/**
 * Another stock sheet on the same day, as the person sees it on the confirmed stock sheet page:
 *  - a stock manager (or the owner) asks, with a reason;
 *  - the owner approves or rejects the requests waiting for them;
 *  - once approved, the person who asked can start the extra stock sheet (nobody else can).
 */
export function RecountPanel({ state, isOwner, timezone, sheetHref }: { state: RecountState; isOwner: boolean; timezone: string; sheetHref: (id: string) => string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "success" | "danger"; text: string } | null>(null);
  const [noteFor, setNoteFor] = useState<string | null>(null);
  const [note, setNote] = useState("");

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: MessageKey }>, done: MessageKey) => {
    setBusy(key); setMessage(null);
    const r = await fn();
    setBusy(null);
    if (r.ok) { setMessage({ tone: "success", text: t(done) }); setReason(""); setNote(""); setNoteFor(null); router.refresh(); return; }
    setMessage({ tone: "danger", text: t((r.error ?? "auth.error.generic") as MessageKey) });
  };

  const mine = state.mine;
  return (
    <section aria-labelledby="rc-h" className="mx-auto max-w-xl space-y-4 text-left">
      {message && <Alert tone={message.tone}>{message.text}</Alert>}

      {isOwner && state.waiting.length > 0 && (
        <Card className="space-y-3">
          <h2 className="text-lg font-semibold">{t("rc.waiting.title")}</h2>
          <ul className="space-y-3">
            {state.waiting.map((r: RecountRequestView) => (
              <li key={r.id} className="space-y-2 rounded-xl border border-border p-3">
                <p className="text-sm">{t("rc.waiting.item", { name: r.requestedByName ?? "?", reason: r.reason })}</p>
                <p className="num text-xs text-muted">{formatShopDateTime(r.createdAt, timezone)}</p>
                {noteFor === r.id ? (
                  <div className="space-y-2">
                    <Label htmlFor={`rc-note-${r.id}`}>{t("rc.rejectNote")}</Label>
                    <Input id={`rc-note-${r.id}`} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
                    <div className="flex flex-wrap gap-2">
                      <Button variant="danger" disabled={!!busy} onClick={() => void run(`rej-${r.id}`, () => decideRecountAction(r.id, false, note), "rc.rejectedDone")}>{t("rc.reject")}</Button>
                      <Button variant="ghost" disabled={!!busy} onClick={() => { setNoteFor(null); setNote(""); }}>{t("common.cancel")}</Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={!!busy} onClick={() => void run(`ok-${r.id}`, () => decideRecountAction(r.id, true, ""), "rc.approvedDone")}>
                      {busy === `ok-${r.id}` && <Loader2 className="size-4 animate-spin" aria-hidden />}{t("rc.approve")}
                    </Button>
                    <Button variant="secondary" disabled={!!busy} onClick={() => setNoteFor(r.id)}>{t("rc.reject")}</Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="space-y-3">
        <h2 id="rc-h" className="text-lg font-semibold">{t("rc.title")}</h2>

        {mine && (
          <div className="space-y-2">
            <Badge tone={tone[mine.status]}>{t(`rc.status.${mine.status}` as MessageKey)}</Badge>
            <p className="text-sm text-muted">{mine.reason}</p>
            {mine.decidedByName && mine.status !== "pending" && <p className="text-xs text-muted">{t("rc.decidedBy", { name: mine.decidedByName })}</p>}
            {mine.decisionNote && <p className="text-xs text-muted">{t("rc.note", { note: mine.decisionNote })}</p>}
            {mine.status === "approved" && (
              <div className="flex flex-wrap gap-2">
                <ButtonLink href={sheetHref(mine.id)} size="lg">{t("rc.start")}</ButtonLink>
                <Button variant="ghost" disabled={!!busy} onClick={() => void run("cancel", () => cancelRecountAction(mine.id), "rc.status.cancelled")}>{t("rc.cancel")}</Button>
              </div>
            )}
            {mine.status === "pending" && (
              <Button variant="ghost" disabled={!!busy} onClick={() => void run("cancel", () => cancelRecountAction(mine.id), "rc.status.cancelled")}>{t("rc.cancel")}</Button>
            )}
          </div>
        )}

        {state.canRequest ? (
          <div className="space-y-3">
            <p className="text-sm text-muted">{isOwner ? t("rc.ownerHelp") : t("rc.help")}</p>
            <div>
              <Label htmlFor="rc-reason">{t("rc.reason")}</Label>
              <Input id="rc-reason" value={reason} maxLength={300} onChange={(e) => { setReason(e.target.value); setMessage(null); }} />
            </div>
            <Button disabled={!!busy || !reason.trim()} onClick={() => void run("request", () => requestRecountAction(state.sessionId, reason), isOwner ? "rc.status.approved" : "rc.asked")}>
              {busy === "request" && <Loader2 className="size-4 animate-spin" aria-hidden />}{busy === "request" ? t("rc.requesting") : t("rc.request")}
            </Button>
          </div>
        ) : !state.isToday ? (
          <p className="text-sm text-muted">{t("rc.notToday")}</p>
        ) : null}
      </Card>
      <p className="text-center text-sm"><Link href="/dashboard" className="text-action underline-offset-4 hover:underline dark:text-sage">{t("nav.dashboard")}</Link></p>
    </section>
  );
}
