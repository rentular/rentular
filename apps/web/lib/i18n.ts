import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import { routing } from "./routing";

type Locale = (typeof routing.locales)[number];

function isLocale(value: string | null | undefined): value is Locale {
  return !!value && (routing.locales as readonly string[]).includes(value);
}

/**
 * First supported language from the browser's Accept-Language header, by
 * quality. "nl-BE,nl;q=0.9,en;q=0.8" gives "nl". Without this a phone set to
 * Dutch got the English site and translated it itself (iPhone and Chrome turn
 * "Rentular" into "Rentulair").
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { lang: (tag || "").toLowerCase().split("-")[0], quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((entry) => entry.lang && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const entry of ranked) {
    if (isLocale(entry.lang)) return entry.lang;
  }
  return null;
}

export default getRequestConfig(async ({ requestLocale }) => {
  // Priority: 1) NEXT_LOCALE cookie (an explicit choice), 2) requestLocale from
  // middleware, 3) the browser's language, 4) default
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("NEXT_LOCALE")?.value;

  let locale: string | undefined = isLocale(cookieLocale) ? cookieLocale : undefined;
  if (!locale) {
    const fromRequest = await requestLocale;
    if (isLocale(fromRequest)) locale = fromRequest;
  }
  if (!locale) {
    const headerStore = await headers();
    locale = localeFromAcceptLanguage(headerStore.get("accept-language")) ?? undefined;
  }
  if (!isLocale(locale)) {
    locale = routing.defaultLocale;
  }

  return {
    locale,
    messages: (await import(`../messages/${locale}/common.json`)).default,
  };
});
