import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { hashPassword, verifyPassword } from './password.js';
import { requireAuth } from './middleware.js';
export const authRouter = Router();
const registerSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    displayName: z.string().min(1).max(100),
});
const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
});
authRouter.post('/register', async (req, res) => {
    try {
        const parsed = registerSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid input', details: parsed.error.flatten() });
            return;
        }
        const { email, password, displayName } = parsed.data;
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            res.status(409).json({ error: 'Email already registered' });
            return;
        }
        const passwordHash = await hashPassword(password);
        const result = await pool.query('INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id, email, display_name', [email, passwordHash, displayName]);
        const user = result.rows[0];
        req.session.userId = user.id;
        res.status(201).json({
            id: user.id,
            email: user.email,
            displayName: user.display_name,
        });
    }
    catch (err) {
        console.error('Register error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});
authRouter.post('/login', async (req, res) => {
    try {
        const parsed = loginSchema.safeParse(req.body);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid input' });
            return;
        }
        const { email, password } = parsed.data;
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