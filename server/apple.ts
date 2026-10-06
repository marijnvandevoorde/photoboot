// Apple in-app purchase for the iOS app (App Store guideline 3.1.1): one
// consumable per paid event, verified here, then billing.ts's lifecycle.
//
//   POST /api/apple/start          {name, email, eventDate} → {eventId, appAccountToken}
//                                  a pending event plus a random UUID the app
//                                  passes to StoreKit; Apple signs it into the
//                                  transaction, which ties the purchase to it
//   POST /api/apple/redeem         {eventId?, jws} → {eventId, eventName, setupLink, galleryLink}
//                                  the app's StoreKit 2 transaction (JWS);
//                                  idempotent per transaction
//   POST /api/apple/notifications  App Store Server Notifications V2
//                                  {signedPayload}: REFUND / REVOKE un-pay the
//                                  event; ONE_TIME_CHARGE activates it even if
//                                  the app never got to redeem
//
// Verification uses node:crypto only. A StoreKit JWS carries its certificate
// chain in the header (x5c: leaf, intermediate, root). We check every
// certificate is within its validity period and signed by the next one, the
// root is Apple Root CA - G3 (pinned by SHA-256 fingerprint, PEM committed
// next to this file), the leaf and intermediate carry Apple's App Store
// marker extensions, and the ES256 signature over header.payload verifies
// with the leaf's key. Then the transaction itself: bundle id, product id,
// type Consumable, environment, not revoked, and the appAccountToken.
//
// Config (env):
//   APPLE_BUNDLE_ID      app bundle id (default co.smallvictories.photoboot)
//   APPLE_PRODUCT_ID     consumable product id (default co.smallvictories.photoboot.eventgallery)
//   APPLE_ALLOW_SANDBOX  1 (default) accepts Sandbox (TestFlight, sandbox
//                        testers) besides Production; 0 = Production only

import { randomUUID, verify, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  activateEvent,
  checkEventRequest,
  createPendingEvent,
  EVENT_CURRENCY,
  galleryLink,
  refundPayment,
  setupLink,
} from './billing.ts';
import { db } from './db.ts';
import { getEvent } from './events.ts';
import { clientIp, HttpError, type Req, type Res, readJson, sendJson } from './http.ts';

// SHA-256 of Apple Root CA - G3 (https://www.apple.com/certificateauthority/).
export const APPLE_ROOT_G3_SHA256 =
  '63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79';
export const APPLE_ROOT_G3_PEM = readFileSync(new URL('./apple-root-ca-g3.pem', import.meta.url), 'utf8');

// Marker extensions Apple puts on App Store signing certificates
// (1.2.840.113635.100.6.11.1 on the leaf, 1.2.840.113635.100.6.2.1 on the
// WWDR intermediate), as DER-encoded OIDs. Apple's own server library
// checks these too: a chain to Apple's root alone isn't specific enough.
const OID_PREFIX = [0x06, 0x0a, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x63, 0x64, 0x06];
const LEAF_OID = Buffer.from([...OID_PREFIX, 0x0b, 0x01]);
const INTERMEDIATE_OID = Buffer.from([...OID_PREFIX, 0x02, 0x01]);

export interface AppleConfig {
  bundleId: string;
  productId: string;
  allowSandbox: boolean;
  // Trusted roots; production trusts only Apple Root CA - G3. Tests inject their own.
  roots: X509Certificate[];
  now: () => Date;
}

function trustedRoot(pem: string): X509Certificate {
  return new X509Certificate(pem);
}

const defaults = (): AppleConfig => ({
  bundleId: process.env.APPLE_BUNDLE_ID || 'co.smallvictories.photoboot',
  productId: process.env.APPLE_PRODUCT_ID || 'co.smallvictories.photoboot.eventgallery',
  allowSandbox: process.env.APPLE_ALLOW_SANDBOX !== '0',
  roots: [trustedRoot(APPLE_ROOT_G3_PEM)],
  now: () => new Date(),
});

let config: AppleConfig = defaults();

// Tests: swap the trusted root (and anything else); no argument resets.
export function configureApple(overrides?: Partial<Omit<AppleConfig, 'roots'>> & { rootPems?: string[] }) {
  const { rootPems, ...rest } = overrides ?? {};
  config = { ...defaults(), ...rest, ...(rootPems ? { roots: rootPems.map(trustedRoot) } : {}) };
}

export class AppleVerifyError extends Error {}

const fail = (message: string): never => {
  throw new AppleVerifyError(message);
};

const decodeJson = (part: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' ? value : fail('JWS part is not an object.');
  } catch (err) {
    if (err instanceof AppleVerifyError) throw err;
    return fail('JWS part is not JSON.');
  }
};

