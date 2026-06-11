import session from 'express-session';
import { RedisStore } from 'connect-redis';
import Redis from 'ioredis';
import { config } from './config.js';
const redisClient = new Redis(config.REDIS_URL);
export const sessionMiddleware = session({
    store: new RedisStore({ client: redisClient }),
    name: 'sid',
    secret: config.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        secure: config.NODE_ENV === 'production',
        sameSite: 'lax',
        maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    },
});
//# sourceMappingURL=session.js.map