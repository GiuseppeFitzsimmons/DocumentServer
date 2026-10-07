/**
 * CLI: list beta signups.
 *
 * Usage:
 *   npm run beta:list              — show pending signups
 *   npm run beta:list -- --all     — show all signups
 */
import { pool } from '../db/pool.js';

async function main() {
  const showAll = process.argv.includes('--all');
  const where = showAll ? '' : "WHERE status = 'pending'";
  const label = showAll ? 'All' : 'Pending';

  const { rows } = await pool.query(
    `SELECT email, display_name, reason, status, created_at
     FROM beta_signups
     ${where}
     ORDER BY created_at ASC`
  );

  console.log(`\n${label} beta signups: ${rows.length}\n`);

  if (rows.length === 0) {
    console.log('  (none)');
  } else {
    for (const r of rows) {
      const date = new Date(r.created_at).toISOString().slice(0, 10);
      const reason = r.reason ? ` — "${r.reason.slice(0, 80)}"` : '';
      console.log(`  [${r.status.toUpperCase().padEnd(8)}] ${date}  ${r.email}  (${r.display_name})${reason}`);
    }
  }

  console.log('');
  await pool.end();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
