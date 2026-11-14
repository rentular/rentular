"use client";

import { useTranslations } from "next-intl";

export interface FlandersAnnouncedRestriction {
  fromYear: number;
  labels: string[];
  inForce: boolean;
}

/**
 * Neutral notice about the indexation ban the Flemish government announced
 * for some EPC labels. It is not law, so it never changes the rent shown.
 */
export function FlandersAnnouncedNote({
  restriction,
  className,
}: {
  restriction?: FlandersAnnouncedRestriction | null;
  className?: string;
}) {
  const t = useTranslations("flandersAnnounced");
  if (!restriction || restriction.inForce || restriction.labels.length === 0) return null;
  const labels =
    restriction.labels.length === 1
      ? restriction.labels[0]
      : `${restriction.labels.slice(0, -1).join(", ")} ${t("or")} ${restriction.labels[restriction.labels.length - 1]}`;
  return (
    <p className={`${className ?? ""} text-muted-foreground`}>
      {t("notice", { year: String(restriction.fromYear), labels: labels ?? "" })}
    </p>
  );
}
