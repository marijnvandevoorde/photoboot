import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The real app with Stripe keys set, and a fake api.stripe.com: fetch is
// stubbed for Stripe's host only, so the tests' own requests still reach
// the server. Env is read at import, so set it first.
let dir: string;
let server: Server;
let base: string;
let stripeMod: typeof import('../server/stripe.ts');
let getEvent: typeof import('../server/events.ts').getEvent;
let outbox: typeof import('../server/mail.ts').outbox;
const realFetch = globalThis.fetch;

const SECRET = 'whsec_test_secret';

interface StripeCall {
  method: string;
  path: string;
  form: URLSearchParams;
  headers: Record<string, string>;
}
const calls: StripeCall[] = [];
const sessions = new Map<string, Record<string, unknown>>(); // what Stripe would return
let nextSession = 0;

function fakeStripe(url: string, init: RequestInit = {}): Response {
  const method = init.method ?? 'GET';
  const { pathname } = new URL(url);
  const form = new URLSearchParams(String(init.body ?? ''));
  calls.push({ method, path: pathname, form, headers: init.headers as Record<string, string> });
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (method === 'POST' && pathname === '/v1/checkout/sessions') {
    const id = `cs_test_${String(++nextSession).padStart(12, '0')}`;
    const session = {
      id,
      url: `https://checkout.stripe.com/c/pay/${id}`,
      payment_status: 'unpaid',
      payment_intent: null,
      amount_total: Number(form.get('line_items[0][price_data][unit_amount]')),
      currency: form.get('line_items[0][price_data][currency]'),
      client_reference_id: form.get('client_reference_id'),
      metadata: { event_id: form.get('metadata[event_id]') },
    };
    sessions.set(id, session);
    return reply(200, session);
  }
  const get = pathname.match(/^\/v1\/checkout\/sessions\/(cs_\w+)$/);
  if (method === 'GET' && get) {
    const session = sessions.get(get[1]);
    return session ? reply(200, session) : reply(404, { error: { message: 'No such checkout.session' } });
  }
  return reply(400, { error: { message: `Unexpected ${method} ${pathname}` } });
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'photoboot-stripe-'));
  process.env.SHARE_DIR = path.join(dir, 'shares');
  process.env.EVENTS_DIR = path.join(dir, 'events');
  process.env.PUBLIC_URL = 'https://booth.test';
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  delete process.env.STRIPE_AUTOMATIC_TAX;
  delete process.env.BASE_URL;
  delete process.env.BREVO_API_KEY;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith('https://api.stripe.com/') ? fakeStripe(url, init) : realFetch(input, init);
  }) as typeof fetch;
  const { createApp } = await import('../server/index.ts');
  stripeMod = await import('../server/stripe.ts');
  ({ getEvent } = await import('../server/events.ts'));
  ({ outbox } = await import('../server/mail.ts'));
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const sign = (body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

async function webhook(event: unknown, signature?: string) {
  const body = JSON.stringify(event);
  return fetch(`${base}/api/stripe/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signature ?? sign(body) },
    body,
  });
}

async function startCheckout(name = 'Anna & Tom', email = 'host@example.com') {
  const res = await fetch(`${base}/api/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, eventDate: '2026-12-31' }),
  });
  expect(res.status).toBe(200);
  const { url } = (await res.json()) as { url: string };
  const call = calls[calls.length - 1];
  const session = sessions.get(url.split('/').pop() ?? '') as Record<string, unknown>;
  return { url, call, session, eventId: call.form.get('metadata[event_id]') as string };
}

// Stripe marks the session paid (card payment) and sends the webhook.
function pay(session: Record<string, unknown>, paymentIntent: string) {
  Object.assign(session, { payment_status: 'paid', payment_intent: paymentIntent });
  return { id: `evt_${paymentIntent}`, type: 'checkout.session.completed', data: { object: session } };
}

const status = async (session: string) => (await fetch(`${base}/api/checkout/status?session=${session}`)).json();

// ---------- signature ----------

