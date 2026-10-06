// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// The app's in-app purchase flow (src/purchase.ts) with StoreKit (the
// @capgo/native-purchases plugin) and the server mocked.

const store = vi.hoisted(() => {
  const listeners: Record<string, (tx: unknown) => void> = {};
  return {
    listeners,
    getProduct: vi.fn(async (_o: unknown) => ({ product: { priceString: '€19.99' } })),
    purchaseProduct: vi.fn(async (_o: Record<string, unknown>) => ({
      transactionId: '2000000001',
      productIdentifier: 'co.smallvictories.photoboot.eventgallery',
      jwsRepresentation: 'jws-1',
    })),
    acknowledgePurchase: vi.fn(async (_o: unknown) => {}),
    getPurchases: vi.fn(async (_o?: unknown) => ({ purchases: [] as unknown[] })),
    addListener: vi.fn(async (name: string, fn: (tx: unknown) => void) => {
      listeners[name] = fn;
      return { remove: async () => {} };
    }),
  };
});
vi.mock('@capgo/native-purchases', () => ({ NativePurchases: store, PURCHASE_TYPE: { INAPP: 'inapp', SUBS: 'subs' } }));
vi.mock('../src/platform.ts', () => ({ apiBase: 'https://api.test', isApp: true, isIosApp: true }));

const purchase = await import('../src/purchase.ts');

const LINKS = {
  eventId: 'ev1',
  eventName: 'Garden party',
  setupLink: 'https://api.test/settings.html#event=ev1.setupkey',
  galleryLink: 'https://api.test/g/ev1/gallerykey',
};

type Handler = (body: Record<string, unknown>) => Response | Promise<Response>;
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let routes: Record<string, Handler>;
const calls: { path: string; body: Record<string, unknown> }[] = [];
const order: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  calls.length = 0;
  order.length = 0;
  routes = {
    '/api/apple/start': () => reply(201, { eventId: 'ev1', appAccountToken: 'tok-1' }),
    '/api/apple/redeem': () => reply(200, LINKS),
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const path = url.replace('https://api.test', '');
      const body = JSON.parse(String(init.body));
      calls.push({ path, body });
      order.push(path);
      const handler = routes[path];
      return handler ? handler(body) : reply(404, { error: 'nope' });
    })
  );
  store.acknowledgePurchase.mockImplementation(async () => {
    order.push('finish');
  });
});

const queue = () => JSON.parse(localStorage.getItem('photoboot:apple-unredeemed') ?? '[]');

