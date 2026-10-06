// Admin settings page. Reads/writes the config in src/config.js, manages
// template images, saved setups (profiles), server events, local photos and
// shows the booth's health and counters.
//
// Laid out for a non-technical host: sections Tonight, Event, What guests
// see, Printer & paper, Photos, Security, and a collapsed Advanced (printer
// type, server events, upload token, reset). Each setting has a one-line
// explanation in settings.html.
//
// Access control is intentionally light: an optional PIN gate (hashed, see
// kiosk.ts). The hidden long-presses in the booth (and /?admin=1) are the
// only entry points — this URL isn't linked from anywhere public.

import { deletePhotos, exportZip, photoEvents } from './archive.ts';
import type { Config, TextTemplateConfig } from './config.ts';
import { DEFAULTS, eventKey, getConfig, PAPER_PRESETS, portableConfig, resetConfig, setConfig } from './config.ts';
import { $, errorMessage, option } from './dom.ts';
import { LANGUAGES, STRING_KEYS, STRINGS } from './i18n.ts';
import { adminUnlocked, checkPin, hasPin, kioskState, pinHash, setAdminUnlocked, unlockKiosk } from './kiosk.ts';
import { PHOTO_STYLES, PHOTO_TWISTS } from './photo.ts';
import { isIosApp } from './platform.ts';
import { listPrinters } from './printers/index.ts';
import type { PurchasedEvent } from './purchase.ts';
import type { Setup } from './remote.ts';
import { remote } from './remote.ts';
import { getPaper, getStats, getStatus, newRoll, paperLeft, resetStats } from './stats.ts';
import { kv } from './storage.ts';
import type { Slot } from './templates.ts';
import {
  BUILT_IN_TEMPLATES,
  clearTemplateImage,
  exportTemplateImages,
  hasTemplateImage,
  importTemplateImages,
  saveTemplateImage,
  TEXT_DEFAULTS,
  TEXT_FONTS,
  templateImageUrl,
} from './templates.ts';

let config = getConfig();

// ---------- auth ----------

// The booth's host menu sets the same flag after its own PIN prompt, so
// coming from there doesn't ask twice.
const locked = () => hasPin(config) && !adminUnlocked();

$<HTMLButtonElement>('auth-submit').addEventListener('click', async () => {
  if (await checkPin(config, $<HTMLInputElement>('auth-password').value)) {
    setAdminUnlocked(true);
    $('auth-error').hidden = true;
    start();
  } else {
    $('auth-error').hidden = false;
  }
});
$<HTMLInputElement>('auth-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $<HTMLButtonElement>('auth-submit').click();
});

// ---------- save ----------

function save(updates: Partial<Config>) {
  config = setConfig(updates);
  flashStatus('Saved ✓');
}

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function flashStatus(message: string, isError = false) {
  const box = $('save-status');
  box.textContent = message;
  box.classList.toggle('error', isError);
  box.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (box.hidden = true), isError ? 4000 : 1600);
}

// Two-way binding for simple inputs. `to`/`from` convert between the
// config value and the input's value.
// `from` returns undefined for an invalid value, which restores the input.
interface BindOptions {
  to?: (value: unknown) => string;
  from?: (value: string) => unknown;
  event?: string;
}

function bind(id: string, key: keyof Config, { to = String, from = (v) => v, event = 'change' }: BindOptions = {}) {
  const input = $<HTMLInputElement | HTMLSelectElement>(id);
  const isCheck = input instanceof HTMLInputElement && input.type === 'checkbox';
  const fill = () => {
    if (isCheck) input.checked = !!config[key];
    else input.value = to(config[key]);
  };
  input.addEventListener(event, () => {
    const value = isCheck ? input.checked : from(input.value);
    if (value === undefined) return fill();
    save({ [key]: value } as Partial<Config>);
  });
  fillers.push(fill);
}
const fillers: (() => void)[] = [];

const num =
  (min: number, max = Infinity) =>
  (v: string) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
  };

// ---------- tonight: status + counters ----------

