// The owner's admin page (/admin.html): log in with the server's admin token
// plus an authenticator code, then manage every event. Talks to
// server/admin.ts; the session is an HttpOnly cookie, so nothing secret is
// kept in this page or in localStorage.

import qrcode from 'qrcode-generator';
import { $, errorMessage } from './dom.ts';

interface AdminEvent {
  id: string;
  name: string;
  email: string | null;
  eventDate: string | null;
  status: 'pending' | 'active';
  paid: boolean;
  retentionDays: number | null;
  source: string;
  created: string;
  setupLink: string;
  galleryLink: string;
  photos: number;
  stats: { sessions: number; prints: number; booths: number };
}

interface Payment {
  eventId: string | null;
  provider: string;
  ref: string;
  amount: number;
  currency: string;
  status: string;
  created: string;
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api/admin/${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined && method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== 'login') showLogin();
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);
const fmtDate = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '—');
const money = (cents: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function flash(message: string, isError = false) {
  const box = $('save-status');
  box.textContent = message;
  box.classList.toggle('error', isError);
  box.hidden = false;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => (box.hidden = true), isError ? 5000 : 1800);
}

function qrSvg(text: string, cell = 5) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true });
}

// ---------- login ----------

function showLogin() {
  $('login').hidden = false;
  $('panels').hidden = true;
  $('logout').hidden = true;
}

async function showPanels() {
  $('login').hidden = true;
  $('panels').hidden = false;
  $('logout').hidden = false;
  await Promise.all([loadEvents(), loadPayments()]);
}

$<HTMLFormElement>('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-error').hidden = true;
  try {
    const res = await api<{ ok?: boolean; enroll?: { secret: string; url: string } }>('POST', 'login', {
      token: $<HTMLInputElement>('login-token').value,
      code: $<HTMLInputElement>('login-code').value.replace(/\s/g, '') || undefined,
    });
    if (res.enroll) {
      $('enroll').hidden = false;
      $('login-code-label').hidden = false; // hidden until enrolled; needed now
      $('enroll-qr').innerHTML = qrSvg(res.enroll.url);
      $('enroll-secret').textContent = res.enroll.secret.replace(/(.{4})/g, '$1 ').trim();
      $<HTMLInputElement>('login-code').required = true;
      $<HTMLInputElement>('login-code').focus();
      return;
    }
    $<HTMLInputElement>('login-token').value = '';
    $<HTMLInputElement>('login-code').value = '';
    $('enroll').hidden = true;
    await showPanels();
  } catch (err) {
    $('login-error').textContent = errorMessage(err);
    $('login-error').hidden = false;
  }
});

$<HTMLButtonElement>('logout').addEventListener('click', async () => {
  await api('POST', 'logout').catch(() => {});
  showLogin();
});

// ---------- events ----------

let searchTimer: ReturnType<typeof setTimeout> | undefined;
$<HTMLInputElement>('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(loadEvents, 250);
});
$<HTMLButtonElement>('refresh').addEventListener('click', () => {
  loadEvents();
  loadPayments();
});

async function loadEvents() {
  const list = $('events');
  try {
    const q = encodeURIComponent($<HTMLInputElement>('search').value.trim());
    const { events } = await api<{ events: AdminEvent[] }>('GET', `events?q=${q}`);
    const paid = events.filter((e) => e.paid).length;
    $('summary').textContent =
      `${events.length} event(s) · ${paid} paid · ${events.reduce((n, e) => n + e.photos, 0)} photos`;
    list.replaceChildren(...events.map(eventItem));
    if (!events.length) list.innerHTML = '<li class="muted">No events.</li>';
  } catch (err) {
    list.innerHTML = `<li class="warn">${esc(errorMessage(err))}</li>`;
  }
}

function badge(ev: AdminEvent) {
  if (ev.status === 'pending') return '<span class="badge pending">waiting for payment</span>';
  return ev.paid ? `<span class="badge paid">${esc(ev.source)}</span>` : '<span class="badge free">not paid</span>';
}

