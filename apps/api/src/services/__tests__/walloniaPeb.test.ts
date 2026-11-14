import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../healthIndex", () => ({
  getHealthIndexValue: vi.fn(),
  getLatestHealthIndex: vi.fn(),
}));

import { getHealthIndexValue, getLatestHealthIndex } from "../healthIndex";
import { calculateIndexedRent } from "@rentular/shared/validation";
import {
  computeIndexationCore,
  walloniaAdaptedRent,
  walloniaWindowAnniversary,
} from "../indexationCalc";

// Every worked example of https://logement.wallonie.be/fr/bail/indexation-loyer
// (read on 2026-11-14), with the official numbers. The health index values are
// the ones the page uses; they match Statbel (base 2013 unless noted):
// 2012-08 98.92 (base 2004: 119.47), 2018-08 107.55, 2019-08 109.07,
// 2019-10 108.98 (base 2004: 131.62), 2021-08 112.74, 2021-10 113.94
// (base 2004: 137.61), 2022-10 127.92 (base 2004: 154.49), 2023-10 128.30.
const STATBEL: Record<string, number> = {
  "2012-08": 98.92,
  "2018-08": 107.55,
  "2019-08": 109.07,
  "2019-10": 108.98,
  "2021-08": 112.74,
  "2021-10": 113.94,
  "2022-10": 127.92,
  "2023-10": 128.3,
};

function mockIndices(values: Record<string, number>): void {
  vi.mocked(getHealthIndexValue).mockImplementation(async (year: string, month: string) => {
    const v = values[`${year}-${month}`];
    return (v === undefined ? null : String(v)) as Awaited<ReturnType<typeof getHealthIndexValue>>;
  });
  vi.mocked(getLatestHealthIndex).mockResolvedValue({
    year: "2023",
    month: "10",
    value: "128.30",
  } as Awaited<ReturnType<typeof getLatestHealthIndex>>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIndices(STATBEL);
});

// Lease signed September 2021, in force November 2021, rent 600, base index August 2021.
const lease2021 = {
  baseRent: 600,
  baseIndex: 112.74,
  region: "wallonia",
  startDate: "2021-11-01",
  leaseType: "residential_long",
};
const NOV_2022 = new Date(2022, 10, 15);
const NOV_2023 = new Date(2023, 10, 15);

describe("walloniaAdaptedRent: official examples", () => {
  it("PEB D, lease of November 2021: 680,79 indexed, adapted 660,59", () => {
    const r = walloniaAdaptedRent({ baseRent: 600, baseIndex: 112.74, windowIndex: 127.92, previousIndex: null, share: 0.75 });
    expect(r.indexedAtWindow).toBe(680.79);
    expect(r.rentDueBefore).toBe(600);
    expect(r.adaptedRent).toBe(660.59);
  });

  it("PEB E, lease of November 2021: adapted 640,39", () => {
    const r = walloniaAdaptedRent({ baseRent: 600, baseIndex: 112.74, windowIndex: 127.92, previousIndex: null, share: 0.5 });
    expect(r.adaptedRent).toBe(640.39);
  });

  it("PEB F, G or none, lease of November 2021: adapted 600", () => {
    const r = walloniaAdaptedRent({ baseRent: 600, baseIndex: 112.74, windowIndex: 127.92, previousIndex: null, share: 0 });
    expect(r.adaptedRent).toBe(600);
  });

  it("PEB D, lease of November 2019: 703,69 and 626,79, adapted 684,47", () => {
    const r = walloniaAdaptedRent({ baseRent: 600, baseIndex: 109.07, windowIndex: 127.92, previousIndex: 113.94, share: 0.75 });
    expect(r.indexedAtWindow).toBe(703.69);
    expect(r.rentDueBefore).toBe(626.79);
    expect(r.adaptedRent).toBe(684.47);
  });

  it("PEB E, lease of November 2019: adapted 665,24", () => {
    const r = walloniaAdaptedRent({ baseRent: 600, baseIndex: 109.07, windowIndex: 127.92, previousIndex: 113.94, share: 0.5 });
    expect(r.adaptedRent).toBe(665.24);
  });

  it("PEB F, G or none, lease of November 2012 (base 2004 indices): 661,02, 775,88, adapted 691,10", () => {
    // Not indexed since 2019: 600 x 131.62 / 119.47.
    expect(calculateIndexedRent(600, 119.47, 131.62)).toBe(661.02);
    const r = walloniaAdaptedRent({ baseRent: 600, baseIndex: 119.47, windowIndex: 154.49, previousIndex: 137.61, share: 0 });
    expect(r.indexedAtWindow).toBe(775.88);
    // "Dernière indexation possible = loyer indexé en 2021"
    expect(r.adaptedRent).toBe(691.1);
  });

  it("PEB F, G or none, lease of November 2018, never indexed: 713,64, adapted 635,65", () => {
    const r = walloniaAdaptedRent({ baseRent: 600, baseIndex: 107.55, windowIndex: 127.92, previousIndex: 113.94, share: 0 });
    expect(r.indexedAtWindow).toBe(713.64);
    expect(r.adaptedRent).toBe(635.65);
  });
});

