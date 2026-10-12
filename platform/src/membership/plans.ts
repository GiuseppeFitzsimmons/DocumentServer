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

export function planKeys(): string[] {
  return Object.keys(PLANS);
}
