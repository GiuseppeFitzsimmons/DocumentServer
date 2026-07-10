/**
 * Internal force-save endpoint.
 * Asks DS for currently open documents, then forcesaves each.
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

/**
 * POST /api/internal/forcesave
 * Queries DS for open documents via 'info' command, then forcesaves each.
 * Falls back to 'license' command to verify connectivity.
 */
forceSaveRouter.post('/forcesave', async (req, res) => {
  try {
    // First verify DS connectivity
    const versionResult = await dsCommand({ c: 'version' });
    console.log(`[forcesave] DS version check:`, JSON.stringify(versionResult));

    // Get open document keys
    const infoResult = await dsCommand({ c: 'info' });
    console.log(`[forcesave] DS info result:`, JSON.stringify(infoResult));

    // Extract keys from response
    let keys: string[] = [];
    if (infoResult.error === 0) {
      // Depending on DS version, keys might be in different fields
      if (Array.isArray(infoResult.keys)) keys = infoResult.keys;
      else if (infoResult.key) keys = [infoResult.key];
    }

    console.log(`[forcesave] Active document keys: [${keys.join(', ')}]`);

    if (keys.length === 0) {
      res.json({ success: true, total: 0, saved: 0, errors: 0, message: 'No open documents' });
      return;
    }

    let saved = 0;
    let errors = 0;

    for (const key of keys) {
      const result = await dsCommand({ c: 'forcesave', key, userdata: 'deploy' });
      if (result.error === 0) {
        saved++;
      } else {
        errors++;
      }
    }

    console.log(`[forcesave] Done: ${saved} saved, ${errors} errors`);
    res.json({ success: true, total: keys.length, saved, errors });
  } catch (err) {
    console.error('[forcesave] Error:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});
