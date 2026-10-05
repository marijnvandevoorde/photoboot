// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

// config.ts caches in memory, so load a fresh copy per test.
async function load() {
  vi.resetModules();
  return import('../src/config.ts');
}

beforeEach(() => localStorage.clear());

describe('config', () => {
  it('starts from the defaults', async () => {
    const { getConfig, DEFAULTS } = await load();
    expect(getConfig()).toEqual(DEFAULTS);
  });

  it('persists updates and merges new defaults into old stored configs', async () => {
    localStorage.setItem('photoboot:config', JSON.stringify({ copies: 2 }));
    const { getConfig, setConfig, DEFAULTS } = await load();
    expect(getConfig().copies).toBe(2);
    expect(getConfig().livePreview).toBe(DEFAULTS.livePreview);
    setConfig({ eventName: 'Party' });
    expect(JSON.parse(localStorage.getItem('photoboot:config') ?? '{}').eventName).toBe('Party');
  });

  it('survives a corrupt stored config', async () => {
    localStorage.setItem('photoboot:config', '{nope');
    const { getConfig, DEFAULTS } = await load();
    expect(getConfig()).toEqual(DEFAULTS);
  });

  it('resets', async () => {
    const { getConfig, resetConfig, setConfig, DEFAULTS } = await load();
    setConfig({ copies: 4 });
    resetConfig();
    expect(getConfig()).toEqual(DEFAULTS);
    expect(localStorage.getItem('photoboot:config')).toBeNull();
  });
});

describe('eventKey', () => {
  it('slugs the event name', async () => {
    const { eventKey } = await load();
    expect(eventKey({ eventName: "Anna & Tom's Café!", serverEvent: null })).toBe('anna-tom-s-cafe');
  });

  it('prefers the server event, then falls back to default', async () => {
    const { eventKey } = await load();
    expect(eventKey({ eventName: 'x', serverEvent: { id: 'abc123', key: 'k' } })).toBe('abc123');
    expect(eventKey({ eventName: '  !! ', serverEvent: null })).toBe('default');
  });
});

describe('portableConfig', () => {
  it('drops device-only keys', async () => {
    const { portableConfig, DEFAULTS } = await load();
    const out = portableConfig({ ...DEFAULTS, printerType: 'phomemo', serverEvent: { id: 'a', key: 'b' } });
    expect(out).not.toHaveProperty('printerType');
    expect(out).not.toHaveProperty('serverEvent');
    expect(out.copies).toBe(DEFAULTS.copies);
  });
});
