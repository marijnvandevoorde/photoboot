// Admin settings page. Reads/writes the config in src/config.js, lets the
// admin pick a printer type, paper width, template, shot count, and manage
// uploaded header/footer images.
//
// Access control is intentionally light: an optional password gate. The
// hidden long-press on the booth title (and /?admin=1) are the only entry
// points — this URL isn't linked from anywhere public.

import { DEFAULTS, PAPER_PRESETS, getConfig, resetConfig, setConfig } from './config.js';
import { listPrinters } from './printers/index.js';
import {
  BUILT_IN_TEMPLATES,
  clearTemplateImage,
  hasTemplateImage,
  saveTemplateImage,
  templateImageUrl,
} from './templates.js';

const $ = (id) => document.getElementById(id);

let config = getConfig();

// ---------- auth ----------

const AUTH_KEY = 'photoboot:admin-ok';
function unlocked() {
  return !config.adminPassword || sessionStorage.getItem(AUTH_KEY) === '1';
}

function render() {
  if (!unlocked()) {
    $('auth').hidden = false;
    $('panels').hidden = true;
    return;
  }
  $('auth').hidden = true;
  $('panels').hidden = false;
  renderPrinter();
  renderPaper();
  renderCapture();
  renderTemplate();
  renderAdmin();
}

$('auth-submit').addEventListener('click', () => {
  if ($('auth-password').value === config.adminPassword) {
    sessionStorage.setItem(AUTH_KEY, '1');
    $('auth-error').hidden = true;
    render();
  } else {
    $('auth-error').hidden = false;
  }
});
$('auth-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('auth-submit').click();
});

// ---------- printer ----------

function renderPrinter() {
  const select = $('printer-type');
  const items = [
    { id: 'auto', label: 'Auto-detect', hint: 'Picks the right driver from the device name after you tap Connect.' },
    ...listPrinters().map((p) => ({ id: p.id, label: p.label, hint: p.hint })),
  ];
  select.replaceChildren(
    ...items.map(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      return opt;
    })
  );
  select.value = config.printerType;
  $('printer-hint').textContent = items.find((i) => i.id === select.value)?.hint ?? '';
  select.addEventListener('change', () => {
    save({ printerType: select.value });
    $('printer-hint').textContent = items.find((i) => i.id === select.value)?.hint ?? '';
  });
}

// ---------- paper ----------

function renderPaper() {
  const preset = $('paper-preset');
  const custom = { dots: -1, label: 'Custom…', note: '' };
  const options = [...PAPER_PRESETS, custom];
  preset.replaceChildren(
    ...options.map(({ dots, label }) => {
      const opt = document.createElement('option');
      opt.value = String(dots);
      opt.textContent = label;
      return opt;
    })
  );
  const current = options.find((o) => o.dots === config.paperWidthDots);
  preset.value = String(current ? current.dots : -1);
  $('paper-width').value = String(config.paperWidthDots);

  preset.addEventListener('change', () => {
    const v = Number(preset.value);
    if (v > 0) {
      $('paper-width').value = String(v);
      save({ paperWidthDots: v });
    }
  });
  $('paper-width').addEventListener('change', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!Number.isFinite(v) || v <= 0 || v % 8 !== 0) {
      e.target.value = String(config.paperWidthDots);
      flashStatus('Width must be a positive multiple of 8.', true);
      return;
    }
    const match = PAPER_PRESETS.find((p) => p.dots === v);
    preset.value = String(match ? match.dots : -1);
    save({ paperWidthDots: v });
  });

  $('density').value = String(config.printDensity);
  $('density').addEventListener('change', (e) => save({ printDensity: Number(e.target.value) }));
}

// ---------- capture ----------

function renderCapture() {
  $('shot-count').value = String(config.shotCount);
  $('shot-count').addEventListener('change', (e) => save({ shotCount: Number(e.target.value) }));
  $('default-delay').value = String(config.defaultDelay);
  $('default-delay').addEventListener('change', (e) => save({ defaultDelay: Number(e.target.value) }));
  $('filter-enabled').checked = !!config.filterEnabled;
  $('filter-enabled').addEventListener('change', (e) => save({ filterEnabled: e.target.checked }));
}

// ---------- template ----------

function renderTemplate() {
  const select = $('template-id');
  select.replaceChildren(
    ...BUILT_IN_TEMPLATES.map(({ id, label }) => {
      const opt = document.createElement('option');
      opt.value = id;
      opt.textContent = label;
      return opt;
    })
  );
  select.value = config.templateId;
  select.addEventListener('change', () => {
    save({ templateId: select.value });
    renderTemplateConfig(select.value);
  });
  renderTemplateConfig(config.templateId);
}

function renderTemplateConfig(id) {
  const box = $('template-config');
  box.replaceChildren();
  if (id === 'custom') renderCustomConfig(box);
}

function renderCustomConfig(box) {
  const wrap = document.createElement('div');
  wrap.className = 'template-slots';
  wrap.append(templateSlot('header', 'Header image'), templateSlot('footer', 'Footer image'));
  box.append(wrap);
  const hint = document.createElement('p');
  hint.className = 'muted small';
  hint.textContent =
    'Images are scaled to the sticker width (' +
    config.paperWidthDots +
    ' dots) and dithered when printed. PNG, JPG, or SVG. Big transparent areas work.';
  box.append(hint);
}

function templateSlot(slot, title) {
  const el = document.createElement('div');
  el.className = 'template-slot';

  const h = document.createElement('h3');
  h.textContent = title;
  el.append(h);

  const img = document.createElement('img');
  img.alt = title;
  el.append(img);

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
  el.append(row);

  picker.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await saveTemplateImage(slot, file);
    e.target.value = '';
    await refreshPreview();
  });

  async function refreshPreview() {
    const has = await hasTemplateImage(slot);
    img.hidden = !has;
    clearBtn.disabled = !has;
    if (has) {
      const url = await templateImageUrl(slot);
      // The previous object URL leaks a few bytes; that's fine on a settings
      // page the admin visits briefly.
      img.src = url;
    } else {
      img.removeAttribute('src');
    }
  }
  refreshPreview();

  return el;
}

// ---------- admin ----------

function renderAdmin() {
  $('admin-password').value = config.adminPassword ?? '';
  $('admin-password').addEventListener('change', (e) => save({ adminPassword: e.target.value }));
  $('reset').addEventListener('click', async () => {
    if (!confirm('Reset all settings and remove uploaded template images?')) return;
    await clearTemplateImage('header').catch(() => {});
    await clearTemplateImage('footer').catch(() => {});
    sessionStorage.removeItem(AUTH_KEY);
    resetConfig();
    config = getConfig();
    render();
    flashStatus('Reset.', false);
  });
}

// ---------- save ----------

function save(updates) {
  config = setConfig(updates);
  flashStatus('Saved.', false);
}

let statusTimer = null;
function flashStatus(message, isError) {
  const el = $('save-status');
  el.textContent = message;
  el.style.color = isError ? 'var(--warn)' : 'var(--muted)';
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (el.textContent = ''), 2000);
}

// Falls back to defaults if the stored config predates a new key.
for (const key of Object.keys(DEFAULTS)) {
  if (config[key] === undefined) config = setConfig({ [key]: DEFAULTS[key] });
}

render();
