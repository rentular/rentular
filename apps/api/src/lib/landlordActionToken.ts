/**
 * Signed one-click "magic link" tokens for the late-payment landlord email.
 *
 * Each link carries an HS256 JWT (signed with AUTH_SECRET) encoding the action
 * and the target payment, with a 21-day TTL. The links are the authentication:
 * no login is needed. Actions are idempotent (mark paid, acknowledge, remind,
 * turn off, hold the automatic third reminder) so a replayed link within its
 * TTL does no harm.
 *
 * The confirmation page of "paid" offers an undo link ("unpaid"). Its token
 * names the mark to undo and expires together with the link that made it.
 */

import { SignJWT, jwtVerify } from "jose";
import { requireAuthSecret } from "./authSecret";

const ALG = "HS256";
const TTL = "21d";

export type LandlordAction = "paid" | "wait" | "remind" | "off" | "hold" | "unpaid";

const ACTIONS: LandlordAction[] = ["paid", "wait", "remind", "off", "hold", "unpaid"];

function getSecret(): Uint8Array {
  return new TextEncoder().encode(requireAuthSecret());
}

export async function signLandlordActionToken(
  action: Exclude<LandlordAction, "unpaid">,
  paymentId: string,
): Promise<string> {
  return new SignJWT({ action, paymentId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(TTL)
    .sign(getSecret());
}

/**
 * Undo link for a paid mark made from the email. Valid until `exp` (seconds
 * since the epoch), the expiry of the "paid" link it came from.
 */
export async function signLandlordUndoToken(
  paymentId: string,
  markId: string,
  exp: number,
): Promise<string> {
  return new SignJWT({ action: "unpaid", paymentId, markId })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(exp)
    .sign(getSecret());
}

export async function verifyLandlordActionToken(
  token: string,
): Promise<{ action: LandlordAction; paymentId: string; markId: string | null; exp: number | null }> {
  const { payload } = await jwtVerify(token, getSecret(), { algorithms: [ALG] });
  // Tokens from other link families (indexation snooze) carry a kind and must
  // never be accepted here.
  if (payload.kind !== undefined) throw new Error("Invalid action");
  const action = payload.action as LandlordAction;
  if (!ACTIONS.includes(action)) {
    throw new Error("Invalid action");
  }
  // An undo token always names its mark; other actions never do.
  const markId = typeof payload.markId === "string" && payload.markId ? payload.markId : null;
  if ((action === "unpaid") !== (markId !== null)) throw new Error("Invalid action");
  return {
    action,
    paymentId: String(payload.paymentId),
    markId,
    exp: typeof payload.exp === "number" ? payload.exp : null,
  };
}
