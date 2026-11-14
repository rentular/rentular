import type { Locator, Page } from "playwright";
import { TestFailure } from "./report";

export interface FieldInfo {
  label: string;
  type: string;
  tag: string;
}

/** Problems that do not fail the run but are worth a look (e.g. a formatter). */
export interface FocusWarning {
  field: string;
  message: string;
}

const MARK = "data-e2e-focus-id";
let counter = 0;

/** Ignores formatting a field may apply (IBAN groups, phone spacing, case). */
function normalise(v: string): string {
  return v.replace(/[^\p{L}\p{N}@]/gu, "").toLowerCase();
}

export async function describeField(locator: Locator): Promise<FieldInfo> {
  return locator.evaluate((el) => {
    const input = el as HTMLInputElement;
    const byFor = input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`) : null;
    const wrapping = input.closest("label");
    // Rentular forms often put the <label> as a sibling just before the input.
    let sibling: Element | null = null;
    let node: Element | null = input;
    for (let i = 0; i < 3 && node && !sibling; i++) {
      let prev = node.previousElementSibling;
      while (prev && !sibling) {
        if (prev.tagName === "LABEL") sibling = prev;
        prev = prev.previousElementSibling;
      }
      node = node.parentElement;
    }
    const label =
      input.getAttribute("aria-label") ||
      byFor?.textContent ||
      wrapping?.textContent ||
      sibling?.textContent ||
      input.getAttribute("placeholder") ||
      input.getAttribute("name") ||
      input.id ||
      el.tagName.toLowerCase();
    return {
      label: label.replace(/\s+/g, " ").trim().slice(0, 60),
      type: (input.getAttribute("type") || "text").toLowerCase(),
      tag: el.tagName.toLowerCase(),
    };
  });
}

/** Picks realistic input for a field from its type and label. */
export function sampleTextFor(info: FieldInfo, placeholder: string): string {
  const hint = `${info.label} ${placeholder}`.toLowerCase();
  if (info.type === "email" || /e-?mail/.test(hint)) return "jan.peeters@example.be";
  if (info.type === "tel" || /phone|telefoon|gsm|téléphone|telefon|whatsapp/.test(hint)) return "0471234567";
  if (info.type === "number") return "1250";
  if (/iban|deposit account|rekening/.test(hint)) return "BE68539007547034";
  if (/dd\/mm|mm\/dd|date|datum/.test(hint)) return "15/03/2026";
  if (/postal|postcode|zip/.test(hint)) return "1000";
  if (/vat|btw|tva/.test(hint)) return "BE0123456789";
  if (/amount|rent|bedrag|huur|price|€|eur/.test(hint)) return "1250";
  if (/search|zoek|recherche|suche/.test(hint)) return "Jansens";
  if (info.tag === "textarea") return "Jansens-Dupont 12, tweede verdieping";
  return "Jansens-Dupont 12";
}

/**
 * Clicks a field and types `text` one key at a time through the real
 * keyboard. After every key it checks that the very same DOM element still
 * has focus (a remounted input is a new element without our marker) and that
 * the value grew as expected. Focus loss throws; an unexpected value is
 * returned as a warning because some fields legitimately reformat input.
 */
export async function typeAndAssertFocus(
  page: Page,
  locator: Locator,
  text: string,
  context: string
): Promise<FocusWarning[]> {
  const warnings: FocusWarning[] = [];
  const info = await describeField(locator);
  const where = `${context} > "${info.label}" (${info.tag}${info.tag === "input" ? `[${info.type}]` : ""})`;
  const id = `f${++counter}`;
  await locator.evaluate((el, [attr, val]) => el.setAttribute(attr, val), [MARK, id] as const);
  // Click like a user. A suggestion list from the previous field can sit on
  // top of this one; then focus it the way Tab would.
  await locator.click({ timeout: 3_000 }).catch(() => locator.focus());
  // Start from empty so the value check is meaningful on edit forms.
  if (info.tag !== "div") {
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Backspace");
  }

  const focused = await page.evaluate((attr) => document.activeElement?.getAttribute(attr) ?? null, MARK);
  if (focused !== id) {
    throw new TestFailure(`${where}: field did not keep focus after clicking it and clearing it`);
  }

  for (let i = 0; i < text.length; i++) {
    await page.keyboard.type(text[i], { delay: 15 });
    const state = await page.evaluate((attr) => {
      const a = document.activeElement as HTMLInputElement | null;
      return {
        mark: a?.getAttribute(attr) ?? null,
        tag: a?.tagName.toLowerCase() ?? "none",
        label: a?.getAttribute("aria-label") || a?.textContent?.trim().slice(0, 40) || a?.getAttribute("name") || "",
      };
    }, MARK);
    if (state.mark !== id) {
      throw new TestFailure(
        `${where}: lost focus after typing character ${i + 1} ("${text.slice(0, i + 1)}"); focus moved to <${state.tag}> ${state.label}`
      );
    }
  }

  if (info.type !== "date" && info.type !== "month") {
    const value = await locator.evaluate((el) =>
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : (el.textContent ?? "")
    );
    const want = normalise(text);
    const got = normalise(value);
    if (!got.includes(want)) {
      warnings.push({ field: where, message: `typed "${text}", field shows "${value}"` });
    }
  }
  return warnings;
}

/** Waits until CSS animations (dialog zoom/slide-in) inside `scope` are done. */
export async function settle(scope: Locator): Promise<void> {
  await scope
    .evaluate((el) => {
      // Skip endless animations (spinners, pulses) and never wait over 2s.
      const finite = (el.ownerDocument.getAnimations?.() ?? []).filter(
        (a) => Number.isFinite(Number(a.effect?.getComputedTiming().endTime))
      );
      return Promise.race([
        Promise.all(finite.map((a) => a.finished.catch(() => undefined))),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    })
    .catch(() => undefined);
}

const FIELD_SELECTOR =
  'input:not([type]), input[type="text"], input[type="email"], input[type="tel"], input[type="number"], input[type="search"], input[type="url"], input[type="password"], input[type="date"], input[type="month"], textarea, [contenteditable="true"]';
let sweepRun = 0;

/**
 * Every field a user can type into inside `scope`: text-like inputs,
 * textareas and contenteditable elements that are visible and enabled. Each
 * one is tagged up front, so the returned locators point at that exact DOM
 * node even when the form changes around it.
 */
export async function typableFields(scope: Locator): Promise<Locator[]> {
  await settle(scope);
  const run = `s${++sweepRun}`;
  const ids = await scope.evaluate(
    (root, [selector, run]) => {
      const out: string[] = [];
      root.querySelectorAll(selector).forEach((el, i) => {
        const h = el as HTMLInputElement;
        const style = getComputedStyle(h);
        const rect = h.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        // Hidden helpers (sr-only native date inputs behind a text field).
        const hidden = h.getAttribute("aria-hidden") === "true" || h.tabIndex < 0 || rect.width <= 2;
        if (!visible || hidden || h.disabled || h.readOnly) return;
        const id = `${run}-${i}`;
        h.setAttribute("data-e2e-field", id);
        out.push(id);
      });
      return out;
    },
    [FIELD_SELECTOR, run] as const
  );
  return ids.map((id) => scope.page().locator(`[data-e2e-field="${id}"]`));
}

/** Sweeps every typable field in `scope`, returning warnings; throws on focus loss. */
export async function sweepFields(
  page: Page,
  scope: Locator,
  context: string,
  opts: { skip?: RegExp } = {}
): Promise<{ count: number; fields: string[]; warnings: FocusWarning[] }> {
  const fields = await typableFields(scope);
  const warnings: FocusWarning[] = [];
  const names: string[] = [];
  for (const field of fields) {
    // A previous field may have changed the form (e.g. hid a section).
    if (!(await field.count()) || !(await field.isVisible().catch(() => false))) continue;
    const info = await describeField(field);
    if (opts.skip?.test(info.label)) continue;
    const placeholder = (await field.getAttribute("placeholder")) ?? "";
    const text = info.type === "password" ? "Correct-Horse-9" : sampleTextFor(info, placeholder);
    warnings.push(...(await typeAndAssertFocus(page, field, text, context)));
    names.push(info.label);
  }
  return { count: names.length, fields: names, warnings };
}
