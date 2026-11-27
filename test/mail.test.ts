import { afterEach, describe, expect, it } from 'vitest';
import { outbox, sendMail } from '../server/mail.ts';

const realFetch = globalThis.fetch;
const mail = { to: { email: 'host@example.com' }, subject: 'Hi', html: '<p>Hi</p>', text: 'Hi' };

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.BREVO_API_KEY;
});

describe('sendMail', () => {
  it('logs the mail without a key', async () => {
    delete process.env.BREVO_API_KEY;
    const before = outbox.length;
    await sendMail(mail);
    expect(outbox.length).toBe(before + 1);
  });

  it('asks Brevo not to track the recipient', async () => {
    process.env.BREVO_API_KEY = 'test-key';
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      sent = { url: String(input), body: JSON.parse(String(init?.body)) };
      return new Response('{"messageId":"x"}', { status: 201 });
    }) as typeof fetch;
    await sendMail(mail);
    expect(sent?.url).toBe('https://api.brevo.com/v3/smtp/email');
    expect(sent?.body.to).toEqual([
      { email: 'host@example.com', contactPixelTrackingConsent: false, removeTrackingPixel: true },
    ]);
  });

  it('throws when Brevo refuses the mail', async () => {
    process.env.BREVO_API_KEY = 'test-key';
    globalThis.fetch = (async () => new Response('bad', { status: 400 })) as typeof fetch;
    await expect(sendMail(mail)).rejects.toThrow('Brevo 400');
  });
});
