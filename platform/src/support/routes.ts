import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { requireAuth } from '../auth/middleware.js';
import { sendEmail } from '../email.js';
import { config } from '../config.js';

export const supportRouter = Router();

supportRouter.use(requireAuth);

const SUPPORT_EMAIL = `support@${config.MAIL_DOMAIN}`;

const ticketSchema = z.object({
  subject: z.string().min(1).max(200),
  message: z.string().min(1).max(5000),
});

// POST /api/support
supportRouter.post('/', async (req, res) => {
  const parsed = ticketSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Subject and message are required.' });
    return;
  }

  const userId = req.session.userId!;
  const { subject, message } = parsed.data;

  // Get user info
  const userResult = await pool.query(
    'SELECT email, display_name FROM users WHERE id = $1',
    [userId]
  );

  if (userResult.rows.length === 0) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const user = userResult.rows[0];

  try {
    await sendEmail({
      to: SUPPORT_EMAIL,
      subject: `[Support] ${subject}`,
      text: [
        `Support ticket from: ${user.display_name} <${user.email}>`,
        `User ID: ${userId}`,
        ``,
        `Subject: ${subject}`,
        ``,
        `Message:`,
        message,
      ].join('\n'),
      html: [
        `<p><strong>Support ticket from:</strong> ${user.display_name} &lt;${user.email}&gt;</p>`,
        `<p><strong>User ID:</strong> ${userId}</p>`,
        `<hr>`,
        `<p><strong>Subject:</strong> ${subject}</p>`,
        `<p><strong>Message:</strong></p>`,
        `<p>${message.replace(/\n/g, '<br>')}</p>`,
      ].join('\n'),
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Support ticket error:', err);
    res.status(500).json({ error: 'Failed to send support ticket. Please try again.' });
  }
});
