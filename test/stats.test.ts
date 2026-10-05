// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function load() {
  vi.resetModules();
  const config = await import('../src/config.ts');
  const stats = await import('../src/stats.ts');
  return { ...config, ...stats };
}

beforeEach(() => localStorage.clear());

describe('stats', () => {
  it('counts sessions per hour, prints, stickers and shares per event', async () => {
    const { record, getStats, setConfig } = await load();
    setConfig({ eventName: 'Party' });
    record('session');
    record('session');
    record('print', { heightDots: 1180, copies: 2 }); // 100 mm per sticker
    record('share');
    record('printFail');
    const s = getStats();
    expect(s).toMatchObject({ sessions: 2, prints: 1, stickers: 2, shares: 1, failedPrints: 1 });
    expect(s.printedMm).toBeCloseTo(200);
    expect(s.byHour[String(new Date().getHours())]).toBe(2);
    expect(getStats('default').sessions).toBe(0); // other event untouched
  });

  it('resets one event', async () => {
    const { record, getStats, resetStats } = await load();
    record('session');
    resetStats();
    expect(getStats().sessions).toBe(0);
  });
});

describe('paper meter', () => {
  it('is off without a roll length', async () => {
    const { paperLeft } = await load();
    expect(paperLeft({ rollLengthMm: 0, paperWarnMm: 500 })).toBeNull();
  });

  it('counts down and warns when low; a new roll resets it', async () => {
    const { paperLeft, record, newRoll } = await load();
    const roll = { rollLengthMm: 1000, paperWarnMm: 300 };
    const check = (leftMm: number, low: boolean) => {
      const paper = paperLeft(roll);
      expect(paper?.leftMm).toBeCloseTo(leftMm);
      expect(paper?.low).toBe(low);
    };
    record('print', { heightDots: 5900 }); // 500 mm
    check(500, false);
    record('print', { heightDots: 2950 }); // 250 mm
    check(250, true);
    newRoll();
    check(1000, false);
  });
});

describe('booth status', () => {
  it('merges updates and stamps them', async () => {
    const { setStatus, getStatus } = await load();
    setStatus({ printer: 'P2S', printerConnected: true });
    setStatus({ camera: 'error', lastError: 'Camera: gone' });
    expect(getStatus()).toMatchObject({ printer: 'P2S', printerConnected: true, camera: 'error' });
    expect(getStatus()?.at).toMatch(/^\d{4}-/);
  });
});
