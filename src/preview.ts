// Print preview page. Takes a sample photo and renders the exact sticker
// that would come out of the printer for the current config + template, at
// 1 printer dot per device pixel. Also offers a filter × twist grid for
// A/B'ing looks without burning paper.

import { getConfig } from './config.ts';
import { DEFAULT_LOOK, PHOTO_STYLES, PHOTO_TWISTS, renderSticker } from './photo.ts';
import { rasterToCanvas } from './raster.ts';
import { loadTemplate, BUILT_IN_TEMPLATES } from './templates.ts';
import { $, ctx2d } from './dom.ts';
import type { ImageSource, Template } from './types.ts';

const config = getConfig();
let sample: HTMLImageElement | HTMLCanvasElement | null = null;
let template: Template | null = null;

async function init() {
  template = await loadTemplate(config.templateId, config.templateConfig?.[config.templateId]);
  renderSummary();
}

function renderSummary() {
  const printerLabel = config.printerType === 'auto' ? 'Auto-detect' : config.printerType;
  const templateLabel = BUILT_IN_TEMPLATES.find((t) => t.id === config.templateId)?.label ?? config.templateId;
  const items = [
    `Printer: <strong>${printerLabel}</strong>`,
    `Paper width: <strong>${config.paperWidthDots} dots</strong> (~${(config.paperWidthDots / 11.8).toFixed(1)} mm)`,
    `Density: <strong>${config.printDensity}</strong>`,
    `Template: <strong>${templateLabel}</strong>`,
    `Shots: <strong>${config.shotCount}</strong>`,
    `Filter: <strong>${config.filterEnabled ? 'enabled' : 'disabled'}</strong>`,
  ];
  $('config-summary').innerHTML = items.map((text) => `<li>${text}</li>`).join('');
}

$<HTMLButtonElement>('pick-file').addEventListener('click', () => $<HTMLInputElement>('file').click());
$<HTMLInputElement>('file').addEventListener('change', async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const img = new Image();
  img.src = URL.createObjectURL(file);
  await img.decode();
  sample = img;
  (e.target as HTMLInputElement).value = '';
  await render();
});

$<HTMLButtonElement>('use-sample').addEventListener('click', async () => {
  sample = await buildSyntheticSample();
  await render();
});

$<HTMLInputElement>('opt-filter').addEventListener('change', () => render());

async function render() {
  if (!sample || !template) return;
  const shot = sample;
  const shots: ImageSource[] = Array.from({ length: Math.max(1, config.shotCount | 0) }, () => shot);
  const look = config.filterEnabled ? DEFAULT_LOOK : { style: 'classic', twist: 'none' };
  const raster = renderSticker(shots, template, { stickerWidth: config.paperWidthDots, look });

  const canvas = rasterToCanvas(raster);
  const preview = $<HTMLCanvasElement>('preview');
  preview.width = canvas.width;
  preview.height = canvas.height;
  const dpr = window.devicePixelRatio || 1;
  preview.style.width = `${canvas.width / dpr}px`;
  preview.style.height = `${canvas.height / dpr}px`;
  ctx2d(preview).drawImage(canvas, 0, 0);

  const mm = (dots: number) => (dots / 11.8).toFixed(1);
  $('preview-meta').textContent =
    `${raster.widthDots} × ${raster.heightDots} dots (~${mm(raster.widthDots)} × ${mm(raster.heightDots)} mm). ` +
    `1 screen pixel = 1 printer dot.`;
  $('status').textContent = `Rendered with ${config.shotCount} shot(s).`;

  if ($<HTMLInputElement>('opt-filter').checked) await renderFilterGrid(shots);
  else $('filter-grid-card').hidden = true;
}

async function renderFilterGrid(shots: ImageSource[]) {
  if (!template) return;
  const tpl = template;
  const card = $('filter-grid-card');
  const grid = $('filter-grid');
  grid.replaceChildren();
  for (const style of PHOTO_STYLES) {
    for (const twist of PHOTO_TWISTS) {
      const r = renderSticker(shots, tpl, {
        stickerWidth: config.paperWidthDots,
        look: { style: style.id, twist: twist.id },
      });
      const fig = document.createElement('figure');
      const c = rasterToCanvas(r);
      const dpr = window.devicePixelRatio || 1;
      c.style.width = `${c.width / dpr}px`;
      c.style.height = `${c.height / dpr}px`;
      const caption = document.createElement('figcaption');
      caption.textContent = `${style.label} · ${twist.label}`;
      fig.append(c, caption);
      grid.append(fig);
    }
  }
  card.hidden = false;
}

// A quick synthetic portrait so the admin can render without a camera / file
// handy. Gradient background + a face-ish arrangement so the dithering and
// filters have something to chew on.
async function buildSyntheticSample() {
  const w = 1024;
  const h = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = ctx2d(canvas);

  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, '#4a6fa5');
  bg.addColorStop(1, '#d2b48c');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  // "face"
  ctx.fillStyle = '#f1d4b1';
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w * 0.22, h * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#2b2b2b';
  for (const [cx, cy] of [[w * 0.42, h * 0.44], [w * 0.58, h * 0.44]]) {
    ctx.beginPath();
    ctx.ellipse(cx, cy, 24, 18, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // mouth
  ctx.beginPath();
  ctx.arc(w / 2, h * 0.56, 40, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.lineWidth = 10;
  ctx.strokeStyle = '#8a4040';
  ctx.stroke();

  // label so it's obvious this is the synthetic sample
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.font = 'bold 36px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Preview sample', w / 2, h * 0.92);

  return canvas;
}

// Settings changed in another tab: re-render with the new config.
window.addEventListener('storage', (e) => {
  if (e.key === 'photoboot:config') location.reload();
});

init();
