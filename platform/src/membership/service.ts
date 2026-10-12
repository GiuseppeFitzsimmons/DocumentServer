import { pool } from '../db/pool.js';
import { getPlan } from './plans.js';

export class UnknownPlanError extends Error {}
export class UserNotFoundError extends Error {}

/**
 * Apply a membership plan to a user by email: sets their plan and storage
 * limit from the plan definition. Shared by the membership:set CLI and (later)
 * the payment webhook so there's one place that mutates entitlements.
 *
 * Returns the updated { email, plan, storageLimitBytes }.
 */
export async function applyPlanByEmail(email: string, planKey: string) {
  const plan = getPlan(planKey);
  if (!plan) {
    throw new UnknownPlanError(`Unknown plan: ${planKey}`);
  }

  const emailLower = email.trim().toLowerCase();
  const { rows } = await pool.query(
    `UPDATE users
       SET plan = $1,
           storage_limit_bytes = $2,
           updated_at = NOW()
     WHERE email = $3
     RETURNING email, plan, storage_limit_bytes`,
    [plan.key, plan.storageLimitBytes, emailLower]
  );

  if (rows.length === 0) {
    throw new UserNotFoundError(`No user with email: ${emailLower}`);
  }

  return {
    email: rows[0].email as string,
    plan: rows[0].plan as string,
    storageLimitBytes: Number(rows[0].storage_limit_bytes),
  };
}
