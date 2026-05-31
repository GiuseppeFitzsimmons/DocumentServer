import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { sessionMiddleware } from './session.js';
import { authRouter } from './auth/routes.js';
import { pageRouter } from './pages/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(helmet());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Render with layout
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = (view: string, options: any = {}) => {
    originalRender(view, options, (err: Error | null, body: string) => {
      if (err) return next(err);
      originalRender('layout', { ...options, body });
    });
  };
  next();
});

// Rate limit auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many requests, try again later' },
});

// API auth routes
app.use('/auth', authLimiter, authRouter);

// Page routes (login, register, logout)
app.use(pageRouter);

// Health check (public)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Auth gate — everything below requires login
app.use((req, res, next) => {
  if (!req.session.userId) {
    res.redirect('/login');
    return;
  }
  next();
});

// Authenticated root — redirect to example for now
app.get('/', (_req, res) => {
  res.redirect('/example');
});

// Proxy /example to DocumentServer (authenticated)
import { createProxyMiddleware } from 'http-proxy-middleware';

app.use('/example', createProxyMiddleware({
  target: config.DS_URL,
  changeOrigin: true,
}));

app.listen(config.PORT, () => {
  console.log(`Portal running on port ${config.PORT}`);
});
