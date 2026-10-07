/**
 * CLI: reject a beta signup.
 *
 * Usage:
 *   npm run beta:reject -- user@example.com
 */
import { pool } from '../db/pool.js';

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();

  if (!email || !email.includes('@')) {
    console.error('Usage: npm run beta:reject -- <email>');
    process.exit(1);
  }

  const { rowCount } = await pool.query(
    "UPDATE beta_signups SET status = 'rejected', reviewed_at = NOW() WHERE email = $1 AND status = 'pending'",
    [email]
  );

  if (rowCount === 0) {
    console.log(`No pending signup found for "${email}".`);
  } else {
    console.log(`✓ Rejected "${email}".`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
