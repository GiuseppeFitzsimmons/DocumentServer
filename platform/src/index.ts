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
import { requirePermanentPassword } from './auth/require-permanent-password.js';
import { fileRouter, folderRouter } from './storage/routes.js';
import { sharingRouter } from './sharing/routes.js';
import { usersRouter } from './users/routes.js';
import { serveRouter } from './ds/serve.js';
import { callbackRouter } from './ds/callback.js';
import { versionRouter } from './versions/routes.js';
import { exportRouter, internalExportRouter } from './export/routes.js';
import { editorRouter } from './pages/editor.js';
import { landingRouter } from './pages/landing.js';
import { homeRouter } from './pages/home.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// Trust proxy (behind Caddy/reverse proxy)
if (config.TRUST_PROXY === 'true') {
  app.set('trust proxy', 1);
}

app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static assets (fonts, images)
const fontsPath = process.env.NODE_ENV === 'production'
  ? '/data/fonts'
  : path.join(__dirname, '..', '..', 'fonts');
app.use('/fonts', express.static(fontsPath));
app.use('/static-fonts', express.static(fontsPath));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Render with layout
app.use((req, res, next) => {
  const originalRender = res.render.bind(res);
  res.render = (view: string, options: any = {}) => {
    if (options.layout === false) {
      originalRender(view, options);
      return;
    }
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

// Public homepage (unauthenticated visitors)
app.use(homeRouter);

// API auth routes
app.use('/auth', authLimiter, authRouter);

// Page routes (login, register, logout — public)
app.use(pageRouter);

// Force temp-password users to /set-password before accessing protected routes
app.use(requirePermanentPassword);

// Health check (public)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// --- Everything below requires login ---

// DocumentServer integration (no session auth — JWT-based, must be before fileRouter)
app.use('/api/files/serve', serveRouter);
app.use('/api/ds/callback', callbackRouter);

// File storage API
app.use('/api/files', versionRouter);
app.use('/api/files', exportRouter);
app.use('/internal/export', internalExportRouter);
app.use('/api/files', fileRouter);
app.use('/api/folders', folderRouter);

// Sharing API
app.use('/api/shares', sharingRouter);

// Users API
app.use('/api/users', usersRouter);

// Editor page (authenticated)
app.use(editorRouter);

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

// Landing page (authenticated root)
app.use('/', landingRouter);

app.listen(config.PORT, () => {
  console.log(`Portal running on port ${config.PORT}`);
});