function fmtTime(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function renderStatus() {
  const status = getStatus();
  const stats = getStats();
  const paper = paperLeft(config);
  const items = [];
  if (status) {
    const printer = status.printer
      ? `${status.printer} — ${status.printerConnected ? 'connected' : '<strong class="bad">reconnecting</strong>'}`
      : 'no printer';
    const camera = status.camera === 'error' ? '<strong class="bad">not working</strong>' : (status.camera ?? '—');
    items.push(`Booth: printer ${printer}; camera ${camera} <span class="muted">(as of ${fmtTime(status.at)})</span>`);
    if (status.lastError) items.push(`Last problem: ${escapeHtml(status.lastError)}`);
  } else {
    items.push('Booth: not started on this device yet.');
  }
  if (paper) {
    const left = (paper.leftMm / 1000).toFixed(1);
    items.push(
      `Paper: ~${left} m of ${(paper.rollMm / 1000).toFixed(1)} m left` +
        (paper.low ? ' — <strong class="bad">low, change the roll soon</strong>' : '')
    );
  } else {
    const { usedMm, since } = getPaper();
    items.push(
      `Paper: ${(usedMm / 1000).toFixed(2)} m used${since ? ` since ${fmtTime(since)}` : ''} (roll not tracked)`
    );
  }
  const busiest = Object.entries(stats.byHour).sort((a, b) => b[1] - a[1])[0];
  items.push(
    `Event “${escapeHtml(eventKey(config))}”: <strong>${stats.sessions}</strong> sessions, ` +
      `<strong>${stats.prints}</strong> prints (${stats.stickers} stickers, ${(stats.printedMm / 1000).toFixed(2)} m), ` +
      `<strong>${stats.shares}</strong> shares` +
      (stats.failedPrints ? `, ${stats.failedPrints} failed prints` : '') +
      (busiest ? `; busiest hour ${busiest[0]}:00 (${busiest[1]})` : '')
  );
  $('status-list').innerHTML = items.map((html) => `<li>${html}</li>`).join('');
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
}

$<HTMLButtonElement>('new-roll').addEventListener('click', () => {
  newRoll();
  renderStatus();
  flashStatus('Paper meter reset ✓');
});
$<HTMLButtonElement>('reset-stats').addEventListener('click', () => {
  if (!confirm(`Reset the counters for “${eventKey(config)}”?`)) return;
  resetStats();
  renderStatus();
});
window.addEventListener('storage', (e) => {
  if (e.key?.startsWith('photoboot:status') || e.key?.startsWith('photoboot:stats')) renderStatus();
});

// ---------- event + profiles ----------

$<HTMLSelectElement>('language').replaceChildren(...LANGUAGES.map((l) => option(l.id, l.label)));
bind('event-name', 'eventName', { from: (v) => v.trim() });
bind('language', 'language');
$<HTMLInputElement>('event-name').addEventListener('change', () => {
  renderStatus();
  renderLocalPhotos();
});
$<HTMLSelectElement>('language').addEventListener('change', () => renderWording());

async function currentSetup(): Promise<Setup> {
  return { version: 1, name: config.eventName, config: portableConfig(config), images: await exportTemplateImages() };
}

async function applySetup(setup: Setup | undefined, extra: Partial<Config> = {}) {
  if (!setup?.config) throw new Error('Not a Photoboot setup file.');
  const keep = { printerType: config.printerType, serverEvent: config.serverEvent };
  resetConfig();
  config = setConfig({ ...portableConfig(setup.config), ...keep, ...extra });
  await importTemplateImages(setup.images ?? {});
  fillAll();
}

async function renderProfiles() {
  const keys = (await kv.keys()).filter((k) => typeof k === 'string' && k.startsWith('profile:'));
  const list = $<HTMLSelectElement>('profile-list');
  list.replaceChildren(...(keys.length ? keys.map((k) => option(k, k.slice(8))) : [option('', 'No saved setups')]));
  $<HTMLButtonElement>('profile-load').disabled = $<HTMLButtonElement>('profile-delete').disabled = !keys.length;
}

$<HTMLButtonElement>('profile-save').addEventListener('click', async () => {
  const name = prompt('Name for this setup:', config.eventName || '');
  if (!name?.trim()) return;
  await kv.set(`profile:${name.trim()}`, await currentSetup());
  await renderProfiles();
  $<HTMLSelectElement>('profile-list').value = `profile:${name.trim()}`;
  flashStatus('Setup saved ✓');
});
$<HTMLButtonElement>('profile-load').addEventListener('click', async () => {
  const key = $<HTMLSelectElement>('profile-list').value;
  if (!key || !confirm(`Replace the current settings with “${key.slice(8)}”?`)) return;
  await applySetup(await kv.get(key));
  flashStatus('Setup loaded ✓');
});
$<HTMLButtonElement>('profile-delete').addEventListener('click', async () => {
  const key = $<HTMLSelectElement>('profile-list').value;
  if (!key || !confirm(`Delete the saved setup “${key.slice(8)}”?`)) return;
  await kv.delete(key);
  await renderProfiles();
});

function download(blob: Blob, filename: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

$<HTMLButtonElement>('export-file').addEventListener('click', async () => {
  const setup = await currentSetup();
  download(
    new Blob([JSON.stringify(setup, null, 2)], { type: 'application/json' }),
    `photoboot-${eventKey(config)}.json`
  );
});
$<HTMLButtonElement>('import-file').addEventListener('click', () => $<HTMLInputElement>('import-picker').click());
$<HTMLInputElement>('import-picker').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  (e.target as HTMLInputElement).value = '';
  if (!file) return;
  try {
    const setup = JSON.parse(await file.text());
    if (!confirm('Replace the current settings with this file?')) return;
    await applySetup(setup);
    flashStatus('Setup imported ✓');
  } catch (err) {
    flashStatus(`Import failed: ${errorMessage(err)}`, true);
  }
});

