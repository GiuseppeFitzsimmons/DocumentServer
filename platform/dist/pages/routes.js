import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../db/pool.js';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { generateTempPassword } from '../auth/temp-password.js';
import { sendEmail } from '../email.js';
import { isDisposableEmail } from '../auth/disposable-email.js';
export const pageRouter = Router();
const registerSchema = z.object({
    email: z.string().email(),
    displayName: z.string().min(1).max(100),
});
const loginSchema = z.object({
    email: z.string().email(),
    password: z.string(),
});
const setPasswordSchema = z.object({
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
}).refine(data => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
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
        const result = await pool.query('SELECT id, email, display_name, password_hash, is_temp_password FROM users WHERE email = $1', [email]);
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
        if (user.is_temp_password) {
            req.session.isTempPassword = true;
            res.redirect('/set-password');
        }
        else {
            res.redirect('/');
        }
    }
    catch (err) {
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
    const { email, displayName } = parsed.data;
    if (isDisposableEmail(email)) {
        console.info(`Registration rejected: disposable email domain "${email.substring(email.lastIndexOf('@') + 1).toLowerCase()}"`);
        res.render('register', { title: 'Create account', error: 'Email domain not accepted.' });
        return;
    }
    try {
        const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (existing.rows.length > 0) {
            res.render('register', { title: 'Create account', error: 'Email already registered.' });
            return;
        }
        const tempPassword = generateTempPassword();
        const passwordHash = await hashPassword(tempPassword);
        await pool.query('INSERT INTO users (email, password_hash, display_name, is_temp_password) VALUES ($1, $2, $3, $4)', [email, passwordHash, displayName, true]);
        let emailWarning = null;
        try {
            await sendEmail({
                to: email,
                subject: 'Welcome to Euro Bureau - Your Temporary Password',
                text: [
                    `Welcome to Euro Bureau!`,
                    ``,
                    `Your temporary password is: ${tempPassword}`,
                    ``,
                    `Please log in at eurobureau.eu/login using this password.`,
                    `You will be asked to set a permanent password on your first login.`,
                ].join('\n'),
                html: [
                    `<p>Welcome to Euro Bureau!</p>`,
                    `<p>Your temporary password is: <strong>${tempPassword}</strong></p>`,
                    `<p>Please log in at <a href="https://eurobureau.eu/login">eurobureau.eu/login</a> using this password.</p>`,
                    `<p>You will be asked to set a permanent password on your first login.</p>`,
                ].join('\n'),
            });
        }
        catch (emailErr) {
            console.error('Email send error:', emailErr);
            emailWarning = 'Your account was created, but we could not send the email. Please contact support.';
        }
        res.render('register-success', { title: 'Account created', warning: emailWarning });
    }
    catch (err) {
        console.error('Register error:', err);
        res.render('register', { title: 'Create account', error: 'Something went wrong.' });
    }
});
pageRouter.get('/set-password', (req, res) => {
    if (!req.session.userId) {
        res.redirect('/login');
        return;
    }
    if (!req.session.isTempPassword) {
        res.redirect('/');
        return;
    }
    res.render('set-password', { title: 'Set your password', error: null });
});
pageRouter.post('/set-password', async (req, res) => {
    if (!req.session.userId) {
        res.redirect('/login');
        return;
    }
    if (!req.session.isTempPassword) {
        res.redirect('/');
        return;
    }
    const parsed = setPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        const msg = parsed.error.issues.map(i => i.message).join(', ');
        res.render('set-password', { title: 'Set your password', error: msg });
        return;
    }
    const { password } = parsed.data;
    try {
        const passwordHash = await hashPassword(password);
        await pool.query('UPDATE users SET password_hash = $1, is_temp_password = false WHERE id = $2', [passwordHash, req.session.userId]);
        delete req.session.isTempPassword;
        res.redirect('/');
    }
    catch (err) {
        console.error('Set password error:', err);
        res.render('set-password', { title: 'Set your password', error: 'Something went wrong.' });
    }
});
pageRouter.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('sid');
        res.redirect('/login');
    });
});
// --- Forgot / Reset Password ---
pageRouter.get('/forgot-password', (req, res) => {
    if (req.session.userId) {
        res.redirect('/');
        return;
    }
    res.render('forgot-password', { title: 'Reset your password', error: null, success: null });
});
pageRouter.post('/forgot-password', async (req, res) => {
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email || !z.string().email().safeParse(email).success) {
        res.render('forgot-password', { title: 'Reset your password', error: 'Please enter a valid email address.', success: null });
        return;
    }
    // Always show success to prevent email enumeration
    const successMessage = 'If an account with that email exists, a reset link has been sent. Check your inbox.';
    try {
        const userResult = await pool.query('SELECT id, display_name FROM users WHERE email = $1', [email]);
        if (userResult.rows.length === 0) {
            res.render('forgot-password', { title: 'Reset your password', error: null, success: successMessage });
            return;
        }
        const user = userResult.rows[0];
        // Invalidate any existing unused tokens for this user
        await pool.query('UPDATE password_reset_tokens SET used = true WHERE user_id = $1 AND used = false', [user.id]);
        // Generate a secure token
        const { randomBytes } = await import('crypto');
        const token = randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await pool.query('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)', [user.id, token, expiresAt]);
        const resetUrl = `https://eurobureau.eu/reset-password/${token}`;
        await sendEmail({
            to: email,
            subject: 'Euro Bureau - Password Reset',
            text: [
                `Hi ${user.display_name},`,
                ``,
                `You requested a password reset. Click the link below to set a new password:`,
                ``,
                resetUrl,
                ``,
                `This link expires in 1 hour.`,
                ``,
                `If you didn't request this, you can safely ignore this email.`,
            ].join('\n'),
            html: [
                `<p>Hi ${user.display_name},</p>`,
                `<p>You requested a password reset. Click the link below to set a new password:</p>`,
                `<p><a href="${resetUrl}">${resetUrl}</a></p>`,
                `<p>This link expires in 1 hour.</p>`,
                `<p>If you didn't request this, you can safely ignore this email.</p>`,
            ].join('\n'),
        });
    }
    catch (err) {
        console.error('Forgot password error:', err);
    }
    res.render('forgot-password', { title: 'Reset your password', error: null, success: successMessage });
});
const resetPasswordSchema = z.object({
    password: z.string().min(8, 'Password must be at least 8 characters'),
    confirmPassword: z.string(),
}).refine(data => data.password === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
});
pageRouter.get('/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    const result = await pool.query('SELECT id, expires_at, used FROM password_reset_tokens WHERE token = $1', [token]);
    if (result.rows.length === 0 || result.rows[0].used || new Date(result.rows[0].expires_at) < new Date()) {
        res.render('forgot-password', { title: 'Reset your password', error: 'This reset link is invalid or has expired.', success: null });
        return;
    }
    res.render('reset-password', { title: 'Set a new password', error: null, token });
});
pageRouter.post('/reset-password/:token', async (req, res) => {
    const { token } = req.params;
    const tokenResult = await pool.query('SELECT id, user_id, expires_at, used FROM password_reset_tokens WHERE token = $1', [token]);
    if (tokenResult.rows.length === 0 || tokenResult.rows[0].used || new Date(tokenResult.rows[0].expires_at) < new Date()) {
        res.render('forgot-password', { title: 'Reset your password', error: 'This reset link is invalid or has expired.', success: null });
        return;
    }
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        const msg = parsed.error.issues.map(i => i.message).join(', ');
        res.render('reset-password', { title: 'Set a new password', error: msg, token });
        return;
    }
    const { password } = parsed.data;
    const userId = tokenResult.rows[0].user_id;
    try {
        const passwordHash = await hashPassword(password);
        await pool.query('UPDATE users SET password_hash = $1, is_temp_password = false WHERE id = $2', [passwordHash, userId]);
        await pool.query('UPDATE password_reset_tokens SET used = true WHERE id = $1', [tokenResult.rows[0].id]);
        res.render('forgot-password', { title: 'Password reset', error: null, success: 'Your password has been reset. You can now sign in.' });
    }
    catch (err) {
        console.error('Reset password error:', err);
        res.render('reset-password', { title: 'Set a new password', error: 'Something went wrong.', token });
    }
});
//# sourceMappingURL=routes.js.map