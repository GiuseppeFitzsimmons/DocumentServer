import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/password.js';

export const pageRouter = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(100),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

pageRouter.get('/login', (req, res) => {
  if (req.session.userId) {
    res.redirect('/');
    return;
  }
  res.render('login', { title: 'Sign in', error: null });
});

pageRouter.post('/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.render('login', { title: 'Sign in', error: 'Invalid email or password.' });
    return;
  }

  const { email, password } = parsed.data;

  try {
    const result = await pool.query(
      'SELECT id, email, display_name, password_hash FROM users WHERE email = $1',
      [email]
    );

    if (result.rows.length === 0) {
      res.render('login', { title: 'Sign in', error: 'Invalid email or password.' });
      return;
    }

    const user = result.rows[0];
    const valid = await verifyPassword(user.password_hash, password);

    if (!valid) {
      res.render('login', { title: 'Sign in', error: 'Invalid email or password.' });
      return;
    }

    req.session.userId = user.id;
    res.redirect('/');
  } catch (err) {
    console.error('Login error:', err);
    res.render('login', { title: 'Sign in', error: 'Something went wrong.' });
  }
});

pageRouter.get('/register', (req, res) => {
  if (req.session.userId) {
    res.redirect('/');
    return;
  }
  res.render('register', { title: 'Create account', error: null });
});

pageRouter.post('/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map(i => i.message).join(', ');
    res.render('register', { title: 'Create account', error: msg });
    return;
  }

  const { email, password, displayName } = parsed.data;

  try {
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      res.render('register', { title: 'Create account', error: 'Email already registered.' });
      return;
    }

    const passwordHash = await hashPassword(password);
    const result = await pool.query(
      'INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id',
      [email, passwordHash, displayName]
    );

    req.session.userId = result.rows[0].id;
    res.redirect('/');
  } catch (err) {
    console.error('Register error:', err);
    res.render('register', { title: 'Create account', error: 'Something went wrong.' });
  }
});

pageRouter.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('sid');
    res.redirect('/login');
  });
});
