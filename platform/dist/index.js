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
import { accountRouter, accountPageRouter } from './account/routes.js';
import { supportRouter } from './support/routes.js';
import { fontsRouter } from './fonts/routes.js';
import { serveRouter } from './ds/serve.js';
import { callbackRouter } from './ds/callback.js';
import { forceSaveRouter } from './ds/forcesave.js';
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
    res.render = (view, options = {}) => {
        if (options.layout === false) {
            originalRender(view, options);
            return;
        }
        originalRender(view, options, (err, body) => {
            if (err)
                return next(err);
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
app.use('/api/internal', forceSaveRouter);
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
// Account management
app.use('/api/account', accountRouter);
app.use(accountPageRouter);
// Support tickets
app.use('/api/support', supportRouter);
// Font manifest proxy (filtered per-user)
app.use('/api/fonts', fontsRouter);
// Editor page (authenticated)
app.use(editorRouter);
// PDF cleaning proxy — intercepts /cache/*.pdf requests routed here by nginx
app.all(/^\/cache\/.*\.pdf/, async (req, res) => {
    const { cleanPdf } = await import('./export/pdf-service.js');
    const { Readable } = await import('stream');
    const { createReadStream } = await import('fs');
    const { stat } = await import('fs/promises');
    const dsUrl = config.DS_INTERNAL_URL || 'http://documentserver';
    const targetUrl = `${dsUrl}${req.originalUrl}`;
    console.log(`[pdf-clean] Intercepted cache PDF request: ${req.originalUrl.slice(0, 100)}`);
    try {
        const dsResponse = await fetch(targetUrl);
        console.log(`[pdf-clean] DS response: ${dsResponse.status}`);
        if (!dsResponse.ok || !dsResponse.body) {
            res.status(dsResponse.status).send('PDF not found');
            return;
        }
        const nodeStream = Readable.fromWeb(dsResponse.body);
        const result = await cleanPdf(nodeStream);
        const stats = await stat(result.outputPath);
        console.log(`[pdf-clean] Ghostscript complete, sending ${stats.size} bytes`);
        // Preserve content-disposition from DS if present
        const disposition = dsResponse.headers.get('content-disposition');
        if (disposition)
            res.setHeader('Content-Disposition', disposition);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', stats.size);
        const outputStream = createReadStream(result.outputPath);
        outputStream.pipe(res);
        res.on('finish', () => result.cleanup());
        res.on('close', () => result.cleanup());
    }
    catch (err) {
        console.error('[pdf-clean] Error:', err);
        if (!res.headersSent) {
            res.status(502).send('PDF cleaning failed');
        }
    }
});
// Proxy /example to DocumentServer (authenticated)
app.use('/example', requireAuth, createProxyMiddleware({
    target: config.DS_URL,
    changeOrigin: true,
    on: {
        proxyReq: (proxyReq, req) => {
            proxyReq.path = req.originalUrl;
        },
        proxyRes: (proxyRes) => {
            const location = proxyRes.headers['location'];
            if (location && location.includes('documentserver')) {
                proxyRes.headers['location'] = location.replace(/https?:\/\/documentserver[^/]*/, '');
            }
        },
    },
}));
// Landing page (authenticated root)
app.use('/', landingRouter);
app.listen(config.PORT, () => {
    console.log(`Portal running on port ${config.PORT}`);
});
//# sourceMappingURL=index.js.map