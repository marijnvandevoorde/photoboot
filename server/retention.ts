// Storage limitation: the hourly job that deletes what we no longer need.
// docs/gdpr.md lists these periods; privacy.html promises them.
//
//   photos          SHARE_TTL_DAYS after they were taken, or the paid event's
//                   retention (photos.ts cleanup)
//   pending events  never paid (abandoned checkout): PENDING_DAYS after they
//                   were created, with the email address
//   events          once their photos are gone and EVENT_GRACE_DAYS have
//                   passed after the retention period, counted from the
//                   latest of created, updated (a booth saved its setup) and
//                   the event date; events kept forever (retention 0) stay
//   payments        accounting records: kept until the end of the 7th
//                   calendar year after the payment (Belgian accounting law),
//                   then deleted
//   admin sessions  once expired

import { db } from './db.ts';
import { deleteEvent, retentionOf } from './events.ts';
import { cleanup as cleanupPhotos, countPhotos } from './photos.ts';

const DAY_MS = 86_400_000;
const INTERVAL_MS = 60 * 60 * 1000;
export const PENDING_DAYS = 30; // long enough for a bank debit or Ask to Buy
export const EVENT_GRACE_DAYS = 30;
export const PAYMENT_YEARS = 7;

const daysAgo = (days: number, now: number) => new Date(now - days * DAY_MS).toISOString();

// Payments made before this date may go: 1 January, PAYMENT_YEARS + 1 years
// back, i.e. the 7 years after the year of the payment have all passed.
export function paymentCutoff(now = Date.now()): string {
  return new Date(Date.UTC(new Date(now).getUTCFullYear() - PAYMENT_YEARS, 0, 1)).toISOString();
}

export interface RetentionResult {
  photos: number;
  pendingEvents: number;
  events: number;
  payments: number;
}

export async function runRetention(now = Date.now()): Promise<RetentionResult> {
  const photos = await cleanupPhotos();

  const pending = await db.all<{ id: string }>(
    "SELECT id FROM events WHERE status = 'pending' AND created < ?",
    daysAgo(PENDING_DAYS, now)
  );
  for (const { id } of pending) await deleteEvent(id);

  let events = 0;
  const active = await db.all<{
    id: string;
    paid: number;
    retention_days: number | null;
    created: string;
    updated: string;
    event_date: string | null;
  }>("SELECT id, paid, retention_days, created, updated, event_date FROM events WHERE status = 'active'");
  for (const ev of active) {
    const days = retentionOf({ paid: Number(ev.paid) === 1, retentionDays: ev.retention_days });
    if (days <= 0) continue; // kept forever
    const latest = Math.max(
      Date.parse(ev.created) || 0,
      Date.parse(ev.updated) || 0,
      (ev.event_date && Date.parse(ev.event_date)) || 0
    );
    if (latest + (days + EVENT_GRACE_DAYS) * DAY_MS > now) continue;
    if ((await countPhotos(ev.id)) > 0) continue; // still in use: wait for its photos to expire
    await deleteEvent(ev.id);
    events++;
  }

  const payments = await db.run('DELETE FROM payments WHERE created < ?', paymentCutoff(now));
  await db.run('DELETE FROM admin_sessions WHERE expires < ?', new Date(now).toISOString());

  const result = { photos, pendingEvents: pending.length, events, payments: payments.changes };
  if (result.pendingEvents || result.events || result.payments) {
    console.log(
      `photoboot: retention removed ${result.pendingEvents} unpaid event(s), ${result.events} expired event(s), ${result.payments} old payment record(s)`
    );
  }
  return result;
}

// Runs in whichever process loads this module (prod server or Vite dev).
const run = () => runRetention().catch((err) => console.error('retention job failed', err));
run();
setInterval(run, INTERVAL_MS).unref();
