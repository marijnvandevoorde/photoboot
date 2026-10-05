# Photoboot

A photo booth that runs in the browser and prints stickers on a pocket
Bluetooth thermal printer. Put a laptop, tablet or Mac mini with a webcam at
your party, connect a Phomemo printer, and guests walk away with a
black-and-white sticker — plus a colour copy on their phone via a QR code.

**Try it: [boot.small-victories.co](https://boot.small-victories.co)** — open
it in Chrome (Android, Mac, Windows) or in [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)
on iPad / iPhone. “Start without printer” works on anything with a camera.

No app store, no account, no cloud service required: it's a static web app
plus a tiny Node server for the QR sharing, which you can host yourself.

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
- **Server events**: publish a setup to your server, scan its QR on any other
  device to get the same booth, and share a private gallery (with ZIP
  download and counters) with the host afterwards.

Settings live on a hidden page: long-press the “Photoboot” title on the
start screen, long-press the top-left corner of the camera view for 2 s, or
open `/?admin=1`. You can protect it with a PIN.

## Hardware

- **Printer**: Phomemo P2 / P2S / M02 / M03 / M04 / T02 family over
  Bluetooth Low Energy (300 dpi, 576-dot head). Other printers can be added,
  see [Adding a printer](#adding-a-printer).
- **Paper**: the default is a 53 mm roll with 50 mm stickers (552 dots wide).
  Other widths are a setting; `/test.html` prints calibration rulers.
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

## Host it

The production server is plain Node (no dependencies) serving `dist/` plus
the share and event routes. With Docker:

```sh
docker compose up -d --build
```

`docker-compose.yml` is set up for a Traefik reverse proxy; adapt the labels,
domain and volumes to your host. `./deploy.sh user@host` copies the project
over SSH and runs Compose there.

| Variable         | Default       | What it does                                                        |
| ---------------- | ------------- | ------------------------------------------------------------------- |
| `BASE_URL`       | from request  | Public origin used in QR links, e.g. `https://booth.example.com`     |
| `PORT`           | `8080`        | HTTP port                                                            |
| `SHARE_DIR`      | `./shares`    | Where shared photos are stored                                       |
| `EVENTS_DIR`     | `./events`    | Where server events are stored                                       |
| `SHARE_TTL_DAYS` | `30`          | Shared photos are deleted after this many days (`0` = never)          |
| `SHARE_MAX_MB`   | `5000`        | Refuse uploads once the photo folder is this big                     |
| `ADMIN_TOKEN`    | —             | Enables server events; enter it on the settings page to manage them  |
| `UPLOAD_TOKEN`   | —             | If set, uploads need this token (set it in settings) or an event key |

Put the secrets in a `.env` next to `docker-compose.yml`.

## Privacy

Only photos a guest chooses to share leave the booth. Each shared photo gets
an unguessable link and a page where the guest can save it or delete it, and
it's deleted automatically after `SHARE_TTL_DAYS`. Images are served with
`Cache-Control: private`, so a CDN doesn't keep copies after a delete.
Uploads are rate-limited per IP unless they come from a booth with a valid
event key. Everything else — settings, counters, the full photo archive —
stays in the booth's browser.

## Adding a printer

Printers are pluggable. Subclass `PrinterBase` in `src/printers/<brand>.js`
(connect, init, printRaster, feed), register it in `src/printers/index.js`
with its Bluetooth name prefixes and service UUIDs, and it shows up in
settings and in auto-detect. The Phomemo protocol notes are in
[CONTEXT.md](CONTEXT.md).

## How it's built

Vanilla JavaScript and Vite, no framework. Photos are dithered to 1-bit in
the browser (`src/raster.js`, `src/effects.js`), composed with the template
(`src/strip.js`) and sent to the printer as ESC/POS raster commands over
Web Bluetooth. [CONTEXT.md](CONTEXT.md) has the full map of the code, the
printer protocol and the decisions behind it.

## License

[MIT](LICENSE) © Marijn Van de Voorde
