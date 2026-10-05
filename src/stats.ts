// Per-event counters kept on this device (localStorage), plus the paper
// meter and the booth's last-known health, which the settings page shows.
//
// Stats shape: { sessions, prints, stickers, shares, failedPrints,
//                printedMm, byHour: { '0'..'23': sessions }, first, last }
// The paper meter is per device, not per event: it follows the roll that's
// in the printer. { usedMm } since the last "new roll".

import { type Config, DOTS_PER_MM, eventKey, getConfig } from './config.ts';

export interface Stats {
  sessions: number;
  prints: number;
  stickers: number;
  shares: number;
  failedPrints: number;
  printedMm: number;
  byHour: Record<string, number>;
  first: string | null;
  last: string | null;
}

export interface BoothStatus {
  printer?: string | null;
  printerConnected?: boolean;
  camera?: 'ok' | 'error';
  lastError?: string;
  at?: string;
}

const STATS_PREFIX = 'photoboot:stats:';
const PAPER_KEY = 'photoboot:paper';
const STATUS_KEY = 'photoboot:status';

function readJson<T>(key: string, fallback: T): T {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full / disabled: stats are best effort */
  }
}

const empty = (): Stats => ({
  sessions: 0,
  prints: 0,
  stickers: 0,
  shares: 0,
  failedPrints: 0,
  printedMm: 0,
  byHour: {},
  first: null,
  last: null,
});

export function getStats(key = eventKey()): Stats {
  return { ...empty(), ...readJson<Partial<Stats>>(STATS_PREFIX + key, {}) };
}

export function resetStats(key = eventKey()) {
  try {
    localStorage.removeItem(STATS_PREFIX + key);
  } catch {
    /* ignore */
  }
}

// kind: 'session' | 'print' | 'share' | 'printFail'. For prints, pass the
// sticker height in dots (tear margin included) and the number of copies.
export function record(
  kind: 'session' | 'print' | 'share' | 'printFail',
  { heightDots = 0, copies = 1 } = {}
): Stats {
  const key = eventKey();
  const s = getStats(key);
  const now = new Date();
  s.first ??= now.toISOString();
  s.last = now.toISOString();
  if (kind === 'session') {
    s.sessions++;
    const h = String(now.getHours());
    s.byHour[h] = (s.byHour[h] ?? 0) + 1;
  } else if (kind === 'print') {
    const mm = (heightDots * copies) / DOTS_PER_MM;
    s.prints++;
    s.stickers += copies;
    s.printedMm += mm;
    const paper = getPaper();
    writeJson(PAPER_KEY, { ...paper, usedMm: paper.usedMm + mm });
  } else if (kind === 'share') {
    s.shares++;
  } else if (kind === 'printFail') {
    s.failedPrints++;
  }
  writeJson(STATS_PREFIX + key, s);
  return s;
}

export function getPaper(): { usedMm: number; since: string | null } {
  return { usedMm: 0, since: null, ...readJson(PAPER_KEY, {}) };
}

export function newRoll() {
  writeJson(PAPER_KEY, { usedMm: 0, since: new Date().toISOString() });
}

// { rollMm, usedMm, leftMm, low } or null when the roll isn't tracked.
export function paperLeft(
  config: Pick<Config, 'rollLengthMm' | 'paperWarnMm'> = getConfig()
): { rollMm: number; usedMm: number; leftMm: number; low: boolean } | null {
  if (!config.rollLengthMm) return null;
  const { usedMm } = getPaper();
  const leftMm = Math.max(0, config.rollLengthMm - usedMm);
  return { rollMm: config.rollLengthMm, usedMm, leftMm, low: leftMm < (config.paperWarnMm || 0) };
}

// Booth health heartbeat: { printer, printerConnected, camera, lastError, at }.
export function setStatus(updates: BoothStatus) {
  writeJson(STATUS_KEY, { ...readJson(STATUS_KEY, {}), ...updates, at: new Date().toISOString() });
}

export function getStatus(): BoothStatus | null {
  return readJson<BoothStatus | null>(STATUS_KEY, null);
}