// ---------- printer ----------

const printerItems = [
  { id: 'auto', label: 'Auto-detect', hint: 'Picks the right driver from the device name after you tap Connect.' },
  ...listPrinters().map((p) => ({ id: p.id, label: p.label, hint: p.hint })),
];
$<HTMLSelectElement>('printer-type').replaceChildren(...printerItems.map(({ id, label }) => option(id, label)));
bind('printer-type', 'printerType');
const printerHint = () =>
  ($('printer-hint').textContent =
    printerItems.find((i) => i.id === $<HTMLSelectElement>('printer-type').value)?.hint ?? '');
$<HTMLSelectElement>('printer-type').addEventListener('change', printerHint);
fillers.push(printerHint);

// ---------- paper ----------

const presetOptions = [...PAPER_PRESETS, { dots: -1, label: 'Custom…' }];
$<HTMLSelectElement>('paper-preset').replaceChildren(...presetOptions.map(({ dots, label }) => option(dots, label)));
// The raw width only shows for Custom…: most hosts just pick their roll.
const showWidth = () => ($('paper-width-field').hidden = $<HTMLSelectElement>('paper-preset').value !== '-1');
fillers.push(() => {
  const current = presetOptions.find((o) => o.dots === config.paperWidthDots);
  $<HTMLSelectElement>('paper-preset').value = String(current ? current.dots : -1);
  $<HTMLInputElement>('paper-width').value = String(config.paperWidthDots);
  showWidth();
});
$<HTMLSelectElement>('paper-preset').addEventListener('change', () => {
  const v = Number($<HTMLSelectElement>('paper-preset').value);
  showWidth();
  if (v > 0) {
    $<HTMLInputElement>('paper-width').value = String(v);
    save({ paperWidthDots: v });
  }
});
$<HTMLInputElement>('paper-width').addEventListener('change', (e) => {
  const v = parseInt((e.target as HTMLInputElement).value, 10);
  if (!Number.isFinite(v) || v <= 0 || v % 8 !== 0) {
    (e.target as HTMLInputElement).value = String(config.paperWidthDots);
    flashStatus('Width must be a positive multiple of 8.', true);
    return;
  }
  const match = PAPER_PRESETS.find((p) => p.dots === v);
  $<HTMLSelectElement>('paper-preset').value = String(match ? match.dots : -1);
  save({ paperWidthDots: v });
});
bind('density', 'printDensity', { from: Number });
const metres: BindOptions = {
  to: (mm) => String((Number(mm) || 0) / 1000),
  from: (v) => (num(0)(v) === undefined ? undefined : Math.round(Number(v) * 1000)),
};
bind('roll-length', 'rollLengthMm', metres);
bind('paper-warn', 'paperWarnMm', metres);
for (const id of ['roll-length', 'paper-warn']) $(id).addEventListener('change', renderStatus);

