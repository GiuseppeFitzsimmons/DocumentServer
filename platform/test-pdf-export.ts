/**
 * Local test script for PDF export.
 * Usage: npx tsx test-pdf-export.ts <path-to-docx>
 *
 * Outputs the generated preamble and attempts the conversion.
 */

import { createReadStream } from 'fs';
import { Readable } from 'stream';
import { convertDocxToPdf } from './src/export/pdf-service.js';

const inputFile = process.argv[2];
if (!inputFile) {
  console.error('Usage: npx tsx test-pdf-export.ts <path-to-docx>');
  process.exit(1);
}

async function main() {
  console.log(`Converting: ${inputFile}`);
  const stream = createReadStream(inputFile) as unknown as Readable;

  try {
    const result = await convertDocxToPdf(stream, {
      title: 'Test Document',
      pageSize: 'a4',
      margin: '1in',
    });
    console.log(`\n✓ PDF generated: ${result.outputPath}`);
    // Copy to cwd
    const { copyFileSync } = await import('fs');
    copyFileSync(result.outputPath, 'test-output.pdf');
    console.log('✓ Copied to ./test-output.pdf');
    await result.cleanup();
  } catch (err) {
    console.error('\n✗ Error:', err);
    process.exit(1);
  }
}

main();
