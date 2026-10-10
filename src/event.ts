// Public sign-up page for a paid event (/event.html): explains the gallery,
// shows the price, sends the host to Stripe Checkout (server/stripe.ts) and,
// back from Stripe (?session=…), shows the links once the payment is in.

import { $, errorMessage } from './dom.ts';

interface Price {
  amount: number;
  currency: string;
  enabled: boolean;
  paidDays: number;
  freeDays: number;
}

interface Status {
  paid: boolean;
  eventName?: string;
  setupLink?: string;
  galleryLink?: string;
}

const DRAFT = 'photoboot:event-draft'; // the form, kept for a cancelled checkout

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Something went wrong (${res.status}).`);
  return data as T;
}

const money = (cents: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

const days = (n: number) => (n === 0 ? 'for good' : n === 365 ? 'a year' : `${n} days`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- the offer + form ----------

async function showPrice() {
  try {
    const price = await api<Price>('/api/checkout/price');
    $('price').textContent = money(price.amount, price.currency);
    for (const el of document.querySelectorAll('[data-paid-days]')) el.textContent = days(price.paidDays);
    for (const el of document.querySelectorAll('[data-free-days]')) el.textContent = days(price.freeDays);
    if (!price.enabled) {
      showError("Payments aren't set up on this server yet.");
      ($('pay') as HTMLButtonElement).disabled = true;
    }
  } catch {
    // The form still works; the server answers with the real error.
  }
}

function showError(message: string) {
  const box = $('form-error');
  box.textContent = message;
  box.hidden = !message;
}

const field = (id: string) => $<HTMLInputElement>(id);

function restoreDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(DRAFT) ?? '{}') as Record<string, string>;
    for (const id of ['name', 'date', 'email']) if (draft[id]) field(id).value = draft[id];
  } catch {
    // no storage (private mode): just an empty form
  }
}

async function submit(e: SubmitEvent) {
  e.preventDefault();
  showError('');
  const name = field('name').value.trim();
  const email = field('email').value.trim();
  const eventDate = field('date').value || null;
  if (!name) return showError('Give the event a name.');
  if (!field('email').checkValidity() || !email) return showError('That email address looks wrong.');
  const pay = $<HTMLButtonElement>('pay');
  pay.disabled = true;
  pay.textContent = 'Opening the payment page…';
  try {
    sessionStorage.setItem(DRAFT, JSON.stringify({ name, date: eventDate ?? '', email }));
  } catch {
    // fine without
  }
  try {
    const { url } = await api<{ url: string }>('/api/checkout', { name, email, eventDate });
    location.href = url;
  } catch (err) {
    showError(errorMessage(err));
    pay.disabled = false;
    pay.textContent = 'Continue to payment';
  }
}

// ---------- back from Stripe ----------

async function showPaid(session: string) {
  $('paid').hidden = false;
  $('offer').hidden = true;
  try {
    sessionStorage.removeItem(DRAFT);
  } catch {
    // fine without
  }
  // The webhook may still be on its way; the server asks Stripe directly.
  for (let i = 0; i < 8; i++) {
    try {
      const status = await api<Status>(`/api/checkout/status?session=${encodeURIComponent(session)}`);
      if (status.paid && status.setupLink && status.galleryLink) return showLinks(status);
    } catch {
      // try again
    }
    await sleep(Math.min(1500 * (i + 1), 5000));
  }
  $('paid-waiting').textContent =
    "Your payment is still being confirmed. That can take a few minutes for some banks: the links will arrive by email as soon as it's in.";
}

function showLinks(status: Status) {
  $('paid-waiting').hidden = true;
  $('paid-links').hidden = false;
  $('paid-name').textContent = status.eventName ?? 'Your event';
  const setup = status.setupLink as string;
  $<HTMLAnchorElement>('setup-open').href = setup;
  const gallery = $<HTMLAnchorElement>('gallery-link');
  gallery.href = status.galleryLink as string;
  gallery.textContent = status.galleryLink as string;
  const copy = $<HTMLButtonElement>('setup-copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(setup);
      copy.textContent = 'Copied ✓';
    } catch {
      prompt('Copy the setup link:', setup);
    }
  });
}

// ---------- start ----------

const params = new URLSearchParams(location.search);
const session = params.get('session');
if (session) {
  void showPaid(session);
} else {
  $('cancelled').hidden = params.get('cancelled') !== '1';
  restoreDraft();
  $<HTMLFormElement>('form').addEventListener('submit', submit);
}
void showPrice();
