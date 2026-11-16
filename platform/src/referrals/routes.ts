import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { createInvite, listInvites, ReferralError } from './service.js';

export const referralRouter = Router();

referralRouter.use(requireAuth);

// POST /api/referrals/invite { email } — send a friend an email-scoped invite.
referralRouter.post('/invite', async (req, res) => {
  const parsed = z.object({ email: z.string().email() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Please enter a valid email address.' });
    return;
  }
  try {
    await createInvite(req.session.userId!, parsed.data.email);
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof ReferralError) {
      res.status(400).json({ error: err.message });
      return;
    }
    console.error('[referrals] invite error:', err);
    res.status(500).json({ error: 'Could not send the invite. Please try again.' });
  }
});

// GET /api/referrals — the caller's sent invites (for the account page).
referralRouter.get('/', async (req, res) => {
  try {
    const invites = await listInvites(req.session.userId!);
    res.json({ invites });
  } catch (err) {
    console.error('[referrals] list error:', err);
    res.status(500).json({ error: 'Could not load invites.' });
  }
});
