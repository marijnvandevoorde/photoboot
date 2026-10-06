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
  of margin each side (`DEFAULT_PRINT_WIDTH_DOTS` in `src/printer.ts`).
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

**UUID candidates tried in order** (`src/printer.ts`):

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

Tooling: TypeScript strict (`tsc` = typecheck only, `erasableSyntaxOnly`
so Node 24 runs `server/*.ts` directly), Biome (lint + format, see
biome.json), Vitest (`test/*.test.ts`; happy-dom where localStorage is
needed — no canvas there, so pixels are covered by `test/e2e`). CI in
.github/workflows/ci.yml. Shared types: src/types.ts; DOM helpers
(`$`, `ctx2d`, `errorMessage`): src/dom.ts.

- `index.html` + `src/booth.ts` + `src/booth.css` — the booth app (kiosk):
  1. Setup screen: connect the printer once (or "Start without printer").
     After that it keeps reconnecting to the same device on a dropout.
     Starting sets the **kiosk lock** (`src/kiosk.ts`, localStorage
     `photoboot:kiosk` = { since, printer: { id, name, type } }): every
     later load skips setup, goes to the camera and restores the printer
     via `restorePrinter` (no picker; `transport.restoreDevice` =
     `navigator.bluetooth.getDevices()` + watchAdvertisements on the web,
     `BleClient.getDevices` in the app). If that fails (e.g. Bluefy has no
     getDevices) the pill shows "Reconnecting…" and lastError tells the host.
     Host access: long-press the "Photoboot" title (~1 s) → settings;
     long-press the top-left corner of the camera view (2 s) → host menu
     (settings, connect/change printer, stop booth = clear the lock). Both
     ask for the PIN in the booth when one is set (then set the
     sessionStorage `photoboot:admin-ok` flag so settings don't ask again;
     the booth clears it on load). `/?admin=1` → settings' own gate.
     Guest-proofing: overscroll-behavior none, no callouts / context menu /
     drag; a "set a PIN" nudge on setup when none is set.
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
     the colour keepsake locally and, in a server event, uploads it to the
     event (unless it was already shared with that twist).
  - Shared/archived photo = `renderColour`: the sticker layout in colour
    (header, shots, gaps, footer, 24-dot side margins), with the twist.
  - Writes a health heartbeat (`photoboot:status`) and counters (stats.ts).
- `settings.html` + `src/settings.ts` — admin page for a non-technical
  host, in sections: Tonight (health, paper, counters), Event (name,
  language, saved setups / export / import), What guests see (capture,
  looks + live preview, sticker design, screens + wording), Printer &
  paper (roll + meter, printing), Photos (local copies, ZIP), Security
  (PIN, booth lock + Stop booth, Guided Access / app pinning help), and a
  collapsed `<details id="advanced">` (printer type, join a server event,
  server events — buttons only once an admin token is entered — upload
  token, reset). Every setting has a one-line `.help` text.
  Inputs use a small `bind()` helper; listeners are bound once.
