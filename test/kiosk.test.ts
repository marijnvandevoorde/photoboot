// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  adminUnlocked,
  checkPin,
  hasPin,
  kioskState,
  lockKiosk,
  pinHash,
  setAdminUnlocked,
  unlockKiosk,
} from '../src/kiosk.ts';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('kiosk lock', () => {
  it('is off until the booth is started', () => {
    expect(kioskState()).toBeNull();
  });

  it('remembers the printer across page loads, until unlocked', () => {
    const printer = { id: 'dev-1', name: 'P2S-1234', type: 'auto' };
    lockKiosk(printer, new Date('2026-10-06T20:00:00Z'));
    expect(kioskState()).toEqual({ since: '2026-10-06T20:00:00.000Z', printer });
    unlockKiosk();
    expect(kioskState()).toBeNull();
  });

  it('remembers a booth started without printer', () => {
    lockKiosk(null);
    expect(kioskState()?.printer).toBeNull();
  });

  it('treats junk as unlocked, and a broken printer entry as no printer', () => {
    localStorage.setItem('photoboot:kiosk', '{nope');
    expect(kioskState()).toBeNull();
    localStorage.setItem('photoboot:kiosk', JSON.stringify({ since: 'x', printer: { name: 'no id' } }));
    expect(kioskState()).toEqual({ since: 'x', printer: null });
  });
});

describe('PIN', () => {
  it('checks hashed and legacy plain PINs', async () => {
    const hashed = { adminPasswordHash: await pinHash('1234'), adminPassword: '' };
    expect(hasPin(hashed)).toBe(true);
    expect(await checkPin(hashed, '1234')).toBe(true);
    expect(await checkPin(hashed, '4321')).toBe(false);
    const plain = { adminPasswordHash: '', adminPassword: 'abc' };
    expect(await checkPin(plain, 'abc')).toBe(true);
    expect(hasPin({ adminPasswordHash: '', adminPassword: '' })).toBe(false);
  });

  it('remembers an unlock for this tab only', () => {
    expect(adminUnlocked()).toBe(false);
    setAdminUnlocked(true);
    expect(adminUnlocked()).toBe(true);
    setAdminUnlocked(false);
    expect(adminUnlocked()).toBe(false);
  });
});