// ---------- printing + capture ----------

bind('auto-print', 'autoPrint');
bind('copies', 'copies', { from: Number });
bind('max-prints', 'maxPrintsPerSession', { from: Number });
bind('shot-count', 'shotCount', { from: Number });
bind('guest-shot-choice', 'guestShotChoice');
bind('default-delay', 'defaultDelay', { from: Number });
bind('tap-anywhere', 'tapAnywhere');
bind('sound', 'sound');

// ---------- looks ----------

bind('filter-enabled', 'filterEnabled');
bind('live-preview', 'livePreview');
const LOOK_SETTINGS: {
  boxId: string;
  key: 'allowedStyles' | 'allowedTwists';
  list: { id: string; label: string }[];
  defaultId: string;
  defaultKey: 'defaultStyle' | 'defaultTwist';
}[] = [
  {
    boxId: 'allowed-styles',
    key: 'allowedStyles',
    list: PHOTO_STYLES,
    defaultId: 'default-style',
    defaultKey: 'defaultStyle',
  },
  {
    boxId: 'allowed-twists',
    key: 'allowedTwists',
    list: PHOTO_TWISTS,
    defaultId: 'default-twist',
    defaultKey: 'defaultTwist',
  },
];

function renderLooks() {
  $('looks-config').hidden = !config.filterEnabled;
  for (const { boxId, key, list, defaultId, defaultKey } of LOOK_SETTINGS) {
    const allowed = config[key] ?? list.map((o) => o.id);
    $(boxId).replaceChildren(
      ...list.map((o) => {
        const label = document.createElement('label');
        label.className = 'checkbox';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = allowed.includes(o.id);
        input.addEventListener('change', () => {
          const next = list.map((x) => x.id).filter((id) => (id === o.id ? input.checked : allowed.includes(id)));
          if (!next.length) {
            input.checked = true;
            flashStatus('Keep at least one.', true);
            return;
          }
          save({ [key]: next.length === list.length ? null : next });
          renderLooks();
        });
        label.append(input, ` ${o.label}`);
        return label;
      })
    );
    const select = $<HTMLSelectElement>(defaultId);
    select.replaceChildren(...list.filter((o) => allowed.includes(o.id)).map((o) => option(o.id, o.label)));
    select.value = allowed.includes(config[defaultKey]) ? config[defaultKey] : allowed[0];
  }
}
$<HTMLInputElement>('filter-enabled').addEventListener('change', renderLooks);
$<HTMLSelectElement>('default-style').addEventListener('change', (e) =>
  save({ defaultStyle: (e.target as HTMLInputElement).value })
);
$<HTMLSelectElement>('default-twist').addEventListener('change', (e) =>
  save({ defaultTwist: (e.target as HTMLInputElement).value })
);
fillers.push(renderLooks);

// ---------- template ----------

$<HTMLSelectElement>('template-id').replaceChildren(...BUILT_IN_TEMPLATES.map(({ id, label }) => option(id, label)));
bind('template-id', 'templateId');
$<HTMLSelectElement>('template-id').addEventListener('change', () => renderTemplateConfig());
fillers.push(() => renderTemplateConfig());

function renderTemplateConfig() {
  const box = $('template-config');
  box.replaceChildren();
  if (config.templateId === 'custom') renderCustomConfig(box);
  if (config.templateId === 'text') renderTextConfig(box);
}

