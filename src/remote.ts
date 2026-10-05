// Client for the server's event API (server/events.js).
//
// Admin calls carry the server's ADMIN_TOKEN (entered once in settings and
// kept in localStorage, never exported). Booth calls carry the event's setup
// key, which the setup QR hands to each device.

import type { PortableConfig } from './config.ts';
import type { Stats } from './stats.ts';
import type { TemplateImages } from './templates.ts';

const ADMIN_TOKEN_KEY = 'photoboot:server-admin-token';

// A whole booth setup: what profiles, export files and server events hold.
export interface Setup {
  version?: number;
  name: string;
  config: Partial<PortableConfig>;
  images: TemplateImages;
}

export interface EventSummary {
  id: string;
  name: string;
  created: string;
  updated: string;
  setupKey: string;
  galleryKey: string;
  photos: number;
  stats: Stats & { booths: number };
}

export interface CreatedEvent {
  id: string;
  name: string;
  setupKey: string;
  galleryKey: string;
}

export function getAdminToken() {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setAdminToken(token: string) {
  try {
    if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
    else localStorage.removeItem(ADMIN_TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

async function call<T>(
  method: string,
  path: string,
  { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

const admin = () => ({ Authorization: `Bearer ${getAdminToken()}` });

export const remote = {
  listEvents: () => call<{ events: EventSummary[] }>('GET', '/api/events', { headers: admin() }),
  createEvent: (event: Setup) => call<CreatedEvent>('POST', '/api/events', { body: event, headers: admin() }),
  updateEvent: (id: string, event: Setup) =>
    call<{ ok: true }>('PUT', `/api/events/${id}`, { body: event, headers: admin() }),
  deleteEvent: (id: string) => call<{ ok: true }>('DELETE', `/api/events/${id}`, { headers: admin() }),
  // Booth side: fetch a setup with its key; push this device's stats.
  loadEvent: (id: string, key: string) =>
    call<Setup & { id: string }>('GET', `/api/events/${id}`, { headers: { 'X-Event-Key': key } }),
  pushStats: (id: string, key: string, device: string, stats: Stats) =>
    call<{ ok: true }>('POST', `/api/events/${id}/stats`, { body: { device, stats }, headers: { 'X-Event-Key': key } }),
};

// A stable random id for this device, so the server can sum stats across
// booths of the same event without double counting.
export function deviceId(): string {
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
export const setupUrl = (id: string, setupKey: string) => `${location.origin}/settings.html#event=${id}.${setupKey}`;
export const galleryUrl = (id: string, galleryKey: string) => `${location.origin}/g/${id}/${galleryKey}`;
