"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileText } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { addDaysYmd, formatDate, todayInZone } from "@/lib/dateLocale";
import { eur } from "@/components/overview/format";

/** One rendered letter for one liable tenant, as the API returns it. */
export interface FormalNoticeLetter {
  tenantId: string;
  recipientName: string;
  language: "nl" | "fr" | "de" | "en";
  addressSource: "correspondence" | "property";
  filename: string;
  /** The PDF as base64. It never arrives as a binary stream. */
  pdfBase64: string;
  /** Null when the letter could not be written to the contract history. */
  communicationId: string | null;
}

/** What the letter claims, computed by the API and never recomputed here. */
export interface FormalNoticeTotals {
  tableSum: number;
  rentOwed: number;
  adjustment: number;
  interest: number;
  fee: number;
  totalClaimed: number;
  currency: string;
}

/** The 200 payload of POST /api/v1/payments/formal-notice. */
export interface FormalNoticeResult {
  letters: FormalNoticeLetter[];
  totals: FormalNoticeTotals;
  arrears: Array<{ month: string; dueDate: string; shortfall: number }>;
  letterDate: string;
  deadline: string;
  deadlineDays: number;
}

/** The deadline the Belgian practice starts from, and the bounds the API enforces. */
const DEFAULT_DEADLINE_DAYS = 16;
const MIN_DEADLINE_DAYS = 1;
const MAX_DEADLINE_DAYS = 90;

/**
 * Save a base64 PDF as a file. The API hands the bytes over inside JSON, so
 * there is no response to stream: the base64 is decoded here, wrapped in a
 * Blob and handed to a synthetic anchor. The object URL is always revoked, or
 * the bytes stay alive for the rest of the browser session.
 */