function renderTextConfig(box: HTMLElement) {
  const current = { ...TEXT_DEFAULTS, ...config.templateConfig?.text };
  const update = (key: keyof TextTemplateConfig, value: string) =>
    save({
      templateConfig: {
        ...config.templateConfig,
        text: { ...TEXT_DEFAULTS, ...config.templateConfig?.text, [key]: value },
      },
    });
  const field = (key: keyof TextTemplateConfig, label: string, placeholder: string) => {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = placeholder;
    input.value = current[key];
    input.addEventListener('change', () => update(key, input.value));
    wrap.append(input);
    return wrap;
  };
  const fontWrap = document.createElement('label');
  fontWrap.textContent = 'Font';
  const font = document.createElement('select');
  font.append(...TEXT_FONTS.map((f) => option(f.id, f.label)));
  font.value = current.font;
  font.addEventListener('change', () => update('font', font.value));
  fontWrap.append(font);
  const hint = document.createElement('p');
  hint.className = 'muted small';
  hint.textContent = 'Empty lines are left out. Check the result in Print preview.';
  box.append(
    field('title', 'Title above the photo', 'Happy birthday Emma!'),
    field('line1', 'Big line below the photo', 'Anna & Tom'),
    field('line2', 'Small line below that', '12 · 10 · 2026 · #AnnaTom'),
    fontWrap,
    hint
  );
}

function renderCustomConfig(box: HTMLElement) {
  const wrap = document.createElement('div');
  wrap.className = 'template-slots';
  wrap.append(templateSlot('header', 'Header image'), templateSlot('footer', 'Footer image'));
  box.append(wrap);
  const hint = document.createElement('p');
  hint.className = 'muted small';
  hint.textContent =
    'Both are optional. Images are scaled to the sticker width (' +
    config.paperWidthDots +
    ' dots) and dithered when printed. PNG, JPG, or SVG. Big transparent areas work.';
  box.append(hint);
}

function templateSlot(slot: Slot, title: string) {
  const box = document.createElement('div');
  box.className = 'template-slot';
  const h = document.createElement('h3');
  h.textContent = title;
  const img = document.createElement('img');
  img.alt = title;
  const row = document.createElement('div');
  row.className = 'row';
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = 'image/*';
  picker.hidden = true;
  const uploadBtn = document.createElement('button');
  uploadBtn.textContent = 'Upload';
  uploadBtn.addEventListener('click', () => picker.click());
  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Remove';
  clearBtn.addEventListener('click', async () => {
    await clearTemplateImage(slot);
    await refreshPreview();
  });
  row.append(uploadBtn, clearBtn, picker);
  box.append(h, img, row);

  picker.addEventListener('change', async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0];
    if (!file) return;
    await saveTemplateImage(slot, file);
    (e.target as HTMLInputElement).value = '';
    await refreshPreview();
    flashStatus('Image saved ✓');
  });

  async function refreshPreview() {
    const has = await hasTemplateImage(slot);
    img.hidden = !has;
    clearBtn.disabled = !has;
    if (has) img.src = (await templateImageUrl(slot)) ?? '';
    else img.removeAttribute('src');
  }
  refreshPreview();
  return box;
}

// ---------- guest screens ----------

bind('review-timeout', 'reviewTimeoutSec', { from: num(10) });
bind('done-timeout', 'doneTimeoutSec', { from: num(5) });
bind('attract-after', 'attractAfterSec', { from: num(0) });
bind('attract-photos', 'attractShowPhotos');

function renderWording() {
  const lang = STRINGS[config.language] ?? STRINGS.en;
  $('wording').replaceChildren(
    ...STRING_KEYS.map((key) => {
      const label = document.createElement('label');
      label.textContent = `“${STRINGS.en[key]}”`;
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = lang[key];
      input.value = config.texts?.[key] ?? '';
      input.addEventListener('change', () => {
        const texts = { ...config.texts, [key]: input.value };
        if (!input.value.trim()) delete texts[key];
        save({ texts });
      });
      label.append(input);
      return label;
    })
  );
}
fillers.push(renderWording);

// ---------- local photos ----------

bind('keep-local', 'keepLocalCopies');

