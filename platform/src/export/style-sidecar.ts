/**
 * Style Sidecar Generator - converts FontAssignmentResult into a JSON array
 * for consumption by the pandoc Lua filter (inject-styles.lua).
 *
 * Each entry corresponds to a non-empty paragraph from the docx.
 * The Lua filter reads this file and applies styles positionally as it
 * walks pandoc's AST — eliminating the alignment problem entirely.
 */

import { writeFileSync } from 'fs';
import type { FontAssignmentResult, ParagraphAssignment } from './font-assignment-extractor.js';

export interface SidecarEntry {
  style: string;  // CSS style string, or "" if no styling needed
}

/**
 * Builds the CSS style string for a single paragraph assignment.
 * Returns "" when no styles apply.
 */
function buildStyle(assignment: ParagraphAssignment, bodyFont: string): string {
  const parts: string[] = [];

  // Font-family (only if paragraph font differs from body)
  if (assignment.font && assignment.font !== bodyFont) {
    parts.push(`font-family: '${assignment.font}'`);
  }

  // Paragraph style properties
  if (assignment.style) {
    const s = assignment.style;
    if (s.textAlign && s.textAlign !== 'justify') {
      parts.push(`text-align: ${s.textAlign}`);
      if (s.textIndent === undefined) {
        parts.push('text-indent: 0pt');
      }
    }
    if (s.fontSize) {
      parts.push(`font-size: ${s.fontSize}pt`);
    }
    if (s.lineHeight) {
      if (s.lineHeight <= 5) {
        parts.push(`line-height: ${Math.round(s.lineHeight * 100)}%`);
      } else {
        parts.push(`line-height: ${s.lineHeight}pt`);
      }
    }
    if (s.textIndent !== undefined) {
      parts.push(`text-indent: ${s.textIndent}pt`);
    }
    if (s.spaceBefore) {
      parts.push(`margin-top: ${s.spaceBefore}pt`);
    }
    if (s.spaceAfter) {
      parts.push(`margin-bottom: ${s.spaceAfter}pt`);
    }
    if (s.marginLeft) {
      parts.push(`margin-left: ${s.marginLeft}pt`);
    }
    if (s.marginRight) {
      parts.push(`margin-right: ${s.marginRight}pt`);
    }
    if (s.borderTop) {
      parts.push(`border-top: ${s.borderTop.width}pt ${s.borderTop.style} #${s.borderTop.color}`);
    }
    if (s.borderBottom) {
      parts.push(`border-bottom: ${s.borderBottom.width}pt ${s.borderBottom.style} #${s.borderBottom.color}`);
    }
    if (s.borderLeft) {
      parts.push(`border-left: ${s.borderLeft.width}pt ${s.borderLeft.style} #${s.borderLeft.color}`);
    }
    if (s.borderRight) {
      parts.push(`border-right: ${s.borderRight.width}pt ${s.borderRight.style} #${s.borderRight.color}`);
    }
  }

  return parts.join('; ');
}

/**
 * Generates the style sidecar JSON file for the Lua filter.
 * Returns the path to the generated file.
 */
export function generateStyleSidecar(
  assignments: FontAssignmentResult,
  outputPath: string
): void {
  const { bodyFont, paragraphs } = assignments;

  const entries: SidecarEntry[] = paragraphs.map(p => ({
    style: buildStyle(p, bodyFont),
  }));

  writeFileSync(outputPath, JSON.stringify(entries));
}
