/**
 * Shared type definitions for the EPUB font embedding pipeline.
 */

/**
 * Represents a single font usage extracted from a docx file.
 * Captures the font family name along with its weight and style variant.
 */
export interface FontUsageRecord {
  family: string;
  weight: 'normal' | 'bold';
  style: 'normal' | 'italic';
}

/**
 * Maps a FontUsageRecord to a resolved file path on disk.
 * A null filePath indicates the font could not be resolved.
 */
export interface FontResolutionResult {
  record: FontUsageRecord;
  filePath: string | null;
}
