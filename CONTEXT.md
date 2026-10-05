# Photoboot — project context

Portable notes so Claude (or you) can pick up on another machine. The
auto-memory system lives in `~/.claude/projects/...` which does *not* travel
with this folder — this file does. Keep it current.

## Goal

A photo booth **PWA** (installable web app) that works on Android *and* iOS
and prints the resulting photo to a **Phomemo P2S** thermal label printer
over Bluetooth Low Energy. First milestone: confirm we can drive the
printer from the browser.

## Hardware facts

- **Printer:** Phomemo P2S (M02/P2 family, Bluetooth).
- **Paper (user's):** 53 mm roll, with 50 mm sticker label centred on it →
  ~1.5 mm paper margin either side of the sticker.
- **Mechanical print margin:** another ~1.5–2 mm from the paper edge to the
  leftmost column the head can print.
- **Measured DPI:** sending 384 dots produced a 33.5 mm print → ~11.5 dots/mm
  → **~300 DPI** (so the model is 300 DPI, *not* the 203 DPI I initially
  assumed). The code originally hard-coded a 384-dot width based on the
  wrong DPI assumption — now parameterised.
- **Head width:** **576 dots** (~48.8 mm), confirmed by the 0–640
  calibration print: the bar and ruler stop at 576.
- **Left edge:** column 0 lands ~2 mm (~24 dots) in from the sticker's
  left edge (fine calibration). That strip is outside the head and cannot
  be printed. The head's right end (col 575) lands right on the sticker's
  right edge.
- **Chosen print width: 552 dots**, left-aligned at col 0, giving ~24 dots
  of margin each side (`DEFAULT_PRINT_WIDTH_DOTS` in `src/printer.js`).
  Phomemo's own app leaves an even bigger margin, so this is final.

## Browser support

- **Android Chrome:** Web Bluetooth works. Primary target.
- **iOS Safari:** no Web Bluetooth. Use the free **Bluefy** browser from the
  App Store, open the same HTTPS URL inside it.
- **Dev:** `npm run dev` serves over HTTPS (self-signed via
  `@vitejs/plugin-basic-ssl`) on the LAN; accept the cert warning on each
  device.

## Phomemo BLE protocol — what we know

The printer presents a BLE GATT service with one write characteristic that
accepts a stream of ESC/POS-flavoured bytes.

**UUID candidates tried in order** (`src/printer.js`):

1. service `0000ff00-…`, write `0000ff02-…` ← most common
2. service `0000ae30-…`, write `0000ae01-…` ← newer M02S variant
3. service `e7810a71-73ae-499d-8c15-faa9aef0c3f2`,
   write `bef8d6c9-9c21-4c9e-b632-bd58c1009f9f` ← reported for some labels

If none match on your device, log the GATT services during connect and add
a fourth candidate.

**Byte sequences used:**

- Init: `1B 40` (ESC @ — reset) then `1F 11 02 nn` = density
  (1 thin, 3 normal, 4 thick). Do NOT probe other `1F 11 xx` opcodes —
  unknown ones have bricked M02-family printers.
- "HD" in the Phomemo app = native 300 dpi; we already print at native res.
- Raster: `GS v 0` = `1D 76 30 00 xL xH yL yH <bitmap>` where `xL/xH` is
  width in **bytes** (little-endian uint16) and `yL/yH` is height in
  **dots**. Bits are MSB-first, 1 = black dot.
- Feed `n` dot-lines: `1B 4A n`.
- Height is split into bands of 128 rows per raster command to avoid
  firmware quirks on tall images.

**Chunking:** writes are split to 200-byte GATT writes. Prefer
`writeValueWithResponse` when the characteristic supports it, otherwise
fall back to `writeValueWithoutResponse`.

## What's in the repo

- `index.html` + `src/booth.js` + `src/booth.css` — the booth app (kiosk):
  1. Setup screen: connect the printer once (or "Start without printer").
     After that there is no UI to change printers; on a dropout it keeps
     reconnecting to the same device. **Long-press the "Photoboot" title
     for ~1 s** (or visit `/?admin=1`) to open the settings page.
  2. Live camera (selfie cam by default, switch button if >1 camera),
     timer 3 / 5 / 10 s (remembered), countdown + flash. If settings has
     `shotCount > 1`, the shutter captures that many frames in a row,
     each with its own countdown, and shows a `n / N` counter at the top.
  3. Review: large sticker preview (scaled in whole/half device-pixel
     steps per dot to avoid moire). **Style** row (Classic / Pop art /
     Woodcut / Stipple) and **Twist** row (Normal / Mirror / Big head) if
     the admin enabled filters — otherwise hidden. **Retry / Print /
     Share**. The sticker is composed from the active template:
       - `plain`:   no decoration, just stacked shots.
       - `custom`:  admin-uploaded header + footer PNGs.
     Prints end with a 72-dot (~6 mm) blank tear margin plus the feed.
     Share uploads a composite JPEG (strip mode: shots stacked vertically)
     and shows a QR to `/share/{uuid}.jpg`. Review auto-returns to the
     camera after 90 s idle.
     Dev: `/?demo=/share/<uuid>.jpg` opens the review with that image.
  - Photos are saved as the preview showed them (mirrored for the front cam).
  - Keeps the screen awake (Wake Lock), fullscreen on first tap, PWA manifest.
- `settings.html` + `src/settings.js` + `src/settings.css` — admin page.
  Picks the printer type (auto / phomemo / …), paper width, print density,
  shot count, default countdown, filter on/off, active template, template
  config (custom header/footer uploads), optional admin password.
  Writes to `localStorage['photoboot:config']` via
  `src/config.js`; template images live in IndexedDB (`src/storage.js`).
- `preview.html` + `src/preview.js` — renders a sticker through the current
  config/template using a synthetic sample or an uploaded photo, 1 printer
  dot per device pixel. Optional filter × twist grid for A/B'ing looks on
  screen before burning paper.
- `test.html` + `src/test.js` + `src/style.css` — printer test / calibration page.
- `print.html` + `src/print.js` — print one chosen photo (full 576 or 552
  centred). `./print.sh` opens it on this Mac via http://localhost.
- `src/config.js` — single config source of truth. Keys: `printerType`,
  `paperWidthDots`, `printDensity`, `filterEnabled`, `shotCount`,
  `defaultDelay`, `templateId`, `templateConfig`, `adminPassword`.
  localStorage-backed. `PAPER_PRESETS` lives here.
- `src/photo.js` — print looks (`PHOTO_STYLES`, `PHOTO_TWISTS`),
  `photoToRaster` (fit + twist + style → raster), `renderSticker`
  (one or more shots + template → final sticker), `printPhoto` (adds the
  tear margin).
- `src/strip.js` — `composeStrip(shotRasters, template, stickerWidth)`
  stacks header + shots + footer at the full sticker width and threshold-
  dithers the whole thing back to 1-bit.
- `src/templates.js` — registry of built-in templates (`plain`, `custom`)
  + helpers to save/load custom header/footer images in IDB.
- `src/effects.js` — custom styles (woodcut, stipple) and twists (mirror,
  big head). 16 more effects were tried in a "filter lab" gallery and
  dropped; they're in commit 8b32a21 if one is wanted back.
- `src/printers/` — printer abstraction.
    - `base.js`: `PrinterBase` interface (connect/reconnect/init/
      printRaster/feed/disconnect).
    - `phomemo.js`: `PhomemoPrinter` for the P2 / M02 / M03 / M04 / T02
      family (ESC/POS over BLE, three service UUID candidates probed).
    - `index.js`: `PRINTERS` registry + `connectPrinter(type, opts)`
      factory. `type: 'auto'` opens a filter-wide BLE picker and routes
      to the matching backend by name prefix. Settings exposes a dropdown
      of registered types.
- `src/printer.js` — compat shim: re-exports `PhomemoPrinter` and the width
  constants for the test / print pages.
- `src/raster.js` — canvas → packed-bit bitmap (error diffusion:
  Floyd–Steinberg / Atkinson / Stucki; screens: halftone, threshold;
  optional photo contrast stretch + gamma + sharpen + ink outlines),
  `toGray` / `inkToRaster` building blocks, `rasterToCanvas`
  preview, calibration generators.
- `src/storage.js` — tiny async key/value store on IndexedDB, used for the
  custom template's header/footer image blobs.
- `server/share.js` — `POST /api/share` (JPEG body → `{id, url}`) and
  `GET /share/{uuid}.jpg`. Mounted in the Vite dev/preview server and the
  production server.
- `server/index.js` — production server (node builtins only): `dist/` + share.
- `Dockerfile` — build + slim runtime; photos in volume `/data/shares`.
- `run.sh` — self-contained local launcher (portable Node in `.node/`).

## Adding a new printer type

1. Subclass `PrinterBase` in `src/printers/<brand>.js`. Implement `connect`,
   `attach`, `init`, `printRaster`, `feed` for that brand's BLE/USB
   protocol. Keep width constants as class fields.
2. Register it in `src/printers/index.js` under `PRINTERS`: label, hint,
   `defaultWidthDots`, `headWidthDots`, `namePrefixes`, `uuids`, `create`.
3. That's it — the settings dropdown picks it up, auto-detect routes to it
   by name prefix, and the booth / preview / print pages see the same
   `PrinterBase` interface.

## Config (env)

- `BASE_URL` — public origin for QR links. Unset → derived from the request
  host, so locally the QR uses whatever IP the tablet opened.
- `SHARE_DIR` — photo folder (default `./shares`, Docker `/data/shares`).
- `PORT` — production server port (default 8080).

## Open questions / next things to do

1. **iPad:** Bluefy is needed for Web Bluetooth — verify that camera
   (`getUserMedia`) works inside Bluefy.
2. **Shares never expire** — add cleanup (cron/`find -mtime`) if needed.
3. **Photo look** — default style "Classic" is Atkinson + threshold noise
   16, gamma 0.6, density 3. Plain Atkinson gave regular hatching on flat
   walls and crushed backlit faces. Pop art / Woodcut / Stipple and the
   frame were tuned on screen only — pending: real test prints (dot gain,
   thin strokes, tear margin length).

## Decisions / conventions

- Default print width 552, left-aligned at col 0 → equal ~24-dot margins
  on the user's 53/50 mm sticker roll. Overridable in settings.
- Width must be a multiple of 8 (byte alignment).
- Deps: Vite + basic-ssl (dev), `qrcode-generator` (client). Server uses
  node builtins only.
- Config lives in localStorage (`photoboot:config`); binary template assets
  in IndexedDB (`photoboot` DB, `blobs` store). Reset both from Settings.

## How to run

```sh
./run.sh              # local, HTTPS on the LAN (accept the self-signed cert)
./print.sh            # print a single photo from this Mac (Chrome)
# Oracle / Docker:
docker build -t photoboot .
docker run -d -p 8080:8080 -e BASE_URL=https://booth.example.com \
  -v photoboot-shares:/data/shares photoboot
```

Production needs HTTPS in front (reverse proxy): camera and Web Bluetooth
won't work over plain HTTP.