// Verifies a JWS signed by the App Store and returns its payload.
export function verifyJws(jws: unknown, cfg: AppleConfig = config): Record<string, unknown> {
  if (typeof jws !== 'string' || jws.length > 64 * 1024) return fail('Missing JWS.');
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[\w-]+$/.test(p))) return fail('Malformed JWS.');
  const header = decodeJson(parts[0]);
  if (header.alg !== 'ES256') return fail('Unexpected JWS algorithm.');
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length !== 3 || !x5c.every((c) => typeof c === 'string'))
    return fail('Expected a certificate chain of three.');

  let chain: X509Certificate[];
  try {
    chain = x5c.map((c: string) => new X509Certificate(Buffer.from(c, 'base64')));
  } catch {
    return fail('Unreadable certificate.');
  }
  const [leaf, intermediate, root] = chain;

  const now = cfg.now().getTime();
  for (const cert of chain) {
    if (now < cert.validFromDate.getTime() || now > cert.validToDate.getTime())
      fail(`Certificate ${cert.subject.replace(/\n/g, ', ')} is outside its validity period.`);
  }
  if (!cfg.roots.some((r) => r.fingerprint256 === root.fingerprint256)) fail('Not signed by a trusted root.');
  if (!intermediate.ca || !root.ca) fail('Chain has a non-CA issuer.');
  for (const [cert, issuer] of [
    [leaf, intermediate],
    [intermediate, root],
  ] as const) {
    if (!cert.checkIssued(issuer) || !cert.verify(issuer.publicKey)) fail('Broken certificate chain.');
  }
  if (!leaf.raw.includes(LEAF_OID) || !intermediate.raw.includes(INTERMEDIATE_OID))
    fail('Not an App Store signing certificate.');

  const signature = Buffer.from(parts[2], 'base64url');
  const ok =
    signature.length === 64 &&
    verify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: leaf.publicKey, dsaEncoding: 'ieee-p1363' },
      signature
    );
  if (!ok) fail('Bad signature.');
  return decodeJson(parts[1]);
}

// The fields of a StoreKit 2 JWSTransactionDecodedPayload we use.
export interface AppleTransaction {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  type: string;
  environment: string;
  appAccountToken: string | null;
  price: number | null; // milliunits of `currency`
  currency: string | null;
  storefront: string | null;
  purchaseDate: number | null;
  revocationDate: number | null;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function environmentOk(env: unknown, cfg: AppleConfig): boolean {
  return env === 'Production' || (env === 'Sandbox' && cfg.allowSandbox);
}

// Verifies a signed transaction and checks it's our app's consumable.
export function verifyTransaction(
  jws: unknown,
  { cfg = config, allowRevoked = false }: { cfg?: AppleConfig; allowRevoked?: boolean } = {}
): AppleTransaction {
  const p = verifyJws(jws, cfg);
  const tx: AppleTransaction = {
    transactionId: str(p.transactionId) ?? fail('Transaction has no id.'),
    originalTransactionId: str(p.originalTransactionId) ?? String(p.transactionId),
    bundleId: String(p.bundleId ?? ''),
    productId: String(p.productId ?? ''),
    type: String(p.type ?? ''),
    environment: String(p.environment ?? ''),
    appAccountToken: str(p.appAccountToken)?.toLowerCase() ?? null,
    price: num(p.price),
    currency: str(p.currency),
    storefront: str(p.storefront),
    purchaseDate: num(p.purchaseDate),
    revocationDate: num(p.revocationDate),
  };
  if (tx.bundleId !== cfg.bundleId) fail('Transaction is for another app.');
  if (tx.productId !== cfg.productId) fail('Transaction is for another product.');
  if (tx.type !== 'Consumable') fail('Transaction is not a consumable.');
  if (!environmentOk(tx.environment, cfg)) fail(`Transactions from ${tx.environment || 'unknown'} aren't accepted.`);
  if (tx.revocationDate !== null && !allowRevoked) fail('This purchase was refunded.');
  return tx;
}

// ---------- appAccountToken ↔ event ----------

export function issueToken(eventId: string): string {
  const token = randomUUID();
  db.prepare('INSERT INTO apple_tokens (token, event_id, created) VALUES (?, ?, ?)').run(
    token,
    eventId,
    new Date().toISOString()
  );
  return token;
}

export function eventForToken(token: string | null): string | null {
  if (!token) return null;
  const row = db.prepare('SELECT event_id FROM apple_tokens WHERE token = ?').get(token.toLowerCase()) as
    | { event_id: string }
    | undefined;
  return row?.event_id ?? null;
}

// Ref = transactionId. Every consumable purchase gets its own transactionId
// (originalTransactionId is the same value for consumables; it only differs
// for subscription renewals and restores of non-consumables), and Apple's
// REFUND notification names the refunded purchase by its transactionId.
async function activate(tx: AppleTransaction, eventId: string) {
  return activateEvent(eventId, {
    provider: 'apple',
    ref: tx.transactionId,
    // price is in milliunits (9990 = 9.99); the payments table keeps cents.
    amount: tx.price === null ? 0 : Math.round(tx.price / 10),
    currency: (tx.currency ?? EVENT_CURRENCY).toLowerCase(),
    raw: {
      transactionId: tx.transactionId,
      originalTransactionId: tx.originalTransactionId,
      productId: tx.productId,
      environment: tx.environment,
      storefront: tx.storefront,
      purchaseDate: tx.purchaseDate,
      price: tx.price,
      currency: tx.currency,
    },
  });
}

// ---------- routes ----------

// Per-IP limits; one map per route.
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (ip: string): boolean => {
    const now = Date.now();
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    recent.push(now);
    hits.set(ip, recent);
    if (hits.size > 10_000) hits.clear();
    return recent.length > max;
  };
}
const HOUR = 60 * 60 * 1000;
const startLimited = limiter(20, HOUR);
const redeemLimited = limiter(120, HOUR);

