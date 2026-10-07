import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { verifyPassword } from './password.js';
import { requireAuth } from './middleware.js';
export const authRouter = Router();
const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
});
authRouter.post('/register', (_req, res) => {
    // Self-serve account creation is disabled during the invite-only beta. New
    // users come in via the /register beta-signup form + manual approval
    // (beta:approve). This JSON endpoint previously created accounts directly,
    // bypassing that gate — keep it closed until public signup opens.
    res.status(403).json({ error: 'Registration is invite-only during beta.' });
});
authRouter.post('/login', async (req, res) => {
    try {
        const parsed = loginSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid input' });
            return;
        }
        const { password } = parsed.data;
        const email = parsed.data.email.trim().toLowerCase();
        const result = await pool.query('SELECT id, email, display_name, password_hash FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }
        const user = result.rows[0];
        const valid = await verifyPassword(user.password_hash, password);
        if (!valid) {
            res.status(401).json({ error: 'Invalid credentials' });
            return;
        }
        req.session.userId = user.id;
        res.json({
            id: user.id,
            email: user.email,
            displayName: user.display_name,
        });
    }
    catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
authRouter.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            res.status(500).json({ error: 'Failed to logout' });
            return;
        }
        res.clearCookie('sid');
        res.json({ ok: true });
    });
});
authRouter.get('/me', requireAuth, async (req, res) => {
    const result = await pool.query('SELECT id, email, display_name, created_at FROM users WHERE id = $1', [req.session.userId]);
    if (result.rows.length === 0) {
        req.session.destroy(() => { });
        res.status(401).json({ error: 'User not found' });
        return;
    }
    const user = result.rows[0];
    res.json({
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        createdAt: user.created_at,
    });
});
//# sourceMappingURL=routes.js.map