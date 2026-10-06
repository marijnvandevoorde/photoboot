import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import puppeteer, { type Browser, type Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CHROME = [
  process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].find((p): p is string => !!p && existsSync(p));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Runs in the page before any script: a Phomemo that counts the bytes it gets
// and how often the picker opened. getDevices() hands back the same printer
// on a later load, like Chrome does for a device the site picked before.
function fakeBluetooth() {
  const w = window as unknown as { __written: number; __picked: number };
  w.__written = 0;
  w.__picked = 0;
  const char = {
    properties: { write: true, writeWithoutResponse: true },
    writeValueWithResponse: async (c: ArrayBufferView) => {
      w.__written += c.byteLength;
    },
    writeValueWithoutResponse: async (c: ArrayBufferView) => {
      w.__written += c.byteLength;
    },
  };
  const gatt = {
    connected: false,
    async connect() {
      gatt.connected = true;
      return gatt;
    },
    getPrimaryService: async () => ({ getCharacteristic: async () => char }),
    disconnect() {
      gatt.connected = false;
    },
  };
  const device = { id: 'fake', name: 'P2S-fake', gatt, addEventListener() {} };
  Object.defineProperty(navigator, 'bluetooth', {
    value: {
      requestDevice: async () => {
        w.__picked++;
        return device;
      },
      getDevices: async () => [device],
    },
  });
}

describe.skipIf(!CHROME)('booth in a real browser', () => {
  let dir: string;
  let server: Server;
  let base: string;
  let browser: Browser;
  let page: Page;
  const errors: string[] = [];

  const visible = (sel: string) => page.$eval(sel, (el) => !(el as HTMLElement).hidden);
  const text = (sel: string) => page.$eval(sel, (el) => el.textContent ?? '');

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'photoboot-e2e-'));
    process.env.SHARE_DIR = path.join(dir, 'shares');
    process.env.EVENTS_DIR = path.join(dir, 'events');
    process.env.ADMIN_TOKEN = 'e2e-admin';
    const { createApp } = await import('../../server/index.ts');
    server = createApp();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    // localhost (not 127.0.0.1) is a secure context: camera + IndexedDB work.
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    process.env.PUBLIC_URL = base; // links in emails / admin point here

    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--no-sandbox'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)));
    page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'E2E party' : undefined));
    await page.evaluateOnNewDocument(fakeBluetooth);

    await page.goto(`${base}/settings.html`);
    await page.waitForSelector('#panels:not([hidden])');
    // Let the first-ever IndexedDB open finish before leaving the page: on an
    // on-disk profile, navigating away within ~100 ms of it leaves the
    // database hanging for the next page (a person can't click that fast).
    await page.waitForFunction(() => document.getElementById('local-photos')?.textContent?.includes('photos'));
    await page.evaluate(() => {
      const cfg = JSON.parse(localStorage.getItem('photoboot:config') || '{}');
      localStorage.setItem(
        'photoboot:config',
        JSON.stringify({
          ...cfg,
          eventName: 'Test party',
          guestShotChoice: true,
          attractAfterSec: 6,
          templateId: 'text',
          templateConfig: { text: { title: 'Hello!', line1: 'Anna & Tom', line2: '12 · 10 · 2026', font: 'script' } },
          allowedStyles: ['classic', 'woodcut'],
          copies: 2,
          maxPrintsPerSession: 1,
          rollLengthMm: 1000,
          paperWarnMm: 900,
          language: 'nl',
        })
      );
      localStorage.setItem('delay', '3');
    });
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server?.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });

  it('connects the printer and starts the camera', async () => {
    await page.goto(`${base}/`);
    await page.click('#connect');
    await page.waitForSelector('#booth:not([hidden])');
    await page.waitForFunction(() => (document.getElementById('video') as HTMLVideoElement).videoWidth > 0);
    expect(await text('#shutter-label')).toBe('Neem foto');
    expect(await visible('#shot-choice')).toBe(true);
  });

  it('shows the live print look', async () => {
    const chips = await page.$$eval('#live-styles .filter', (b) => b.map((x) => (x as HTMLElement).dataset.value));
    expect(chips).toEqual(['camera', 'classic', 'woodcut']);
    await page.click('#live-styles .filter[data-value="classic"]');
    await page.waitForFunction(() => !(document.getElementById('live') as HTMLCanvasElement).hidden);
  });

  it('cancels a countdown', async () => {
    await page.click('#shutter');
    await sleep(1200);
    expect(await text('#countdown-caption')).toBe('Maak je klaar…');
    await page.click('#cancel-countdown');
    await sleep(400);
    expect(await visible('#countdown')).toBe(false);
    expect(await visible('#review')).toBe(false);
  });

  it('takes a two-photo strip by tapping the camera view', async () => {
    await page.click('.shots[data-shots="2"]');
    await page.mouse.click(640, 200);
    await sleep(2200);
    expect(await text('#shot-counter')).toBe('Foto 1 van 2');
    await page.waitForSelector('#review:not([hidden])', { timeout: 20_000 });
    const styles = await page.$$eval('#styles .filter', (b) => b.map((x) => (x as HTMLElement).dataset.value));
    expect(styles).toEqual(['classic', 'woodcut']);
    const classic = await page.$eval('#styles .filter[data-value="classic"]', (b) => b.getAttribute('aria-checked'));
    expect(classic).toBe('true'); // the live pick carried over
    expect(await page.$eval('#sticker', (c) => (c as HTMLCanvasElement).width)).toBe(552);
  });

  it('prints two copies, then hits the print limit', async () => {
    await page.click('#print');
    await page.waitForFunction(() => !document.getElementById('print-overlay')?.hidden);
    await page.waitForFunction(() => document.getElementById('print-overlay')?.hidden, { timeout: 20_000 });
    expect(await page.evaluate(() => (window as unknown as { __written: number }).__written)).toBeGreaterThan(10_000);
    expect(await page.$eval('#print', (b) => (b as HTMLButtonElement).disabled)).toBe(true);
    const stats = await page.evaluate(() => JSON.parse(localStorage.getItem('photoboot:stats:test-party') ?? '{}'));
    expect(stats).toMatchObject({ sessions: 1, prints: 1, stickers: 2 });
  });

  it('shares via QR and goes back to the camera', async () => {
    await page.click('#share');
    await page.waitForSelector('#qr-dialog:not([hidden])', { timeout: 10_000 });
    expect(await page.$('#qr svg')).not.toBeNull();
    await page.click('#qr-close');
    await page.click('#done');
    await page.waitForSelector('#booth:not([hidden])');
    expect(await text('#printer-pill')).toContain('low');
  });

  it('cycles the colour keepsake on the idle screen', async () => {
    await page.waitForSelector('#attract:not([hidden])', { timeout: 15_000 });
    await page.waitForFunction(() => (document.getElementById('attract-photo') as HTMLImageElement).naturalWidth > 0);
    const [w, h] = await page.$eval('#attract-photo', (i) => [
      (i as HTMLImageElement).naturalWidth,
      (i as HTMLImageElement).naturalHeight,
    ]);
    expect(w).toBeGreaterThan(1000); // camera resolution, not dots
    expect(h).toBeGreaterThan(w); // header + two shots + footer
    await page.mouse.click(640, 400);
    await sleep(300);
    expect(await visible('#attract')).toBe(false);
    expect(await visible('#countdown')).toBe(false);
  });

  it('comes back to the camera after a reload, with the same printer', async () => {
    await page.reload();
    await page.waitForSelector('#booth:not([hidden])');
    expect(await visible('#setup')).toBe(false);
    await page.waitForFunction(() => document.getElementById('printer-pill')?.textContent?.includes('P2S-fake'));
    expect(await page.evaluate(() => (window as unknown as { __picked: number }).__picked)).toBe(0);
    expect(await page.$eval('#printer-pill', (p) => p.classList.contains('bad'))).toBe(false);
  });

  it('joins an event from its setup link, saves its setup, and a second device gets it', async () => {
    const { compEvent, setupLink } = await import('../../server/billing.ts');
    const ev = await compEvent({ name: 'E2E party', email: '', sendEmail: false });
    const link = setupLink(ev);

    await page.goto(`${base}/settings.html`);
    await page.waitForSelector('#panels:not([hidden])');
    await page.waitForFunction(() => document.getElementById('local-photos')?.textContent?.includes('1 photos'));
    await page.type('#setup-link', link);
    await page.click('#use-setup-link');
    await page.waitForFunction(() => document.getElementById('import-status')?.textContent?.includes('now set up'));
    expect(await visible('#event-joined')).toBe(true);

    // Customise this booth, then save it to the event for the other booths.
    await page.select('#copies', '3');
    await page.click('#save-to-event');
    await page.waitForFunction(() =>
      document.getElementById('save-status')?.textContent?.includes('Saved to the event')
    );

    const other = await browser.createBrowserContext();
    const page2 = await other.newPage();
    await page2.goto(link);
    await page2.waitForFunction(() => document.getElementById('import-status')?.textContent?.includes('now set up'));
    const cfg = await page2.evaluate(() => JSON.parse(localStorage.getItem('photoboot:config') ?? '{}'));
    expect(cfg).toMatchObject({ copies: 3, serverEvent: { id: ev.id, name: 'E2E party' } });
    await other.close();
  });

  it('logs in to /admin with an authenticator and lists the event', async () => {
    const { totp } = await import('../../server/totp.ts');
    const admin = await browser.newPage();
    await admin.goto(`${base}/admin`);
    await admin.waitForSelector('#login:not([hidden])');
    await admin.type('#login-token', 'e2e-admin');
    await admin.click('#login-form button[type="submit"]');
    await admin.waitForSelector('#enroll:not([hidden])');
    const secret = (await admin.$eval('#enroll-secret', (e) => e.textContent ?? '')).replace(/\s/g, '');
    await admin.type('#login-code', totp(secret));
    await admin.click('#login-form button[type="submit"]');
    await admin.waitForSelector('#panels:not([hidden])');
    await admin.waitForFunction(() => document.getElementById('events')?.textContent?.includes('E2E party'));
    await admin.close();
  });

  it('asks for the PIN before a guest can leave the booth', async () => {
    await page.type('#admin-password', '2468');
    await page.click('#set-pin');
    await page.goto(`${base}/`);
    await page.waitForSelector('#booth:not([hidden])');

    const longPressHatch = async () => {
      await page.mouse.move(20, 20);
      await page.mouse.down();
      await sleep(2300);
      await page.mouse.up();
    };
    await longPressHatch();
    expect(await visible('#host-dialog')).toBe(true);
    expect(await visible('#host-menu')).toBe(false);
    await page.type('#host-pin-input', '1111');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#host-pin-error:not([hidden])');
    expect(await visible('#host-menu')).toBe(false);
    await page.click('[data-host-close]');
    expect(await visible('#host-dialog')).toBe(false);

    await longPressHatch();
    await page.type('#host-pin-input', '2468');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#host-menu:not([hidden])');
    await Promise.all([page.waitForNavigation(), page.click('#host-settings')]);
    await page.waitForSelector('#panels:not([hidden])'); // no second PIN prompt
    expect(await visible('#auth')).toBe(false);
  });

  it('stops the booth from settings, so the next start shows the setup screen', async () => {
    expect(await text('#kiosk-status')).toContain('running');
    await page.click('#stop-booth');
    await page.waitForFunction(() => document.getElementById('kiosk-status')?.textContent?.includes('not running'));
    await page.goto(`${base}/`);
    await page.waitForSelector('#setup:not([hidden])');
    expect(await visible('#booth')).toBe(false);
    expect(await visible('#pin-nudge')).toBe(false); // a PIN is set

    // Settings are locked again once the host walked away.
    await page.goto(`${base}/settings.html`);
    await page.waitForSelector('#auth:not([hidden])');
  });

  it('had no uncaught page errors', () => {
    expect(errors).toEqual([]);
  });
});
