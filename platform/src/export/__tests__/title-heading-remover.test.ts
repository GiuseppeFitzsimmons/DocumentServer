import { describe, it, expect } from 'vitest';
import { stripFirstUnnumberedTitle } from '../title-heading-remover.js';

describe('stripFirstUnnumberedTitle', () => {
  it('removes an unnumbered h1 title heading', () => {
    const input = '<body><h1 class="unnumbered">Untitled</h1><p>Hello</p></body>';
    expect(stripFirstUnnumberedTitle(input)).toBe('<body><p>Hello</p></body>');
  });

  it('matches the unnumbered token among multiple classes', () => {
    const input = '<section><h1 class="title unnumbered foo">Name</h1><p>x</p></section>';
    expect(stripFirstUnnumberedTitle(input)).toBe('<section><p>x</p></section>');
  });

  it('returns null when there is no unnumbered h1', () => {
    const input = '<body><h1 class="chapter">Chapter One</h1></body>';
    expect(stripFirstUnnumberedTitle(input)).toBeNull();
  });

  it('leaves numbered/plain headings intact', () => {
    const input = '<h1>Plain</h1><h2 class="unnumbered">Sub</h2>';
    // Only h1.unnumbered is targeted; this has none, so returns null.
    expect(stripFirstUnnumberedTitle(input)).toBeNull();
  });

  it('removes only the first unnumbered h1', () => {
    const input = '<h1 class="unnumbered">A</h1><h1 class="unnumbered">B</h1>';
    expect(stripFirstUnnumberedTitle(input)).toBe('<h1 class="unnumbered">B</h1>');
  });
});
