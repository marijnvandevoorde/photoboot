# Photoboot as a store app: assessment (2026-11-27)

The question: ship photoboot on the App Store and Google Play, still using the server for uploads and galleries.

## What is sold, and the model that fits

The booth is free; the one thing for sale is an **event gallery**: €19 per event (`EVENT_PRICE_CENTS`), paid
once, through Stripe on the web. Both stores treat that as a digital good, so inside the apps it must go through
their own billing. The fitting product is a **consumable** one-time purchase (one per event, buyable again for
the next event), which is what the iOS app already does. No subscription: hosts buy per party.

| | Web (Stripe) | App Store / Play, €19.99 |
| --- | --- | --- |
| Net per sale, Belgian buyer (21% VAT) | ~€15.15 (€15.70 ex VAT minus 1.5% + €0.25) | ~€14.05 (€16.52 ex VAT minus 15%) |
| VAT | We file it | The store collects and pays it |

Prices in the stores come from price points (€18.99 or €19.99); a different price than the web is allowed.
Purchases made on the web stay usable in the apps (join with the setup link): Apple's 3.1.3(b) allows that
because the same thing is also on sale in the app.

## Work per platform

**iOS (most of it is built):** Capacitor app with native Bluetooth printing and keep-awake, StoreKit 2 purchase
with server verification (`src/purchase.ts`, `server/apple.ts`), refund notifications, and the web checkout link
hidden in the app. Left to do, about 1–2 days plus review time:

- App Store Connect: the app record, the consumable `co.smallvictories.photoboot.eventgallery` with its review
  screenshot, Server Notifications V2 URL, Small Business Program (check that the account is in it).
- Listing in en/nl/fr, screenshots for 13" iPad and 6.9" iPhone (or make it iPad-only:
  `TARGETED_DEVICE_FAMILY` is now `1,2`), age rating, privacy labels (photos, email, purchases; no tracking).
- A privacy manifest if the upload asks for one (the app target has no `PrivacyInfo.xcprivacy`).
- One TestFlight round on the iPad: camera, printing, buying in Sandbox.
- App Review buys in Sandbox against the production server, so production keeps `APPLE_ALLOW_SANDBOX=1`.

**Android (not built), about 3–5 days:**

- `@capacitor/android` and `cap add android`; Bluetooth (`BLUETOOTH_SCAN` with `neverForLocation`,
  `BLUETOOTH_CONNECT`) and camera permissions; current target SDK.
- Play Billing in the client: `@capgo/native-purchases` covers Android too; `isIosApp` becomes "store app".
- `server/google.ts`: start (pending event, `obfuscatedAccountId` = event token), redeem (Play Developer API
  `purchases.products` lookup, check product, state and token, consume, activate), refunds from the Voided
  Purchases API in the hourly job or from real-time notifications (Pub/Sub). Rilo's
  `server/src/identity/google-purchases.ts` already does the service-account JWT and Play calls with
  `node:crypto` only; copy that.
- Play Console: one-time product, Data safety form, content rating, listing, internal/closed testing (a personal
  developer account made after November 2023 needs 12 testers for 14 days; an organisation account doesn't).
- Privacy policy, terms and `docs/gdpr.md` add Google next to Apple.

**Both:** the hub rule that small-victories.co links only to the stores can't apply here. Laptops, Mac minis
and Android Chrome run the web booth, which is the main product, so the web stays listed next to the badges.
Each release then means two store reviews, plus a yearly target-SDK bump on Play and the Xcode minimum on Apple.

## Review risks

- **Apple 4.2 (minimum functionality / wrapped website): low to medium.** The app bundles its pages (it doesn't
  load the website) and does what Safari can't: Bluetooth printing (no Web Bluetooth on iOS), a kiosk camera,
  screen kept on. Say so in the review notes.
- **Apple 2.1 (reviewer can't test):** the reviewer has no thermal printer. "Start without printer" works
  everywhere; add a short video of a print to the notes.
- **Apple 3.1.1 (payments):** covered by IAP. The app must never show the web price or link to `/event.html`
  (settings already hides it; keep it that way).
- **Apple 1.2 (user-generated content):** galleries are private per event and guests can delete their photo;
  a reviewer may still ask about reporting. Answer: nothing is shared publicly between users.
- **Google:** Payments policy is met once Play Billing is in; low risk on the WebView rules for the same
  reasons as Apple.

## Cost

- Accounts: none extra. The Small Victories developer accounts already exist for the kids' apps (€99 a year,
  $25 once).
- Commission: 15% (Apple Small Business Program; Play's 15% tier on the first $1M a year), about €1.10 less
  per sale than the web.
- Time: iOS 1–2 days, Android 3–5 days, then about an hour or two per release for builds and reviews.

## Recommendation

**Ship iOS first, iPad-only; hold Android.** iOS is where the web falls short (Safari has no Web Bluetooth,
and Bluefy is a workaround whose camera is still untested), and the code is already there. Android Chrome
already prints from the web and installs as a PWA, so an Android app only adds store visibility, for 3–5 days
of billing work. Revisit Android once the iOS app has sold galleries for a few months. If Android is wanted
sooner, a version without in-app sales (hosts buy on the web, the app only joins events, with no link or price
for the web checkout) avoids Play Billing.
