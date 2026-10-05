// Admin settings page. Reads/writes the config in src/config.js, manages
// template images, saved setups (profiles), server events, local photos and
// shows the booth's health and counters.
//
// Access control is intentionally light: an optional PIN gate (hashed). The
// hidden long-presses in the booth (and /?admin=1) are the only entry points —
// this URL isn't linked from anywhere public.

import qrcode from 'qrcode-generator';
import { deletePhotos, exportZip, photoEvents } from './archive.ts';
import { DEFAULTS, PAPER_PRESETS, eventKey, getConfig, portableConfig, resetConfig, setConfig } from './config.ts';
import { LANGUAGES, STRINGS, STRING_KEYS } from './i18n.ts';
import { PHOTO_STYLES, PHOTO_TWISTS } from './photo.ts';
import { listPrinters } from './printers/index.ts';
import { galleryUrl, getAdminToken, remote, setAdminToken, setupUrl } from './remote.ts';
import { getPaper, getStats, getStatus, newRoll, paperLeft, resetStats } from './stats.ts';
import { kv } from './storage.ts';
import {
  BUILT_IN_TEMPLATES,
  TEXT_DEFAULTS,
  TEXT_FONTS,
  clearTemplateImage,
  exportTemplateImages,
  hasTemplateImage,
  importTemplateImages,
  saveTemplateImage,
  templateImageUrl,
} from './templates.ts';
import { $, errorMessage, option } from './dom.ts';
import type { Config, TextTemplateConfig } from './config.ts';
import type { EventSummary, Setup } from './remote.ts';
import type { Slot } from './templates.ts';


let config = getConfig();


// ---------- auth ----------

const AUTH_KEY = 'photoboot:admin-ok';

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const pinHash = (pin: string) => sha256(`photoboot:${pin}`);

function locked() {
  return (config.adminPasswordHash || config.adminPassword) && sessionStorage.getItem(AUTH_KEY) !== '1';
}

async function checkPin(pin: string): Promise<boolean> {
  if (config.adminPasswordHash) return (await pinHash(pin)) === config.adminPasswordHash;
  return pin === config.adminPassword; // pre-hash configs
}