async function start(req: Req, res: Res) {
  if (startLimited(clientIp(req))) return sendJson(res, 429, { error: 'Too many tries, please wait a bit.' });
  const body = await readJson(req, 16 * 1024);
  let request: ReturnType<typeof checkEventRequest>;
  try {
    request = checkEventRequest(body);
  } catch (err) {
    return sendJson(res, 400, { error: (err as Error).message });
  }
  const ev = createPendingEvent(request, 'apple');
  sendJson(res, 201, { eventId: ev.id, appAccountToken: issueToken(ev.id) });
}

async function redeem(req: Req, res: Res) {
  if (redeemLimited(clientIp(req))) return sendJson(res, 429, { error: 'Too many tries, please wait a bit.' });
  const { eventId, jws } = await readJson<{ eventId?: unknown; jws?: unknown }>(req, 64 * 1024);
  const tx = verifyTransaction(jws);
  const forToken = eventForToken(tx.appAccountToken);
  if (!forToken) return sendJson(res, 404, { error: 'This purchase isn’t linked to an event.' });
  if (eventId !== undefined && eventId !== null && eventId !== forToken)
    return sendJson(res, 400, { error: 'This purchase belongs to another event.' });
  const refunded = db.prepare("SELECT 1 FROM payments WHERE ref = ? AND status = 'refunded'").get(tx.transactionId);
  if (refunded) return sendJson(res, 409, { error: 'This purchase was refunded.' });
  const ev = await activate(tx, forToken);
  if (!ev) return sendJson(res, 404, { error: 'The event no longer exists.' });
  sendJson(res, 200, { eventId: ev.id, eventName: ev.name, setupLink: setupLink(ev), galleryLink: galleryLink(ev) });
}

// App Store Server Notifications V2. Apple retries anything but 2xx, so
// notifications we don't act on get 200; only a bad signature gets 400.
async function notification(req: Req, res: Res) {
  const { signedPayload } = await readJson<{ signedPayload?: unknown }>(req, 256 * 1024);
  const payload = verifyJws(signedPayload);
  const type = String(payload.notificationType ?? '');
  const data = (payload.data ?? {}) as Record<string, unknown>;
  if (data.bundleId !== config.bundleId) fail('Notification is for another app.');
  const ignore = (why: string) => sendJson(res, 200, { ok: true, ignored: why });
  if (!environmentOk(data.environment, config)) return ignore('environment');
  if (!['REFUND', 'REVOKE', 'ONE_TIME_CHARGE'].includes(type)) return ignore(type || 'type');

  // The inner transaction is signed separately; verify it the same way.
  let tx: AppleTransaction;
  try {
    tx = verifyTransaction(data.signedTransactionInfo, { allowRevoked: type !== 'ONE_TIME_CHARGE' });
  } catch (err) {
    // A bad signature is an error; another product of ours is not.
    if (err instanceof AppleVerifyError && /another product|not a consumable/.test(err.message))
      return ignore('product');
    throw err;
  }
  if (type === 'ONE_TIME_CHARGE') {
    // The app normally redeems first; this covers a purchase whose app
    // closed (or lost its network) before it could.
    const eventId = eventForToken(tx.appAccountToken);
    if (!eventId || !getEvent(eventId)) return ignore('unknown token');
    await activate(tx, eventId);
  } else {
    refundPayment(tx.transactionId);
  }
  sendJson(res, 200, { ok: true });
}

export async function appleRoutes(req: Req, res: Res, url: URL): Promise<boolean> {
  const route = url.pathname.match(/^\/api\/apple\/(start|redeem|notifications)$/)?.[1];
  if (!route) return false;
  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed.' });
    return true;
  }
  try {
    if (route === 'start') await start(req, res);
    else if (route === 'redeem') await redeem(req, res);
    else await notification(req, res);
  } catch (err) {
    if (err instanceof AppleVerifyError) throw new HttpError(400, err.message);
    throw err;
  }
  return true;
}
