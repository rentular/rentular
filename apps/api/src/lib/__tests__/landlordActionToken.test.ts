import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  process.env.AUTH_SECRET = "test-secret-please-change-0123456789";
});

describe("landlordActionToken", () => {
  it("round-trips an action + payment id", async () => {
    const { signLandlordActionToken, verifyLandlordActionToken } = await import(
      "../landlordActionToken"
    );
    const token = await signLandlordActionToken("paid", "pay-123");
    const decoded = await verifyLandlordActionToken(token);
    expect(decoded).toMatchObject({ action: "paid", paymentId: "pay-123", markId: null });
    expect(typeof decoded.exp).toBe("number");
  });

  it("rejects a tampered/garbage token", async () => {
    const { verifyLandlordActionToken } = await import("../landlordActionToken");
    await expect(verifyLandlordActionToken("not-a-jwt")).rejects.toThrow();
  });

  it("carries each supported action", async () => {
    const { signLandlordActionToken, verifyLandlordActionToken } = await import(
      "../landlordActionToken"
    );
    for (const action of ["paid", "wait", "remind", "off"] as const) {
      const decoded = await verifyLandlordActionToken(
        await signLandlordActionToken(action, "p"),
      );
      expect(decoded.action).toBe(action);
    }
  });

  it("signs an undo link for a mark that expires with the paid link", async () => {
    const { signLandlordActionToken, signLandlordUndoToken, verifyLandlordActionToken } = await import(
      "../landlordActionToken"
    );
    const paid = await verifyLandlordActionToken(await signLandlordActionToken("paid", "pay-1"));
    const undo = await verifyLandlordActionToken(await signLandlordUndoToken("pay-1", "mark-1", paid.exp!));
    expect(undo).toEqual({ action: "unpaid", paymentId: "pay-1", markId: "mark-1", exp: paid.exp });
  });

  it("rejects an undo token without a mark and a mark on another action", async () => {
    const { verifyLandlordActionToken } = await import("../landlordActionToken");
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode("test-secret-please-change-0123456789");
    const bare = await new SignJWT({ action: "unpaid", paymentId: "p" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1d")
      .sign(key);
    await expect(verifyLandlordActionToken(bare)).rejects.toThrow();
    const odd = await new SignJWT({ action: "paid", paymentId: "p", markId: "m" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1d")
      .sign(key);
    await expect(verifyLandlordActionToken(odd)).rejects.toThrow();
  });

  it("rejects an expired undo token", async () => {
    const { signLandlordUndoToken, verifyLandlordActionToken } = await import("../landlordActionToken");
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect(verifyLandlordActionToken(await signLandlordUndoToken("p", "m", past))).rejects.toThrow();
  });

  it("rejects a token from another link family that carries a kind", async () => {
    const { verifyLandlordActionToken } = await import("../landlordActionToken");
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({ kind: "indexation-snooze", action: "paid", paymentId: "p" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("1d")
      .sign(new TextEncoder().encode("test-secret-please-change-0123456789"));
    await expect(verifyLandlordActionToken(token)).rejects.toThrow();
  });
});
