// Paid events: the lifecycle shared by every way to get one.
//
//   createPendingEvent()  host fills in name + email; event exists, unpaid
//   activateEvent()       payment confirmed (Stripe webhook, Apple
//                         transaction, or a comp from /admin): mark it paid,
//                         record the payment once, email the links
//
// The payment providers (stripe.ts, apple.ts) only verify payments and call
// activateEvent(); they never touch events directly.
//
// Config (env):
//   PUBLIC_URL / BASE_URL  origin used in the emailed links
//   EVENT_PRICE_CENTS      web price per event in cents (default 1900)
//   EVENT_CURRENCY         ISO currency (default eur)

import { db } from './db.ts';
import { env, envNumber } from './env.ts';
import { createEvent, getEvent, type StoredEvent, updateEvent } from './events.ts';
import { escapeHtml } from './http.ts';
import { sendMail } from './mail.ts';
import { PAID_RETENTION_DAYS } from './photos.ts';

export const EVENT_PRICE_CENTS = envNumber('EVENT_PRICE_CENTS', 1900);
export const EVENT_CURRENCY = env('EVENT_CURRENCY', 'eur').toLowerCase();

const publicUrl = () =>
  (process.env.PUBLIC_URL || process.env.BASE_URL || 'https://boot.small-victories.co').replace(/\/+$/, '');

export const setupLink = (ev: Pick<StoredEvent, 'id' | 'setupKey'>) =>
  `${publicUrl()}/settings.html#event=${ev.id}.${ev.setupKey}`;
export const galleryLink = (ev: Pick<StoredEvent, 'id' | 'galleryKey'>) => `${publicUrl()}/g/${ev.id}/${ev.galleryKey}`;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface EventRequest {
  name: string;
  email: string;
  eventDate?: string | null;
}

// Validates what a host typed. Throws with a message fit for the form.
export function checkEventRequest(body: unknown): EventRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  const name = String(b.name ?? '').trim();
  const email = String(b.email ?? '')
    .trim()
    .toLowerCase();
  const eventDate = b.eventDate ? String(b.eventDate).slice(0, 10) : null;
  if (!name || name.length > 120) throw new Error('Give the event a name (up to 120 characters).');
  if (!EMAIL.test(email) || email.length > 200) throw new Error('That email address looks wrong.');
  if (eventDate && !/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new Error('Pick a valid date.');
  return { name, email, eventDate };
}

export function createPendingEvent(req: EventRequest, source: 'stripe' | 'apple'): StoredEvent {
  return createEvent({ ...req, status: 'pending', paid: false, source });
}

export interface PaymentRecord {
  provider: 'stripe' | 'apple' | 'comp';
  ref: string; // checkout session id / Apple transaction id; unique
  amount: number; // cents
  currency: string;
  raw?: unknown;
}

// Idempotent per payment ref: a webhook retry or a second redeem of the same
// Apple transaction doesn't activate or email twice. Returns the event, or
// null when it doesn't exist.
export async function activateEvent(
  eventId: string,
  payment: PaymentRecord,
  { email = true }: { email?: boolean } = {}
): Promise<StoredEvent | null> {
  const ev = getEvent(eventId);
  if (!ev) return null;
  const inserted = db
    .prepare(
      `INSERT OR IGNORE INTO payments (event_id, provider, ref, amount, currency, status, created, raw)
       VALUES (?, ?, ?, ?, ?, 'paid', ?, ?)`
    )
    .run(
      ev.id,
      payment.provider,
      payment.ref,
      payment.amount,
      payment.currency,
      new Date().toISOString(),
      payment.raw === undefined ? null : JSON.stringify(payment.raw)
    );
  if (Number(inserted.changes) === 0) return getEvent(eventId); // seen this payment before
  updateEvent(ev.id, { status: 'active', paid: true, retentionDays: ev.retentionDays ?? PAID_RETENTION_DAYS });
  const active = getEvent(ev.id) as StoredEvent;
  if (email && active.email) await sendEventEmail(active).catch((err) => console.error('Event email failed', err));
  return active;
}

// A refund (Stripe / Apple notification): keep the photos, end the paid perks.
export function refundPayment(ref: string) {
  const row = db.prepare('SELECT event_id FROM payments WHERE ref = ?').get(ref) as
    | { event_id: string | null }
    | undefined;
  db.prepare("UPDATE payments SET status = 'refunded' WHERE ref = ?").run(ref);
  if (row?.event_id) updateEvent(row.event_id, { paid: false });
}

// Owner gives an event away from /admin.
export async function compEvent(req: EventRequest & { sendEmail?: boolean }): Promise<StoredEvent> {
  const ev = createEvent({ ...req, email: req.email || null, status: 'pending', paid: false, source: 'comp' });
  const ref = `comp-${ev.id}`;
  const active = await activateEvent(
    ev.id,
    { provider: 'comp', ref, amount: 0, currency: EVENT_CURRENCY },
    { email: req.sendEmail ?? true }
  );
  return active as StoredEvent;
}

export async function sendEventEmail(ev: StoredEvent): Promise<void> {
  if (!ev.email) throw new Error('This event has no email address.');
  const setup = setupLink(ev);
  const gallery = galleryLink(ev);
  const name = escapeHtml(ev.name);
  await sendMail({
    to: { email: ev.email },
    subject: `Your photo booth for ${ev.name} is ready`,
    text: `Your photo booth event "${ev.name}" is ready.

1. Set up the booth: open this link on the iPad or laptop you'll use as the booth (open it on every booth if you have more than one):
${setup}

2. Your photo gallery: every photo guests share shows up here, with a download of all of them. Keep this link private; share it with whoever should get the photos:
${gallery}

Photos are kept for ${ev.retentionDays ?? PAID_RETENTION_DAYS} days after they're taken.

Have a great party!
Photoboot — ${publicUrl()}`,
    html: `<div style="font:16px/1.5 -apple-system,system-ui,sans-serif;max-width:560px">
<h1 style="font-size:22px">Your photo booth for ${name} is ready 📸</h1>
<p><strong>1. Set up the booth.</strong> Open this link on the iPad or laptop you'll use as the booth (on every booth, if you have more than one):</p>
<p><a href="${escapeHtml(setup)}" style="display:inline-block;background:#1f9e6e;color:#000;padding:12px 20px;border-radius:999px;text-decoration:none;font-weight:600">Set up the booth</a></p>
<p><strong>2. Your photo gallery.</strong> Every photo guests share shows up here, with a download of all of them. Keep this link private; share it with whoever should get the photos:</p>
<p><a href="${escapeHtml(gallery)}">${escapeHtml(gallery)}</a></p>
<p style="color:#666">Photos are kept for ${ev.retentionDays ?? PAID_RETENTION_DAYS} days after they're taken.</p>
</div>`,
  });
}
