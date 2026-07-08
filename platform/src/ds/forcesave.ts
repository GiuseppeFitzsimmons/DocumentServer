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
  // Inside docker-compose, DS is reachable via service name
  return 'http://documentserver:8000/coauthoring/CommandService.ashx';
})();

/**
 * POST /api/internal/forcesave
 * Triggers forcesave on all recently-active documents.
 */
forceSaveRouter.post('/forcesave', async (req, res) => {
  try {
    // Find files modified in the last hour (likely to have open sessions)
    const result = await pool.query(
      `SELECT id FROM files WHERE updated_at > NOW() - INTERVAL '1 hour'`
    );

    const fileIds = result.rows.map((r: any) => r.id);
    console.log(`[forcesave] Attempting forcesave on ${fileIds.length} recently-modified files`);

    let saved = 0;
    let errors = 0;

    for (const fileId of fileIds) {
      // The document key format used by the editor
      // It's "{fileId}_{timestamp}" but we need the exact key the DS knows.
      // The DS tracks by the key we gave it in editorConfig.document.key
      // which is "{fileId}_{file.updatedAt timestamp}"
      // We can try with just the fileId-based pattern
      
      const file = await pool.query('SELECT id, updated_at FROM files WHERE id = $1', [fileId]);
      if (file.rows.length === 0) continue;
      
      const updatedAt = new Date(file.rows[0].updated_at).getTime();
      const docKey = `${fileId}_${updatedAt}`;

      const payload = { c: 'forcesave', key: docKey, userdata: 'deploy-forcesave' };
      const token = jwt.sign(payload, config.DS_JWT_SECRET, { expiresIn: '1m' });

      try {
        const response = await fetch(DS_COMMAND_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
          },
          body: JSON.stringify({ ...payload, token }),
        });

        const data = await response.json() as { error?: number };
        if (data.error === 0) {
          saved++;
        } else if (data.error === 1) {
          // Key not found — document not currently open in DS, skip
        } else {
          errors++;
          console.warn(`[forcesave] Error for ${fileId}: error code ${data.error}`);
        }
      } catch (err) {
        errors++;
        console.warn(`[forcesave] Failed for ${fileId}:`, err);
      }
    }

    console.log(`[forcesave] Complete: ${saved} saved, ${errors} errors, ${fileIds.length - saved - errors} not open`);
    res.json({ success: true, total: fileIds.length, saved, errors });
  } catch (err) {
    console.error('[forcesave] Error:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});
