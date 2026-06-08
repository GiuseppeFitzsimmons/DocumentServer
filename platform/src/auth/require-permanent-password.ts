import type { Request, Response, NextFunction } from 'express';

const SKIP_PATHS = ['/set-password', '/logout'];
const STATIC_PREFIXES = ['/public', '/assets'];
const STATIC_EXTENSIONS = ['.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.map'];

export function requirePermanentPassword(req: Request, res: Response, next: NextFunction): void {
  // Skip static asset paths
  if (STATIC_PREFIXES.some(prefix => req.path.startsWith(prefix))) {
    next();
    return;
  }

  // Skip paths with static file extensions
  if (STATIC_EXTENSIONS.some(ext => req.path.endsWith(ext))) {
    next();
    return;
  }

  // Skip allowed paths
  if (req.path.startsWith('/set-password') || req.path === '/logout') {
    next();
    return;
  }

  // Skip unauthenticated requests
  if (!req.session.userId) {
    next();
    return;
  }

  // Redirect if user has a temporary password
  if (req.session.isTempPassword) {
    res.redirect('/set-password');
    return;
  }

  next();
}
