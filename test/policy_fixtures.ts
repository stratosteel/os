/**
 * Shared fixtures for the policy tests. Invented names and example.com addresses only.
 */
import { DEFAULT_POLICY, type PolicyConfig } from '../src/policy.js';

/** A configured instance policy over the template defaults (timezone Europe/Bratislava, quiet hours 00:00-06:00). */
export const CONFIG: PolicyConfig = { ...DEFAULT_POLICY };

/**
 * A trusted clock reading given as Europe/Bratislava wall time. Summer-time dates only (UTC+2, 2026-03-29 to 2026-10-24);
 * the DST tests give UTC instants explicitly.
 */
export function bratislava(hhmm: string, date = '2026-10-07'): Date {
  if (date < '2026-03-29' || date > '2026-10-24') throw new Error(`bratislava() covers summer-time dates only, got ${date}`);
  return new Date(`${date}T${hhmm}:00+02:00`);
}