describe("walloniaWindowAnniversary", () => {
  it("is the anniversary between 1 November 2022 and 31 October 2023", () => {
    expect(walloniaWindowAnniversary("2021-11-01")).toBe("2022-11-01");
    expect(walloniaWindowAnniversary("2019-05-01")).toBe("2023-05-01");
    expect(walloniaWindowAnniversary("2022-10-31")).toBe("2023-10-31");
    expect(walloniaWindowAnniversary("2012-12-15")).toBe("2022-12-15");
  });

  it("does not exist for a lease in force from 1 November 2022", () => {
    expect(walloniaWindowAnniversary("2022-11-01")).toBeNull();
    expect(walloniaWindowAnniversary("2024-03-01")).toBeNull();
  });
});

describe("computeIndexationCore: Wallonia PEB rule, official examples", () => {
  it("PEB D: 680,79 standard, 660,59 in November 2022, 662,55 in November 2023", async () => {
    const nov22 = await computeIndexationCore({ ...lease2021, epcLabel: "D", today: NOV_2022 });
    expect(nov22.unrestrictedNewRent).toBe(680.79);
    expect(nov22.newRent).toBe(660.59);
    expect(nov22.wallonia?.phase).toBe("window");

    const nov23 = await computeIndexationCore({ ...lease2021, epcLabel: "D", today: NOV_2023 });
    expect(nov23.newRent).toBe(662.55);
    expect(nov23.epcRestricted).toBe(true);
    expect(nov23.wallonia).toMatchObject({
      label: "D",
      share: 0.75,
      phase: "after",
      windowAnniversary: "2022-11-01",
      adaptedRent: 660.59,
      adaptedIndex: 127.92,
      adaptedIndexMonth: "2022-10",
      fromLease: false,
    });
    expect(nov23.indexationBlocked).toBeNull();
  });

  it("PEB E: 640,39 in November 2022, 642,29 in November 2023", async () => {
    const nov22 = await computeIndexationCore({ ...lease2021, epcLabel: "E", today: NOV_2022 });
    expect(nov22.newRent).toBe(640.39);
    const nov23 = await computeIndexationCore({ ...lease2021, epcLabel: "E", today: NOV_2023 });
    expect(nov23.newRent).toBe(642.29);
  });

  it.each(["F", "G", null])("PEB %s: stays 600 in November 2022, 601,78 in November 2023", async (label) => {
    const nov22 = await computeIndexationCore({ ...lease2021, epcLabel: label, currentRent: 600, today: NOV_2022 });
    expect(nov22.newRent).toBe(600);
    const nov23 = await computeIndexationCore({ ...lease2021, epcLabel: label, today: NOV_2023 });
    expect(nov23.newRent).toBe(601.78);
    expect(nov23.wallonia?.label).toBe(label ?? "none");
  });

  it("PEB D, lease of November 2019: 684,47 on 1 November 2022", async () => {
    const r = await computeIndexationCore({
      ...lease2021,
      baseIndex: 109.07,
      startDate: "2019-11-01",
      epcLabel: "D",
      today: NOV_2022,
    });
    expect(r.unrestrictedNewRent).toBe(703.69);
    expect(r.wallonia?.rentDueBefore).toBe(626.79);
    expect(r.newRent).toBe(684.47);
  });

  it("PEB E, lease of November 2019: 665,24 on 1 November 2022", async () => {
    const r = await computeIndexationCore({
      ...lease2021,
      baseIndex: 109.07,
      startDate: "2019-11-01",
      epcLabel: "E",
      today: NOV_2022,
    });
    expect(r.newRent).toBe(665.24);
  });

  it("no PEB, lease of November 2012 not indexed since 2019: kept at 661,02, then 693,15", async () => {
    const lease2012 = { ...lease2021, baseIndex: 98.92, startDate: "2012-11-01", epcLabel: null };
    const nov22 = await computeIndexationCore({ ...lease2012, currentRent: 661.02, today: NOV_2022 });
    expect(nov22.newRent).toBe(661.02);
    expect(nov22.wallonia?.adaptedRent).toBe(691.1);

    const nov23 = await computeIndexationCore({ ...lease2012, currentRent: 661.02, today: NOV_2023 });
    expect(nov23.newRent).toBe(693.15);
  });

  it("PEB F, lease of November 2018 never indexed: kept at 600, then 637,54", async () => {
    const lease2018 = { ...lease2021, baseIndex: 107.55, startDate: "2018-11-01", epcLabel: "F" };
    const nov22 = await computeIndexationCore({ ...lease2018, currentRent: 600, today: NOV_2022 });
    expect(nov22.unrestrictedNewRent).toBe(713.64);
    expect(nov22.newRent).toBe(600);

    const nov23 = await computeIndexationCore({ ...lease2018, currentRent: 600, today: NOV_2023 });
    expect(nov23.wallonia?.adaptedRent).toBe(635.65);
    expect(nov23.newRent).toBe(637.54);
  });

  it("the adapted base keeps applying in later years and never exceeds the standard rent", async () => {
    mockIndices({ ...STATBEL, "2026-10": 140 });
    const r = await computeIndexationCore({ ...lease2021, epcLabel: "D", today: new Date(2026, 10, 15) });
    expect(r.unrestrictedNewRent).toBe(calculateIndexedRent(600, 112.74, 140));
    expect(r.newRent).toBe(Math.round(((660.59 * 140) / 127.92) * 100) / 100);
    expect(r.newRent).toBeLessThan(r.unrestrictedNewRent);
  });
});

