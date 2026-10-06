import { randomUUID, sign, X509Certificate } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

// Apple in-app purchase (server/apple.ts) against throwaway certificate
// chains (test/fixtures/apple, made with make.sh) shaped like StoreKit's.
// The real server runs on a random port with its database in a temp folder.

const FIXTURES = path.join(import.meta.dirname, 'fixtures', 'apple');
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');
const der = (name: string) =>
  fixture(name)
    .replace(/-----[A-Z ]+-----/g, '')
    .replace(/\s+/g, '');

const BUNDLE = 'co.smallvictories.photoboot';
const PRODUCT = 'co.smallvictories.photoboot.eventgallery';

let dir: string;
let server: Server;
let base: string;
let apple: typeof import('../server/apple.ts');
let db: typeof import('../server/db.ts').db;
let outbox: typeof import('../server/mail.ts').outbox;
let getEvent: typeof import('../server/events.ts').getEvent;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'photoboot-apple-'));
  process.env.SHARE_DIR = path.join(dir, 'shares');
  process.env.EVENTS_DIR = path.join(dir, 'events');
  process.env.PUBLIC_URL = 'https://booth.test';
  delete process.env.BREVO_API_KEY;
  delete process.env.APPLE_ALLOW_SANDBOX;
  // A database from before the Apple migration (user_version 1, no
  // apple_tokens): opening it must upgrade it in place.
  mkdirSync(process.env.EVENTS_DIR, { recursive: true });
  const old = new DatabaseSync(path.join(process.env.EVENTS_DIR, 'photoboot.db'));
  old.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL); PRAGMA user_version = 1;');
  old.close();

  const { createApp } = await import('../server/index.ts');
  apple = await import('../server/apple.ts');
  ({ db } = await import('../server/db.ts'));
  ({ outbox } = await import('../server/mail.ts'));
  ({ getEvent } = await import('../server/events.ts'));
  trustTestRoot();
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

afterEach(() => trustTestRoot());

function trustTestRoot(extra: Parameters<typeof apple.configureApple>[0] = {}) {
  apple.configureApple({ rootPems: [fixture('root.pem')], ...extra });
}

// ---------- signing like the App Store ----------

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

interface SignOptions {
  chain?: [string, string, string];
  key?: string;
  header?: Record<string, unknown>;
}

function signJws(
  payload: unknown,
  { chain = ['leaf.pem', 'intermediate.pem', 'root.pem'], key = 'leaf.key', header = {} }: SignOptions = {}
) {
  const head = b64url({ alg: 'ES256', x5c: chain.map(der), ...header });
  const body = b64url(payload);
  const sig = sign('sha256', Buffer.from(`${head}.${body}`), { key: fixture(key), dsaEncoding: 'ieee-p1363' });
  return `${head}.${body}.${sig.toString('base64url')}`;
}

let nextId = 2000000000;
function transaction(overrides: Record<string, unknown> = {}) {
  const id = String(nextId++);
  return {
    transactionId: id,
    originalTransactionId: id,
    bundleId: BUNDLE,
    productId: PRODUCT,
    type: 'Consumable',
    environment: 'Sandbox',
    appAccountToken: randomUUID(),
    purchaseDate: Date.now(),
    signedDate: Date.now(),
    quantity: 1,
    storefront: 'BEL',
    price: 19990,
    currency: 'EUR',
    inAppOwnershipType: 'PURCHASED',
    ...overrides,
  };
}

const json = { 'Content-Type': 'application/json' };
const post = (route: string, body: unknown) =>
  fetch(`${base}/api/apple/${route}`, { method: 'POST', headers: json, body: JSON.stringify(body) });

async function startEvent(name = 'Garden party') {
  const res = await post('start', { name, email: 'host@example.com', eventDate: '2026-12-31' });
  expect(res.status).toBe(201);
  return (await res.json()) as { eventId: string; appAccountToken: string };
}

function notification(type: string, signedTransactionInfo: string, data: Record<string, unknown> = {}) {
  return signJws({
    notificationType: type,
    notificationUUID: randomUUID(),
    version: '2.0',
    signedDate: Date.now(),
    data: { bundleId: BUNDLE, environment: 'Sandbox', signedTransactionInfo, ...data },
  });
}

// ---------- verification ----------

