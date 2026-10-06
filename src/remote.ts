// Client for the server's booth-side event API (server/events.ts). Every
// call carries the event's setup key, which the setup link hands to each
// device. Managing events is the owner's /admin (src/admin.ts), not this.

import type { PortableConfig } from './config.ts';
import { apiBase } from './platform.ts';
import type { Stats } from './stats.ts';
import type { TemplateImages } from './templates.ts';

// A whole booth setup: what profiles, export files and server events hold.
export interface Setup {
  version?: number;
  name: string;
  config: Partial<PortableConfig>;
  images: TemplateImages;
}

async function call<T>(
  method: string,
  path: string,
  { body, headers = {} }: { body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  return data as T;
}

export const remote = {
  // Booth side: fetch a setup with its key; push this device's stats.
  loadEvent: (id: string, key: string) =>
    call<Setup & { id: string }>('GET', `/api/events/${id}`, { headers: { 'X-Event-Key': key } }),
  saveEvent: (id: string, key: string, setup: Setup) =>
    call<{ ok: true }>('PUT', `/api/events/${id}`, { body: setup, headers: { 'X-Event-Key': key } }),
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
