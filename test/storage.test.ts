import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { presign, s3ConfigFromEnv, s3Store } from '../server/storage.ts';

describe('S3 presigning', () => {
  // The worked example in AWS's "Authenticating Requests: Using Query
  // Parameters" (Signature Version 4) documentation.
  it('matches the AWS SigV4 query-string example', () => {
    const url = presign(
      {
        bucket: 'examplebucket',
        endpoint: 'https://s3.amazonaws.com',
        region: 'us-east-1',
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        pathStyle: false,
      },
      'GET',
      'test.txt',
      86400,
      {},
      new Date('2013-05-24T00:00:00Z')
    );
    expect(url).toBe(
      'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
        '&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request' +
        '&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host' +
        '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404'
    );
  });

  it('puts the bucket in the path when asked to', () => {
    const url = new URL(
      presign(
        {
          bucket: 'photos',
          endpoint: 'https://ns.compat.objectstorage.eu-amsterdam-1.oraclecloud.com',
          region: 'eu-amsterdam-1',
          accessKeyId: 'id',
          secretAccessKey: 'secret',
          pathStyle: true,
        },
        'GET',
        'shares/a b.jpg',
        60,
        { 'response-content-disposition': 'attachment; filename="photobooth.jpg"' }
      )
    );
    expect(url.host).toBe('ns.compat.objectstorage.eu-amsterdam-1.oraclecloud.com');
    expect(url.pathname).toBe('/photos/shares/a%20b.jpg');
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="photobooth.jpg"');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Against a real bucket (e.g. MinIO) when PHOTOBOOT_TEST_BACKENDS=1 and S3_* are set.
const live = process.env.PHOTOBOOT_TEST_BACKENDS === '1' ? s3ConfigFromEnv() : null;
describe.skipIf(!live)('S3 store against a bucket', () => {
  it('puts, reads, links and removes a photo', async () => {
    const store = s3Store(live as NonNullable<typeof live>);
    const id = randomUUID();
    const body = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]);
    await store.put(id, body);
    expect(await store.read(id)).toEqual(body);
    const res = await fetch(store.link(id) as string);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(body);
    await store.remove(id);
    expect(await store.read(id)).toBeNull();
  });
});
