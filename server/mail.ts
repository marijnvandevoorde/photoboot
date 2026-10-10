// Transactional email through Brevo's HTTP API (no SDK). Without a key the
// mail is logged instead, so development and tests need no account.
//
// Config (env):
//   BREVO_API_KEY  Brevo API key (Settings → SMTP & API → API keys)
//   MAIL_FROM      sender address, e.g. booth@small-victories.co (must be a
//                  verified sender in Brevo)
//   MAIL_FROM_NAME sender name (default "Photoboot")

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

export interface Mail {
  to: { email: string; name?: string };
  subject: string;
  html: string;
  text: string;
}

// Last mails sent without a key, for tests and local runs.
export const outbox: Mail[] = [];

export async function sendMail(mail: Mail): Promise<void> {
  const key = process.env.BREVO_API_KEY;
  if (!key) {
    outbox.push(mail);
    if (outbox.length > 50) outbox.shift();
    console.log(`photoboot: (no BREVO_API_KEY) mail to ${mail.to.email}: ${mail.subject}`);
    return;
  }
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': key, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: {
        email: process.env.MAIL_FROM || 'booth@small-victories.co',
        name: process.env.MAIL_FROM_NAME || 'Photoboot',
      },
      to: [mail.to],
      subject: mail.subject,
      htmlContent: mail.html,
      textContent: mail.text,
    }),
  });
  if (!res.ok) throw new Error(`Brevo ${res.status}: ${await res.text().catch(() => '')}`);
}
