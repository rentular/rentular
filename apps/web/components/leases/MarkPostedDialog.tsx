"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import LocaleDateInput from "@/components/LocaleDateInput";
import { formatDate, todayInZone } from "@/lib/dateLocale";

/**
 * Record the day a formal notice was handed in at the post office, with the
 * barcode on the receipt. That day is the legal anchor of the deadline, so it
 * is entered by hand and may be corrected afterwards.
 */
export function MarkPostedDialog({
  open,
  onOpenChange,
  communicationId,
  initialPostedOn,
  initialReference,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  communicationId: string | null;
  initialPostedOn?: string | null;
  initialReference?: string | null;
  onSaved: () => void | Promise<void>;
}) {
  const t = useTranslations("formalNotice");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  const [postedOn, setPostedOn] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPostedOn(initialPostedOn || todayInZone());
    setReference(initialReference || "");
    setError(null);
  }, [open, initialPostedOn, initialReference]);

  const save = async () => {
    if (!communicationId) return;
    if (!postedOn) {
      setError(t("posted.errors.invalid_posted_date"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiUrl}/api/v1/communications/${communicationId}/posted`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ postedOn, reference: reference.trim() || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const code = typeof body.code === "string" ? body.code : null;
        setError(code && t.has(`posted.errors.${code}`) ? t(`posted.errors.${code}`) : t("posted.errors.failed"));
        return;
      }
      toast.success(t("posted.saved", { date: formatDate(postedOn) }));
      onOpenChange(false);
      await onSaved();
    } catch {
      setError(t("posted.errors.failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("posted.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("posted.dialogDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label htmlFor="posted-on">{t("posted.postedOn")}</Label>
            <LocaleDateInput id="posted-on" value={postedOn} onChange={setPostedOn} disabled={busy} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="posted-reference">{t("posted.reference")}</Label>
            <Input
              id="posted-reference"
              value={reference}
              maxLength={64}
              onChange={(e) => setReference(e.target.value)}
              disabled={busy}
            />
          </div>
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button type="button" onClick={save} disabled={busy || !postedOn || !communicationId}>
            {t("posted.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
