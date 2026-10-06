// Stripe Checkout for paid events: Stripe's REST API over fetch (no SDK).
//
//   GET  /api/checkout/price    { amount, currency, enabled } for the sign-up page
//   POST /api/checkout          { name, email, eventDate? } → pending event +
//                               Checkout Session → { url } (redirect there)
//   GET  /api/checkout/status?session=cs_…
//                               { paid, eventName, setupLink, galleryLink } once
//                               paid, else { paid: false }. The session id in
//                               the success URL is the capability: only the
//                               payer has it, and they get the links by email
//                               anyway.
//   POST /api/stripe/webhook    signed events from Stripe
//
// Payment ref: the PaymentIntent id (pi_…), not the session id. Refunds
// arrive as `charge.refunded`, which carries the payment_intent but not the
// session, so this one id ties the payment to its refund with no extra
// lookup. Both the webhook and the status endpoint activate with that same
// ref, so whichever comes first wins and the host gets exactly one email.
//
// Config (env):
//   STRIPE_SECRET_KEY      sk_live_… / sk_test_… (without it: 503, the booth
//                          stays free)
//   STRIPE_WEBHOOK_SECRET  whsec_… of the webhook endpoint
//   STRIPE_AUTOMATIC_TAX   1 = let Stripe Tax add VAT (price is tax-inclusive)

import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  activateEvent,
  checkEventRequest,
  createPendingEvent,
  EVENT_CURRENCY,
  EVENT_PRICE_CENTS,
  galleryLink,
  refundPayment,
  setupLink,
} from './billing.ts';
import { deleteEvent } from './events.ts';
import { clientIp, HttpError, type Req, type Res, rateLimiter, readBody, readJson, sendJson } from './http.ts';

const API = 'https://api.stripe.com/v1';
const TOLERANCE_SEC = 5 * 60; // reject webhook signatures older than this
const HOUR = 60 * 60 * 1000;
const checkoutLimited = rateLimiter(20, HOUR); // new checkouts per IP per hour
const statusLimited = rateLimiter(300, HOUR); // the success page polls
const SESSION_ID = /^cs_[\w]{10,200}$/;

// Read at call time, so a server without keys simply has no payments.
const secretKey = () => process.env.STRIPE_SECRET_KEY || '';
const webhookSecret = () => process.env.STRIPE_WEBHOOK_SECRET || '';
const publicUrl = () =>
  (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://boot.small-victories.co').replace(/\/+$/, '');

// The bits of a Checkout Session / Charge this file reads.
interface Session {
  id: string;
  url?: string | null;
  payment_status?: string;
  payment_intent?: string | { id: string } | null;
  amount_total?: number | null;
  currency?: string | null;
  client_reference_id?: string | null;
  metadata?: Record<string, string> | null;
  customer_details?: { email?: string | null } | null;
}

interface Charge {
  id: string;
  payment_intent?: string | { id: string } | null;
  refunded?: boolean;
}

// ---------- Stripe API ----------

// Stripe's form encoding: nested objects and arrays as a[b][0][c]=v.
export function formEncode(params: Record<string, unknown>): string {
  const out = new URLSearchParams();
  const add = (key: string, value: unknown) => {
    if (value === undefined || value === null) return;
    if (typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) add(`${key}[${k}]`, v);
    } else out.append(key, String(value));
  };
  for (const [k, v] of Object.entries(params)) add(k, v);
  return out.toString();
}

async function stripe<T>(method: 'GET' | 'POST', path: string, params?: Record<string, unknown>, idemKey?: string) {
  const headers: Record<string, string> = { Authorization: `Bearer ${secretKey()}` };
  if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idemKey) headers['Idempotency-Key'] = idemKey;
  const res = await fetch(`${API}${path}`, { method, headers, body: params ? formEncode(params) : undefined });
  const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
  if (!res.ok) {
    console.error(`Stripe ${method} ${path} → ${res.status}: ${data.error?.message ?? ''}`);
    throw new HttpError(res.status === 404 ? 404 : 502, 'The payment provider had a problem. Please try again.');
  }
  return data as T;
}

// ---------- webhook signature ----------

// Stripe-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">[,v1=…].
// Several v1 values appear while a secret is being rolled; any match counts.
export function verifyStripeSignature(
  rawBody: Buffer | string,
  header: string | undefined,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000)
): boolean {
  if (!header || !secret) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=', 2).map((s) => s.trim());
    if (k === 't') t = v;
    else if (k === 'v1' && v) sigs.push(v);
  }
  if (!/^\d+$/.test(t) || Math.abs(nowSec - Number(t)) > TOLERANCE_SEC) return false;
  const expected = createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, 'hex');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

// ---------- payments ----------

const idOf = (x: string | { id: string } | null | undefined) => (typeof x === 'string' ? x : (x?.id ?? null));

