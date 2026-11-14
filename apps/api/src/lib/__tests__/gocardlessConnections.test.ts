/**
 * A reconnect gets a new token from GoCardless and the old one stops working,
 * so saving a connection for an owner who already has one overwrites that row.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

let existing: Array<Record<string, unknown>> = [];
const updates: Array<Record<string, unknown>> = [];
const inserts: Array<Record<string, unknown>> = [];

vi.mock("@rentular/db", () => ({
  getDb: () => ({
    select: () => ({ from: () => ({ where: () => ({ limit: async () => existing }) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updates.push(v);
        return { where: async () => [] };
      },
    }),
    insert: () => ({
      values: async (v: Record<string, unknown>) => {
        inserts.push(v);
      },
    }),
  }),
  gocardlessConnections: { ownerId: "owner_id", id: "id", organisationId: "organisation_id" },
  leases: {},
  properties: {},
}));

vi.mock("../encryption", () => ({
  encrypt: vi.fn((plain: string) => ({ encrypted: `ENC(${plain})`, iv: "IV", tag: "TAG" })),
  decrypt: vi.fn(),
}));

import { saveConnection } from "../gocardlessConnections";

const input = {
  accessToken: "NEW-TOKEN",
  organisationId: "OR-A",
  environment: "live" as const,
  creditorId: "CR-A",
  creditorName: "A",
  scheme: "sepa_core",
};

beforeEach(() => {
  existing = [];
  updates.length = 0;
  inserts.length = 0;
});

describe("saveConnection", () => {
  it("inserts the first connection of an owner", async () => {
    await saveConnection("landlord-a", input);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ ownerId: "landlord-a", accessTokenEncrypted: "ENC(NEW-TOKEN)", status: "active" });
    expect(updates).toHaveLength(0);
  });

  it("overwrites the token on reconnect, also after a revoke", async () => {
    existing = [{ id: "row-1", ownerId: "landlord-a", status: "revoked", accessTokenEncrypted: null }];
    await saveConnection("landlord-a", input);
    expect(inserts).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      accessTokenEncrypted: "ENC(NEW-TOKEN)",
      organisationId: "OR-A",
      status: "active",
      lastError: null,
    });
  });
});
