// Client for the server's event API (server/events.js).
//
// Admin calls carry the server's ADMIN_TOKEN (entered once in settings and
// kept in localStorage, never exported). Booth calls carry the event's setup
// key, which the setup QR hands to each device.

const ADMIN_TOKEN_KEY = 'photoboot:server-admin-token';

export function getAdminToken() {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(token) {
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function call(method, path, { body, headers = {} } = {}) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const admin = () => ({ Authorization: `Bearer ${getAdminToken()}` });

export const remote = {
  listEvents: () => call('GET', '/api/events', { headers: admin() }),
  // event: { name, config, images } → { id, name, setupKey, galleryKey }
  createEvent: (event) => call('POST', '/api/events', { body: event, headers: admin() }),
  updateEvent: (id, event) => call('PUT', `/api/events/${id}`, { body: event, headers: admin() }),
  deleteEvent: (id) => call('DELETE', `/api/events/${id}`, { headers: admin() }),
  // Booth side: fetch a setup with its key; push this device's stats.
  loadEvent: (id, key) => call('GET', `/api/events/${id}`, { headers: { 'X-Event-Key': key } }),
  pushStats: (id, key, device, stats) =>
    call('POST', `/api/events/${id}/stats`, { body: { device, stats }, headers: { 'X-Event-Key': key } }),
};

// A stable random id for this device, so the server can sum stats across
// booths of the same event without double counting.
export function deviceId() {
  try {
    let id = localStorage.getItem('photoboot:device');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('photoboot:device', id);
    }
    return id;
  } catch {
    return 'unknown';
  }
}

// Links the server hands out for an event.
export const setupUrl = (id, setupKey) => `${location.origin}/settings.html#event=${id}.${setupKey}`;
export const galleryUrl = (id, galleryKey) => `${location.origin}/g/${id}/${galleryKey}`;
