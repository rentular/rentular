"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/dateLocale";

interface ConnectionStatus {
  connected: boolean;
  status: "active" | "revoked" | "error" | null;
  organisationId: string | null;
  creditorId: string | null;
  creditorName: string | null;
  environment: "sandbox" | "live" | null;
  connectedAt: string | null;
  lastError: string | null;
}

export interface GoCardlessSetupStatus {
  mode: "partner" | "instance";
  partnerConfigured: boolean;
  canConnect: boolean;
  configured: boolean;
  environment: string | null;
  connection: ConnectionStatus | null;
}

/**
 * Direct debit via GoCardless: on a hosted install each landlord connects
 * their own GoCardless account; on a self-hosted install the server's own
 * token is used and this card only reports whether it is set.
 */
export function GoCardlessConnectionCard({
  apiUrl,
  onStatus,
}: {
  apiUrl: string;
  onStatus?: (status: GoCardlessSetupStatus | null) => void;
}) {
  const t = useTranslations("settings.goCardlessConnect");
  const [status, setStatus] = useState<GoCardlessSetupStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiUrl}/api/v1/gocardless/status`, { credentials: "include" });
      const json = res.ok ? await res.json() : null;
      setStatus(json?.data ?? null);
      onStatus?.(json?.data ?? null);
    } catch {
      setStatus(null);
      onStatus?.(null);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, onStatus]);

  useEffect(() => {
    load();
  }, [load]);

  // Outcome of the connect flow, passed back by the API callback redirect.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const outcome = params.get("gocardless");
    if (!outcome) return;
    if (outcome === "connected") toast.success(t("connectedToast"));
    else if (params.get("reason") === "cancelled") toast(t("connectCancelled"));
    else toast.error(t("connectError"));
    params.delete("gocardless");
    params.delete("reason");
    const qs = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${qs ? `?${qs}` : ""}`);
  }, [t]);

  const connect = async (view: "login" | "signup") => {
    setBusy(true);
    try {
      const res = await fetch(`${apiUrl}/api/v1/gocardless/connect?view=${view}`, {
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && json?.data?.url) {
        window.location.href = json.data.url;
        return;
      }
      toast.error(res.status === 403 ? t("notLandlord") : t("connectError"));
    } catch {
      toast.error(t("connectError"));
    }
    setBusy(false);
  };

  const disconnect = async () => {
    if (!window.confirm(t("disconnectConfirm"))) return;
    setBusy(true);
    try {
      const res = await fetch(`${apiUrl}/api/v1/gocardless/disconnect`, {
        method: "POST",
        credentials: "include",
      });
      if (res.ok) toast.success(t("disconnected"));
      else toast.error(t("connectError"));
    } finally {
      setBusy(false);
      load();
    }
  };

  const connection = status?.connection ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("intro")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        ) : !status ? (
          <p className="text-sm text-muted-foreground">{t("connectError")}</p>
        ) : status.mode === "instance" ? (
          <div className="flex items-center gap-2 text-sm">
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${status.configured ? "bg-green-500" : "bg-red-500"}`}
            />
            <span>{status.configured ? t("instanceConfigured") : t("unavailable")}</span>
            {status.configured && status.environment && (
              <Badge variant="secondary">{status.environment}</Badge>
            )}
          </div>
        ) : !status.partnerConfigured ? (
          <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
        ) : connection?.connected ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
              {t("connected")}
            </div>
            {connection.creditorName && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("creditor")}</span>
                <span>{connection.creditorName}</span>
              </div>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t("organisation")}</span>
              <span className="font-mono">{connection.organisationId}</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{t("environment")}</span>
              <Badge variant="secondary">{connection.environment}</Badge>
            </div>
            {connection.connectedAt && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{t("connectedSince")}</span>
                <span>{formatDate(connection.connectedAt)}</span>
              </div>
            )}
            {connection.lastError && (
              <p className="text-sm text-destructive">
                {t("lastError")}: {connection.lastError}
              </p>
            )}
            <div className="flex justify-end">
              <Button variant="outline" onClick={disconnect} disabled={busy}>
                {t("disconnectButton")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />
              {connection?.status === "revoked" ? t("revoked") : t("notConnected")}
            </div>
            {connection?.status === "revoked" && connection.lastError ? (
              // Revoked at GoCardless (401 access_token_revoked): ask to reconnect.
              <p className="text-sm text-amber-700 dark:text-amber-400">{t("revokedAtGoCardless")}</p>
            ) : connection?.lastError ? (
              <p className="text-sm text-muted-foreground">
                {t("lastError")}: {connection.lastError}
              </p>
            ) : null}
            {status.canConnect ? (
              <>
                <p className="text-sm text-muted-foreground">{t("connectHelp")}</p>
                <div className="flex flex-wrap gap-2">
                  <Button onClick={() => connect("login")} disabled={busy}>
                    {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t("connectButton")}
                  </Button>
                  <Button variant="outline" onClick={() => connect("signup")} disabled={busy}>
                    {t("signupButton")}
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t("notLandlord")}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