describe('JWS verification', () => {
  it('accepts a valid transaction', () => {
    const tx = transaction();
    const verified = apple.verifyTransaction(signJws(tx));
    expect(verified).toMatchObject({
      transactionId: tx.transactionId,
      productId: PRODUCT,
      appAccountToken: tx.appAccountToken,
      price: 19990,
      currency: 'EUR',
    });
  });

  it('rejects a tampered payload', () => {
    const [head, , sig] = signJws(transaction()).split('.');
    const forged = `${head}.${b64url(transaction({ price: 1 }))}.${sig}`;
    expect(() => apple.verifyTransaction(forged)).toThrow(/Bad signature/);
  });

  it('rejects a chain to another root', () => {
    const evil = signJws(transaction(), {
      chain: ['evil-leaf.pem', 'evil-intermediate.pem', 'evil-root.pem'],
      key: 'evil-leaf.key',
    });
    expect(() => apple.verifyTransaction(evil)).toThrow(/trusted root/);
  });

  it('rejects a chain that only claims the trusted root', () => {
    const mixed = signJws(transaction(), {
      chain: ['evil-leaf.pem', 'evil-intermediate.pem', 'root.pem'],
      key: 'evil-leaf.key',
    });
    expect(() => apple.verifyTransaction(mixed)).toThrow(/Broken certificate chain/);
  });

  it('rejects a signature by another key than the leaf', () => {
    expect(() => apple.verifyTransaction(signJws(transaction(), { key: 'evil-leaf.key' }))).toThrow(/Bad signature/);
  });

  it('rejects expired and not-yet-valid certificates', () => {
    const jws = signJws(transaction());
    trustTestRoot({ now: () => new Date('2200-01-01') });
    expect(() => apple.verifyTransaction(jws)).toThrow(/validity period/);
    trustTestRoot({ now: () => new Date('2000-01-01') });
    expect(() => apple.verifyTransaction(jws)).toThrow(/validity period/);
  });

  it('rejects a leaf without the App Store extension', () => {
    const jws = signJws(transaction(), {
      chain: ['plain-leaf.pem', 'intermediate.pem', 'root.pem'],
      key: 'plain-leaf.key',
    });
    expect(() => apple.verifyTransaction(jws)).toThrow(/App Store signing certificate/);
  });

  it('rejects malformed tokens and other algorithms', () => {
    expect(() => apple.verifyTransaction('nope')).toThrow(/Malformed/);
    expect(() => apple.verifyTransaction(undefined)).toThrow(/Missing/);
    expect(() => apple.verifyTransaction(signJws(transaction(), { header: { alg: 'none' } }))).toThrow(/algorithm/);
    expect(() => apple.verifyTransaction(signJws(transaction(), { header: { x5c: [der('leaf.pem')] } }))).toThrow(
      /chain of three/
    );
  });

  it('checks bundle, product, type, environment and refunds', () => {
    const check = (o: Record<string, unknown>) => () => apple.verifyTransaction(signJws(transaction(o)));
    expect(check({ bundleId: 'com.example.other' })).toThrow(/another app/);
    expect(check({ productId: 'co.smallvictories.photoboot.other' })).toThrow(/another product/);
    expect(check({ type: 'Non-Consumable' })).toThrow(/not a consumable/);
    expect(check({ environment: 'Xcode' })).toThrow(/aren't accepted/);
    expect(check({ revocationDate: Date.now() })).toThrow(/refunded/);
    expect(check({ environment: 'Production' })).not.toThrow();
    trustTestRoot({ allowSandbox: false });
    expect(check({ environment: 'Sandbox' })).toThrow(/aren't accepted/);
    expect(check({ environment: 'Production' })).not.toThrow();
  });

  it('pins the real Apple Root CA - G3 by default', () => {
    expect(apple.APPLE_ROOT_G3_PEM).toMatch(/^-----BEGIN CERTIFICATE-----/);
    apple.configureApple();
    // The committed PEM is the root the code expects…
    const real = new X509Certificate(apple.APPLE_ROOT_G3_PEM);
    expect(real.fingerprint256).toBe(apple.APPLE_ROOT_G3_SHA256);
    expect(real.subject).toMatch(/CN=Apple Root CA - G3/);
    expect(real.ca).toBe(true);
    // …and without injection, our test chain isn't trusted.
    expect(() => apple.verifyTransaction(signJws(transaction()))).toThrow(/trusted root/);
  });
});

// ---------- routes ----------

describe('purchase flow', () => {
  it('upgraded the old database', () => {
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(2);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'apple_tokens'").get()).toBeTruthy();
  });

  it('validates the host form', async () => {
    const res = await post('start', { name: '', email: 'host@example.com' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/name/);
    expect((await fetch(`${base}/api/apple/start`)).status).toBe(405);
  });

  it('start → redeem activates the event and emails once', async () => {
    const { eventId, appAccountToken } = await startEvent('Garden party');
    expect(appAccountToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(getEvent(eventId)).toMatchObject({ status: 'pending', paid: false, source: 'apple' });

    const tx = transaction({ appAccountToken: appAccountToken.toUpperCase() }); // StoreKit sends upper case
    const jws = signJws(tx);
    const mails = outbox.length;
    const first = await post('redeem', { eventId, jws });
    expect(first.status).toBe(200);
    const links = await first.json();
    expect(links).toMatchObject({ eventId, eventName: 'Garden party' });
    expect(links.setupLink).toMatch(new RegExp(`^https://booth\\.test/settings\\.html#event=${eventId}\\.[\\w-]+$`));
    expect(links.galleryLink).toMatch(new RegExp(`^https://booth\\.test/g/${eventId}/[\\w-]+$`));
    expect(getEvent(eventId)).toMatchObject({ status: 'active', paid: true });

    // A second redeem (app retry, restore) gives the same links, no new mail.
    const again = await post('redeem', { jws });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(links);
    expect(outbox.length).toBe(mails + 1);
    expect(outbox.at(-1)?.text).toContain(links.galleryLink);

    const payments = db.prepare('SELECT * FROM payments WHERE event_id = ?').all(eventId) as {
      provider: string;
      ref: string;
      amount: number;
      currency: string;
      raw: string;
    }[];
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ provider: 'apple', ref: tx.transactionId, amount: 1999, currency: 'eur' });
    expect(JSON.parse(payments[0].raw)).toMatchObject({ environment: 'Sandbox', storefront: 'BEL' });
  });

  it('refuses a purchase made for another event or no event', async () => {
    const a = await startEvent('A');
    const b = await startEvent('B');
    const jws = signJws(transaction({ appAccountToken: a.appAccountToken }));
    const wrong = await post('redeem', { eventId: b.eventId, jws });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toMatch(/another event/);
    expect(getEvent(b.eventId)?.paid).toBe(false);

    const unknown = await post('redeem', { jws: signJws(transaction()) });
    expect(unknown.status).toBe(404);
    const none = await post('redeem', { jws: signJws(transaction({ appAccountToken: undefined })) });
    expect(none.status).toBe(404);
    expect(getEvent(a.eventId)?.paid).toBe(false);
  });

  it('refuses a forged transaction', async () => {
    const { eventId, appAccountToken } = await startEvent();
    const evil = signJws(transaction({ appAccountToken }), {
      chain: ['evil-leaf.pem', 'evil-intermediate.pem', 'evil-root.pem'],
      key: 'evil-leaf.key',
    });
    const res = await post('redeem', { eventId, jws: evil });
    expect(res.status).toBe(400);
    expect(getEvent(eventId)?.paid).toBe(false);
  });
});

describe('server notifications', () => {
  it('a refund un-pays the event', async () => {
    const { eventId, appAccountToken } = await startEvent('Refunded party');
    const tx = transaction({ appAccountToken });
    expect((await post('redeem', { eventId, jws: signJws(tx) })).status).toBe(200);
    expect(getEvent(eventId)?.paid).toBe(true);

    const refunded = signJws({ ...tx, revocationDate: Date.now(), revocationReason: 0 });
    const res = await post('notifications', { signedPayload: notification('REFUND', refunded) });
    expect(res.status).toBe(200);
    expect(getEvent(eventId)?.paid).toBe(false);
    expect(db.prepare('SELECT status FROM payments WHERE ref = ?').get(tx.transactionId)).toEqual({
      status: 'refunded',
    });
    // Redeeming the old (pre-refund) JWS again doesn't bring it back.
    expect((await post('redeem', { eventId, jws: signJws(tx) })).status).toBe(409);
    expect(getEvent(eventId)?.paid).toBe(false);
  });

  it('ONE_TIME_CHARGE activates an event the app never redeemed', async () => {
    const { eventId, appAccountToken } = await startEvent('Closed app');
    const tx = signJws(transaction({ appAccountToken, environment: 'Production' }));
    const res = await post('notifications', {
      signedPayload: notification('ONE_TIME_CHARGE', tx, { environment: 'Production' }),
    });
    expect(res.status).toBe(200);
    expect(getEvent(eventId)).toMatchObject({ status: 'active', paid: true });
  });

  it('answers 200 to types it ignores and 400 to bad signatures', async () => {
    const ok = await post('notifications', { signedPayload: notification('TEST', signJws(transaction())) });
    expect(ok.status).toBe(200);
    expect((await ok.json()).ignored).toBe('TEST');

    const otherProduct = signJws(transaction({ productId: 'co.smallvictories.photoboot.tip' }));
    expect((await post('notifications', { signedPayload: notification('REFUND', otherProduct) })).status).toBe(200);

    const evil = signJws(
      { notificationType: 'REFUND', data: { bundleId: BUNDLE, environment: 'Sandbox' } },
      { chain: ['evil-leaf.pem', 'evil-intermediate.pem', 'evil-root.pem'], key: 'evil-leaf.key' }
    );
    expect((await post('notifications', { signedPayload: evil })).status).toBe(400);

    // Outer payload genuine, inner transaction forged.
    const forgedInner = signJws(transaction(), { key: 'evil-leaf.key' });
    expect((await post('notifications', { signedPayload: notification('REFUND', forgedInner) })).status).toBe(400);
    expect((await post('notifications', { signedPayload: 'x.y.z' })).status).toBe(400);
  });
});
