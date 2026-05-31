import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config.js';
import { sessionMiddleware } from './session.js';
import { authRouter } from './auth/routes.js';

const app = express();

app.use(helmet());
app.use(express.json());
app.use(sessionMiddleware);

// Rate limit auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  message: { error: 'Too many requests, try again later' },
});

app.use('/auth', authLimiter, authRouter);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.listen(config.PORT, () => {
  console.log(`Portal running on port ${config.PORT}`);
});
