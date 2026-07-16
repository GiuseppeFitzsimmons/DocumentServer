/**
 * Test helpers for xhtml-font-injector tests.
 * Provides utilities for building in-memory EPUB archives and test fixtures.
 */

import AdmZip from 'adm-zip';
import type {
  FontAssignmentResult,
  ParagraphAssignment,
} from '../font-assignment-extractor.js';

/**
 * Creates an in-memory zip archive (EPUB) with named XHTML entries.
 */
export function buildTestEpub(files: { name: string; content: string }[]): Buffer {
  const zip = new AdmZip();
  for (const file of files) {
    zip.addFile(file.name, Buffer.from(file.content, 'utf-8'));
  }
  return zip.toBuffer();
}

/**
 * Wraps body content in minimal valid XHTML boilerplate.
 */
export function makeXhtml(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Test</title></head>
<body>
${body}
</body>
</html>`;
}

/**
 * Factory for test ParagraphAssignment objects with sensible defaults.
 */
export function makeAssignment(overrides?: Partial<ParagraphAssignment>): ParagraphAssignment {
  return {
    font: 'Arial',
    runs: [{ font: 'Arial', text: 'sample text' }],
    ...overrides,
  };
}

/**
 * Wraps an array of ParagraphAssignment into a full FontAssignmentResult.
 */
export function makeAssignmentResult(
  paragraphs: ParagraphAssignment[],
  bodyFont?: string,
): FontAssignmentResult {
  return {
    bodyFont: bodyFont ?? 'Times New Roman',
    paragraphs,
    headingFonts: new Map(),
  };
}
