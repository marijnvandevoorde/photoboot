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
- **Head width:** **unknown**, probably 576 dots (common for 300-DPI
  Phomemos). To be confirmed by the width calibration print.

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

- Init: `1B 40` (ESC @ — reset) then `1F 11 02 04` (Phomemo print quality /
  density).
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

- `index.html` — printer-test UI shell.
- `src/style.css` — minimal dark theme.
- `src/printer.js` — `PhomemoPrinter` class: `connect`, `init`, `printRaster`,
  `feed`, `disconnect`. Raster width is a parameter, not a constant.
- `src/raster.js` — canvas → packed-bit bitmap (Floyd–Steinberg dither),
  plus generators: `textToCanvas`, `testPatternCanvas`,
  `widthCalibrationCanvas`.
- `src/main.js` — UI glue, status log, target-width input.
- `vite.config.js` — HTTPS dev server, LAN host.
- `package.json` — Vite + basic-ssl plugin.

## What works

- BLE connect / disconnect, device picker with name filters
  (`P2`, `M02`, `M03`, `M04`, `T02`, `Phomemo`).
- Printing text, a test pattern (border + diagonals + ramp), and arbitrary
  images.
- Floyd–Steinberg dithering (looks acceptable in the user's first test).
- Width calibration button: prints a solid bar out to 640 dots plus a
  numbered ruler.

## Open questions / next things to do

1. **Width calibration — in progress.** User to report:
   - Column where the solid bar physically ends (= head width).
   - Highest tick number that is fully inside the sticker (= usable width).
   - Then run fine calibration (step 16) if we need sticker-edge accuracy
     better than ~2.6 mm.
2. **Set `targetWidth`** in the UI based on calibration (nearest multiple of
   8 ≤ usable width). Confirm with text / pattern prints.
3. **Left-edge offset?** If the physical left margin is non-zero we might
   want to render content with a leading white padding so important
   subjects don't ride the edge. Measure physical offset from paper edge
   to column 0 during calibration.
4. **Photo-booth features** (next milestone, not started):
   - Camera capture via `getUserMedia`.
   - 2×2 or 4-strip layout.
   - Countdown + flash.
   - PWA manifest + service worker so it installs to the home screen.
   - Permissions story on iOS/Bluefy.
5. **Density / darkness** — `1F 11 02 04` is one quality level; other Phomemo
   models accept different values. Expose a density setting once we have
   width nailed.

## Decisions / conventions

- Keep calibration prints short (~1 cm tall) to minimise paper waste.
- Width must be a multiple of 8 (byte alignment).
- Prints are left-aligned to column 0; centring is done by padding the
  canvas, not by a printer command.
- No dependencies beyond Vite + basic-ssl.

## How to resume

```sh
cd photoboot
npm install           # if node_modules not on the USB
npm run dev           # Vite prints a LAN HTTPS URL
```

Open the LAN URL on the phone (Android Chrome, or Bluefy on iOS), accept
the self-signed cert, hit **Connect printer**, then **Print width
calibration** and report the two numbers above.
