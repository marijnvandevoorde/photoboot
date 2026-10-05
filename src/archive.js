// Local copies of every session (colour JPEG, strips stacked) in IndexedDB,
// grouped per event, so the host can download them all the next morning
// even if nobody pressed Share. Keys: `photo:<event>:<ISO timestamp>`.

import { zip } from '../server/zip.js';
import { eventKey } from './config.js';
import { kv } from './storage.js';

const prefix = (event) => `photo:${event}:`;

export async function savePhoto(blob, event = eventKey()) {
  await kv.set(prefix(event) + new Date().toISOString(), blob);
}

export async function listPhotoKeys(event = eventKey()) {
  const keys = await kv.keys();
  return keys.filter((k) => typeof k === 'string' && k.startsWith(prefix(event))).sort();
}

// Events that have photos on this device, with counts.
export async function photoEvents() {
  const counts = {};
  for (const key of await kv.keys()) {
    if (typeof key !== 'string' || !key.startsWith('photo:')) continue;
    const event = key.slice(6, key.indexOf(':', 6)); // event keys never contain ':'
    counts[event] = (counts[event] ?? 0) + 1;
  }
  return counts;
}

export async function recentPhotos(limit = 12, event = eventKey()) {
  const keys = (await listPhotoKeys(event)).slice(-limit);
  const blobs = await Promise.all(keys.map((k) => kv.get(k)));
  return blobs.filter(Boolean);
}

export async function exportZip(event = eventKey()) {
  const files = [];
  for (const key of await listPhotoKeys(event)) {
    const blob = await kv.get(key);
    if (!blob) continue;
    const stamp = key.slice(prefix(event).length);
    files.push({
      name: `${event}-${stamp.replace(/[:.]/g, '-')}.jpg`,
      data: new Uint8Array(await blob.arrayBuffer()),
      date: new Date(stamp),
    });
  }
  return { count: files.length, blob: new Blob([zip(files)], { type: 'application/zip' }) };
}

export async function deletePhotos(event = eventKey()) {
  for (const key of await listPhotoKeys(event)) await kv.delete(key);
}