- `src/kiosk.ts` — kiosk lock state + PIN hashing/checking (shared by the
  booth's host menu and the settings gate).
- `preview.html` + `src/preview.ts` — renders a sticker through the current
  config/template from a synthetic sample or an uploaded photo; reloads when
  settings change in another tab.
- `test.html` + `src/test.ts` + `src/style.css` — printer test / calibration page.
- `print.html` + `src/print.ts` — print one chosen photo.
- `src/config.ts` — config source of truth (localStorage
  `photoboot:config`); see DEFAULTS for every key. `portableConfig` drops
  device keys for exports; `eventKey` groups stats/photos per event.
- `src/i18n.ts` — guest wording en/nl/fr + per-key overrides (`texts`).
- `src/stats.ts` — per-event counters, paper meter, booth heartbeat.
- `src/archive.ts` — local colour copies in IndexedDB (`photo:<event>:<iso>`)
  and ZIP export (uses `server/zip.ts`).
- `src/remote.ts` — client for the server event API.
- `src/purchase.ts` — iOS app only: Apple in-app purchase of an event
  gallery (`@capgo/native-purchases`, StoreKit 2): `/api/apple/start` →
  purchase with the event's appAccountToken → `/api/apple/redeem` → finish
  the transaction only after the server confirmed. Unconfirmed ones are
  kept (localStorage `photoboot:apple-unredeemed` + StoreKit's unfinished
  list) and redeemed on settings load / "Restore unfinished purchase".
  `platform.ts` starts `watchTransactions()` (late deliveries, Ask to Buy).
  Settings' "Online gallery" card shows the buy form when `isIosApp`.
- `src/photo.ts` — looks (`PHOTO_STYLES`, `PHOTO_TWISTS`), `photoToRaster`,
  `renderSticker`, `renderColour`, `printPhoto` (copies + tear margin).
- `src/strip.ts` — `composeStrip` (1-bit sticker) and `composeColour`.
- `src/templates.ts` — `plain`, `text` (title / two lines / system font),
  `custom` (header/footer images in IndexedDB); image export/import helpers.
- `src/effects.ts` — woodcut, stipple, mirror, big head. 16 more effects
  were tried in a "filter lab" and dropped; they're in commit 8b32a21.
- `src/printers/` — printer abstraction: `transport.ts` (BleTransport —
  Web Bluetooth today, a native plugin in the app), `base.ts`,
  `phomemo.ts`, registry + auto-detect + `restorePrinter` (adopt a saved
  device, connect via `reconnect`) in `index.ts`. `src/printer.ts` is a
  compat shim.
- `src/raster.ts` — canvas → packed-bit bitmap (error diffusion, screens,
  tone options), `rasterToCanvas`, calibration generators.
- `src/storage.ts` — tiny IndexedDB key/value store (template images,
  saved setups, local photos). Closes on `pagehide`.
- `server/share.ts` — the one middleware (Vite dev + prod): CORS for the
  app, `POST /api/share`, `/s/{uuid}` share page (save / delete),
  `/share/{uuid}.jpg`, `DELETE /api/share/{uuid}`, rate limit, then the
  admin, event and Stripe routes.
- `server/db.ts` — SQLite (`node:sqlite`): events, photos, stats, payments,
  admin sessions, settings (TOTP secret). Imports the pre-database JSON
  events and photo sidecars once (`PRAGMA user_version` 1), then runs
  `MIGRATIONS` in order (2: `apple_tokens`, appAccountToken → event).
- `server/photos.ts` — photo files + rows; expiry per photo: free
  `SHARE_TTL_DAYS`, paid events `retention_days` / `PAID_RETENTION_DAYS`;
  disk quota.
- `server/events.ts` — event store + the booth routes (setup key: load /
  save setup, stats) and the host gallery + streamed ZIP (gallery key).
  Pending (unpaid) events refuse photos and show no gallery.
- `server/billing.ts` — the paid-event lifecycle every payment path uses:
  `createPendingEvent`, `activateEvent` (idempotent per payment ref,
  emails the links), `refundPayment`, `compEvent`, `sendEventEmail`.
- `server/stripe.ts` — Stripe over fetch (no SDK): `POST /api/checkout`
  (pending event + Checkout Session → `{url}`), `GET /api/checkout/price`,
  `GET /api/checkout/status?session=cs_…` (asks Stripe; activates and
  returns the links once paid), `POST /api/stripe/webhook` (raw body,
  `verifyStripeSignature`: HMAC of `t.body`, 5 min tolerance). Payment
  ref = the PaymentIntent id, so `charge.refunded` (which only carries
  `payment_intent`) maps straight to `refundPayment`; only full refunds
  un-pay. Page: `event.html` + `src/event.ts` (sign-up, success, cancel).
- `server/apple.ts` — `/api/apple/start|redeem|notifications`. Verifies
  StoreKit 2 JWS with node:crypto only: x5c chain (validity, issuer
  signatures, root = `apple-root-ca-g3.pem` by fingerprint256, Apple's
  marker OIDs), ES256 (ieee-p1363); then bundle / product / Consumable /
  environment / not revoked / appAccountToken. Payment ref = transactionId.
  Notifications V2: REFUND / REVOKE → refundPayment, ONE_TIME_CHARGE →
  activate, everything else 200. `configureApple()` injects a test root
  (fixtures + openssl script in `test/fixtures/apple`).
- `server/admin.ts` — `/api/admin/*`: ADMIN_TOKEN + TOTP login (first
  login enrolls), cookie sessions, list / edit / comp / delete events,
  payments. Page: `admin.html` + `src/admin.ts`.
- `server/mail.ts` — Brevo HTTP API; logs to `outbox` without a key.
- `server/totp.ts` — RFC 6238 codes, base32.
- `server/http.ts` — helpers (incl. the per-IP `rateLimiter`) + the HTML
  shell of the public pages.
- `server/zip.ts` — stored-ZIP writer + CRC32, shared with the browser.
- `server/index.ts` — production server (node builtins only): `dist/` +
  routes; `createApp()` is what the tests start.
- `Dockerfile` / `docker-compose.yml` — volumes `/data/shares`, `/data/events`.
- `run.sh` — self-contained local launcher (portable Node in `.node/`).
- `deploy.sh` — tar over SSH + `docker compose up -d --build`; keeps the
  server's `.env`, skips `template-assets/` (local, gitignored).

## Adding a new printer type

1. Subclass `PrinterBase` in `src/printers/<brand>.ts`. Implement `connect`
   (picker via `this.ble.requestDevice`), `attach`, `init`, `printRaster`,
   `feed` for that brand's protocol, writing bytes through `this.ble` (the
   BleTransport) — never navigator.bluetooth directly, so the app works too.
   Add a fake-transport test like test/phomemo.test.ts.
2. Register it in `src/printers/index.ts` under `PRINTERS`: label, hint,
   `defaultWidthDots`, `headWidthDots`, `namePrefixes`, `uuids`, `create`.
3. That's it — the settings dropdown picks it up, auto-detect routes to it
   by name prefix, and the booth / preview / print pages see the same
   `PrinterBase` interface.

## Config (env)

Every variable is listed in `.env.example` (and the README table); copy it to
`.env`. Empty values mean the default (`server/env.ts`). Compose loads `.env`
via `env_file`; `npm start` / the Vite dev server read it too
(`server/load-env.ts`). Variables: `BASE_URL`, `PORT`, `SHARE_DIR`, `EVENTS_DIR`,
`SHARE_TTL_DAYS`, `SHARE_MAX_MB`, `ADMIN_TOKEN`, `UPLOAD_TOKEN`, the
event price / mail / Stripe keys (`STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_AUTOMATIC_TAX`) and the in-app purchase
settings (`APPLE_BUNDLE_ID`, `APPLE_PRODUCT_ID`, `APPLE_ALLOW_SANDBOX`). On the
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
