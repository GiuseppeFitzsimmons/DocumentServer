import { Router } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool.js';
import { config } from '../config.js';
import { sendEmail } from '../email.js';
import { getPlan } from './plans.js';

const PLAN_KEY = 'storage_100';
const GRANT_DAYS = 30;

function productSet(): Set<string> {
  return new Set(
    config.PAYHIP_STORAGE_PRODUCTS.split(',').map((s) => s.trim()).filter(Boolean)
  );
}

function signatureValid(sig: unknown): boolean {
  if (typeof sig !== 'string' || !config.PAYHIP_API_KEY) return false;
  const expected = crypto.createHash('sha256').update(config.PAYHIP_API_KEY).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Recompute plan/limit from grants. A user holds storage_100 while they have an
 * unrefunded grant that hasn't expired; otherwise they're free. Only touches
 * users currently on free/storage_100 so manually assigned plans are untouched.
 * Pass an email to scope to one user; omit for a full sweep (expiry).
 */
export async function syncPlans(email?: string): Promise<void> {
  const paid = getPlan(PLAN_KEY)!;
  const free = getPlan('free')!;
  // Sets the plan. storage_limit_bytes is kept in sync only as a derived cache
  // (plan base + referral bonus); quota.ts derives the effective limit the same
  // way, so referral credit is preserved across plan changes.
  await pool.query(
    `UPDATE users u
        SET plan = x.new_plan,
            storage_limit_bytes =
              (CASE WHEN x.new_plan = $1 THEN $2::bigint ELSE $3::bigint END)
              + COALESCE(u.referral_bonus_bytes, 0),
            updated_at = NOW()
       FROM (
         SELECT u2.id,
                CASE WHEN EXISTS (
                  SELECT 1 FROM membership_grants g
                   WHERE g.email = LOWER(u2.email)
                     AND g.plan = $1
                     AND g.refunded_at IS NULL
                     AND g.expires_at > NOW()
                ) THEN $1 ELSE 'free' END AS new_plan
           FROM users u2
          WHERE u2.plan IN ('free', $1)
            AND ($4::text IS NULL OR LOWER(u2.email) = $4)
       ) x
      WHERE u.id = x.id AND u.plan <> x.new_plan`,
    [PLAN_KEY, paid.storageLimitBytes, free.storageLimitBytes, email ?? null]
  );
}

async function userExists(email: string): Promise<boolean> {
  const { rows } = await pool.query('SELECT 1 FROM users WHERE LOWER(email) = $1', [email]);
  return rows.length > 0;
}

async function notifyUnknown(email: string): Promise<void> {
  const text =
    'Thanks for your EuroBureau storage purchase. We could not match this email address ' +
    'to a EuroBureau account, so your storage has not been applied yet. Please contact ' +
    'support and we will sort it out for you.';
  try {
    await sendEmail({
      to: email,
      subject: 'Your EuroBureau storage purchase: please contact support',
      html: `<p>${text}</p>`,
      text,
    });
  } catch (err) {
    console.error(`[payhip] failed to send unknown-email notice to ${email}:`, err);
  }
}

function matchesProduct(items: any[] | undefined): boolean {
  const set = productSet();
  if (!set.size || !Array.isArray(items)) return false;
  return items.some((i) =>
    [i?.product_id, i?.product_key, i?.product_permalink].some((v) => v && set.has(String(v)))
  );
}

async function handlePaid(ev: any): Promise<void> {
  if (!matchesProduct(ev.items)) return;
  const email = String(ev.email || '').trim().toLowerCase();
  if (!email || !ev.id) return;

  const start = new Date((Number(ev.date) || Math.floor(Date.now() / 1000)) * 1000);
  const end = new Date(start.getTime() + GRANT_DAYS * 86400_000);
  const { rowCount } = await pool.query(
    `INSERT INTO membership_grants (source_ref, email, plan, starts_at, expires_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (source_ref) DO NOTHING`,
    [String(ev.id), email, PLAN_KEY, start, end]
  );
  if (!rowCount) return; // retry of an already-processed event

  if (await userExists(email)) await syncPlans(email);
  else await notifyUnknown(email);
}

async function handleRefund(ev: any): Promise<void> {
  if (!ev.id) return;
  const { rows } = await pool.query(
    `UPDATE membership_grants SET refunded_at = NOW()
      WHERE source_ref = $1 AND refunded_at IS NULL
      RETURNING email`,
    [String(ev.id)]
  );
  for (const r of rows) await syncPlans(r.email);
}


export const payhipRouter = Router();

payhipRouter.post('/', async (req, res) => {
  if (!config.PAYHIP_API_KEY) {
    res.status(503).json({ error: 'webhook not configured' });
    return;
  }
  const ev = req.body || {};
  if (!signatureValid(ev.signature)) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }
  try {
    if (ev.type === 'paid') await handlePaid(ev);
    else if (ev.type === 'refunded') await handleRefund(ev);
    else console.log(`[payhip] ${ev.type} (${ev.subscription_id ?? ''}): no action`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[payhip] webhook error:', err);
    res.status(500).json({ error: 'internal' });
  }
});

export function startMembershipSweep(): void {
  const run = () => syncPlans().catch((e) => console.error('[membership] sweep failed:', e));
  run();
  setInterval(run, 60 * 60 * 1000).unref();
}
