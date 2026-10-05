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

README.md has the user-facing feature list; this is the code map.

- `index.html` + `src/booth.js` + `src/booth.css` — the booth app (kiosk):
  1. Setup screen: connect the printer once (or "Start without printer").
     After that it keeps reconnecting to the same device on a dropout.
     Settings: long-press the "Photoboot" title (~1 s), long-press the
     top-left corner of the camera view (2 s), or `/?admin=1`.
  2. Camera: timer chips (remembered), optional 1–4 photo chips
     (`guestShotChoice`), shutter with caption, tap anywhere to start.
     Live look chips (`livePreview`): Camera or a style + twist, rendered
     from the video ~15 fps into `#live`; the pick carries into the review.
     Countdown with "Get ready / Smile!", beeps, cancel; "Next pose!" and
     "Photo n of N" between strip shots. Camera failures show a panel and
     auto-retry. Idle → attract screen cycling recent local photos.
  3. Review: sticker preview (whole/half device pixels per dot), style and
     twist rows (allowed subset), Print / Get photo / Retake / Done.
     Printing shows a full-screen overlay; copies, a per-photo limit, and
     auto-print are settings. Back to the camera `doneTimeoutSec` after a
     print/share, `reviewTimeoutSec` when idle. Leaving the review archives
     the colour keepsake locally.
  - Shared/archived photo = `renderColour`: the sticker layout in colour
    (header, shots, gaps, footer, 24-dot side margins), with the twist.
  - Writes a health heartbeat (`photoboot:status`) and counters (stats.js).
- `settings.html` + `src/settings.js` — admin page: tonight (health, paper,
  counters), event name + language, saved setups / export / import,
  printer, paper (+ roll meter), printing, capture, looks, template,
  guest screens + wording, local photos (ZIP), server events, PIN, reset.
  Inputs use a small `bind()` helper; listeners are bound once.
- `preview.html` + `src/preview.js` — renders a sticker through the current
  config/template from a synthetic sample or an uploaded photo; reloads when
  settings change in another tab.
- `test.html` + `src/test.js` + `src/style.css` — printer test / calibration page.
- `print.html` + `src/print.js` — print one chosen photo.
- `src/config.js` — config source of truth (localStorage
  `photoboot:config`); see DEFAULTS for every key. `portableConfig` drops
  device keys for exports; `eventKey` groups stats/photos per event.
- `src/i18n.js` — guest wording en/nl/fr + per-key overrides (`texts`).
- `src/stats.js` — per-event counters, paper meter, booth heartbeat.
- `src/archive.js` — local colour copies in IndexedDB (`photo:<event>:<iso>`)
  and ZIP export (uses `server/zip.js`).
- `src/remote.js` — client for the server event API.
- `src/photo.js` — looks (`PHOTO_STYLES`, `PHOTO_TWISTS`), `photoToRaster`,
  `renderSticker`, `renderColour`, `printPhoto` (copies + tear margin).
- `src/strip.js` — `composeStrip` (1-bit sticker) and `composeColour`.
- `src/templates.js` — `plain`, `text` (title / two lines / system font),
  `custom` (header/footer images in IndexedDB); image export/import helpers.
- `src/effects.js` — woodcut, stipple, mirror, big head. 16 more effects
  were tried in a "filter lab" and dropped; they're in commit 8b32a21.
- `src/printers/` — printer abstraction (`base.js`, `phomemo.js`, registry
  + auto-detect in `index.js`). `src/printer.js` is a compat shim.
- `src/raster.js` — canvas → packed-bit bitmap (error diffusion, screens,
  tone options), `rasterToCanvas`, calibration generators.
- `src/storage.js` — tiny IndexedDB key/value store (template images,
  saved setups, local photos). Closes on `pagehide`.
- `server/share.js` — the one middleware (Vite dev + prod): `POST
  /api/share`, `/s/{uuid}` share page (save / delete), `/share/{uuid}.jpg`,
  `DELETE /api/share/{uuid}`, rate limit, then event routes.
- `server/photos.js` — photo files + `{id}.json` sidecars (event, created),
  expiry cleanup (hourly), disk quota.
- `server/events.js` — events: admin CRUD (`ADMIN_TOKEN`), setup load and
  stats push (setup key), gallery `/g/{id}/{galleryKey}` + streamed ZIP.
- `server/http.js` — helpers + the HTML shell of the public pages.
- `server/zip.js` — stored-ZIP writer + CRC32, shared with the browser.
- `server/index.js` — production server (node builtins only): `dist/` + routes.
- `Dockerfile` / `docker-compose.yml` — volumes `/data/shares`, `/data/events`.
- `run.sh` — self-contained local launcher (portable Node in `.node/`).
- `deploy.sh` — tar over SSH + `docker compose up -d --build`; keeps the
  server's `.env`, skips `template-assets/` (local, gitignored).

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

See the table in README.md: `BASE_URL`, `PORT`, `SHARE_DIR`, `EVENTS_DIR`,
`SHARE_TTL_DAYS`, `SHARE_MAX_MB`, `ADMIN_TOKEN`, `UPLOAD_TOKEN`. On the
production host the secrets are in `~/photoboot/.env`.

## Open questions / next things to do

1. **iPad:** Bluefy is needed for Web Bluetooth — verify that camera
   (`getUserMedia`) works inside Bluefy.
2. **Paper-out / lid / battery** — not detected. Would need reading the
   printer's notify characteristic; never probe unknown opcodes.
3. **Photo look** — default style "Classic" is Atkinson + threshold noise
   16, gamma 0.6, density 3. Plain Atkinson gave regular hatching on flat
   walls and crushed backlit faces. Pop art / Woodcut / Stipple were
   tuned on screen only — pending: real test prints (dot gain, thin
   template strokes, tear margin length).

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
