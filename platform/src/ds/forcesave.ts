/**
 * Internal force-save endpoint for blue-green deploys.
 *
 * Rather than relying on DS's unreliable `info` command to discover open
 * documents, we use two complementary sources:
 *   1. Redis-tracked active sessions (populated when editors are opened)
 *   2. Database fallback (constructs all possible document keys from files table)
 *
 * The forcesave command is idempotent — if a document isn't actually open in DS,
 * the command returns error 3 (no changes) or error 2 (unknown key), both harmless.
 * This means we can safely over-shoot and attempt all documents.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getDocumentsToForceSave, getActiveDocuments } from './active-documents.js';

export const forceSaveRouter = Router();

const DS_COMMAND_URL = (() => {
  if (config.DS_INTERNAL_URL) return `${config.DS_INTERNAL_URL}/coauthoring/CommandService.ashx`;
  return 'http://documentserver:8000/coauthoring/CommandService.ashx';
})();

async function dsCommand(payload: Record<string, unknown>): Promise<any> {
  const token = jwt.sign(payload, config.DS_JWT_SECRET, { expiresIn: '1m' });
  console.log(`[forcesave] DS command:`, JSON.stringify(payload));
  const response = await fetch(DS_COMMAND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ ...payload, token }),
  });
  const text = await response.text();
  console.log(`[forcesave] DS raw response (${response.status}):`, text);
  try {
    return JSON.parse(text);
  } catch {
    return { error: -1, raw: text };
  }
}

// DS forcesave error codes that are non-fatal:
// 0 = success
// 1 = document key missing/unknown (not open)
// 2 = callback url couldn't be reached (transient)
// 3 = no changes to save
// 4 = command error (generic)
const NON_FATAL_ERRORS = new Set([1, 3]);

/**
 * POST /api/internal/forcesave
 *
 * Query params:
 *   strategy = 'tracked' | 'all' | 'both' (default: 'both')
 *     - tracked: only force-save documents tracked via Redis (known active sessions)
 *     - all: force-save every document in the DB (safe but slower)
 *     - both: merge both sources (recommended for blue-green deploys)
 *   concurrency = number (default: 5) - how many forcesaves to run in parallel
 */
forceSaveRouter.post('/forcesave', async (req, res) => {
  try {
    // Verify DS connectivity
    const versionResult = await dsCommand({ c: 'version' });
    console.log(`[forcesave] DS version check:`, JSON.stringify(versionResult));

    const strategy = (req.query.strategy as 'tracked' | 'all' | 'both') || 'both';
    const concurrency = Math.min(Math.max(Number(req.query.concurrency) || 5, 1), 20);

    console.log(`[forcesave] Strategy: ${strategy}, concurrency: ${concurrency}`);

    // Get document keys to forcesave
    const documents = await getDocumentsToForceSave(strategy);
    console.log(`[forcesave] Documents to force-save: ${documents.length}`);

    if (documents.length === 0) {
      res.json({
        success: true,
        strategy,
        total: 0,
        saved: 0,
        skipped: 0,
        errors: 0,
        message: 'No documents to forcesave',
      });
      return;
    }

    let saved = 0;
    let skipped = 0;
    let errors = 0;
    const errorDetails: Array<{ fileId: string; key: string; error: number }> = [];

    // Process in batches for controlled concurrency
    for (let i = 0; i < documents.length; i += concurrency) {
      const batch = documents.slice(i, i + concurrency);
      const results = await Promise.allSettled(
        batch.map(async ({ fileId, documentKey }) => {
          const result = await dsCommand({
            c: 'forcesave',
            key: documentKey,
            userdata: 'deploy',
          });

          if (result.error === 0) {
            return { status: 'saved' as const, fileId, key: documentKey };
          } else if (NON_FATAL_ERRORS.has(result.error)) {
            // Document not open or no changes — this is expected
            return { status: 'skipped' as const, fileId, key: documentKey };
          } else {
            return { status: 'error' as const, fileId, key: documentKey, error: result.error };
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const val = result.value;
          if (val.status === 'saved') saved++;
          else if (val.status === 'skipped') skipped++;
          else {
            errors++;
            errorDetails.push({ fileId: val.fileId, key: val.key, error: val.error });
          }
        } else {
          errors++;
        }
      }
    }

    console.log(
      `[forcesave] Done: ${saved} saved, ${skipped} skipped (not open/no changes), ${errors} errors`
    );

    res.json({
      success: errors === 0,
      strategy,
      total: documents.length,
      saved,
      skipped,
      errors,
      ...(errorDetails.length > 0 ? { errorDetails } : {}),
    });
  } catch (err) {
    console.error('[forcesave] Error:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});

/**
 * GET /api/internal/forcesave/active
 * Returns the currently tracked active documents (debugging/monitoring).
 */
forceSaveRouter.get('/forcesave/active', async (_req, res) => {
  try {
    const docs = await getActiveDocuments();
    res.json({ count: docs.length, documents: docs });
  } catch (err) {
    console.error('[forcesave] Error listing active docs:', err);
    res.status(500).json({ error: String(err) });
  }
});
