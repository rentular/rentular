"use client";

import { useLocale, useTranslations } from "next-intl";

export interface WalloniaPebInfo {
  label: string;
  labelSource: "lease" | "property";
  share: number;
  windowAnniversary: string;
  phase: "before" | "window" | "after";
  adaptedRent: number | null;
  adaptedIndex: number | null;
  adaptedIndexMonth: string;
  rentDueBefore: number | null;
  indexedAtWindow: number | null;
  fromLease: boolean;
  missingIndexMonth: string | null;
}

/**
 * One line telling the landlord how the Walloon PEB rule of 2022-2023 (decree
 * of 19 October 2022) shapes this indexation: the adapted base rent and index
 * that apply for the rest of the lease, the limited indexation in the window
 * itself, full indexation, or a missing health index.
 */
export function WalloniaPebNote({
  wallonia,
  blocked,
  className,
}: {
  wallonia?: WalloniaPebInfo | null;
  blocked?: string | null;
  className?: string;
}) {
  const t = useTranslations("walloniaPeb");
  const locale = useLocale();
  if (!wallonia) return null;

  const eur = (n: number) =>
    new Intl.NumberFormat(locale === "en" ? "en-BE" : `${locale}-BE`, { style: "currency", currency: "EUR" }).format(n);
  const num = (n: number) => (locale === "en" ? n.toFixed(2) : n.toFixed(2).replace(".", ","));
  const monthYear = (ym: string) =>
    new Intl.DateTimeFormat(locale, { month: "long", year: "numeric" }).format(
      new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, 15))
    );
  const label = wallonia.label === "none" ? t("none") : wallonia.label;

  if (blocked === "wallonia_index_missing" || wallonia.missingIndexMonth) {
    return (
      <p className={`${className ?? ""} text-yellow-700 dark:text-yellow-500`}>
        {t("indexMissing", { month: monthYear(wallonia.missingIndexMonth ?? wallonia.adaptedIndexMonth) })}
      </p>
    );
  }
  if (wallonia.phase === "before") return null;

  if (wallonia.adaptedRent === null || wallonia.adaptedIndex === null) {
    return <p className={`${className ?? ""} text-muted-foreground`}>{t("fullAllowed", { label })}</p>;
  }

  if (wallonia.phase === "window") {
    return (
      <p className={`${className ?? ""} text-orange-700 dark:text-orange-300`}>
        {t("window", {
          label,
          share: t("sharePct", { pct: String(wallonia.share * 100) }),
          rent: eur(wallonia.adaptedRent),
        })}
      </p>
    );
  }

  return (
    <p className={`${className ?? ""} text-orange-700 dark:text-orange-300`}>
      {t("baseAdapted", {
        rent: eur(wallonia.adaptedRent),
        label,
        month: monthYear(wallonia.windowAnniversary.slice(0, 7)),
        index: num(wallonia.adaptedIndex),
      })}
      {wallonia.fromLease ? ` ${t("baseStored")}` : ""}
    </p>
  );
}
