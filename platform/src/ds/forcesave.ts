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
 *
 * IMPORTANT: DS's forcesave command is ASYNCHRONOUS. DS returns error:0 immediately
 * but the actual callback (which persists the file to S3) happens separately.
 * We must wait for callbacks to complete before returning success.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
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
// 1 = document key missing/unknown (not open)
// 3 = no changes to save
const NON_FATAL_ERRORS = new Set([1, 3]);

/**
 * Wait for a file's updated_at to change from its current value.
 * This confirms the callback actually completed and persisted to DB.
 */
async function waitForSaveConfirmation(
  fileId: string,
  previousUpdatedAt: Date,
  timeoutMs: number = 15000
): Promise<boolean> {
  const start = Date.now();
  const pollInterval = 500;

  while (Date.now() - start < timeoutMs) {
    const { rows } = await pool.query(
      'SELECT updated_at FROM files WHERE id = $1',
      [fileId]
    );
    if (rows.length > 0) {
      const currentUpdatedAt = new Date(rows[0].updated_at);
      if (currentUpdatedAt.getTime() > previousUpdatedAt.getTime()) {
        return true; // Callback completed, file was saved
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
  return false; // Timed out
}

/**
 * POST /api/internal/forcesave
 *
 * Query params:
 *   strategy = 'tracked' | 'all' | 'both' (default: 'both')
 *     - tracked: only force-save documents tracked via Redis (known active sessions)
 *     - all: force-save every document in the DB (safe but slower)
 *     - both: merge both sources (recommended for blue-green deploys)
 *   concurrency = number (default: 5) - how many forcesaves to run in parallel
 *   wait = 'true' | 'false' (default: 'true') - wait for callbacks to complete
 */
forceSaveRouter.post('/forcesave', async (req, res) => {
  try {
    // Verify DS connectivity
    const versionResult = await dsCommand({ c: 'version' });
    console.log(`[forcesave] DS version check:`, JSON.stringify(versionResult));

    const strategy = (req.query.strategy as 'tracked' | 'all' | 'both') || 'both';
    const concurrency = Math.min(Math.max(Number(req.query.concurrency) || 5, 1), 20);
    const shouldWait = req.query.wait !== 'false';

    console.log(`[forcesave] Strategy: ${strategy}, concurrency: ${concurrency}, wait: ${shouldWait}`);

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

    // Snapshot current updated_at values for documents we'll attempt to save
    const timestamps = new Map<string, Date>();
    if (shouldWait) {
      const { rows } = await pool.query(
        'SELECT id, updated_at FROM files WHERE id = ANY($1)',
        [documents.map(d => d.fileId)]
      );
      for (const row of rows) {
        timestamps.set(row.id as string, new Date(row.updated_at));
      }
    }

    let saved = 0;
    let skipped = 0;
    let errors = 0;
    let confirmed = 0;
    let unconfirmed = 0;
    const errorDetails: Array<{ fileId: string; key: string; error: number; detail?: string }> = [];
    const pendingConfirmations: Array<{ fileId: string; previousUpdatedAt: Date }> = [];

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
            return { status: 'skipped' as const, fileId, key: documentKey };
          } else {
            return { status: 'error' as const, fileId, key: documentKey, error: result.error };
          }
        })
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const val = result.value;
          if (val.status === 'saved') {
            saved++;
            if (shouldWait) {
              const prevTs = timestamps.get(val.fileId);
              if (prevTs) {
                pendingConfirmations.push({ fileId: val.fileId, previousUpdatedAt: prevTs });
              }
            }
          } else if (val.status === 'skipped') {
            skipped++;
          } else {
            errors++;
            errorDetails.push({ fileId: val.fileId, key: val.key, error: val.error });
          }
        } else {
          errors++;
        }
      }
    }

    // Wait for callbacks to actually complete (file persisted to S3 + DB updated)
    if (shouldWait && pendingConfirmations.length > 0) {
      console.log(`[forcesave] Waiting for ${pendingConfirmations.length} callback(s) to complete...`);

      const confirmResults = await Promise.allSettled(
        pendingConfirmations.map(async ({ fileId, previousUpdatedAt }) => {
          const ok = await waitForSaveConfirmation(fileId, previousUpdatedAt);
          return { fileId, ok };
        })
      );

      for (const result of confirmResults) {
        if (result.status === 'fulfilled') {
          if (result.value.ok) {
            confirmed++;
          } else {
            unconfirmed++;
            errorDetails.push({
              fileId: result.value.fileId,
              key: '',
              error: -2,
              detail: 'Forcesave command accepted but callback did not complete within timeout',
            });
          }
        } else {
          unconfirmed++;
        }
      }

      console.log(`[forcesave] Confirmations: ${confirmed} confirmed, ${unconfirmed} unconfirmed`);
    }

    console.log(
      `[forcesave] Done: ${saved} saved, ${skipped} skipped (not open/no changes), ${errors} errors`
    );

    res.json({
      success: errors === 0 && unconfirmed === 0,
      strategy,
      total: documents.length,
      saved,
      confirmed,
      unconfirmed,
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