describe("computeIndexationCore: Wallonia PEB rule, scope and stored base", () => {
  it("a lease in force after 31 October 2022 indexes in full, any label", async () => {
    const r = await computeIndexationCore({
      ...lease2021,
      startDate: "2022-11-01",
      baseIndex: 127.92,
      epcLabel: "G",
      today: NOV_2023,
    });
    expect(r.wallonia).toBeNull();
    expect(r.epcRestricted).toBe(false);
    expect(r.newRent).toBe(r.unrestrictedNewRent);
    expect(r.newRent).toBe(calculateIndexedRent(600, 127.92, 128.3));
  });

  it("PEB C in the window: unaffected, full indexation", async () => {
    const r = await computeIndexationCore({ ...lease2021, epcLabel: "C", today: NOV_2023 });
    expect(r.wallonia).toMatchObject({ label: "C", share: 1, adaptedRent: null });
    expect(r.epcRestricted).toBe(false);
    expect(r.newRent).toBe(r.unrestrictedNewRent);
  });

  it("a better certificate after 2023 does not change a stored base", async () => {
    const r = await computeIndexationCore({
      ...lease2021,
      epcLabel: "B",
      walloniaPebLabel2022: "D",
      walloniaAdaptedRent: 660.59,
      walloniaAdaptedIndex: 127.92,
      walloniaAdaptedIndexMonth: "2022-10",
      today: NOV_2023,
    });
    expect(r.newRent).toBe(662.55);
    expect(r.wallonia).toMatchObject({ label: "D", labelSource: "lease", fromLease: true });
    // The stored values are used as they are: no index lookup for the window.
    expect(vi.mocked(getHealthIndexValue).mock.calls.some(([y, m]) => `${y}-${m}` === "2022-10")).toBe(false);
  });

  it("the PEB label set on the lease for 2022-2023 wins over the property's current label", async () => {
    const r = await computeIndexationCore({ ...lease2021, epcLabel: "A", walloniaPebLabel2022: "E", today: NOV_2023 });
    expect(r.newRent).toBe(642.29);
    expect(r.wallonia?.labelSource).toBe("lease");

    const c = await computeIndexationCore({ ...lease2021, epcLabel: "F", walloniaPebLabel2022: "C", today: NOV_2023 });
    expect(c.newRent).toBe(c.unrestrictedNewRent);
  });

  it("a missing health index blocks the indexation instead of guessing", async () => {
    const { ["2022-10"]: _omit, ...rest } = STATBEL;
    mockIndices(rest);
    const r = await computeIndexationCore({ ...lease2021, epcLabel: "D", currentRent: 650, today: NOV_2023 });
    expect(r.indexationBlocked).toBe("wallonia_index_missing");
    expect(r.newRent).toBe(650);
    expect(r.wallonia?.missingIndexMonth).toBe("2022-10");
  });

  it("commercial leases follow federal law: no PEB rule", async () => {
    const r = await computeIndexationCore({ ...lease2021, leaseType: "commercial", epcLabel: "G", today: NOV_2023 });
    expect(r.wallonia).toBeNull();
    expect(r.newRent).toBe(r.unrestrictedNewRent);
  });

  it("Flanders and Brussels results carry no Wallonia info", async () => {
    const f = await computeIndexationCore({ ...lease2021, region: "flanders", epcLabel: "A", today: NOV_2023 });
    expect(f.wallonia).toBeNull();
    const b = await computeIndexationCore({
      ...lease2021,
      region: "brussels",
      epcLabel: "A",
      leaseRegistered: true,
      today: NOV_2023,
    });
    expect(b.wallonia).toBeNull();
    expect(b.newRent).toBe(b.unrestrictedNewRent);
  });
});