export function downloadPdf(filename: string, base64: string): void {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Ask for the payment deadline and an optional paragraph, generate the formal
 * notice, download one PDF per liable tenant and show what the letter claims.
 */
export function FormalNoticeDialog({
  open,
  onOpenChange,
  leaseId,
  label,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leaseId: string;
  /** Who and what, e.g. "Carnotstraat 65 b102, Jan Peeters". */
  label?: string;
  onChanged: () => void | Promise<void>;
}) {
  const t = useTranslations("formalNotice");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  const [deadlineDays, setDeadlineDays] = useState(String(DEFAULT_DEADLINE_DAYS));
  const [extraParagraph, setExtraParagraph] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [result, setResult] = useState<FormalNoticeResult | null>(null);

  // Opening the dialog starts a fresh letter. Closing it drops the PDF bytes.
  useEffect(() => {
    if (!open) {
      setResult(null);
      return;
    }
    setDeadlineDays(String(DEFAULT_DEADLINE_DAYS));
    setExtraParagraph("");
    setError(null);
    setErrorCode(null);
    setResult(null);
  }, [open]);

  const days = Number(deadlineDays);
  const daysValid =
    /^\d+$/.test(deadlineDays.trim()) &&
    Number.isInteger(days) &&
    days >= MIN_DEADLINE_DAYS &&
    days <= MAX_DEADLINE_DAYS;
  const previewDeadline = daysValid ? addDaysYmd(todayInZone(), days) : "";

  const generate = async () => {
    if (!daysValid) {
      setError(t("errors.invalid_deadline"));
      setErrorCode(null);
      return;
    }
    setBusy(true);
    setError(null);
    setErrorCode(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/payments/formal-notice`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leaseId,
          deadlineDays: days,
          extraParagraph: extraParagraph.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = typeof body.code === "string" ? body.code : null;
        setErrorCode(code);
        setError(code && t.has(`errors.${code}`) ? t(`errors.${code}`) : t("errors.failed"));
        return;
      }
      const data = ((await res.json()).data ?? null) as FormalNoticeResult | null;
      if (!data) {
        setError(t("errors.failed"));
        return;
      }
      setResult(data);
      for (const letter of data.letters) downloadPdf(letter.filename, letter.pdfBase64);
      await onChanged();
    } catch {
      setError(t("errors.failed"));
    } finally {
      setBusy(false);
    }
  };

  const amountRow = (text: string, amount: number, strong = false) => (
    <div className={`flex items-baseline justify-between gap-4 text-sm ${strong ? "font-semibold" : ""}`}>
      <span>{text}</span>
      <span>{eur(amount)}</span>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>

        {label && <p className="text-sm text-muted-foreground">{label}</p>}

        {result ? (
          <div className="space-y-4">
            <div className="space-y-1 rounded-lg bg-muted p-3">
              <p className="font-semibold">{t("resultTitle")}</p>
              {amountRow(t("rentOwed"), result.totals.rentOwed)}
              {result.totals.interest > 0 && amountRow(t("interest"), result.totals.interest)}
              {result.totals.fee > 0 && amountRow(t("fee"), result.totals.fee)}
              {amountRow(t("total"), result.totals.totalClaimed, true)}
              <div className="flex items-baseline justify-between gap-4 text-sm">
                <span>{t("deadline")}</span>
                <span>{formatDate(result.deadline)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <p className="font-semibold">{t("lettersTitle")}</p>
              <ul className="space-y-2">
                {result.letters.map((letter) => (
                  <li key={letter.tenantId} className="rounded-lg border p-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2 text-sm">
                        <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{t("letterFor", { name: letter.recipientName })}</span>
                      </span>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => downloadPdf(letter.filename, letter.pdfBase64)}
                      >
                        {t("downloadAgain")}
                      </Button>
                    </div>
                    {letter.communicationId === null && (
                      <p className="mt-1 text-xs text-amber-700">{t("notLogged")}</p>
                    )}
                  </li>
                ))}
              </ul>
            </div>

            <p className="rounded-lg bg-sky-50 p-3 text-sm text-sky-900 dark:bg-sky-900/30 dark:text-sky-100">
              {t("postHint")}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="formal-notice-days">{t("deadlineDays")}</Label>
              <Input
                id="formal-notice-days"
                type="number"
                inputMode="numeric"
                min={MIN_DEADLINE_DAYS}
                max={MAX_DEADLINE_DAYS}
                step={1}
                value={deadlineDays}
                onChange={(e) => setDeadlineDays(e.target.value)}
              />
              <p className={`text-xs ${daysValid ? "text-muted-foreground" : "text-red-700"}`}>
                {daysValid ? t("deadlineDate", { date: formatDate(previewDeadline) }) : t("errors.invalid_deadline")}
              </p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="formal-notice-extra">{t("extraParagraph")}</Label>
              <Textarea
                id="formal-notice-extra"
                value={extraParagraph}
                maxLength={2000}
                rows={4}
                onChange={(e) => setExtraParagraph(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("extraParagraphHint")}</p>
            </div>
            {error && (
              <div className="space-y-1">
                <p className="text-sm text-red-700">{error}</p>
                {errorCode === "missing_sender_address" && (
                  <Link href="/settings" className="text-sm font-medium text-navy underline">
                    {t("openSettings")}
                  </Link>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {result ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              {t("close")}
            </Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
                {t("cancel")}
              </Button>
              <Button type="button" onClick={generate} disabled={busy || !daysValid}>
                {busy ? t("generating") : t("generate")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The block on the contract page that explains the letter and opens the
 * generate dialog, next to the other reminder actions.
 */
export function FormalNoticeCard({
  leaseId,
  label,
  onChanged,
}: {
  leaseId: string;
  label?: string;
  onChanged: () => void | Promise<void>;
}) {
  const t = useTranslations("formalNotice");
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2">
          <FileText className="mt-0.5 h-5 w-5 text-muted-foreground" />
          <div>
            <p className="font-semibold">{t("cardTitle")}</p>
            <p className="text-sm text-muted-foreground">{t("cardDescription")}</p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setOpen(true)}>
          <FileText className="mr-2 h-4 w-4" />
          {t("open")}
        </Button>
      </CardContent>
      <FormalNoticeDialog
        open={open}
        onOpenChange={setOpen}
        leaseId={leaseId}
        label={label}
        onChanged={onChanged}
      />
    </Card>
  );
}
