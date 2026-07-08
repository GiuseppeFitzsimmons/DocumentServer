/**
 * Internal force-save endpoint.
 * Calls the DS CommandService to force-save all open documents.
 * Protected: only accessible from localhost or private network.
 */

import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export const forceSaveRouter = Router();

const DS_COMMAND_URL = config.DS_INTERNAL_URL
  ? `${config.DS_INTERNAL_URL}/coauthoring/CommandService.ashx`
  : `${config.DS_URL}/coauthoring/CommandService.ashx`;

/**
 * POST /api/internal/forcesave
 * Triggers force-save on all open documents via the DS command API.
 * No auth required — restricted by network (only called by deploy scripts via localhost/private IP).
 */
forceSaveRouter.post('/forcesave', async (req, res) => {
  try {
    // Sign a JWT for the DS command service
    const token = jwt.sign(
      { c: 'forcesave', status: 1 },
      config.DS_JWT_SECRET,
      { expiresIn: '1m' }
    );

    // The DS forcesave command requires a document key.
    // To save ALL documents, we use the "drop" command which disconnects
    // all users and triggers save callbacks for every open document.
    const payload = {
      c: 'drop',
      users: [''],  // empty string = all users
    };

    const commandToken = jwt.sign(payload, config.DS_JWT_SECRET, { expiresIn: '1m' });

    const response = await fetch(DS_COMMAND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${commandToken}`,
      },
      body: JSON.stringify({ ...payload, token: commandToken }),
    });

    const result = await response.json();
    console.log('[forcesave] DS command response:', result);

    if (result.error === 0 || result.error === undefined) {
      res.json({ success: true, result });
    } else {
      res.status(502).json({ success: false, error: result.error, result });
    }
  } catch (err) {
    console.error('[forcesave] Error:', err);
    res.status(500).json({ success: false, error: String(err) });
  }
});
