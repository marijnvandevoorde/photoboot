import { describe, expect, it } from 'vitest';
import { crc32, zip } from '../server/zip.ts';

const text = (s: string) => new TextEncoder().encode(s);

// Reads the central directory back: enough to check what zip() wrote.
function readZip(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  expect(view.getUint32(end, true)).toBe(0x06054b50);
  const count = view.getUint16(end + 10, true);
  let p = view.getUint32(end + 16, true);
  const files: { name: string; data: string; crc: number }[] = [];
  for (let i = 0; i < count; i++) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const crc = view.getUint32(p + 16, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const offset = view.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const localNameLen = view.getUint16(offset + 26, true);
    const start = offset + 30 + localNameLen;
    files.push({ name, crc, data: new TextDecoder().decode(bytes.subarray(start, start + size)) });
    p += 46 + nameLen;
  }
  return files;
}

describe('crc32', () => {
  it('matches the standard check value', () => {
    expect(crc32(text('123456789'))).toBe(0xcbf43926);
  });
  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('zip', () => {
  it('stores every file with its name, data and crc', () => {
    const files = readZip(
      zip([
        { name: 'a.txt', data: text('hello') },
        { name: 'dir/ü.jpg', data: text('world!'), date: new Date(2026, 9, 5, 12, 30) },
      ])
    );
    expect(files).toEqual([
      { name: 'a.txt', data: 'hello', crc: crc32(text('hello')) },
      { name: 'dir/ü.jpg', data: 'world!', crc: crc32(text('world!')) },
    ]);
  });

  it('writes a valid empty archive', () => {
    const bytes = zip([]);
    expect(bytes.length).toBe(22);
    expect(readZip(bytes)).toEqual([]);
  });
});
