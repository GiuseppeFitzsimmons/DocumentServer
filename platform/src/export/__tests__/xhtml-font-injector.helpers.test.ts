import { describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { buildTestEpub, makeXhtml, makeAssignment, makeAssignmentResult } from './xhtml-font-injector.helpers.js';

describe('xhtml-font-injector test helpers', () => {
  it('buildTestEpub creates a valid zip with named entries', () => {
    const content = makeXhtml('<p>Hello</p>');
    const buf = buildTestEpub([{ name: 'EPUB/ch001.xhtml', content }]);

    const zip = new AdmZip(buf);
    const entry = zip.getEntry('EPUB/ch001.xhtml');
    expect(entry).not.toBeNull();
    expect(entry!.getData().toString('utf-8')).toBe(content);
  });

  it('makeXhtml wraps body in valid XHTML boilerplate', () => {
    const result = makeXhtml('<p>test</p>');
    expect(result).toContain('<?xml version="1.0"');
    expect(result).toContain('<html xmlns="http://www.w3.org/1999/xhtml">');
    expect(result).toContain('<head>');
    expect(result).toContain('<body>');
    expect(result).toContain('<p>test</p>');
    expect(result).toContain('</body>');
    expect(result).toContain('</html>');
  });

  it('makeAssignment provides sensible defaults', () => {
    const a = makeAssignment();
    expect(a.font).toBe('Arial');
    expect(a.runs).toHaveLength(1);
    expect(a.runs[0].font).toBe('Arial');
    expect(a.runs[0].text).toBe('sample text');
  });

  it('makeAssignment allows overrides', () => {
    const a = makeAssignment({ font: 'Helvetica', headingLevel: 2 });
    expect(a.font).toBe('Helvetica');
    expect(a.headingLevel).toBe(2);
    expect(a.runs).toHaveLength(1); // default runs preserved
  });

  it('makeAssignmentResult wraps paragraphs with default body font', () => {
    const paras = [makeAssignment()];
    const result = makeAssignmentResult(paras);
    expect(result.bodyFont).toBe('Times New Roman');
    expect(result.paragraphs).toBe(paras);
    expect(result.headingFonts).toBeInstanceOf(Map);
    expect(result.headingFonts.size).toBe(0);
  });

  it('makeAssignmentResult accepts custom body font', () => {
    const result = makeAssignmentResult([], 'Georgia');
    expect(result.bodyFont).toBe('Georgia');
  });
});