async function renderLocalPhotos() {
  const counts = await photoEvents().catch((): Record<string, number> => ({}));
  const current = eventKey(config);
  const items = [`This event (“${escapeHtml(current)}”): <strong>${counts[current] ?? 0}</strong> photos`];
  for (const [ev, n] of Object.entries(counts)) if (ev !== current) items.push(`${escapeHtml(ev)}: ${n} photos`);
  $('local-photos').innerHTML = items.map((html) => `<li>${html}</li>`).join('');
  $<HTMLButtonElement>('download-zip').disabled = $<HTMLButtonElement>('delete-local').disabled = !counts[current];
}

$<HTMLButtonElement>('download-zip').addEventListener('click', async () => {
  $<HTMLButtonElement>('download-zip').disabled = true;
  flashStatus('Building ZIP…');
  try {
    const { count, blob } = await exportZip();
    download(blob, `photoboot-${eventKey(config)}.zip`);
    flashStatus(`ZIP with ${count} photos ✓`);
  } catch (err) {
    flashStatus(`ZIP failed: ${errorMessage(err)}`, true);
  } finally {
    $<HTMLButtonElement>('download-zip').disabled = false;
  }
});
$<HTMLButtonElement>('delete-local').addEventListener('click', async () => {
  if (!confirm(`Delete all photos of “${eventKey(config)}” from this device? Download the ZIP first.`)) return;
  await deletePhotos();
  renderLocalPhotos();
});

// ---------- server event (online gallery) ----------
// Managing events is the owner's job, in /admin. A booth only joins one
// with its setup link, saves its setup to it, or leaves it.

bind('upload-token', 'uploadToken', { from: (v) => v.trim() });

function renderServerEvent() {
  const ev = config.serverEvent;
  $('server-event').innerHTML = ev?.id
    ? `This booth is part of <strong>${escapeHtml(ev.name || ev.id)}</strong>: shared photos go to its online gallery.`
    : '';
  $('event-joined').hidden = !ev?.id;
  $('event-join').hidden = !!ev?.id;
}
fillers.push(renderServerEvent);

$<HTMLButtonElement>('save-to-event').addEventListener('click', async () => {
  const ev = config.serverEvent;
  if (!ev?.id) return;
  if (!confirm(`Save this booth's setup to “${ev.name || ev.id}”? Booths that open its setup link get it.`)) return;
  try {
    await remote.saveEvent(ev.id, ev.key, await currentSetup());
    flashStatus('Saved to the event ✓');
  } catch (err) {
    flashStatus(`Couldn't save: ${errorMessage(err)}`, true);
  }
});
$<HTMLButtonElement>('use-setup-link').addEventListener('click', () =>
  importSetupLink($<HTMLInputElement>('setup-link').value)
);
$<HTMLButtonElement>('leave-event').addEventListener('click', () => {
  if (!confirm('Disconnect this booth from the event? Settings stay as they are.')) return;
  save({ serverEvent: null });
  renderServerEvent();
  renderStatus();
});

// Setup QR: /settings.html#event=<id>.<setupKey>
// Setup QR / link: …/settings.html#event=<id>.<setupKey>. Opened directly
// in a browser, or pasted on a device where the link opens elsewhere (the
// app: the camera's QR scanner opens Safari).
const SETUP_LINK = /#event=([\w-]+)\.([\w-]+)$/;

async function importFromHash() {
  if (!SETUP_LINK.test(location.hash)) return;
  const link = location.hash;
  history.replaceState(null, '', location.pathname);
  await importSetupLink(link);
}

async function importSetupLink(link: string): Promise<boolean> {
  const m = link.trim().match(SETUP_LINK);
  const notice = $('import-status');
  notice.classList.remove('warn');
  if (!m) {
    notice.hidden = false;
    notice.textContent = "That isn't a setup link. It ends in #event=…";
    notice.classList.add('warn');
    return false;
  }
  notice.hidden = false;
  notice.textContent = 'Loading the event setup…';
  try {
    const setup = await remote.loadEvent(m[1], m[2]);
    await applySetup(setup, { serverEvent: { id: m[1], key: m[2], name: setup.name } });
    notice.textContent = `This booth is now set up for “${setup.name}”. Go back to the booth to start.`;
    return true;
  } catch (err) {
    notice.textContent = `Couldn't load the event: ${errorMessage(err)}`;
    notice.classList.add('warn');
    return false;
  }
}

