"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle, Loader2, AlertCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import Link from "next/link";

interface MandateSetupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tenantId?: string;
  leaseId?: string;
  tenantName?: string;
  tenantEmail?: string;
  onSuccess?: () => void;
}

interface TenantOption {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  gocardlessCustomerId?: string;
}

export function MandateSetupModal({
  open,
  onOpenChange,
  tenantId,
  leaseId,
  tenantName,
  tenantEmail,
  onSuccess,
}: MandateSetupModalProps) {
  const t = useTranslations("mandates");
  const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  const [step, setStep] = useState<"select" | "confirm" | "success" | "error">(
    tenantId ? "confirm" : "select"
  );
  const [tenants, setTenants] = useState<TenantOption[]>([]);
  const [selectedTenantId, setSelectedTenantId] = useState(tenantId || "");
  const [selectedTenant, setSelectedTenant] = useState<TenantOption | null>(
    null
  );
  const [sending, setSending] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [sentEmail, setSentEmail] = useState("");
  // Can the landlord of this lease collect by direct debit? null while unknown.
  const [gcBlock, setGcBlock] = useState<
    | null
    | { code: string; isOwnAccount: boolean; mode: "partner" | "instance" }
  >(null);

  // The landlord must have GoCardless ready (their own account when hosted).
  useEffect(() => {
    if (!open || !leaseId) {
      setGcBlock(null);
      return;
    }
    let cancelled = false;
    fetch(`${apiUrl}/api/v1/gocardless/status?leaseId=${encodeURIComponent(leaseId)}`, {
      credentials: "include",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled || !json?.data) return;
        const d = json.data;
        setGcBlock(
          d.available ? null : { code: d.code || "", isOwnAccount: !!d.isOwnAccount, mode: d.mode }
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [open, leaseId, apiUrl]);

  const blockMessage = (block: { code: string; isOwnAccount: boolean; mode: string }) =>
    block.mode === "instance"
      ? t("notConfiguredSelf")
      : block.code === "GOCARDLESS_PARTNER_NOT_CONFIGURED"
        ? t("notAvailable")
        : block.isOwnAccount
          ? t("notConnectedOwn")
          : t("notConnectedOther");

  // Reset state when modal opens/closes
  useEffect(() => {
    if (open) {
      setStep(tenantId ? "confirm" : "select");
      setSelectedTenantId(tenantId || "");
      setSending(false);
      setErrorMessage("");
      setSentEmail("");
      if (tenantId && tenantName && tenantEmail) {
        setSelectedTenant({
          id: tenantId,
          firstName: tenantName.split(" ")[0] || "",
          lastName: tenantName.split(" ").slice(1).join(" ") || "",
          email: tenantEmail,
        });
      }
    }
  }, [open, tenantId, tenantName, tenantEmail]);

  // Fetch tenants if no tenantId provided
  useEffect(() => {
    if (open && !tenantId) {
      fetch(`${apiUrl}/api/v1/tenants`, { credentials: "include" })
        .then((res) => res.json())
        .then((data) => setTenants(data.data || []))
        .catch(() => setTenants([]));
    }
  }, [open, tenantId, apiUrl]);

  const handleSelectTenant = (id: string) => {
    setSelectedTenantId(id);
    const tenant = tenants.find((t) => t.id === id);
    if (tenant) {
      setSelectedTenant(tenant);
      setStep("confirm");
    }
  };

  const handleSendAuthorization = async () => {
    if (!selectedTenant) return;
    setSending(true);
    setErrorMessage("");

    try {
      const res = await fetch(`${apiUrl}/api/v1/gocardless/mandates/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          tenantId: selectedTenant.id,
          leaseId: leaseId || selectedTenant.id, // fallback
          tenantEmail: selectedTenant.email,
          tenantFirstName: selectedTenant.firstName,
          tenantLastName: selectedTenant.lastName,
          gocardlessCustomerId:
            selectedTenant.gocardlessCustomerId || undefined,
          redirectUrl: `${window.location.origin}/dashboard/leases`,
        }),
      });

      if (res.ok) {
        setSentEmail(selectedTenant.email);
        setStep("success");
        onSuccess?.();
      } else {
        const data = await res.json().catch(() => ({}));
        if (typeof data.code === "string" && data.code.startsWith("GOCARDLESS_")) {
          // Not connected (or not available): explain instead of a raw error.
          setGcBlock({
            code: data.code,
            isOwnAccount: true,
            mode: data.code === "GOCARDLESS_NOT_CONFIGURED" ? "instance" : "partner",
          });
          setStep("confirm");
          return;
        }
        setErrorMessage(data.error || t("setupFailed"));
        setStep("error");
      }
    } catch {
      setErrorMessage(t("setupFailed"));
      setStep("error");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("setupTitle")}</DialogTitle>
          <DialogDescription>
            {step === "select" && t("selectTenant")}
            {step === "confirm" && t("confirmAndSend")}
            {step === "success" && t("done")}
            {step === "error" && t("setupFailed")}
          </DialogDescription>
        </DialogHeader>

        {/* GoCardless not ready for this landlord: explain how to fix it */}
        {gcBlock && step !== "success" && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/50 bg-amber-50 p-3 dark:bg-amber-950/30">
              <AlertCircle className="h-5 w-5 text-amber-600 mt-0.5 shrink-0" />
              <div className="space-y-1 text-sm">
                <p className="font-medium">{t("notConnectedTitle")}</p>
                <p className="text-muted-foreground">{blockMessage(gcBlock)}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                {t("cancel")}
              </Button>
              {gcBlock.mode === "partner" &&
                gcBlock.code === "GOCARDLESS_NOT_CONNECTED" &&
                gcBlock.isOwnAccount && (
                  <Button asChild>
                    <Link href="/settings?tab=gocardless">{t("goToSettings")}</Link>
                  </Button>
                )}
            </div>
          </div>
        )}

        {/* Step 1: Select tenant */}
        {!gcBlock && step === "select" && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("selectTenant")}</Label>
              <Select
                value={selectedTenantId}
                onValueChange={handleSelectTenant}
              >
                <SelectTrigger>
                  <SelectValue placeholder={t("selectTenant")} />
                </SelectTrigger>
                <SelectContent>
                  {tenants.map((tenant) => (
                    <SelectItem key={tenant.id} value={tenant.id}>
                      {tenant.firstName} {tenant.lastName} ({tenant.email})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {/* Step 2: Confirm and send */}
        {!gcBlock && step === "confirm" && selectedTenant && (
          <div className="space-y-4">
            <div className="rounded-lg border p-4 space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t("tenant")}</span>
                <span className="font-medium">
                  {selectedTenant.firstName} {selectedTenant.lastName}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {t("tenantEmail")}
                </span>
                <span className="font-medium">{selectedTenant.email}</span>
              </div>
            </div>

            <div className="border-l-4 border-primary bg-primary/5 p-3 text-sm text-muted-foreground">
              {t("authorizationInfo", { email: selectedTenant.email })}
            </div>

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t("cancel")}
              </Button>
              <Button onClick={handleSendAuthorization} disabled={sending}>
                {sending ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    {t("sending")}
                  </>
                ) : (
                  t("sendAuthorizationEmail")
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Success state */}
        {step === "success" && (
          <div className="flex flex-col items-center py-6 space-y-4">
            <CheckCircle className="h-12 w-12 text-green-500" />
            <p className="text-sm text-center text-muted-foreground">
              {t("authorizationSuccess", { email: sentEmail })}
            </p>
            <Button onClick={() => onOpenChange(false)}>{t("done")}</Button>
          </div>
        )}

        {/* Error state */}
        {step === "error" && (
          <div className="space-y-4">
            <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 p-3">
              <AlertCircle className="h-5 w-5 text-destructive mt-0.5" />
              <p className="text-sm text-destructive">{errorMessage}</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                {t("cancel")}
              </Button>
              <Button
                onClick={() => {
                  setStep("confirm");
                  setErrorMessage("");
                }}
              >
                {t("sendAuthorizationEmail")}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
