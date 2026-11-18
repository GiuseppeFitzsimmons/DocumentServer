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
  // A user holds storage_100 if EITHER:
  //   - an unexpired one-off grant (single-month purchase; a refund shrinks its
  //     expires_at to the grace window, so expiry alone is the active test), OR
  //   - a subscription still within its paid period (current_period_end > now),
  //     whether active or canceled — a canceled sub keeps its remaining period.
  // Only touches users on free/storage_100 so manual plans are left alone.
  // storage_limit_bytes is kept as a derived cache (plan base + referral bonus);
  // quota.ts derives the effective limit the same way.
  await pool.query(
    `UPDATE users u
        SET plan = x.new_plan,
            storage_limit_bytes =
              (CASE WHEN x.new_plan = $1 THEN $2::bigint ELSE $3::bigint END)
              + COALESCE(u.referral_bonus_bytes, 0),
            updated_at = NOW()
       FROM (
         SELECT u2.id,
                CASE WHEN (
                  EXISTS (
                    SELECT 1 FROM membership_grants g
                     WHERE g.email = LOWER(u2.email)
                       AND g.plan = $1
                       AND g.expires_at > NOW()
                  ) OR EXISTS (
                    SELECT 1 FROM membership_subscriptions s
                     WHERE s.email = LOWER(u2.email)
                       AND s.plan = $1
                       AND s.current_period_end > NOW()
                  )
                ) THEN $1 ELSE 'free' END AS new_plan
           FROM users u2
          WHERE u2.plan IN ('free', $1)
            AND ($4::text IS NULL OR LOWER(u2.email) = $4)
       ) x
      WHERE u.id = x.id AND u.plan <> x.new_plan`,
    [PLAN_KEY, paid.storageLimitBytes, free.storageLimitBytes, email ?? null]
  );
}

/**
 * Self-renew active subscriptions: roll current_period_end forward in 30-day
 * steps until it's in the future. Payhip sends no per-renewal webhook, so this
 * is what keeps a paying subscriber's storage alive. Deliberately generous — it
 * rolls to a future boundary and self-heals after any downtime, so an active
 * subscription can never lapse (worst case the customer gets a little free
 * time, which is the intended bias).
 */
