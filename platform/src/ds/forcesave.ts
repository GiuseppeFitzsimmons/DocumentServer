/**
 * Internal force-save endpoint.
 * Queries recently modified files and triggers DS forcesave for each.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { pool } from '../db/pool.js';

export const forceSaveRouter = Router();

const DS_COMMAND_URL = (() => {
  if (config.DS_INTERNAL_URL) return `${config.DS_INTERNAL_URL}/coauthoring/CommandService.ashx`;
  return 'http://documentserver:8000/coauthoring/CommandService.ashx';
})();

async function dsCommand(payload: Record<string, unknown>): Promise<any> {
  const token = jwt.sign(payload, config.DS_JWT_SECRET, { expiresIn: '1m' });
  console.log(`[forcesave] Sending DS command:`, JSON.stringify(payload));
  console.log(`[forcesave] DS URL: ${DS_COMMAND_URL}`);
  const response = await fetch(DS_COMMAND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ ...payload, token }),
  });
  const result = await response.json();
  console.log(`[forcesave] DS response:`, JSON.stringify(result));
  return result;
}

/**
 * POST /api/internal/forcesave
 * Triggers forcesave on all recently-active documents.
 */
forceSaveRouter.post('/forcesave', async (req, res) => {
  try {
    // Find files modified in the last hour (likely to have open sessions)
    const result = await pool.query(
      `SELECT id, updated_at FROM files WHERE updated_at > NOW() - INTERVAL '1 hour'`
    );

    const files = result.rows;
    console.log(`[forcesave] Found ${files.length} recently-modified files`);

    if (files.length === 0) {
      // Try broader window
      const broader = await pool.query(
        `SELECT id, updated_at FROM files ORDER BY updated_at DESC LIMIT 10`
      );
      console.log(`[forcesave] Broader query (last 10 files):`, broader.rows.map((r: any) => ({
        id: r.id,
        updated_at: r.updated_at,
        key: `${r.id}_${new Date(r.updated_at).getTime()}`
      })));
    }

    let saved = 0;
    let errors = 0;
    const results: any[] = [];

    for (const file of files) {
      const updatedAt = new Date(file.updated_at).getTime();
      const docKey = `${file.id}_${updatedAt}`;
      console.log(`[forcesave] Trying key: ${docKey}`);

      try {
        const data = await dsCommand({ c: 'forcesave', key: docKey, userdata: 'deploy' });
        results.push({ key: docKey, result: data });
        if (data.error === 0) {
          saved++;
        } else if (data.error === 1) {
          // Key not found — document not currently open in DS
          console.log(`[forcesave] Key not found (not open): ${docKey}`);
        } else {
          errors++;
          console.warn(`[forcesave] Error for ${file.id}: code ${data.error}`);
        }
      } catch (err) {
        errors++;
        console.warn(`[forcesave] Failed for ${file.id}:`, err);
        results.push({ key: docKey, error: String(err) });
      }
    }

    console.log(`[forcesave] Complete: ${saved} saved, ${errors} errors, ${files.length - saved - errors} not open`);
    res.json({ success: true, total: files.length, saved, errors, results });
  } catch (err) {
    console.error('[forcesave] Error:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});
