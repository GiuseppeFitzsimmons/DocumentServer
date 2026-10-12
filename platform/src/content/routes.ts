import { Router } from 'express';
import {
  fetchContent,
  fetchBinaryContent,
  invalidateContentCache,
  ContentNotFoundError,
} from './fetcher.js';
import { renderMarkdown } from './markdown.js';
import { requireAuth } from '../auth/middleware.js';

export const contentRouter = Router();

// Map public page paths to their content file in the static-content repo.
const PAGES: Record<string, { file: string; title: string }> = {
  terms: { file: 'terms.md', title: 'Terms & Conditions' },
  faq: { file: 'faq.md', title: 'FAQ' },
};

// Map public document paths to a binary file in the static-content repo. The
// slug is the public URL (stable), the file is the repo filename (can change).
// Served inline so the browser's PDF viewer opens it; the download filename is
// what the user sees if they save it.
const DOCUMENTS: Record<string, { file: string; downloadName: string }> = {
  'publishing-guide': {
    file: 'Self-Publishing with EuroBureau.pdf',
    downloadName: 'Self-Publishing with EuroBureau.pdf',
  },
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

// Binary documents (public), e.g. the publishing guide PDF. Fetched from the
// static-content repo at request time, so pushing a new PDF goes live without a
// redeploy — same model as the Terms/FAQ pages. Served inline with a short
// cache; the editor updates it by committing a new file to the repo.
for (const [slug, { file, downloadName }] of Object.entries(DOCUMENTS)) {
  contentRouter.get(`/${slug}`, async (_req, res) => {
    try {
      const { body, contentType } = await fetchBinaryContent(file);
      res.setHeader('Content-Type', contentType);
      // Both a quoted ASCII-ish fallback and an RFC 5987 encoded form so the
      // spaces in the name are handled consistently across browsers.
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${downloadName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`
      );
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.send(body);
    } catch (err) {
      if (err instanceof ContentNotFoundError) {
        res.status(404).send('This document is not available yet.');
        return;
      }
      console.error(`[content] Failed to serve ${slug}:`, err);
      res.status(502).send("We couldn't load this document right now. Please try again shortly.");
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
