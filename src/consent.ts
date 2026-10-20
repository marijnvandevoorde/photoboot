// Google Tag Manager behind a cookie banner, with Google Consent Mode v2.
// Only on the public host-facing pages (event sign-up, privacy, terms): never
// on the booth, settings, admin, or the guests' photo and gallery pages.
//
// Usage: load this first in <head> with
//   <script type="module" src="/src/consent.ts"></script>
// and put a reopen link anywhere on the page:
//   <button type="button" data-consent-open>Cookie settings</button>
//
// - Every consent type defaults to 'denied', pushed before GTM loads.
// - Accept grants analytics_storage only; the ad_* types always stay denied.
// - The choice is kept in localStorage ('photoboot:consent'); Reject also
//   removes the Google Analytics cookies.
// - The GA4 tag lives in the GTM container, not here.
// - No GTM id (VITE_GTM_ID set empty at build time), or running inside the
//   app, on localhost or in the Vite dev server: nothing loads, no banner.

const GTM_ID = (import.meta.env.VITE_GTM_ID ?? 'GTM-KPTLSZBG').trim();
const KEY = 'photoboot:consent';
const PRIVACY_URL = '/privacy';

type Choice = 'granted' | 'denied';

declare global {
  interface Window {
    dataLayer: unknown[];
    gtag: (...args: unknown[]) => void;
  }
}

function read(): Choice | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}

function write(v: Choice) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    // Private mode: the banner simply comes back next time.
  }
}

function clearGaCookies() {
  // GA sets its cookies on the widest domain it can (.small-victories.co
  // for boot.small-victories.co), so clear them on every parent domain too.
  const parts = location.hostname.split('.');
  const domains = [''];
  for (let i = 0; i < parts.length - 1; i++) {
    const d = parts.slice(i).join('.');
    domains.push(`; domain=${d}`, `; domain=.${d}`);
  }
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0].trim();
    if (name === '_ga' || name.startsWith('_ga_') || name === '_gid') {
      for (const d of domains) {
        // biome-ignore lint/suspicious/noDocumentCookie: the Cookie Store API is missing in older Safari
        document.cookie = `${name}=; Max-Age=0; path=/${d}`;
      }
    }
  }
}

function loadGtm(id: string) {
  window.dataLayer = window.dataLayer || [];
  // gtag() must push the arguments object itself, as Google's snippet does.
  window.gtag = function gtag() {
    // biome-ignore lint/complexity/noArguments: Consent Mode reads the arguments object
    window.dataLayer.push(arguments);
  };
  window.gtag('consent', 'default', {
    ad_storage: 'denied',
    ad_user_data: 'denied',
    ad_personalization: 'denied',
    analytics_storage: 'denied',
    functionality_storage: 'denied',
    personalization_storage: 'denied',
    security_storage: 'denied',
    wait_for_update: 500,
  });
  if (read() === 'granted') window.gtag('consent', 'update', { analytics_storage: 'granted' });
  window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${encodeURIComponent(id)}`;
  document.head.appendChild(script);
}

function banner(): HTMLElement {
  const el = document.createElement('section');
  el.className = 'consent';
  el.setAttribute('role', 'region');
  el.setAttribute('aria-labelledby', 'consent-title');
  el.hidden = true;
  el.innerHTML = `<div class="consent-inner">
  <h2 id="consent-title">Cookies?</h2>
  <p>May I use Google Analytics to count visits to this page? It sets cookies, and only if you say yes.
  More in the <a href="${PRIVACY_URL}">privacy policy</a>.</p>
  <div class="consent-actions">
    <button type="button" data-consent="granted">Accept</button>
    <button type="button" data-consent="denied">Reject</button>
  </div>
</div>`;
  el.addEventListener('click', (e) => {
    const btn = (e.target as Element).closest<HTMLElement>('[data-consent]');
    if (!btn) return;
    const value = btn.dataset.consent as Choice;
    write(value);
    window.gtag('consent', 'update', { analytics_storage: value });
    if (value === 'denied') clearGaCookies();
    el.hidden = true;
  });
  document.body.appendChild(el);
  return el;
}

function init() {
  const el = banner();
  if (!read()) el.hidden = false;
  document.addEventListener('click', (e) => {
    if (!(e.target as Element).closest('[data-consent-open]')) return;
    e.preventDefault();
    el.hidden = false;
    el.querySelector('button')?.focus();
  });
}

const inApp = location.protocol === 'capacitor:' || location.hostname === 'localhost';
if (GTM_ID && !inApp && !import.meta.env.DEV) {
  loadGtm(GTM_ID);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
} else {
  // Nothing to choose: hide the reopen links.
  const hide = () => {
    for (const el of document.querySelectorAll<HTMLElement>('[data-consent-open]')) el.hidden = true;
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hide);
  else hide();
}
