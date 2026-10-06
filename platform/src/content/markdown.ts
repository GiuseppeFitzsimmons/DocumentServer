// Minimal, dependency-free Markdown -> HTML renderer for static content pages.
//
// Supports the subset used by our content files: ATX headings (#..######),
// bold (**..**) and italic (_.._ / *..*), inline code (`..`), links
// ([text](url)), blockquotes (>), unordered lists (-/*), ordered lists (1.),
// horizontal rules (---) and paragraphs. All source text is HTML-escaped BEFORE
// any markup is applied, so content fetched from the repo cannot inject HTML or
// script. Links are restricted to http(s) and mailto to avoid javascript: URLs.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(url: string): string | null {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || /^mailto:/i.test(trimmed)) {
    return trimmed;
  }
  return null;
}

// Inline formatting applied to already-escaped text.
function renderInline(escaped: string): string {
  let out = escaped;
  // Links: [text](url) — the url here is still escaped; validate the raw-ish form.
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, href: string) => {
    // href was escaped (& -> &amp; etc.); undo the entity for scheme checks.
    const rawHref = href.replace(/&amp;/g, '&');
    const safe = safeHref(rawHref);
    if (!safe) return text;
    return `<a href="${escapeHtml(safe)}" rel="noopener noreferrer">${text}</a>`;
  });
  // Inline code
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic (underscore or single asterisk)
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  out = out.replace(/_([^_]+)_/g, '<em>$1</em>');
  return out;
}

/** Render a Markdown string to a sanitised HTML fragment. */
export function renderMarkdown(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const html: string[] = [];

  let paragraph: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  let quote: string[] = [];

  function flushParagraph() {
    if (paragraph.length) {
      html.push(`<p>${renderInline(escapeHtml(paragraph.join(' ')))}</p>`);
      paragraph = [];
    }
  }
  function flushList() {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  }
  function flushQuote() {
    if (quote.length) {
      html.push(`<blockquote>${renderInline(escapeHtml(quote.join(' ')))}</blockquote>`);
      quote = [];
    }
  }
  function flushAll() {
    flushParagraph();
    flushList();
    flushQuote();
  }

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      flushAll();
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(trimmed)) {
      flushAll();
      html.push('<hr>');
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      html.push(`<h${level}>${renderInline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }

    // Blockquote
    const bq = /^>\s?(.*)$/.exec(trimmed);
    if (bq) {
      flushParagraph();
      flushList();
      quote.push(bq[1]);
      continue;
    } else {
      flushQuote();
    }

    // Ordered list
    const ol = /^\d+\.\s+(.*)$/.exec(trimmed);
    if (ol) {
      flushParagraph();
      if (listType !== 'ol') {
        flushList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${renderInline(escapeHtml(ol[1]))}</li>`);
      continue;
    }

    // Unordered list
    const ul = /^[-*]\s+(.*)$/.exec(trimmed);
    if (ul) {
      flushParagraph();
      if (listType !== 'ul') {
        flushList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${renderInline(escapeHtml(ul[1]))}</li>`);
      continue;
    }

    // Plain paragraph line
    flushList();
    paragraph.push(trimmed);
  }

  flushAll();
  return html.join('\n');
}
