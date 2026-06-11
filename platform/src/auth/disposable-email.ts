import fs from 'fs';
import type { Request, Response, NextFunction } from 'express';

const DOMAINS_FILE_PATH = '/app/data/disposable-domains.txt';

let disposableDomains: Set<string> = new Set();

function loadDomains(): void {
  try {
    const content = fs.readFileSync(DOMAINS_FILE_PATH, 'utf-8');
    const domains = content
      .split('\n')
      .map((line) => line.trim().toLowerCase())
      .filter((line) => line.length > 0);
    disposableDomains = new Set(domains);
    console.log(`Loaded ${disposableDomains.size} disposable email domains`);
  } catch (err: any) {
    if (err.code === 'ENOENT') {
      console.warn(`Disposable domains file not found at ${DOMAINS_FILE_PATH}, starting with empty set`);
      disposableDomains = new Set();
    } else {
      console.error(`Error reading disposable domains file: ${err.message}`);
    }
  }
}

// Load domains at module init
loadDomains();

// Watch for file changes to reload the domain set
fs.watchFile(DOMAINS_FILE_PATH, { persistent: false }, () => {
  console.log('Disposable domains file changed, reloading...');
  loadDomains();
});

export function rejectDisposableEmail(req: Request, res: Response, next: NextFunction): void {
  const email: string | undefined = req.body?.email;

  if (!email || typeof email !== 'string') {
    next();
    return;
  }

  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) {
    next();
    return;
  }

  const domain = email.substring(atIndex + 1).toLowerCase();

  if (disposableDomains.has(domain)) {
    console.info(`Registration rejected: disposable email domain "${domain}"`);
    res.status(400).json({ error: 'Email domain not accepted' });
    return;
  }

  next();
}

export function isDisposableEmail(email: string): boolean {
  const atIndex = email.lastIndexOf('@');
  if (atIndex === -1) return false;
  const domain = email.substring(atIndex + 1).toLowerCase();
  return disposableDomains.has(domain);
}