describe('webhook signature', () => {
  const body = '{"id":"evt_1"}';
  const now = 1_800_000_000;

  it('accepts a valid signature', () => {
    expect(stripeMod.verifyStripeSignature(body, sign(body, SECRET, now), SECRET, now)).toBe(true);
    expect(stripeMod.verifyStripeSignature(Buffer.from(body), sign(body, SECRET, now), SECRET, now + 60)).toBe(true);
  });

  it('refuses a wrong secret, a changed body or a missing header', () => {
    expect(stripeMod.verifyStripeSignature(body, sign(body, 'whsec_other', now), SECRET, now)).toBe(false);
    expect(stripeMod.verifyStripeSignature(`${body} `, sign(body, SECRET, now), SECRET, now)).toBe(false);
    expect(stripeMod.verifyStripeSignature(body, undefined, SECRET, now)).toBe(false);
    expect(stripeMod.verifyStripeSignature(body, 'v1=abc', SECRET, now)).toBe(false);
  });

  it('refuses a stale timestamp', () => {
    expect(stripeMod.verifyStripeSignature(body, sign(body, SECRET, now - 301), SECRET, now)).toBe(false);
  });

  it('accepts any of several v1 signatures', () => {
    const good = sign(body, SECRET, now).split(',v1=')[1];
    const header = `t=${now},v1=${'0'.repeat(64)},v0=whatever,v1=${good}`;
    expect(stripeMod.verifyStripeSignature(body, header, SECRET, now)).toBe(true);
  });

  it('form-encodes nested params the way Stripe expects', () => {
    expect(decodeURIComponent(stripeMod.formEncode({ a: [{ b: { c: 1 } }], d: 'x', e: undefined }))).toBe(
      'a[0][b][c]=1&d=x'
    );
  });
});

// ---------- checkout ----------

describe('checkout', () => {
  it('shows the price', async () => {
    expect(await (await fetch(`${base}/api/checkout/price`)).json()).toEqual({
      amount: 1900,
      currency: 'eur',
      enabled: true,
    });
  });

  it('creates a pending event and a Checkout Session for it', async () => {
    const { url, call, eventId } = await startCheckout();
    expect(url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    expect(call.method).toBe('POST');
    expect(call.path).toBe('/v1/checkout/sessions');
    expect(call.headers.Authorization).toBe('Bearer sk_test_fake');
    expect(Object.fromEntries(call.form)).toMatchObject({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': '1900',
      'line_items[0][price_data][product_data][name]': 'Photo booth gallery — Anna & Tom',
      customer_email: 'host@example.com',
      client_reference_id: eventId,
      'metadata[event_id]': eventId,
      'invoice_creation[enabled]': 'true',
      success_url: 'https://booth.test/event.html?session={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://booth.test/event.html?cancelled=1',
    });
    expect(call.form.has('automatic_tax[enabled]')).toBe(false);
    expect(getEvent(eventId)).toMatchObject({
      name: 'Anna & Tom',
      email: 'host@example.com',
      eventDate: '2026-12-31',
      status: 'pending',
      paid: false,
      source: 'stripe',
    });
  });

  it('turns on Stripe Tax when asked', async () => {
    process.env.STRIPE_AUTOMATIC_TAX = '1';
    try {
      const { call } = await startCheckout('Taxed');
      expect(call.form.get('automatic_tax[enabled]')).toBe('true');
      expect(call.form.get('line_items[0][price_data][tax_behavior]')).toBe('inclusive');
    } finally {
      delete process.env.STRIPE_AUTOMATIC_TAX;
    }
  });

  it('refuses a bad form with the reason', async () => {
    const res = await fetch(`${base}/api/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Party', email: 'nope' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/email/);
  });

  it('answers 503 when the server has no Stripe key', async () => {
    delete process.env.STRIPE_SECRET_KEY;
    try {
      const res = await fetch(`${base}/api/checkout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Party', email: 'a@b.co' }),
      });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("Payments aren't set up on this server.");
      expect((await (await fetch(`${base}/api/checkout/price`)).json()).enabled).toBe(false);
    } finally {
      process.env.STRIPE_SECRET_KEY = 'sk_test_fake';
    }
  });
});

