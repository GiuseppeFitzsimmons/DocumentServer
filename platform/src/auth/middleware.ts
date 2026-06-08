import type { Request, Response, NextFunction } from 'express';

declare module 'express-session' {
  interface SessionData {
    userId: string;
    isTempPassword?: boolean;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    // If it's an API request, return JSON
    if (req.path.startsWith('/auth/') || req.headers.accept?.includes('application/json')) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    // Otherwise redirect to login
    res.redirect('/login');
    return;
  }
  next();
}