// ---------- buying an event gallery (iOS app: Apple in-app purchase) ----------
// The web keeps its link to /event.html (Stripe). In the iOS app Apple
// requires in-app purchase: src/purchase.ts talks to StoreKit and the server.

const purchaseModule = () => import('./purchase.ts');

function buyStatus(text: string, warn = false) {
  const box = $('buy-status');
  box.textContent = text;
  box.classList.toggle('warn', warn);
  box.hidden = !text;
}

// The server confirmed a purchase: join the event and show its gallery link.
async function delivered(event: PurchasedEvent) {
  $<HTMLInputElement>('gallery-link').value = event.galleryLink;
  $('event-bought').hidden = false;
  const joined = await importSetupLink(event.setupLink);
  buyStatus(
    joined
      ? `Paid ✓ This booth is set up for “${event.eventName}”. The links are in your email too.`
      : `Paid ✓ “${event.eventName}” is ready, but this booth couldn't load it yet: open the setup link from the email.`,
    !joined
  );
  renderServerEvent();
}

async function redeemUnfinished(manual: boolean) {
  const { redeemUnfinished } = await purchaseModule();
  const { redeemed, failed } = await redeemUnfinished();
  const last = redeemed.at(-1);
  if (last) await delivered(last);
  if (failed.length)
    buyStatus(`A purchase couldn't be confirmed yet (${failed[0]}). Try "Restore unfinished purchase" later.`, true);
  else if (manual && !last) buyStatus('No unfinished purchases on this device.');
}

let appPurchaseReady = false;
async function setupAppPurchase() {
  if (!isIosApp || appPurchaseReady) return;
  appPurchaseReady = true;
  $('event-buy-web').hidden = true;
  $('event-buy-app').hidden = false;
  if (!$<HTMLInputElement>('buy-name').value) $<HTMLInputElement>('buy-name').value = config.eventName || '';
  const p = await purchaseModule();
  // Ask to Buy approved (or another late delivery) while settings are open.
  p.onTransactionDelivered((tx) => {
    p.redeem(tx).then(delivered, (err) => buyStatus(`Couldn't confirm the purchase: ${errorMessage(err)}`, true));
  });
  const button = $<HTMLButtonElement>('buy-gallery');
  try {
    const price = await p.productPrice();
    if (!price) throw new Error('product not found');
    button.textContent = `Buy — ${price}`;
    button.disabled = false;
  } catch {
    buyStatus("The App Store isn't reachable right now. Check the internet connection and reopen settings.", true);
  }
  await redeemUnfinished(false).catch(() => {});
}

$<HTMLButtonElement>('buy-gallery').addEventListener('click', async () => {
  const name = $<HTMLInputElement>('buy-name').value.trim();
  const email = $<HTMLInputElement>('buy-email').value.trim();
  const eventDate = $<HTMLInputElement>('buy-date').value || null;
  if (!name) return buyStatus('Give the event a name first.', true);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return buyStatus('Enter the email address for the links.', true);
  const button = $<HTMLButtonElement>('buy-gallery');
  button.disabled = true;
  buyStatus('Opening the App Store…');
  try {
    const { buyEventGallery } = await purchaseModule();
    const result = await buyEventGallery({ name, email, eventDate });
    if (result.status === 'cancelled') buyStatus('Purchase cancelled. Nothing was charged.');
    else if (result.status === 'pending')
      buyStatus(
        'Waiting for approval (Ask to Buy). Once it’s approved, open these settings again and the booth sets itself up; the links also arrive by email.'
      );
    else await delivered(result.event);
  } catch (err) {
    buyStatus(
      `Couldn't finish: ${errorMessage(err)} If you were charged, nothing is lost: tap “Restore unfinished purchase” once you're online.`,
      true
    );
  } finally {
    button.disabled = false;
  }
});