// ---------- webhook ----------

describe('webhook', () => {
  it('activates the event on a paid session, and emails once even when delivered twice', async () => {
    const { session, eventId } = await startCheckout('Webhook party', 'webhook@example.com');
    const before = outbox.length;
    const event = pay(session, 'pi_webhook_1');
    expect((await webhook(event)).status).toBe(200);
    expect((await webhook(event)).status).toBe(200); // Stripe retries
    expect(getEvent(eventId)).toMatchObject({ status: 'active', paid: true, retentionDays: 365 });
    const mails = outbox.slice(before);
    expect(mails).toHaveLength(1);
    expect(mails[0].to.email).toBe('webhook@example.com');
    expect(mails[0].text).toContain(`https://booth.test/settings.html#event=${eventId}.`);
  });

  it('waits for an async payment (bank debit) to succeed', async () => {
    const { session, eventId } = await startCheckout('Bank party');
    const pending = { ...session, payment_status: 'unpaid', payment_intent: 'pi_async_1' };
    await webhook({ type: 'checkout.session.completed', data: { object: pending } });
    expect(getEvent(eventId)?.paid).toBe(false);
    const paid = { ...pending, payment_status: 'paid' };
    expect((await webhook({ type: 'checkout.session.async_payment_succeeded', data: { object: paid } })).status).toBe(
      200
    );
    expect(getEvent(eventId)?.paid).toBe(true);
  });

  it('refuses a bad signature', async () => {
    const { session, eventId } = await startCheckout('Forged');
    const event = pay(session, 'pi_forged');
    expect((await webhook(event, sign(JSON.stringify(event), 'whsec_wrong'))).status).toBe(400);
    expect((await webhook(event, 'garbage')).status).toBe(400);
    expect(getEvent(eventId)?.paid).toBe(false);
  });

  it('ends the paid perks on a full refund', async () => {
    const { session, eventId } = await startCheckout('Refunded');
    await webhook(pay(session, 'pi_refund_1'));
    expect(getEvent(eventId)?.paid).toBe(true);
    const charge = (refunded: boolean) => ({
      type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_refund_1', refunded } },
    });
    await webhook(charge(false)); // partial refund: keep it
    expect(getEvent(eventId)?.paid).toBe(true);
    expect((await webhook(charge(true))).status).toBe(200);
    expect(getEvent(eventId)?.paid).toBe(false);
  });

  it('acknowledges event types it does not handle', async () => {
    expect((await webhook({ type: 'customer.created', data: { object: {} } })).status).toBe(200);
  });
});

// ---------- status ----------

describe('checkout status', () => {
  it('reveals the links only once the session is paid', async () => {
    const { session, eventId } = await startCheckout('Status party', 'status@example.com');
    const id = session.id as string;
    expect(await status(id)).toEqual({ paid: false });

    // Paid at Stripe, webhook not here yet: the status call activates it.
    const before = outbox.length;
    Object.assign(session, { payment_status: 'paid', payment_intent: 'pi_status_1' });
    const paid = await status(id);
    expect(paid).toMatchObject({ paid: true, eventName: 'Status party' });
    expect(paid.setupLink).toMatch(new RegExp(`^https://booth\\.test/settings\\.html#event=${eventId}\\.`));
    expect(paid.galleryLink).toMatch(new RegExp(`^https://booth\\.test/g/${eventId}/`));

    // The webhook arriving afterwards doesn't email again.
    await webhook({ type: 'checkout.session.completed', data: { object: session } });
    expect(outbox.length).toBe(before + 1);
  });

  it('refuses a malformed or unknown session', async () => {
    expect((await fetch(`${base}/api/checkout/status?session=nope`)).status).toBe(400);
    expect((await fetch(`${base}/api/checkout/status?session=cs_test_unknown12345`)).status).toBe(404);
  });
});
