import { Resend } from 'resend';
import { createTransport, type Transporter } from 'nodemailer';
import { config } from './config.js';

const DKIM_SELECTOR = 'euro';

interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
}

interface EmailParams {
  to: string;
  subject: string;
  html: string;
  text?: string;
  attachments?: EmailAttachment[];
}

// --- Resend (primary) ---

function getResendClient(): Resend | null {
  if (!config.RESEND_API_KEY) return null;
  return new Resend(config.RESEND_API_KEY);
}

const resend = getResendClient();

// --- Nodemailer (legacy fallback) ---

function buildTransporter(): Transporter | null {
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

  if (config.DKIM_PRIVATE_KEY) {
    return createTransport({
      direct: true,
      name: config.MAIL_DOMAIN,
      dkim: {
        domainName: config.MAIL_DOMAIN,
        keySelector: DKIM_SELECTOR,
        privateKey: config.DKIM_PRIVATE_KEY,
      },
    } as any);
  }

  return null;
}

const transporter = buildTransporter();

// --- Public API ---

export async function sendEmail(params: EmailParams): Promise<void> {
  if (resend) {
    const { error } = await resend.emails.send({
      from: `Euro Bureau <noreply@${config.MAIL_DOMAIN}>`,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
      ...(params.attachments?.length ? {
        attachments: params.attachments.map(a => ({
          filename: a.filename,
          content: a.content,
          content_type: a.contentType,
        })),
      } : {}),
    });

    if (error) {
      throw new Error(`Resend error: ${error.message}`);
    }
    return;
  }

  // Fallback to SMTP/direct
  if (!transporter) {
    console.warn('[email] No RESEND_API_KEY, SMTP_HOST, or DKIM_PRIVATE_KEY set — skipping email send');
    return;
  }

  await transporter.sendMail({
    from: `"Euro Bureau" <noreply@${config.MAIL_DOMAIN}>`,
    to: params.to,
    subject: params.subject,
    html: params.html,
    text: params.text,
    ...(params.attachments?.length ? {
      attachments: params.attachments.map(a => ({
        filename: a.filename,
        content: a.content,
        contentType: a.contentType,
      })),
    } : {}),
  });
}
