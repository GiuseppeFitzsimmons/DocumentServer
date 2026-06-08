import { createTransport, type Transporter } from 'nodemailer';
import { config } from './config.js';

const DKIM_SELECTOR = 'euro';

function buildTransporter(): Transporter {
  // Prefer SMTP relay if configured
  if (config.SMTP_HOST) {
    return createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_PORT === 465,
      auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS,
      },
    });
  }

  // Fallback: direct sending (requires outbound port 25)
  return createTransport({
    direct: true,
    name: config.MAIL_DOMAIN,
    dkim: config.DKIM_PRIVATE_KEY
      ? {
          domainName: config.MAIL_DOMAIN,
          keySelector: DKIM_SELECTOR,
          privateKey: config.DKIM_PRIVATE_KEY,
        }
      : undefined,
  } as any);
}

const transporter = buildTransporter();

export async function sendEmail(params: {
  to: string;
  subject: string;
  html: string;
  text?: string;
}): Promise<void> {
  if (!config.SMTP_HOST && !config.DKIM_PRIVATE_KEY) {
    console.warn('[email] No SMTP_HOST or DKIM_PRIVATE_KEY set — skipping email send');
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
