import { pool } from '../db/pool.js';
import { FONT_CATALOG_SET } from './catalog.js';

export async function getUserFonts(userId: string): Promise<string[]> {
  const { rows } = await pool.query(
    'SELECT font_name FROM user_font_preferences WHERE user_id = $1 ORDER BY font_name',
    [userId]
  );
  return rows.map(r => r.font_name);
}

export async function setUserFonts(userId: string, fontNames: string[]): Promise<void> {
  // Validate all names against catalog
  const valid = fontNames.filter(f => FONT_CATALOG_SET.has(f));

  // Replace all preferences in a transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM user_font_preferences WHERE user_id = $1', [userId]);

    if (valid.length > 0) {
      const values = valid.map((_, i) => `($1, $${i + 2})`).join(', ');
      await client.query(
        `INSERT INTO user_font_preferences (user_id, font_name) VALUES ${values}`,
        [userId, ...valid]
      );
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