// A paid session → the event is paid (idempotent per PaymentIntent).
async function activateFromSession(session: Session) {
  const eventId = session.metadata?.event_id || session.client_reference_id;
  if (!eventId || session.payment_status !== 'paid') return null;
  const paymentIntent = idOf(session.payment_intent);
  const ev = await activateEvent(eventId, {
    provider: 'stripe',
    ref: paymentIntent ?? session.id,
    amount: session.amount_total ?? 0,
    currency: session.currency ?? EVENT_CURRENCY,
    raw: { session: session.id, paymentIntent, email: session.customer_details?.email ?? null },
  });
  if (!ev) console.error(`Stripe: paid session ${session.id} for unknown event ${eventId}`);
  return ev;
}

async function checkout(req: Req, res: Res) {
  if (checkoutLimited(clientIp(req))) throw new HttpError(429, 'Too many attempts, try again later.');
  let request: ReturnType<typeof checkEventRequest>;
  try {
    request = checkEventRequest(await readJson(req, 8192));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, (err as Error).message);
  }
  const ev = createPendingEvent(request, 'stripe');
  const params: Record<string, unknown> = {
    mode: 'payment',
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: EVENT_CURRENCY,
          unit_amount: EVENT_PRICE_CENTS,
          product_data: { name: `Photo booth gallery — ${ev.name}` },
        },
      },
    ],
    customer_email: request.email,
    client_reference_id: ev.id,
    metadata: { event_id: ev.id },
    payment_intent_data: { metadata: { event_id: ev.id } },
    invoice_creation: { enabled: true }, // hosts may need an invoice
    success_url: `${publicUrl()}/event.html?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${publicUrl()}/event.html?cancelled=1`,
  };
  if (process.env.STRIPE_AUTOMATIC_TAX === '1') {
    params.automatic_tax = { enabled: true };
    // The advertised price is what the host pays: VAT is included in it.
    (params.line_items as { price_data: Record<string, unknown> }[])[0].price_data.tax_behavior = 'inclusive';
  }
  const session = await stripe<Session>('POST', '/checkout/sessions', params, `checkout-${ev.id}`).catch(
    async (err: unknown) => {
      await deleteEvent(ev.id); // no checkout, so no use for the pending event
      throw err;
    }
  );
  sendJson(res, 200, { url: session.url });
}

async function status(req: Req, res: Res, url: URL) {
  if (statusLimited(clientIp(req))) throw new HttpError(429, 'Too many requests, try again later.');
  const id = url.searchParams.get('session') ?? '';
  if (!SESSION_ID.test(id)) throw new HttpError(400, 'Bad session id.');
  // Ask Stripe, not the webhook's result: the page may be faster than it.
  const session = await stripe<Session>('GET', `/checkout/sessions/${id}`);
  const ev = await activateFromSession(session);
  if (!ev?.paid || ev.status !== 'active') return sendJson(res, 200, { paid: false });
  sendJson(res, 200, { paid: true, eventName: ev.name, setupLink: setupLink(ev), galleryLink: galleryLink(ev) });
}

async function webhook(req: Req, res: Res) {
  const raw = await readBody(req, 1024 * 1024);
  const sig = req.headers['stripe-signature'];
  if (!verifyStripeSignature(raw, Array.isArray(sig) ? sig[0] : sig, webhookSecret())) {
    return sendJson(res, 400, { error: 'Bad signature.' });
  }
  const event = JSON.parse(raw.toString('utf8')) as { type?: string; data?: { object?: unknown } };
  const object = event.data?.object;
  switch (event.type) {
    // completed = paid now (card) or later (bank debit → async_payment_succeeded).
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      await activateFromSession(object as Session);
      break;
    case 'charge.refunded': {
      // Only a full refund ends the perks; a partial one is a goodwill gesture.
      const charge = object as Charge;
      const ref = idOf(charge.payment_intent);
      if (charge.refunded && ref) refundPayment(ref);
      break;
    }
  }
  sendJson(res, 200, { received: true });
}

// Returns true when it handled the request.
export async function stripeRoutes(req: Req, res: Res, url: URL): Promise<boolean> {
  const { pathname } = url;
  if (pathname === '/api/checkout/price' && req.method === 'GET') {
    sendJson(res, 200, { amount: EVENT_PRICE_CENTS, currency: EVENT_CURRENCY, enabled: !!secretKey() });
    return true;
  }
  const routes: Record<string, (() => Promise<void>) | undefined> = {
    'POST /api/checkout': () => checkout(req, res),
    'GET /api/checkout/status': () => status(req, res, url),
    'POST /api/stripe/webhook': () => webhook(req, res),
  };
  const handler = routes[`${req.method} ${pathname}`];
  if (!handler) return false;
  if (!secretKey() || (pathname === '/api/stripe/webhook' && !webhookSecret())) {
    sendJson(res, 503, { error: "Payments aren't set up on this server." });
    return true;
  }
  await handler();
  return true;
}
