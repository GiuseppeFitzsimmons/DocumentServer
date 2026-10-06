import { Router } from 'express';
import { fetchContent, invalidateContentCache, ContentNotFoundError } from './fetcher.js';
import { renderMarkdown } from './markdown.js';
import { requireAuth } from '../auth/middleware.js';

export const contentRouter = Router();

// Map public page paths to their content file in the static-content repo.
const PAGES: Record<string, { file: string; title: string }> = {
  terms: { file: 'terms.md', title: 'Terms & Conditions' },
  faq: { file: 'faq.md', title: 'FAQ' },
};

// Rendered HTML pages (public). Content is fetched from the static-content repo
// at request time, so repo edits go live without a redeploy.
for (const [slug, { file, title }] of Object.entries(PAGES)) {
  contentRouter.get(`/${slug}`, async (_req, res) => {
    try {
      const md = await fetchContent(file);
      const bodyHtml = renderMarkdown(md);
      res.render('content', { title, bodyHtml, layout: false });
    } catch (err) {
      if (err instanceof ContentNotFoundError) {
        res.status(404).render('content', {
          title,
          bodyHtml: `<p>This content is not available yet.</p>`,
          layout: false,
        });
        return;
      }
      console.error(`[content] Failed to render ${slug}:`, err);
      res.status(502).render('content', {
        title,
        bodyHtml: `<p>We couldn't load this page right now. Please try again shortly.</p>`,
        layout: false,
      });
    }
  });
}

// Rendered HTML fragment for a content file (public). Used by the in-page
// support/FAQ widget so it can show content without a client-side markdown
// parser. GET /content/html/:file  (e.g. /content/html/faq.md)
contentRouter.get('/content/html/:file', async (req, res) => {
  try {
    const md = await fetchContent(req.params.file);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(renderMarkdown(md));
  } catch (err) {
    if (err instanceof ContentNotFoundError) {
      res.status(404).send('<p>Not available yet.</p>');
      return;
    }
    console.error('[content] html fetch error:', err);
    res.status(502).send('<p>Content fetch error.</p>');
  }
});

// Raw markdown passthrough for programmatic use (public).
// GET /content/raw/:file  (e.g. /content/raw/terms.md)
contentRouter.get('/content/raw/:file', async (req, res) => {
  try {
    const md = await fetchContent(req.params.file);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(md);
  } catch (err) {
    if (err instanceof ContentNotFoundError) {
      res.status(404).send('Not found');
      return;
    }
    console.error('[content] raw fetch error:', err);
    res.status(502).send('Content fetch error');
  }
});

// Invalidate the content cache so the next request re-fetches immediately
// (authenticated — lets an admin push a repo edit live without waiting for TTL).
contentRouter.post('/content/invalidate-cache', requireAuth, (_req, res) => {
  invalidateContentCache();
  res.json({ success: true });
});