export async function renewSubscriptions(): Promise<string[]> {
  const { rows } = await pool.query(
    `UPDATE membership_subscriptions
        SET current_period_end =
              current_period_end
              + (ceil(EXTRACT(EPOCH FROM (NOW() - current_period_end)) / (${GRANT_DAYS} * 86400))
                 * INTERVAL '${GRANT_DAYS} days')
      WHERE status = 'active' AND current_period_end <= NOW()
      RETURNING email`,
    []
  );
  return rows.map((r) => r.email as string);
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

  const purchased = new Date((Number(ev.date) || Math.floor(Date.now() / 1000)) * 1000);

  // Stack, don't overlap. The new 30 days begin at the buyer's furthest-out
  // paid-through date so the purchase always adds a full 30 days of real
  // runway — never wasted on coverage they already have. That furthest date is
  // the latest of:
  //   - any active one-off grant's expiry, and
  //   - any active subscription's current_period_end (so a single-month bought
  //     during an active subscription banks 30 days PAST the subscription,
  //     rather than running concurrently and evaporating).
  // Otherwise it starts at the purchase date.
  const { rows: activeRows } = await pool.query(
    `SELECT GREATEST(
              COALESCE((SELECT MAX(expires_at) FROM membership_grants
                         WHERE email = $1 AND plan = $2
                           AND refunded_at IS NULL AND expires_at > NOW()), 'epoch'),
              COALESCE((SELECT MAX(current_period_end) FROM membership_subscriptions
                         WHERE email = $1 AND plan = $2
                           AND current_period_end > NOW()), 'epoch')
            ) AS end_at`,
    [email, PLAN_KEY]
  );
  const rawEnd = activeRows[0]?.end_at as Date | null;
  const currentEnd: Date | null = rawEnd && rawEnd.getTime() > 0 ? rawEnd : null;
  const start = currentEnd && currentEnd > purchased ? currentEnd : purchased;
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

const REFUND_GRACE_DAYS = 2;

async function handleRefund(ev: any): Promise<void> {
  if (!ev.id) return;
  // Grace period: a refunded single-month purchase keeps 100 MB active for a
  // further REFUND_GRACE_DAYS, then lapses. We encode this by shrinking the
  // grant's expiry to min(current expiry, now + grace) and stamping
  // refunded_at. The expiry-based sync below then treats it like any other
  // grant that will soon run out.
  const { rows } = await pool.query(
    `UPDATE membership_grants
        SET refunded_at = NOW(),
            expires_at = LEAST(expires_at, NOW() + ($2 || ' days')::interval)
      WHERE source_ref = $1 AND refunded_at IS NULL
      RETURNING email`,
    [String(ev.id), String(REFUND_GRACE_DAYS)]
  );
  for (const r of rows) await syncPlans(r.email);
}


async function handleSubscriptionCreated(ev: any): Promise<void> {
  const email = String(ev.customer_email || '').trim().toLowerCase();
  const subId = String(ev.subscription_id || '');
  if (!email || !subId) return;

  const start = new Date((Number(ev.date_subscription_started) || Math.floor(Date.now() / 1000)) * 1000);
  const periodEnd = new Date(start.getTime() + GRANT_DAYS * 86400_000);
  // Upsert: a re-created / reactivated subscription becomes active again and its
  // period end is pushed to at least 30 days out (never shortened).
  await pool.query(
    `INSERT INTO membership_subscriptions (subscription_id, email, plan, status, current_period_end)
     VALUES ($1, $2, $3, 'active', $4)
     ON CONFLICT (subscription_id) DO UPDATE
       SET status = 'active',
           canceled_at = NULL,
           email = EXCLUDED.email,
           current_period_end = GREATEST(membership_subscriptions.current_period_end, EXCLUDED.current_period_end)`,
    [subId, email, PLAN_KEY, periodEnd]
  );

  if (await userExists(email)) await syncPlans(email);
  else await notifyUnknown(email);
}

async function handleSubscriptionDeleted(ev: any): Promise<void> {
  const subId = String(ev.subscription_id || '');
  if (!subId) return;
  // Stop renewing, but keep the current paid period: leave current_period_end
  // untouched so the customer keeps the remainder they already paid for. The
  // plan lapses naturally once current_period_end passes (no further renewals).
  const { rows } = await pool.query(
    `UPDATE membership_subscriptions
        SET status = 'canceled', canceled_at = NOW()
      WHERE subscription_id = $1 AND status <> 'canceled'
      RETURNING email`,
    [subId]
  );
  for (const r of rows) await syncPlans(r.email);
}

/**
 * Record every verified event verbatim. Best-effort: a logging failure must
 * never fail the webhook (Payhip would needlessly retry). Primarily here so we
 * can confirm what — if anything — Payhip sends on a subscription renewal.
 */
async function logEvent(ev: any): Promise<void> {
  try {
    const sourceRef = ev.id ?? ev.subscription_id ?? null;
    const email = ev.email ?? ev.customer_email ?? null;
    await pool.query(
      `INSERT INTO payhip_events (event_type, source_ref, email, payload)
       VALUES ($1, $2, $3, $4)`,
      [ev.type ?? null, sourceRef ? String(sourceRef) : null,
       email ? String(email).toLowerCase() : null, ev]
    );
  } catch (err) {
    console.error('[payhip] failed to log event:', err);
  }
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
  // Log first so even an event we don't handle (or that errors) is captured.
  await logEvent(ev);
  console.log(`[payhip] received ${ev.type ?? 'unknown'} (ref=${ev.id ?? ev.subscription_id ?? '-'})`);
  try {
    if (ev.type === 'paid') await handlePaid(ev);
    else if (ev.type === 'refunded') await handleRefund(ev);
    else if (ev.type === 'subscription.created') await handleSubscriptionCreated(ev);
    else if (ev.type === 'subscription.deleted') await handleSubscriptionDeleted(ev);
    else console.log(`[payhip] ${ev.type}: no action`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[payhip] webhook error:', err);
    res.status(500).json({ error: 'internal' });
  }
});

export function startMembershipSweep(): void {
  const run = async () => {
    try {
      // Roll active subscriptions forward FIRST so an about-to-lapse period is
      // extended before the plan sync evaluates expiry — an active subscription
      // must never be seen as lapsed.
      await renewSubscriptions();
      await syncPlans();
    } catch (e: any) {
      // On first boot the sweep can run before migrations have created the
      // membership tables. That's transient (next tick, post-migration, works),
      // so don't spam a stack trace — just note it and move on.
      if (e?.code === '42P01') {
        console.warn('[membership] sweep skipped: membership tables not migrated yet');
      } else {
        console.error('[membership] sweep failed:', e);
      }
    }
  };
  void run();
  setInterval(() => void run(), 60 * 60 * 1000).unref();
}