function eventItem(ev: AdminEvent): HTMLLIElement {
  const li = document.createElement('li');
  const keep = ev.retentionDays === 0 ? 'kept forever' : `kept ${ev.retentionDays ?? '—'} days`;
  li.innerHTML =
    `<div><strong>${esc(ev.name)}</strong>${badge(ev)}<br>` +
    `<span class="meta">${esc(ev.email ?? 'no email')} · ${ev.eventDate ? `on ${esc(ev.eventDate)} · ` : ''}` +
    `${ev.photos} photos · ${ev.stats.sessions} sessions on ${ev.stats.booths} booth(s) · ${keep} · ` +
    `created ${fmtDate(ev.created)} · <code>${esc(ev.id)}</code></span></div>`;
  const row = document.createElement('div');
  row.className = 'row';
  const btn = (label: string, fn: () => unknown, cls = '') => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (cls) b.className = cls;
    b.addEventListener('click', async () => {
      try {
        await fn();
      } catch (err) {
        flash(errorMessage(err), true);
      }
    });
    row.append(b);
  };
  btn('Setup link', () => showLink(`Setup link for “${ev.name}”: open on each booth`, ev.setupLink));
  btn('Gallery link', () => showLink(`Gallery for “${ev.name}”: for the host`, ev.galleryLink));
  if (ev.email) {
    btn('Resend email', async () => {
      await api('POST', `events/${ev.id}/email`);
      flash(`Sent to ${ev.email} ✓`);
    });
  }
  btn('Retention…', async () => {
    const days = prompt(
      'Keep photos for how many days after they were taken? (0 = forever)',
      String(ev.retentionDays ?? '')
    );
    if (days === null) return;
    await api('PATCH', `events/${ev.id}`, { retentionDays: Number(days) });
    flash('Saved ✓');
    loadEvents();
  });
  if (!ev.paid) {
    btn('Mark paid', async () => {
      if (!confirm(`Mark “${ev.name}” as paid without a payment?`)) return;
      await api('PATCH', `events/${ev.id}`, { paid: true });
      loadEvents();
    });
  }
  btn(
    'Delete',
    async () => {
      if (!confirm(`Delete “${ev.name}” and all ${ev.photos} of its photos? This can't be undone.`)) return;
      await api('DELETE', `events/${ev.id}`);
      flash('Deleted ✓');
      loadEvents();
    },
    'danger'
  );
  li.append(row);
  return li;
}

function showLink(title: string, url: string) {
  const box = $('qr-box');
  box.innerHTML =
    `<p><strong>${esc(title)}</strong></p>${qrSvg(url)}` +
    `<p class="small"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url)}</a></p>` +
    '<div class="row"><button type="button" data-copy>Copy</button><button type="button" data-close>Close</button></div>';
  box.hidden = false;
  box.querySelector('[data-copy]')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(url);
    flash('Copied ✓');
  });
  box.querySelector('[data-close]')?.addEventListener('click', () => (box.hidden = true));
}

// ---------- comp ----------

$<HTMLFormElement>('comp-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { event } = await api<{ event: AdminEvent }>('POST', 'events', {
      name: $<HTMLInputElement>('comp-name').value,
      email: $<HTMLInputElement>('comp-email').value,
      eventDate: $<HTMLInputElement>('comp-date').value || undefined,
      sendEmail: $<HTMLInputElement>('comp-send').checked,
    });
    $<HTMLFormElement>('comp-form').reset();
    flash(`Created “${event.name}” ✓`);
    showLink(`Setup link for “${event.name}”`, event.setupLink);
    loadEvents();
  } catch (err) {
    flash(errorMessage(err), true);
  }
});

// ---------- payments ----------

async function loadPayments() {
  const list = $('payments');
  try {
    const { payments } = await api<{ payments: Payment[] }>('GET', 'payments');
    list.innerHTML = payments.length
      ? payments
          .map(
            (p) =>
              `<li>${fmtDate(p.created)} · ${esc(p.provider)} · ${money(p.amount, p.currency)} · ${esc(p.status)}` +
              ` · event <code>${esc(p.eventId ?? 'deleted')}</code></li>`
          )
          .join('')
      : '<li class="muted">No payments yet.</li>';
  } catch (err) {
    list.innerHTML = `<li class="warn">${esc(errorMessage(err))}</li>`;
  }
}

// ---------- start ----------

api<{ loggedIn: boolean; enrolled: boolean }>('GET', 'me')
  .then(({ loggedIn, enrolled }) => {
    $('login-code-label').hidden = !enrolled;
    if (loggedIn) showPanels();
    else showLogin();
  })
  .catch((err) => {
    showLogin();
    $('login-error').textContent = errorMessage(err);
    $('login-error').hidden = false;
  });
