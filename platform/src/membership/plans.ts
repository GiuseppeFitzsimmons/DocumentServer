// Membership plan definitions — the single source of truth mapping a plan key
// to its storage quota. Phase 2 (the Payhip webhook) will map a purchased
// product/variant to one of these keys; for now the membership:set CLI uses it
// for manual upgrades.

export interface Plan {
  key: string;
  label: string;
  storageLimitBytes: number;
}

const MB = 1024 * 1024;

export const PLANS: Record<string, Plan> = {
  free: { key: 'free', label: 'Free', storageLimitBytes: 10 * MB },
  storage_100: { key: 'storage_100', label: 'Storage 100MB', storageLimitBytes: 100 * MB },
};

export function getPlan(key: string): Plan | null {
  return PLANS[key] ?? null;
}

// Base storage for a plan key, independent of any per-account bonuses (e.g.
// referral credit). Falls back to the free plan for unknown keys.
export function planBaseBytes(key: string | null | undefined): number {
  return (key && PLANS[key] ? PLANS[key] : PLANS.free).storageLimitBytes;
}

// Permanent storage credit granted to each side of a successful referral.
export const REFERRAL_BONUS_BYTES = 10 * MB;

export function planKeys(): string[] {
  return Object.keys(PLANS);
}
