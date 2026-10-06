// Buying an event gallery in the iOS app: Apple in-app purchase (StoreKit 2
// through @capgo/native-purchases), verified by the server (server/apple.ts).
//
//   1. POST /api/apple/start   → a pending event + an appAccountToken (UUID)
//   2. StoreKit purchase with that token (Apple signs it into the transaction)
//   3. POST /api/apple/redeem  with the signed transaction (JWS) → the event's
//      setup + gallery links
//   4. only then finish the transaction: a consumable that isn't finished
//      comes back on every launch, so nothing is lost if 3 fails
//
// Transactions the server hasn't confirmed yet are also kept in localStorage
// (the plugin finishes ones StoreKit delivers later, e.g. Ask to Buy, by
// itself). redeemUnfinished() retries them; the server is idempotent per
// transaction, and its App Store notification (ONE_TIME_CHARGE) activates
// the event even if the app never gets back to it.

import { NativePurchases, PURCHASE_TYPE, type Transaction } from '@capgo/native-purchases';
import { errorMessage } from './dom.ts';
import { apiBase } from './platform.ts';

export const PRODUCT_ID = import.meta.env.VITE_APPLE_PRODUCT_ID ?? 'co.smallvictories.photoboot.eventgallery';

export interface EventRequest {
  name: string;
  email: string;
  eventDate: string | null;
}

export interface PurchasedEvent {
  eventId: string;
  eventName: string;
  setupLink: string;
  galleryLink: string;
}

export type BuyResult = { status: 'done'; event: PurchasedEvent } | { status: 'cancelled' } | { status: 'pending' };

export class ServerError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function post<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('No connection to the server. Check the internet connection and try again.');
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ServerError(res.status, data.error || `Server error (${res.status}).`);
  return data;
}

// The localized price ("€19.99"), or null when StoreKit has no such product.
export async function productPrice(): Promise<string | null> {
  const { product } = await NativePurchases.getProduct({
    productIdentifier: PRODUCT_ID,
    productType: PURCHASE_TYPE.INAPP,
  });
  return product?.priceString || null;
}

// ---------- transactions the server hasn't confirmed yet ----------

const QUEUE_KEY = 'photoboot:apple-unredeemed';

interface Unredeemed {
  transactionId: string;
  jws: string;
  eventId?: string;
}

function readQueue(): Unredeemed[] {
  try {
    const list = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeQueue(list: Unredeemed[]) {
  try {
    if (list.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(list));
    else localStorage.removeItem(QUEUE_KEY);
  } catch {
    // Private mode / full storage: StoreKit and the server notification still have it.
  }
}

function remember(tx: Unredeemed) {
  const list = readQueue().filter((q) => q.transactionId !== tx.transactionId);
  writeQueue([...list, tx]);
}

const forget = (transactionId: string) => writeQueue(readQueue().filter((q) => q.transactionId !== transactionId));

// Tells StoreKit the purchase is delivered. "Not found" means it's already
// finished (the plugin finishes late deliveries itself): fine.
async function finish(transactionId: string) {
  await NativePurchases.acknowledgePurchase({ purchaseToken: transactionId }).catch(() => {});
}

// ---------- buying ----------

export async function buyEventGallery(request: EventRequest): Promise<BuyResult> {
  const { eventId, appAccountToken } = await post<{ eventId: string; appAccountToken: string }>(
    '/api/apple/start',
    request
  );
  let tx: Transaction;
  try {
    tx = await NativePurchases.purchaseProduct({
      productIdentifier: PRODUCT_ID,
      productType: PURCHASE_TYPE.INAPP,
      appAccountToken,
      quantity: 1,
      // Finish only after the server confirmed (redeem below).
      autoAcknowledgePurchases: false,
    });
  } catch (err) {
    const message = errorMessage(err);
    if (/cancel/i.test(message)) return { status: 'cancelled' };
    // Ask to Buy: StoreKit delivers it later through watchTransactions().
    if (/pending|deferred/i.test(message)) return { status: 'pending' };
    throw err;
  }
  return { status: 'done', event: await redeem(tx, eventId) };
}

// Sends a transaction to the server; finishes it once the server confirmed.
export async function redeem(
  tx: Pick<Transaction, 'transactionId' | 'jwsRepresentation'>,
  eventId?: string
): Promise<PurchasedEvent> {
  if (!tx.jwsRepresentation) throw new Error("The App Store didn't return a signed purchase.");
  remember({ transactionId: tx.transactionId, jws: tx.jwsRepresentation, eventId });
  try {
    const event = await post<PurchasedEvent>('/api/apple/redeem', { eventId, jws: tx.jwsRepresentation });
    await finish(tx.transactionId);
    forget(tx.transactionId);
    return event;
  } catch (err) {
    // Refunded in the meantime: nothing left to deliver.
    if (err instanceof ServerError && err.status === 409) {
      await finish(tx.transactionId);
      forget(tx.transactionId);
    }
    throw err;
  }
}

// Unfinished purchases (StoreKit's own list + the local queue), redeemed.
export async function redeemUnfinished(): Promise<{ redeemed: PurchasedEvent[]; failed: string[] }> {
  const todo = new Map<string, Unredeemed>();
  for (const q of readQueue()) todo.set(q.transactionId, q);
  const { purchases } = await NativePurchases.getPurchases({ productType: PURCHASE_TYPE.INAPP }).catch(() => ({
    purchases: [] as Transaction[],
  }));
  for (const p of purchases) {
    if (p.productIdentifier !== PRODUCT_ID || !p.jwsRepresentation || todo.has(p.transactionId)) continue;
    todo.set(p.transactionId, { transactionId: p.transactionId, jws: p.jwsRepresentation });
  }
  const redeemed: PurchasedEvent[] = [];
  const failed: string[] = [];
  for (const q of todo.values()) {
    try {
      redeemed.push(await redeem({ transactionId: q.transactionId, jwsRepresentation: q.jws }, q.eventId));
    } catch (err) {
      failed.push(errorMessage(err));
    }
  }
  return { redeemed, failed };
}

// ---------- late deliveries ----------

type Delivered = (tx: Transaction) => void;
let onDelivered: Delivered | null = null;
let watching = false;

// Keeps every late delivery of our product (see the top of this file).
export function watchTransactions() {
  if (watching) return;
  watching = true;
  void NativePurchases.addListener('transactionUpdated', (tx) => {
    if (tx.productIdentifier !== PRODUCT_ID || !tx.jwsRepresentation) return;
    remember({ transactionId: tx.transactionId, jws: tx.jwsRepresentation });
    onDelivered?.(tx);
  }).catch(() => {});
}

// Settings: be told right away when one arrives while it's open.
export function onTransactionDelivered(fn: Delivered | null) {
  watchTransactions();
  onDelivered = fn;
}
