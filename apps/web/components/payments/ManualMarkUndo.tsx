"use client";

import { useCallback, useEffect, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Hand, Undo2 } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTime } from "@/lib/dateLocale";

/** A month marked paid by hand, as the API returns it. */
export interface ManualMarkInfo {
  id: string;
  leaseId: string;
  month: string;
  paymentId: string;
  createdRow: boolean;
  method: string | null;
  amount: number | null;
  source: "overview" | "api" | "magic_link" | "mcp" | "other";
  markedBy: string | null;
  markedByName: string | null;
  markedAt: string;
  undoable: boolean;
  blockedReason: "row_missing" | "bank_matched" | "allocated" | "changed" | "not_latest" | null;
  blockedMessage: string | null;
}

type UndoReason = NonNullable<ManualMarkInfo["blockedReason"]>;
const REASONS: UndoReason[] = ["row_missing", "bank_matched", "allocated", "changed", "not_latest"];

/** "November 2026" in the viewer's language. */
export function monthName(month: string, locale: string): string {
  const d = new Date(`${month}-01T00:00:00`);
  if (isNaN(d.getTime())) return month;
  return d.toLocaleDateString(locale, { month: "long", year: "numeric" });
}

/** "Marked paid by hand by Jasper on 14/11/2026 21:05". */
export function markedByLine(t: ReturnType<typeof useTranslations>, mark: ManualMarkInfo): string {
  const date = formatDateTime(mark.markedAt);
  return mark.markedByName ? t("markedBy", { name: mark.markedByName, date }) : t("markedOn", { date });
}

function reasonText(t: ReturnType<typeof useTranslations>, reason: string | null | undefined): string {
  return reason && (REASONS as string[]).includes(reason) ? t(`blocked.${reason}`) : t("failed");
}

/**
 * Undo a manual paid mark through the API. Shows the outcome as a toast and
 * returns true when the month is open again (or already was).
 */
export async function undoManualMark(
  t: ReturnType<typeof useTranslations>,
  input: { leaseId: string; markId?: string; month?: string },
): Promise<boolean> {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
  try {
    const res = await fetch(`${apiUrl}/api/v1/payments/unmark-month-paid`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({}));
    if (res.ok) {
      toast.success(body?.data?.already ? t("already") : t("undone"));
      return true;
    }
    if (res.status === 403) toast.error(t("forbidden"));
    else toast.error(reasonText(t, body?.code));
  } catch {
    toast.error(t("failed"));
  }
  return false;
}

/**
 * "Undo" next to a month that shows as paid because of a manual mark. Asks to
 * confirm. When the API would refuse, the button looks disabled and tapping it
 * says why.
 */
export function ManualMarkUndoButton({
  mark,
  label,
  onUndone,
}: {
  mark: ManualMarkInfo;
  /** Shown in the confirm question, e.g. the property name. */
  label?: string;
  onUndone: () => void | Promise<void>;
}) {
  const t = useTranslations("manualMark");
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const reason = mark.undoable ? null : reasonText(t, mark.blockedReason);

  const click = async () => {
    if (reason) {
      toast.info(reason, { duration: 10000 });
      return;
    }
    const question = t("confirm", { month: monthName(mark.month, locale) });
    if (!window.confirm(label ? `${label}\n\n${question}` : question)) return;
    setBusy(true);
    const ok = await undoManualMark(t, { leaseId: mark.leaseId, markId: mark.id });
    setBusy(false);
    if (ok) await onUndone();
  };

  return (
    <button
      type="button"
      onClick={click}
      disabled={busy}
      aria-disabled={!!reason}
      title={reason ?? markedByLine(t, mark)}
      className={`flex items-center gap-1 rounded-lg border border-input bg-white px-2 py-1 text-xs font-medium text-navy hover:bg-muted disabled:opacity-50 ${
        reason ? "cursor-help opacity-50" : ""
      }`}
    >
      <Undo2 className="h-3.5 w-3.5" />
      {t("undo")}
    </button>
  );
}

/** Small badge saying the month was marked paid by hand, with who and when on hover. */
export function ManualMarkBadge({ mark }: { mark: ManualMarkInfo }) {
  const t = useTranslations("manualMark");
  return (
    <span
      title={markedByLine(t, mark)}
      className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground"
    >
      <Hand className="h-3 w-3" />
      {t("badge")}
    </span>
  );
}

/**
 * Contract page: the months of this contract that were marked paid by hand
 * and are not undone yet, each with an undo button. Hidden when there are none.
 */
export function ManualMarksCard({ leaseId, onChanged }: { leaseId: string; onChanged?: () => void }) {
  const t = useTranslations("manualMark");
  const locale = useLocale();
  const [marks, setMarks] = useState<ManualMarkInfo[]>([]);
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${apiUrl}/api/v1/payments/manual-marks?leaseId=${encodeURIComponent(leaseId)}`, {
        credentials: "include",
      });
      if (!res.ok) return;
      setMarks(((await res.json()).data ?? []) as ManualMarkInfo[]);
    } catch {
      // Optional block: leave it empty.
    }
  }, [apiUrl, leaseId]);

  useEffect(() => {
    load();
  }, [load]);

  if (marks.length === 0) return null;
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2">
          <Hand className="h-4 w-4 text-navy" />
          <h2 className="font-semibold">{t("cardTitle")}</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{t("cardHint")}</p>
        <ul className="mt-3 divide-y divide-border/70">
          {marks.map((m) => (
            <li key={m.id} className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {monthName(m.month, locale)}
                  {m.amount != null && (
                    <span className="ml-2 font-normal text-muted-foreground">
                      {new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" }).format(m.amount)}
                      {m.method ? ` · ${t(`method.${m.method}`)}` : ""}
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {markedByLine(t, m)}
                  {m.source === "magic_link" || m.source === "api" || m.source === "mcp" ? ` · ${t(`source.${m.source}`)}` : ""}
                </p>
                {!m.undoable && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">{reasonText(t, m.blockedReason)}</p>
                )}
              </div>
              <ManualMarkUndoButton
                mark={m}
                onUndone={async () => {
                  await load();
                  onChanged?.();
                }}
              />
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
