import { Hono } from "hono";
import {
  isHostedInstance,
  verifyWebhookSignature,
  type GoCardlessWebhookPayload,
} from "../lib/gocardless";
import {
  createDbWebhookStore,
  processGoCardlessEvent,
  type WebhookStore,
} from "../services/gocardlessWebhook";

export const webhooksRouter = new Hono();

let storeFactory: () => WebhookStore = createDbWebhookStore;

/** Replace the data access behind the webhook (tests). */
export function setWebhookStoreFactory(factory: (() => WebhookStore) | null): void {
  storeFactory = factory ?? createDbWebhookStore;
}

/**
 * The secret GoCardless signs webhooks with. Hosted: the partner app's
 * webhook secret (events of every connected landlord arrive there).
 * Self-hosted: the secret of the instance's own webhook endpoint.
 */
export function gocardlessWebhookSecret(hosted: boolean): { name: string; value: string | undefined } {
  return hosted
    ? { name: "GOCARDLESS_PARTNER_WEBHOOK_SECRET", value: process.env.GOCARDLESS_PARTNER_WEBHOOK_SECRET }
    : { name: "GOCARDLESS_WEBHOOK_SECRET", value: process.env.GOCARDLESS_WEBHOOK_SECRET };
}

// GoCardless webhook handler
// Receives payment status updates, mandate events, etc.
// Docs: https://developer.gocardless.com/api-reference/#appendix-webhooks
webhooksRouter.post("/gocardless", async (c) => {
  const signature = c.req.header("Webhook-Signature");
  const body = await c.req.text();

  const hosted = isHostedInstance();
  const secret = gocardlessWebhookSecret(hosted);
  if (!secret.value) {
    console.error(`[Webhook] ${secret.name} is not set`);
    return c.json({ error: "Webhook secret not configured" }, 500);
  }

  // Verify signature
  if (!verifyWebhookSignature(body, signature, secret.value)) {
    console.warn("[Webhook] Invalid GoCardless webhook signature");
    return c.json({ error: "Invalid signature" }, 401);
  }

  // Parse the events
  let payload: GoCardlessWebhookPayload;
  try {
    payload = JSON.parse(body);
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }

  const store = storeFactory();
  for (const event of payload.events ?? []) {
    try {
      await processGoCardlessEvent(event, { hosted, store });
    } catch (err) {
      // Log but don't fail the webhook - GoCardless will retry if we return non-200
      console.error(`[Webhook] Error processing event ${event.id}:`, err);
    }
  }

  // Always return 200 to acknowledge receipt
  return c.json({ status: "received" });
});
