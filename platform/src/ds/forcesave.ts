/**
 * Internal force-save endpoint.
 * Queries the DS for active document keys and triggers forcesave for each.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const forceSaveRouter = Router();

const DS_COMMAND_URL = (() => {
  if (config.DS_INTERNAL_URL) return `${config.DS_INTERNAL_URL}/coauthoring/CommandService.ashx`;
  return 'http://documentserver:8000/coauthoring/CommandService.ashx';
})();

async function dsCommand(payload: Record<string, unknown>): Promise<any> {
  const token = jwt.sign(payload, config.DS_JWT_SECRET, { expiresIn: '1m' });
  const response = await fetch(DS_COMMAND_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ ...payload, token }),
  });
  return response.json();
}

/**
 * POST /api/internal/forcesave
 * Gets active docs from DS via 'info' command, then forcesaves each.
 */
forceSaveRouter.post('/forcesave', async (req, res) => {
  try {
    // Step 1: Get list of active document keys from DS
    const infoResult = await dsCommand({ c: 'info' });
    console.log('[forcesave] DS info response:', JSON.stringify(infoResult));

    // The info command returns {error: 0, keys: ["key1", "key2", ...]}
    // or it might return all docs differently depending on version
    let keys: string[] = [];
    if (infoResult.error === 0 && Array.isArray(infoResult.keys)) {
      keys = infoResult.keys;
    }

    if (keys.length === 0) {
      console.log('[forcesave] No active documents found');
      res.json({ success: true, total: 0, saved: 0, errors: 0 });
      return;
    }

    console.log(`[forcesave] Found ${keys.length} active document(s): ${keys.join(', ')}`);

    let saved = 0;
    let errors = 0;

    for (const key of keys) {
      try {
        const result = await dsCommand({ c: 'forcesave', key, userdata: 'deploy' });
        if (result.error === 0) {
          saved++;
        } else {
          errors++;
          console.warn(`[forcesave] Error for key ${key}: code ${result.error}`);
        }
      } catch (err) {
        errors++;
        console.warn(`[forcesave] Failed for key ${key}:`, err);
      }
    }

    console.log(`[forcesave] Complete: ${saved} saved, ${errors} errors out of ${keys.length} documents`);
    res.json({ success: true, total: keys.length, saved, errors });
  } catch (err) {
    console.error('[forcesave] Error:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});