describe('in-app purchase flow', () => {
  it('shows the localized price', async () => {
    expect(await purchase.productPrice()).toBe('€19.99');
    expect(store.getProduct).toHaveBeenCalledWith({
      productIdentifier: 'co.smallvictories.photoboot.eventgallery',
      productType: 'inapp',
    });
  });

  it('start → purchase → redeem → finish', async () => {
    const result = await purchase.buyEventGallery({ name: 'Garden party', email: 'h@x.be', eventDate: null });
    expect(result).toEqual({ status: 'done', event: LINKS });
    expect(calls[0]).toEqual({
      path: '/api/apple/start',
      body: { name: 'Garden party', email: 'h@x.be', eventDate: null },
    });
    expect(store.purchaseProduct).toHaveBeenCalledWith(
      expect.objectContaining({ appAccountToken: 'tok-1', autoAcknowledgePurchases: false, productType: 'inapp' })
    );
    expect(calls[1]).toEqual({ path: '/api/apple/redeem', body: { eventId: 'ev1', jws: 'jws-1' } });
    // Finished only after the server confirmed.
    expect(order).toEqual(['/api/apple/start', '/api/apple/redeem', 'finish']);
    expect(store.acknowledgePurchase).toHaveBeenCalledWith({ purchaseToken: '2000000001' });
    expect(queue()).toEqual([]);
  });

  it('reports a cancel and Ask to Buy without redeeming', async () => {
    store.purchaseProduct.mockRejectedValueOnce(new Error('User cancelled'));
    expect(await purchase.buyEventGallery({ name: 'A', email: 'h@x.be', eventDate: null })).toEqual({
      status: 'cancelled',
    });
    store.purchaseProduct.mockRejectedValueOnce(new Error('Transaction pending'));
    expect(await purchase.buyEventGallery({ name: 'A', email: 'h@x.be', eventDate: null })).toEqual({
      status: 'pending',
    });
    expect(calls.filter((c) => c.path === '/api/apple/redeem')).toHaveLength(0);
    expect(store.acknowledgePurchase).not.toHaveBeenCalled();
  });

  it('shows the server error when start fails', async () => {
    routes['/api/apple/start'] = () => reply(400, { error: 'That email address looks wrong.' });
    await expect(purchase.buyEventGallery({ name: 'A', email: 'x', eventDate: null })).rejects.toThrow(/email/);
    expect(store.purchaseProduct).not.toHaveBeenCalled();
  });

  it('keeps a purchase the server never confirmed, and restores it later', async () => {
    routes['/api/apple/redeem'] = () => {
      throw new TypeError('Failed to fetch');
    };
    await expect(purchase.buyEventGallery({ name: 'A', email: 'h@x.be', eventDate: null })).rejects.toThrow(
      /No connection/
    );
    expect(store.acknowledgePurchase).not.toHaveBeenCalled(); // StoreKit keeps it too
    expect(queue()).toEqual([{ transactionId: '2000000001', jws: 'jws-1', eventId: 'ev1' }]);

    // Back online: StoreKit still lists it as unfinished (deduplicated).
    routes['/api/apple/redeem'] = () => reply(200, LINKS);
    store.getPurchases.mockResolvedValueOnce({
      purchases: [
        {
          transactionId: '2000000001',
          productIdentifier: 'co.smallvictories.photoboot.eventgallery',
          jwsRepresentation: 'jws-1',
        },
        { transactionId: '9', productIdentifier: 'other.product', jwsRepresentation: 'jws-other' },
      ],
    });
    calls.length = 0;
    const { redeemed, failed } = await purchase.redeemUnfinished();
    expect(redeemed).toEqual([LINKS]);
    expect(failed).toEqual([]);
    expect(calls).toEqual([{ path: '/api/apple/redeem', body: { eventId: 'ev1', jws: 'jws-1' } }]);
    expect(store.acknowledgePurchase).toHaveBeenCalledWith({ purchaseToken: '2000000001' });
    expect(queue()).toEqual([]);
  });

  it('finishes a refunded purchase instead of retrying forever', async () => {
    routes['/api/apple/redeem'] = () => reply(409, { error: 'This purchase was refunded.' });
    await expect(purchase.redeem({ transactionId: '5', jwsRepresentation: 'jws-5' })).rejects.toThrow(/refunded/);
    expect(store.acknowledgePurchase).toHaveBeenCalledWith({ purchaseToken: '5' });
    expect(queue()).toEqual([]);
  });

  it('keeps late deliveries (Ask to Buy approved) and tells settings', async () => {
    const seen: string[] = [];
    purchase.onTransactionDelivered((tx) => seen.push(tx.transactionId));
    await vi.waitFor(() => expect(store.listeners.transactionUpdated).toBeTypeOf('function'));
    store.listeners.transactionUpdated({ transactionId: 'x', productIdentifier: 'other', jwsRepresentation: 'j' });
    store.listeners.transactionUpdated({
      transactionId: '7',
      productIdentifier: 'co.smallvictories.photoboot.eventgallery',
      jwsRepresentation: 'jws-7',
    });
    expect(seen).toEqual(['7']);
    expect(queue()).toEqual([{ transactionId: '7', jws: 'jws-7' }]);
    purchase.onTransactionDelivered(null);
  });
});
