# GDPR record of processing (Art. 30, short form)

Last reviewed: 2026-10-20, against the code in this repo. Keep it true when data handling changes, together
with `privacy.html` and `terms.html`.

**Who:** Small Victories (Marijn Vandevoorde), Mellestraat 303, 9090 Merelbeke-Melle, Belgium,
BE0793.301.929, hello@small-victories.co. No DPO (not required: small scale, no special categories as a
core activity).

## Roles

- **Photos taken at a booth:** the **host** (whoever runs the booth, free or paid) is the controller. We are
  the processor. The Art. 28 terms are in `terms.html` ("How we process your guests' photos for you").
- **Hosts' data, payments, booth counters, visits to our pages:** we are the controller.

## Processing activities

| Activity | Data | People | Legal basis | Kept | Where in the code |
| --- | --- | --- | --- | --- | --- |
| Shared photos (QR "Get photo") | JPEG of the sticker layout (no EXIF), random id, time, size | Guests | Host's (controller); we act on the host's instructions | `SHARE_TTL_DAYS` (30) after taken; guest can delete from `/s/<id>` | `server/share.ts`, `server/photos.ts` |
| Event gallery photos | Same, plus the event id | Guests | Host's (controller); we act on the host's instructions | Paid: event's `retention_days` or `PAID_RETENTION_DAYS` (365); after a refund 30 | `server/events.ts`, `src/booth.ts` (`archiveSession`, Retake skips the upload) |
| Host account / event | Event name, optional date, email, setup (config + header/footer images), keys | Hosts | Contract (Art. 6(1)(b)) | Until the host deletes it, or 30 days after its retention ended once no photos are left; unpaid: 30 days | `server/events.ts`, `server/retention.ts` |
| Payments | Provider ref, amount, currency, status, date; Stripe: session id, PaymentIntent, email, withdrawal-consent time (Stripe metadata); Apple: transaction id, product, storefront | Hosts | Contract + legal obligation (Art. 6(1)(b), (c)): Belgian accounting law | Until the end of the 7th calendar year after the payment, then deleted; kept apart from photos (event deletion sets `event_id` NULL) | `server/billing.ts`, `server/stripe.ts`, `server/apple.ts`, `server/retention.ts` |
| Booth counters | Sessions, prints, shares, paper, busiest hour, per random device id | None (no guest data) | Legitimate interest (Art. 6(1)(f)) | With the event (cascade) | `server/events.ts` (`stats`) |
| Event email | Email address, event name, links | Hosts | Contract | Brevo's own log retention | `server/mail.ts`, `server/billing.ts` |
| Analytics | GA4 via GTM, cookies `_ga*` | Visitors of event / privacy / terms pages | Consent (Art. 6(1)(a)), Consent Mode v2 default denied | Google's GA4 retention setting | `src/consent.ts` |
| Admin login | Session token hash, IP, expiry | Owner | Legitimate interest (security) | Deleted when expired (hourly job) | `server/admin.ts`, `server/retention.ts` |
| Backups | Database dump + photo bucket mirror, encrypted | All of the above | Same as the source | 30 days (`Oracle/k8s/backup/sv-backup.sh`) | Oracle repo |

The booth device itself (local copies in IndexedDB, settings, counters, PIN) is the host's device and never
reaches us unless the host exports it.

## Processors (sub-processors for the host's photos)

| Processor | What | Location | Transfer safeguard |
| --- | --- | --- | --- |
| Oracle Cloud Infrastructure | Kubernetes cluster, MySQL HeatWave (`photoboot` schema), private bucket `photoboot` (`NoPublicAccess`, no versioning) | eu-amsterdam-1 (NL) | Data stored in the EU; Oracle support access from outside the EU under SCCs / DPF |
| Hetzner | Encrypted backup mirror (Storage Box) | EU | n/a (EU) |
| Cloudflare | DNS, proxy, TLS (HTTPS redirect + HSTS at the edge) | Global edge, US company | EU–US DPF + SCCs |
| Brevo | Transactional email | France | n/a (EU) |
| Stripe | Web payments, invoices (controller for its own part) | Ireland / US | DPF + SCCs |
| Apple | In-app purchases (controller for its own part) | Ireland / US | DPF + SCCs |
| Google | GA4 + GTM, consent only | Ireland / US | DPF + SCCs |

Photos go only to Oracle (and the Hetzner backup) and through Cloudflare in transit (`Cache-Control: private`,
so not cached at the edge). Stripe, Apple and Google never see photos.

## Security (Art. 32)

- HTTPS only: Cloudflare redirects HTTP and sends HSTS; admin cookie is `Secure`, `HttpOnly`, `SameSite=Strict`.
- Unguessable links: photo id = UUID v4 (122 random bits); setup key and gallery key = 16 random bytes
  (128 bits) each, compared in constant time; event id = 9 random bytes. The bucket is private; photos are
  served through 1-hour presigned URLs or streamed by the app.
- No indexing: `/s/`, `/g/` and `/share/` send `X-Robots-Tag: noindex` (and a robots meta tag);
  `robots.txt` disallows them; `Referrer-Policy: no-referrer` on those pages so the gallery key doesn't leak.
- No directory listing: the static server only serves files from `dist/`.
- Rate limits: uploads without an event key 120/h per IP, checkout 20/h, admin login 10 failures / 15 min.
- Admin: `ADMIN_TOKEN` + TOTP. Secrets live in Kubernetes Secrets (`photoboot-env`, `photoboot-mysql`,
  `photoboot-bucket`), never in the repo.
- GTM never loads on the booth, settings or guest pages.

## Data-subject requests

- **Guest wants a photo removed:** they can delete it themselves on its page (`/s/<id>`, "Delete from the
  server"), which also removes it from the gallery. If they mail us (the gallery page, the booth notice and the
  privacy policy point to hello@small-victories.co):
  1. Find the photo by its link, or the event by name/date in `/admin`.
  2. Tell the host (their email is on the event) that a guest asked for removal.
  3. Delete the photo (its `/s/<id>` page, or `DELETE /api/share/<id>`) within a few days unless the host gives
     a good reason to keep it; answer the guest either way, within one month.
  4. The booth device's local copy is the host's: tell the guest to ask the host.
- **Host wants access, correction or deletion:** `/admin` shows and edits the event; the host can delete the
  event themselves (settings → Event → Online gallery → Delete the event, `DELETE /api/events/<id>` with the
  setup key). Payment rows stay for accounting law.
- **Breach:** tell affected hosts without undue delay (they notify their guests / the authority as
  controller); notify the Belgian DPA within 72 hours where we are the controller.

## Host's information duty

The host must tell guests. `/sign` is a printable notice (en/nl/fr, gallery or QR-only), linked from the
event page, the success screen, the event email and settings.

## Withdrawal right (consumer law, not GDPR)

The web checkout requires a checkbox (`withdrawalConsent`) that the gallery starts right away and the 14-day
withdrawal right ends once the event has taken place. The time is stored as `withdrawal_consent` metadata on
the Stripe Checkout Session and PaymentIntent, and confirmed in the event email.

## Open points

- Check the Brevo account: turn off open and click tracking for transactional email (not in the code).
- Make sure a DPA is in place with each processor: Oracle, Cloudflare, Brevo and Stripe include one in their
  terms; Hetzner's has to be concluded in its console.
- The gallery link lets anyone who has it delete a photo (through its page). That's deliberate (guests can
  remove their own photo), but it means a guest can also delete someone else's photo.
