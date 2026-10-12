/**
 * CLI: set a user's membership plan (and thus storage quota) manually.
 *
 * Usage:
 *   npm run membership:set -- user@example.com storage_100
 *   npm run membership:set -- user@example.com free
 *
 * Plan keys come from membership/plans.ts. Shares applyPlanByEmail with the
 * (future) payment webhook so manual and automated upgrades behave identically.
 */
import { pool } from '../db/pool.js';
import { applyPlanByEmail, UnknownPlanError, UserNotFoundError } from './service.js';
import { planKeys } from './plans.js';

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  const planKey = process.argv[3]?.trim();

  if (!email || !email.includes('@') || !planKey) {
    console.error('Usage: npm run membership:set -- <email> <plan>');
    console.error(`Plans: ${planKeys().join(', ')}`);
    process.exit(1);
  }

  try {
    const result = await applyPlanByEmail(email, planKey);
    const mb = (result.storageLimitBytes / (1024 * 1024)).toFixed(0);
    console.log(`✓ ${result.email} -> plan "${result.plan}" (${mb} MB)`);
  } catch (err) {
    if (err instanceof UnknownPlanError) {
      console.error(err.message);
      console.error(`Plans: ${planKeys().join(', ')}`);
      process.exit(1);
    }
    if (err instanceof UserNotFoundError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