$<HTMLButtonElement>('auth-submit').addEventListener('click', async () => {
  if (await checkPin($<HTMLInputElement>('auth-password').value)) {
    sessionStorage.setItem(AUTH_KEY, '1');
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

const num = (min: number, max = Infinity) => (v: string) => {
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
    const camera = status.camera === 'error' ? '<strong class="bad">not working</strong>' : status.camera ?? '—';
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
    items.push(`Paper: ${(usedMm / 1000).toFixed(2)} m used${since ? ` since ${fmtTime(since)}` : ''} (roll not tracked)`);
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
  download(new Blob([JSON.stringify(setup, null, 2)], { type: 'application/json' }), `photoboot-${eventKey(config)}.json`);
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
  ($('printer-hint').textContent = printerItems.find((i) => i.id === $<HTMLSelectElement>('printer-type').value)?.hint ?? '');
$<HTMLSelectElement>('printer-type').addEventListener('change', printerHint);
fillers.push(printerHint);

// ---------- paper ----------

const presetOptions = [...PAPER_PRESETS, { dots: -1, label: 'Custom…' }];
$<HTMLSelectElement>('paper-preset').replaceChildren(...presetOptions.map(({ dots, label }) => option(dots, label)));
fillers.push(() => {
  const current = presetOptions.find((o) => o.dots === config.paperWidthDots);
  $<HTMLSelectElement>('paper-preset').value = String(current ? current.dots : -1);
  $<HTMLInputElement>('paper-width').value = String(config.paperWidthDots);
});
$<HTMLSelectElement>('paper-preset').addEventListener('change', () => {
  const v = Number($<HTMLSelectElement>('paper-preset').value);
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
  { boxId: 'allowed-styles', key: 'allowedStyles', list: PHOTO_STYLES, defaultId: 'default-style', defaultKey: 'defaultStyle' },
  { boxId: 'allowed-twists', key: 'allowedTwists', list: PHOTO_TWISTS, defaultId: 'default-twist', defaultKey: 'defaultTwist' },
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
$<HTMLSelectElement>('default-style').addEventListener('change', (e) => save({ defaultStyle: (e.target as HTMLInputElement).value }));
$<HTMLSelectElement>('default-twist').addEventListener('change', (e) => save({ defaultTwist: (e.target as HTMLInputElement).value }));
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
    save({ templateConfig: { ...config.templateConfig, text: { ...TEXT_DEFAULTS, ...config.templateConfig?.text, [key]: value } } });
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
      label.textContent = key;
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

// ---------- server events ----------

bind('upload-token', 'uploadToken', { from: (v) => v.trim() });
$<HTMLInputElement>('admin-token').value = getAdminToken();
$<HTMLInputElement>('admin-token').addEventListener('change', (e) => {
  setAdminToken((e.target as HTMLInputElement).value.trim());
  refreshEvents();
});

function renderServerEvent() {
  const ev = config.serverEvent;
  $('server-event').innerHTML = ev?.id
    ? `This booth is part of server event <strong>${escapeHtml(ev.name || ev.id)}</strong>.`
    : 'This booth is not linked to a server event.';
  $<HTMLButtonElement>('leave-event').hidden = !ev?.id;
}
fillers.push(renderServerEvent);

function showQr(title: string, url: string) {
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const box = $('event-qr');
  box.innerHTML = `<p><strong>${escapeHtml(title)}</strong></p>${qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true })}<p class="small"><a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a></p>`;
  box.hidden = false;
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function refreshEvents() {
  const list = $('event-list');
  list.replaceChildren();
  if (!getAdminToken()) return;
  try {
    const { events } = await remote.listEvents();
    if (!events.length) list.innerHTML = '<li class="muted">No events on the server yet.</li>';
    for (const ev of events) {
      const li = document.createElement('li');
      const current = config.serverEvent?.id === ev.id;
      li.innerHTML =
        `<div><strong>${escapeHtml(ev.name || ev.id)}</strong>${current ? ' <span class="tag">this booth</span>' : ''}<br>` +
        `<span class="muted small">${ev.photos} shared photos · ${ev.stats.sessions} sessions · ${ev.stats.prints} prints · created ${fmtTime(ev.created)}</span></div>`;
      const row = document.createElement('div');
      row.className = 'row';
      const btn = (label: string, fn: () => unknown, cls = '') => {
        const b = document.createElement('button');
        b.textContent = label;
        if (cls) b.className = cls;
        b.addEventListener('click', fn);
        row.append(b);
      };
      btn('Setup QR', () => showQr(`Scan on a booth device to set it up as “${ev.name}”`, setupUrl(ev.id, ev.setupKey)));
      btn('Gallery', () => showQr(`Gallery for “${ev.name}” — share with the host`, galleryUrl(ev.id, ev.galleryKey)));
      btn('Use here', () => useEvent(ev));
      btn('Overwrite with current setup', async () => {
        if (!confirm(`Replace the setup of “${ev.name}” on the server with this page's settings?`)) return;
        await remote.updateEvent(ev.id, await currentSetup());
        flashStatus('Event updated ✓');
        refreshEvents();
      });
      btn(
        'Delete',
        async () => {
          if (!confirm(`Delete “${ev.name}” and all its shared photos from the server? This can't be undone.`)) return;
          await remote.deleteEvent(ev.id);
          if (config.serverEvent?.id === ev.id) save({ serverEvent: null });
          renderServerEvent();
          refreshEvents();
        },
        'danger'
      );
      li.append(row);
      list.append(li);
    }
  } catch (err) {
    list.innerHTML = `<li class="warn">Couldn't list events: ${escapeHtml(errorMessage(err))}</li>`;
  }
}

async function useEvent(ev: EventSummary) {
  const setup = await remote.loadEvent(ev.id, ev.setupKey);
  await applySetup(setup, { serverEvent: { id: ev.id, key: ev.setupKey, name: setup.name } });
  flashStatus(`This booth now runs “${setup.name}” ✓`);
  refreshEvents();
}

$<HTMLButtonElement>('publish-event').addEventListener('click', async () => {
  if (!getAdminToken()) return flashStatus('Enter the server admin token first.', true);
  const name = prompt('Event name on the server:', config.eventName || '');
  if (!name?.trim()) return;
  try {
    if (!config.eventName) save({ eventName: name.trim() });
    const setup = { ...(await currentSetup()), name: name.trim() };
    const ev = await remote.createEvent(setup);
    save({ serverEvent: { id: ev.id, key: ev.setupKey, name: ev.name } });
    renderServerEvent();
    renderStatus();
    showQr(`Scan on a booth device to set it up as “${ev.name}”`, setupUrl(ev.id, ev.setupKey));
    refreshEvents();
  } catch (err) {
    flashStatus(`Publish failed: ${errorMessage(err)}`, true);
  }
});
$<HTMLButtonElement>('refresh-events').addEventListener('click', refreshEvents);
$<HTMLButtonElement>('leave-event').addEventListener('click', () => {
  if (!confirm('Unlink this booth from its server event? Settings stay as they are.')) return;
  save({ serverEvent: null });
  renderServerEvent();
  renderStatus();
  refreshEvents();
});

// Setup QR: /settings.html#event=<id>.<setupKey>
async function importFromHash() {
  const m = location.hash.match(/^#event=([\w-]+)\.([\w-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname);
  const notice = $('import-status');
  notice.hidden = false;
  notice.textContent = 'Loading the event setup…';
  try {
    const setup = await remote.loadEvent(m[1], m[2]);
    await applySetup(setup, { serverEvent: { id: m[1], key: m[2], name: setup.name } });
    notice.textContent = `This booth is now set up for “${setup.name}”. Go back to the booth to start.`;
  } catch (err) {
    notice.textContent = `Couldn't load the event: ${errorMessage(err)}`;
    notice.classList.add('warn');
  }
}

// ---------- admin ----------

$<HTMLButtonElement>('set-pin').addEventListener('click', async () => {
  const pin = $<HTMLInputElement>('admin-password').value;
  save({ adminPasswordHash: pin ? await pinHash(pin) : '', adminPassword: '' });
  $<HTMLInputElement>('admin-password').value = '';
  if (pin) sessionStorage.setItem(AUTH_KEY, '1');
  flashStatus(pin ? 'PIN set ✓' : 'PIN removed ✓');
});

$<HTMLButtonElement>('reset').addEventListener('click', async () => {
  if (!confirm('Reset all settings and remove uploaded template images?')) return;
  await clearTemplateImage('header').catch(() => {});
  await clearTemplateImage('footer').catch(() => {});
  sessionStorage.removeItem(AUTH_KEY);
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
  refreshEvents();
  importFromHash();
}

// Fills in keys added since the stored config was written.
for (const key of Object.keys(DEFAULTS)) {
  const k = key as keyof Config;
  if (config[k] === undefined) config = setConfig({ [k]: DEFAULTS[k] } as Partial<Config>);
}

start();