$<HTMLButtonElement>('restore-purchase').addEventListener('click', async () => {
  const button = $<HTMLButtonElement>('restore-purchase');
  button.disabled = true;
  buyStatus('Looking for unfinished purchases…');
  try {
    await redeemUnfinished(true);
  } catch (err) {
    buyStatus(`Couldn't restore: ${errorMessage(err)}`, true);
  } finally {
    button.disabled = false;
  }
});

$<HTMLButtonElement>('copy-gallery').addEventListener('click', async () => {
  const input = $<HTMLInputElement>('gallery-link');
  try {
    await navigator.clipboard.writeText(input.value);
    flashStatus('Gallery link copied ✓');
  } catch {
    input.select(); // the host can copy it by hand
  }
});
$<HTMLButtonElement>('share-gallery').addEventListener('click', () => {
  const url = $<HTMLInputElement>('gallery-link').value;
  if (navigator.share) navigator.share({ title: 'Photo booth gallery', url }).catch(() => {});
  else $<HTMLButtonElement>('copy-gallery').click();
});

// ---------- security: PIN + kiosk lock ----------

function renderSecurity() {
  $('pin-status').innerHTML = hasPin(config)
    ? 'A PIN is set. ✓'
    : '<strong class="bad">No PIN yet</strong>: any guest can open these settings or stop the booth.';
  const kiosk = kioskState();
  $('kiosk-status').innerHTML = kiosk
    ? `The booth is <strong>running</strong> on this device since ${fmtTime(kiosk.since)}, ` +
      (kiosk.printer ? `with printer ${escapeHtml(kiosk.printer.name || kiosk.printer.id)}.` : 'without printer.')
    : 'The booth is not running on this device: it opens on the “Connect printer” screen.';
  $<HTMLButtonElement>('stop-booth').disabled = !kiosk;
}
fillers.push(renderSecurity);

$<HTMLButtonElement>('set-pin').addEventListener('click', async () => {
  const pin = $<HTMLInputElement>('admin-password').value;
  save({ adminPasswordHash: pin ? await pinHash(pin) : '', adminPassword: '' });
  $<HTMLInputElement>('admin-password').value = '';
  if (pin) setAdminUnlocked(true);
  renderSecurity();
  flashStatus(pin ? 'PIN set ✓' : 'PIN removed ✓');
});

$<HTMLButtonElement>('stop-booth').addEventListener('click', () => {
  if (!confirm('Stop the booth? The next time it opens, it shows the “Connect printer” screen.')) return;
  unlockKiosk();
  renderSecurity();
  flashStatus('Booth stopped ✓');
});
window.addEventListener('storage', (e) => {
  if (e.key === 'photoboot:kiosk') renderSecurity();
});

// The jump link opens the collapsed Advanced section.
document.querySelector('.jump a[href="#advanced"]')?.addEventListener('click', () => {
  $<HTMLDetailsElement>('advanced').open = true;
});

$<HTMLButtonElement>('reset').addEventListener('click', async () => {
  if (!confirm('Reset all settings and remove uploaded template images?')) return;
  await clearTemplateImage('header').catch(() => {});
  await clearTemplateImage('footer').catch(() => {});
  setAdminUnlocked(false);
  config = resetConfig();
  fillAll();
  flashStatus('Reset ✓');
});

// ---------- start ----------

function fillAll() {
  config = getConfig();
  for (const fill of fillers) fill();
  renderStatus();
  renderLocalPhotos();
}

function start() {
  if (locked()) {
    $('auth').hidden = false;
    $('panels').hidden = true;
    return;
  }
  $('auth').hidden = true;
  $('panels').hidden = false;
  fillAll();
  renderProfiles();
  importFromHash();
  setupAppPurchase().catch((err) => buyStatus(errorMessage(err), true));
}

// Fills in keys added since the stored config was written.
for (const key of Object.keys(DEFAULTS)) {
  const k = key as keyof Config;
  if (config[k] === undefined) config = setConfig({ [k]: DEFAULTS[k] } as Partial<Config>);
}

start();
