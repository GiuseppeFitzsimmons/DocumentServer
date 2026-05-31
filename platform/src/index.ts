import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { config } from './config.js';
import { sessionMiddleware } from './session.js';
import { authRouter } from './auth/routes.js';
import { pageRouter } from './pages/routes.js';
import { requireAuth } from './auth/middleware.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

app.use(helmet({
  hsts: false,
  contentSecurityPolicy: false,
}));
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

// Page routes (login, register, logout — public)
app.use(pageRouter);

// Health check (public)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- Everything below requires login ---

// Proxy /example to DocumentServer (authenticated)
app.use('/example', requireAuth, createProxyMiddleware({
  target: config.DS_URL,
  changeOrigin: true,
  on: {
    proxyReq: (proxyReq, req) => {
      proxyReq.path = (req as any).originalUrl;
    },
    proxyRes: (proxyRes) => {
      const location = proxyRes.headers['location'];
      if (location && location.includes('documentserver')) {
        proxyRes.headers['location'] = location.replace(
          /https?:\/\/documentserver[^/]*/,
          ''
        );
      }
    },
  },
}));

// Authenticated root
app.get('/', requireAuth, (_req, res) => {
  res.redirect('/example');
});

app.listen(config.PORT, () => {
  console.log(`Portal running on port ${config.PORT}`);
});
