# Photoboot — a DIY photo booth that prints stickers

**Turn any laptop, tablet or Mac mini with a webcam into a party photo booth
that prints black-and-white stickers on a cheap Bluetooth thermal printer.**
Open-source, runs in the browser (PWA), self-hosted, no app to install.

[![Live demo](https://img.shields.io/badge/live%20demo-boot.small--victories.co-1f9e6e)](https://boot.small-victories.co)
[![CI](https://github.com/marijnvandevoorde/photoboot/actions/workflows/ci.yml/badge.svg)](https://github.com/marijnvandevoorde/photoboot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![Web Bluetooth](https://img.shields.io/badge/Web%20Bluetooth-Phomemo%20P2%20%2F%20M02-555)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)

![The four print styles — Classic, Pop art, Woodcut and Stipple — on a sticker with a typed title, names and date](docs/styles.png)

Guests strike a pose, watch the countdown, and walk away with a sticker — plus
a colour copy on their phone via a QR code. Great for weddings, birthdays,
company parties, school fairs and festivals.

**Try it now: [boot.small-victories.co](https://boot.small-victories.co)** —
open it in Chrome (Android, Mac, Windows, ChromeOS) or in
[Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) on
iPad / iPhone. “Start without printer” works on anything with a camera.

- 🖨️ **Prints over Bluetooth** to cheap thermal printers, straight from the
  browser (Web Bluetooth): Phomemo, the "cat printers" from AliExpress and
  Temu, LuckJingle and the Action / Lidl pocket printers, PeriPage,
  Paperang, Niimbot and BLE receipt printers. See
  [Supported printers](#supported-printers).
- 🎨 **Live looks**: see the camera in Classic, Pop art, Woodcut or Stipple
  before the photo is taken, plus Mirror and Big head twists.
- 🎞️ **Photo strips** of 1–4 shots, with your own header and footer — typed
  names and date, or your own artwork.
- 📱 **QR sharing**: guests scan to get a colour copy; photos expire after
  30 days and can be deleted by the guest.
- 🎉 **Runs unattended**: auto-print, print limits, a paper-low warning, an
  idle attract screen and self-healing camera and printer connections.
- 🏠 **Self-hosted and private**: a static web app plus a tiny dependency-free
  Node server, with a Dockerfile and Compose setup.

## What guests get

- A live camera with a big countdown (3 / 5 / 10 s), beeps, a flash and a
  cancel button. Tap anywhere to start.
- Single shots or photo strips of 2–4 shots, with “Photo 2 of 3 · Next pose!”.
- Looks — Classic, Pop art, Woodcut, Stipple — and twists — Mirror, Big head —
  shown **live on the camera** before the photo is taken.
- A review screen that shows the sticker exactly as it will print, then
  Print, Get photo (QR to a colour copy), Retake or Done.
- English, Dutch or French, or your own wording for every message.

## What the host gets

- **Templates**: plain, a typed title / names / date / hashtag, or your own
  header and footer images.
- **Unattended mode**: auto-print, copies per print, a print limit per photo,
  an idle “tap to take your photo” screen that cycles recent photos, and
  friendly error screens that recover by themselves when the camera or
  printer drops out.
- **Paper meter**: set the roll length and the booth warns you (not the
  guests) when it's running low.
- **Counters**: sessions, prints, shares and the busiest hour, per event.
- **Every photo kept**: a colour copy of every session in the browser, ready
  to download as a ZIP the next morning.
- **Saved setups**: save, export and import whole setups (settings and
  template images) as a file.
- **Event galleries** (paid): a host signs up on `/event.html` and pays once
  with Stripe — or, in the iOS app, with an in-app purchase right in
  settings — and gets a setup link for every booth and a private gallery
  with a ZIP of all the event's photos, kept for a year. The owner manages
  events in `/admin` (admin token + authenticator code).

- **Guest-proof kiosk**: once started, the booth stays on the camera — a
  reload or app restart comes straight back and reconnects to the same
  printer by itself (Chrome and the app). Leaving the booth needs the host
  PIN. No pull-to-refresh, zoom or long-press menus. For a fully locked
  tablet, use iPad Guided Access or Android app pinning.

Settings live on a hidden page, grouped for hosts (Tonight, Event, What
guests see, Printer & paper, Photos, Security, Advanced) with a short
explanation under every setting. To get there: long-press the “Photoboot”
title on the start screen, or long-press the top-left corner of the camera
view for 2 s for the host menu (settings, reconnect or change printer, stop
booth). A tap on the red “Reconnecting…” pill retries the printer at once. Both
ask for the PIN when one is set; `/?admin=1` opens settings behind the same
PIN. **Stop booth** (host menu or Settings → Security) brings back the
start screen.

## Hardware

- **Printer**: a Bluetooth Low Energy thermal printer, see
  [Supported printers](#supported-printers). We build and test on a
  Phomemo P2S (300 dpi, 576-dot head).
- **Paper**: the booth sets the print width from the printer (a 53 mm roll
  with 50 mm stickers on the P2S: 552 dots). The width and the blank paper
  after each sticker can be overridden in settings; `/test.html` prints
  calibration rulers.
- **Camera**: any webcam or built-in camera. The booth asks for 1280×960 at
  30 fps, which is plenty for a 50 mm sticker.
- **Browser**: Web Bluetooth is needed for printing — Chrome / Edge on
  Android, macOS, Windows, ChromeOS, or Bluefy on iOS. Safari and Firefox
  can run the booth without a printer.

## Run it locally

```sh
./run.sh          # downloads a portable Node into ./.node, then starts Vite
```

That serves the booth over HTTPS on your LAN (accept the self-signed
certificate) at `https://<this machine>:5173`. Camera and Bluetooth both need
HTTPS or `localhost`. Shared photos land in `./shares`.

Other scripts: `./run.sh build` builds into `dist/`; `./print.sh` opens a page
to print a single photo from this computer.

## Develop

TypeScript (strict) with no framework, built by Vite, linted and formatted
by Biome, tested with Vitest. The server runs its `.ts` files directly on
Node 24 — no build step.

```sh
npm ci
npm run dev        # Vite dev server with HTTPS + the share/event API
npm run check      # typecheck + lint + unit/server tests
npm run test:e2e   # builds, then drives headless Chrome with a fake camera
                   # and a fake Bluetooth printer (needs Google Chrome)
npm run format     # Biome: format + safe fixes
```

Tests need Node 22+. Running the booth itself only needs Node 20.19+
(`./run.sh` picks the right Node for older Macs).

## Host it

The production server is plain Node (no dependencies) serving `dist/` plus
the share and event routes. With Docker:

```sh
docker compose up -d --build
```

`docker-compose.yml` is set up for a Traefik reverse proxy; adapt the labels,
domain and volumes to your host.

Production (boot.small-victories.co) runs on the Kubernetes cluster `sv-oke`.
`npm run deploy` ships `origin/main` there with the shared `sv-deploy` script from
the Oracle repo (config in `deploy.env`; `npm run deploy:check` shows what runs;
`SV_DEPLOY` overrides the script's path, default `../Oracle/deploy/sv-deploy`).

| Variable         | Default       | What it does                                                        |
| ---------------- | ------------- | ------------------------------------------------------------------- |
| `BASE_URL`       | from request  | Public origin used in QR links, e.g. `https://booth.example.com`     |
| `PORT`           | `8080`        | HTTP port                                                            |
| `SHARE_DIR`      | `./shares`    | Where shared photos are stored (without `S3_BUCKET`)                 |
| `EVENTS_DIR`     | `./events`    | Where server events are stored                                       |
| `DATABASE_URL`   | —             | MySQL instead of SQLite: `mysql://user:pass@host:3306/db?ssl-mode=REQUIRED` |
| `S3_BUCKET`      | —             | Keep photos in this S3-compatible bucket instead of `SHARE_DIR`; with `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` |
| `SHARE_TTL_DAYS` | `30`          | Shared photos are deleted after this many days (`0` = never)          |
| `SHARE_MAX_MB`   | `5000`        | Refuse uploads once the photo folder is this big                     |
| `ADMIN_TOKEN`    | —             | Enables `/admin` (log in with it + an authenticator code)            |
| `ADMIN_TOTP_RESET` | —           | `1` forgets the enrolled authenticator (next login sets up a new one) |
| `PUBLIC_URL`     | `BASE_URL`    | Origin used in emailed setup / gallery links                         |
| `PAID_RETENTION_DAYS` | `365`    | How long a paid event keeps its photos                               |
| `EVENT_PRICE_CENTS` | `1900`     | Web price of an event gallery, in cents                              |
| `EVENT_CURRENCY` | `eur`         | Currency of that price                                               |
| `APPLE_BUNDLE_ID` | `co.smallvictories.photoboot` | iOS app whose in-app purchases are accepted               |
| `APPLE_PRODUCT_ID` | `co.smallvictories.photoboot.eventgallery` | The consumable that buys an event gallery |
| `APPLE_ALLOW_SANDBOX` | `1`      | Accept Sandbox purchases (TestFlight, sandbox testers); `0` = Production only |
| `BREVO_API_KEY`  | —             | Sends the event emails through Brevo (without it they're logged)     |
| `MAIL_FROM`      | `booth@small-victories.co` | Sender address (a verified Brevo sender)                |
| `DB_PATH`        | `EVENTS_DIR/photoboot.db` | SQLite database (events, photos, payments, sessions), without `DATABASE_URL` |
| `UPLOAD_TOKEN`   | —             | If set, uploads need this token (set it in settings) or an event key |
| `STRIPE_SECRET_KEY` | —          | Stripe secret key (`sk_live_…` / `sk_test_…`); without it there's no checkout |
| `STRIPE_WEBHOOK_SECRET` | —      | Signing secret (`whsec_…`) of the Stripe webhook endpoint            |
| `STRIPE_AUTOMATIC_TAX` | —       | `1` lets Stripe Tax add VAT (the price is then VAT-inclusive)        |

All settings live in a `.env` next to `docker-compose.yml`: copy
[`.env.example`](.env.example), which lists every variable with its default, and
fill in what you need (empty = default). Compose loads it into the container,
and `npm start` / `npm run dev` read it too.

### Payments (Stripe)

Hosts pay for an event gallery on `/event.html` through Stripe Checkout;
the server talks to Stripe's API directly (no SDK).

1. In the Stripe dashboard (Developers → API keys) copy the secret key into
   `STRIPE_SECRET_KEY`.
2. Developers → Webhooks → Add endpoint: `https://<host>/api/stripe/webhook`
   with the events `checkout.session.completed`,
   `checkout.session.async_payment_succeeded` and `charge.refunded`. Copy
   its signing secret into `STRIPE_WEBHOOK_SECRET`.
3. Optional: turn on Stripe Tax (with your registrations) and set
   `STRIPE_AUTOMATIC_TAX=1`. Checkout always offers an invoice.

Test mode works the same: use the `sk_test_…` key and a test-mode webhook
(or `stripe listen --forward-to localhost:8080/api/stripe/webhook`). A full
refund in Stripe ends the event's paid perks; its photos stay.

### In-app purchase (iOS)

Inside the iOS app, an event gallery is sold through Apple in-app purchase
(App Store guideline 3.1.1); the web keeps its own checkout. The app asks the
server for a pending event, buys the consumable with that event's
`appAccountToken`, and sends the signed StoreKit 2 transaction to
`/api/apple/redeem`. The server verifies Apple's signature and certificate
chain itself (pinned Apple Root CA - G3, `server/apple-root-ca-g3.pem`) and
activates the event; the host gets the usual email and the booth sets itself
up right away. To set it up:

1. **App Store Connect → the app → In-App Purchases**: create a
   **Consumable** with product id `co.smallvictories.photoboot.eventgallery`
   (or set `APPLE_PRODUCT_ID` on the server and `VITE_APPLE_PRODUCT_ID` when
   building the app), a price, a display name and description, and a review
   screenshot of the settings card. Submit it together with the next app
   version.
2. **App Information → App Store Server Notifications**: Version 2, with
   `https://<host>/api/apple/notifications` as both the Production and the
   Sandbox URL. Refunds then end the paid perks, and a purchase whose app
   never got back to the server still activates its event.
3. **Agreements, Tax, and Banking**: the Paid Apps agreement must be active.
   Join the **App Store Small Business Program** (15% commission instead of
   30% under $1M a year).
4. Test with TestFlight or a sandbox account: those purchases are Sandbox,
   accepted unless `APPLE_ALLOW_SANDBOX=0`.

## Privacy

Without a server event, only photos a guest chooses to share leave the
booth; a booth in an event uploads every photo to that event's gallery. Each
uploaded photo gets an unguessable link and a page where the guest can save it or delete it, and
it's deleted automatically after `SHARE_TTL_DAYS`. Images are served with
`Cache-Control: private`, so a CDN doesn't keep copies after a delete.
Uploads are rate-limited per IP unless they come from a booth with a valid
event key. Everything else — settings, counters, the full photo archive —
stays in the booth's browser.

## Supported printers

Auto-detect recognises a printer by its Bluetooth name when you tap
*Connect printer*, and sets the paper width, resolution and tear margin for
it. Not recognised? Pick your model under Settings → Printer & paper. You
can override the width and margin there too.

✅ printed on real hardware · 🧪 implemented from the protocol as documented
by other open-source projects, not tried yet. **Got one of the 🧪 printers?
Please tell us how it went**:
[open a printer report](https://github.com/marijnvandevoorde/photoboot/issues/new?template=printer.yml),
whether it worked or not.

| Printer | Also sold as / Bluetooth name | Width | Status |
| --- | --- | --- | --- |
| Phomemo P2, P2S | `P2…` | 552 of 576 dots, 300 dpi | ✅ |
| Phomemo M02S, M02 Pro | `M02S`, `M02PRO` | 552 / 600 dots, 300 dpi | 🧪 |
| Phomemo M02, M02X, T02, M03, Memoking | `M02…`, `T02…`, `Mr.in…` | 384 (M03: 432) dots, 203 dpi | 🧪 |
| Phomemo M110, M120, M220, M221 (labels) | `M110`, `Q199E`, `Q0xx`… | 320 / 560 dots, 203 dpi | 🧪 |
| Cat printers GB01–GB05, GT01, X5–X8, LY0x | iPrint / Tiny Print apps, AliExpress, Temu, Amazon | 384 dots, 203 dpi | 🧪 |
| Cat printers MX05–MX13, YT01, PD01 | iPrint / Fun Print | 384 dots | 🧪 |
| MXW01, Flying Tiger, StickerMate, C17 | Fun Print / WalkPrint | 384 dots | 🧪 |
| LuckJingle / Luck P D1, L1, S1 | `LuckP_…`, `DP_…` | 384 dots | 🧪 |
| Crafts & Co 3128 (Action) | `C&Co…` | 384 dots | 🧪 |
| Fichero Mini Pocket Printer (Action) | pick it in settings: the picker then lists every device | 384 dots | 🧪 |
| Lidl / Silvercrest Mini Pocket Printer | `Mini Pocket Printer…` | 384 dots | 🧪 |
| PeriPage A6, A6+ | `PeriPage…` | 384 / 576 dots | 🧪 |
| Marklife P50 | `P50…` | 384 dots | 🧪 |
| Paperang P1, P2 | `Paperang…` | 384 / 576 dots | 🧪 |
| Niimbot B1, B21 (labels) | `B1-…`, `B21…` | 384 dots | 🧪 |
| 58 / 80 mm BLE receipt printers (PT-210, MTP-II, MPT-III…) | any name: pick *Receipt printer* in settings | 384 / 576 dots | 🧪 |

**Not supported:**
- Printers that only do Bluetooth Classic, which browsers can't reach. Many
  older receipt printers are like this; if yours never shows up in the
  picker, this is probably why.
- Narrow label makers (Niimbot D11 / D110, Phomemo D30 / Q30 / P12,
  Marklife P12 / P15, Fichero D11s labelprinter): they print sideways on
  12 mm tape, too small for a photo.
- Photo printers that aren't thermal (Kodak, Polaroid, HP Sprocket, Canon
  Zoemini, ZINK, dye-sub).

The drivers build on the reverse-engineering work of
[NaitLee/Cat-Printer](https://github.com/NaitLee/Cat-Printer),
[rbaron/catprinter](https://github.com/rbaron/catprinter),
[jeremy46231/MXW01-catprinter](https://github.com/jeremy46231/MXW01-catprinter),
[MultiMote/niimbluelib](https://github.com/MultiMote/niimbluelib),
[vivier/phomemo-tools](https://github.com/vivier/phomemo-tools),
[0xMH/fichero-printer](https://github.com/0xMH/fichero-printer),
[SwapnanilDhol/minixprint](https://github.com/SwapnanilDhol/minixprint),
[Yrr0r/paperang-web](https://github.com/Yrr0r/paperang-web),
[bitbank2/Thermal_Printer](https://github.com/bitbank2/Thermal_Printer) and
[opentlp](https://github.com/opentlp/opentlp).

## Adding a printer

Have a printer that isn't on the list, or a 🧪 one that doesn't print right?
[Open a printer report](https://github.com/marijnvandevoorde/photoboot/issues/new?template=printer.yml)
with its Bluetooth name and the app it came with: that's usually enough to
tell which protocol it speaks.

Want to add it yourself? Pull requests are very welcome:

- Most printers speak a protocol we already have: add a model to
  `src/printers/models.ts` with its Bluetooth name prefixes, resolution,
  width and tear margin.
- A new protocol is a subclass of `PrinterBase` in
  `src/printers/<family>.ts`. Declare its Bluetooth channels and implement
  `init`, `printRaster` and `feed`; the base class does the connecting,
  timeouts, write pacing and reconnects. Register it in
  `src/printers/index.ts`, and add a test with a fake printer like those in
  `test/printers.test.ts`.
- Tried it on real hardware? Set `verified: true` on the model and move it
  to ✅ in this README.

Protocol notes are in [CONTEXT.md](CONTEXT.md).

## How it's built

TypeScript and Vite, no framework. Photos are dithered to 1-bit in
the browser (`src/raster.js`, `src/effects.js`), composed with the template
(`src/strip.js`) and sent to the printer in its own protocol over Web
Bluetooth (`src/printers/`). [CONTEXT.md](CONTEXT.md) has the full map of the code, the
printer protocol and the decisions behind it.

## License

[MIT](LICENSE) © Marijn Van de Voorde
