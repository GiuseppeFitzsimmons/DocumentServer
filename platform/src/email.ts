import nodemailer from 'nodemailer';
import { createTransport } from 'nodemailer';
import { config } from './config.js';

const DKIM_SELECTOR = 'euro';

// Direct sending — resolves recipient MX records and delivers directly.
// No external SMTP relay needed.
const transporter = createTransport({
  direct: true,
  name: config.MAIL_DOMAIN, // EHLO hostname
  dkim: {
    domainName: config.MAIL_DOMAIN,
    keySelector: DKIM_SELECTOR,
    privateKey: config.DKIM_PRIVATE_KEY,
  },
} as any);

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  if (!config.DKIM_PRIVATE_KEY) {
    console.warn('[email] DKIM_PRIVATE_KEY not set — skipping email send');
    return;
  }

  await transporter.sendMail({
    from: `"Euro Bureau" <noreply@${config.MAIL_DOMAIN}>`,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
  });
}
