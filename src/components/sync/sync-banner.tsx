"use client";

import { Loader2, WifiOff } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Alert } from "@/components/ui/feedback";
import { formatBusinessDate } from "@/lib/dates/business";
import { isBlocked, type QueuedCount } from "@/lib/offline/sync-queue";
import { useI18n } from "@/providers/i18n-provider";
import { useSync } from "@/providers/sync-provider";
import { ConflictResolver } from "./conflict-resolver";

/**
 * Everything the person needs to know about counts that have not reached the server yet, on every page:
 * "offline", "waiting to send", "conflict: please decide", "could not be sent". Nothing here ever says "confirmed":
 * only the server's answer does that (and then the entry disappears and a notice says so).
 */
export function SyncBanner() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { entries, online, syncing, syncNow, retry, discard, editAgain } = useSync();
  const [reviewing, setReviewing] = useState<string | null>(null);
  const reviewEntry = entries.find((e) => e.id === reviewing && e.state === "conflict") ?? null;

  if (online && entries.length === 0) return null;
  const when = (e: QueuedCount) => formatBusinessDate(e.businessDate, locale);

  const edit = async (e: QueuedCount) => {
    const date = await editAgain(e.id);
    if (date) router.push(`/morning-stock?date=${date}`);
  };
  const drop = async (e: QueuedCount) => {
    if (window.confirm(t("sync.discardConfirm", { date: when(e) }))) await discard(e.id);
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-2 px-4 pt-4 sm:px-6 print:hidden" data-testid="sync-banner">
      {!online && (
        <Alert tone="info">
          <span className="flex items-center gap-2"><WifiOff className="size-4 shrink-0" aria-hidden />{t("sync.offline")}</span>
        </Alert>
      )}

      {entries.map((e) => {
        if (e.state === "conflict") {
          return (
            <Alert key={e.id} tone="warning">
              <p className="font-medium">{t("sync.conflict.item", { date: when(e) })}</p>
              <Button className="mt-2 whitespace-normal" variant="secondary" onClick={() => setReviewing(e.id)}>{t("sync.review")}</Button>
            </Alert>
          );
        }
        if (e.state === "failed") {
          return (
            <Alert key={e.id} tone="danger">
              <p className="font-medium">{t("sync.failed.item", { date: when(e) })}</p>
              {e.error && <p className="mt-1">{t(e.error)}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void retry(e.id)} disabled={!online || syncing}>{t("sync.retry")}</Button>
                <Button variant="secondary" onClick={() => void edit(e)}>{t("sync.editAgain")}</Button>
                <Button variant="ghost" onClick={() => void drop(e)}>{t("sync.discard")}</Button>
              </div>
            </Alert>
          );
        }
        const blocked = isBlocked(entries, e);
        return (
          <Alert key={e.id} tone="info">
            <p className="font-medium">{t("sync.pending.item", { date: when(e) })}</p>
            <p className="mt-1">{blocked ? t("sync.blocked") : t("sync.pending.hint")}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => void syncNow()} disabled={!online || syncing || blocked}>
                {syncing && !blocked ? <><Loader2 className="size-4 animate-spin" aria-hidden />{t("sync.sending")}</> : t("sync.sendNow")}
              </Button>
              {e.attempts > 0 && <span className="num text-xs text-muted">{t("sync.attempts", { count: e.attempts })}</span>}
            </div>
          </Alert>
        );
      })}

      {reviewEntry && <ConflictResolver entry={reviewEntry} onClose={() => setReviewing(null)} />}
    </div>
  );
}
