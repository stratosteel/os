/**
 * Pins finding OS-POL-02 of the independent review of 2026-10-07: fail-closed quiet hours.
 * The time of an external action comes from a trusted clock reading taken by the caller and read in the configured
 * IANA timezone; a worker-supplied localTime is never enough on its own and can only make the result stricter.
 * Missing or invalid clock configuration and unparseable times deny. A dispatch-time recheck denies a send that was
 * approved before midnight and dispatched after it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../src/policy.js';
import type { PolicyConfig, PolicyResult, ProposedAction } from '../src/policy.js';
import { CONFIG, bratislava } from './policy_fixtures.js';

/** The action of the review's reproduction: an L2 supplier inquiry carrying only the worker's boolean claims. */
const B: ProposedAction = { category: 'supplier_inquiry', level: 'L2', external: true, counterpartyInRegister: true, recipientKnown: true, templateApproved: true };

const CLOCK_REASON = /clock|quiet hours|local time|timezone/i;

function deniedByClock(r: PolicyResult, pattern: RegExp): void {
  assert.equal(r.decision, 'deny', `expected deny, got ${r.decision}: ${r.reasons.join('; ')}`);
  assert.ok(r.reasons.some((x) => pattern.test(x)), `no reason matches ${pattern}: ${r.reasons.join('; ')}`);
}

function notDeniedByClock(r: PolicyResult): void {
  assert.notEqual(r.decision, 'deny', `unexpected deny: ${r.reasons.join('; ')}`);
  assert.deepEqual(r.reasons.filter((x) => CLOCK_REASON.test(x)), []);
}

test('OS-POL-02: without a trusted clock reading an external action is denied, whatever localTime claims', () => {
  deniedByClock(policy.decide(B), /no trusted clock/);
  deniedByClock(policy.decide(B, CONFIG, {}), /no trusted clock/);
  deniedByClock(policy.decide({ ...B, localTime: '10:00' }, CONFIG), /no trusted clock/);
});

test('OS-POL-02: hour and minute ranges are validated; an unparseable time denies', () => {
  const day = { now: bratislava('10:00') };
  for (const t of ['99:99', '24:00', '23:60', '7', 'noon', '', '10:00:00', '-1:30']) {
    deniedByClock(policy.decide({ ...B, localTime: t }, CONFIG, day), /not a valid HH:MM/);
  }
  assert.throws(() => policy.inQuietHours('99:99', CONFIG.quietHours), /bad time/);
  assert.throws(() => policy.inQuietHours('10:00', { start: '25:00', end: '06:00' }), /bad time/);
});

test('OS-POL-02: the trusted clock decides; a worker-supplied localTime can only make the result stricter', () => {
  deniedByClock(policy.decide({ ...B, localTime: '10:00' }, CONFIG, { now: bratislava('00:30', '2026-10-08') }), /quiet hours 00:00-06:00/);
  deniedByClock(policy.decide({ ...B, localTime: '00:30' }, CONFIG, { now: bratislava('10:00') }), /worker-supplied local time 00:30/);
  notDeniedByClock(policy.decide(B, CONFIG, { now: bratislava('10:00') }));
});

test('OS-POL-02: missing or invalid clock configuration denies every external action, internal work is unaffected', () => {
  const day = { now: bratislava('10:00') };
  for (const timezone of ['Mars/Olympus', '', '   ', '+02:00', undefined]) {
    deniedByClock(policy.decide(B, { ...CONFIG, timezone } as unknown as PolicyConfig, day), /timezone/);
  }
  deniedByClock(policy.decide(B, { ...CONFIG, quietHours: { start: '25:00', end: '06:00' } }, day), /quiet hours configuration/);
  deniedByClock(policy.decide(B, { ...CONFIG, quietHours: undefined } as unknown as PolicyConfig, day), /quiet hours configuration/);
  deniedByClock(policy.decide(B, CONFIG, { now: new Date('not a date') }), /trusted clock reading is invalid/);
  const broken = { ...CONFIG, timezone: 'Mars/Olympus' } as PolicyConfig;
  assert.equal(policy.decide({ category: 'draft', level: 'L1', external: false }, broken).decision, 'allow');
});

test('OS-POL-02: overnight window 22:00-06:00 is read on the trusted clock', () => {
  const cfg: PolicyConfig = { ...CONFIG, quietHours: { start: '22:00', end: '06:00' } };
  const at = (hhmm: string, date: string) => policy.decide(B, cfg, { now: bratislava(hhmm, date) });
  notDeniedByClock(at('21:59', '2026-10-07'));
  deniedByClock(at('22:00', '2026-10-07'), /quiet hours 22:00-06:00/);
  deniedByClock(at('23:30', '2026-10-07'), /quiet hours/);
  deniedByClock(at('00:00', '2026-10-08'), /quiet hours/);
  deniedByClock(at('05:59', '2026-10-08'), /quiet hours/);
  notDeniedByClock(at('06:00', '2026-10-08'));
  // The default window starts at midnight.
  notDeniedByClock(policy.decide(B, CONFIG, { now: bratislava('23:59') }));
  deniedByClock(policy.decide(B, CONFIG, { now: bratislava('00:00', '2026-10-08') }), /quiet hours 00:00-06:00/);
});

test('OS-POL-02: DST boundary dates read Europe/Bratislava local time, not a fixed offset', () => {
  const at = (iso: string) => policy.decide(B, CONFIG, { now: new Date(iso) });
  // 25 October 2026: clocks go back from 03:00 CEST to 02:00 CET.
  notDeniedByClock(at('2026-10-24T21:59:00Z')); // 23:59 CEST
  deniedByClock(at('2026-10-24T22:30:00Z'), /quiet hours/); // 00:30 CEST
  deniedByClock(at('2026-10-25T04:30:00Z'), /quiet hours/); // 05:30 CET; a fixed +02:00 offset would read 06:30 and let it pass
  notDeniedByClock(at('2026-10-25T05:00:00Z')); // 06:00 CET
  // 29 March 2026: clocks go forward from 02:00 CET to 03:00 CEST.
  deniedByClock(at('2026-03-29T03:59:00Z'), /quiet hours/); // 05:59 CEST
  notDeniedByClock(at('2026-03-29T04:00:00Z')); // 06:00 CEST; a fixed +01:00 offset would read 05:00 and deny
  assert.deepEqual(policy.localClock(new Date('2026-10-25T04:30:00Z'), 'Europe/Bratislava'), { date: '2026-10-25', time: '05:30' });
  assert.deepEqual(policy.localClock(new Date('2026-03-29T01:00:00Z'), 'Europe/Bratislava'), { date: '2026-03-29', time: '03:00' });
});

test('OS-POL-02: dispatch-time recheck: approved at 23:50, dispatched at 00:10 is denied', () => {
  const quote: ProposedAction = { category: 'customer_quote', level: 'L2', external: true };
  assert.equal(policy.decide(quote, CONFIG, { now: bratislava('23:40') }).decision, 'ask');
  const approval = { status: 'approved' as const, decidedAt: bratislava('23:50').toISOString() };
  // Positive control: dispatched before midnight, the approved send goes.
  assert.equal(policy.recheckAtDispatch(quote, approval, CONFIG, { now: bratislava('23:55') }).decision, 'allow');
  // Dispatched after midnight: denied, the approval does not carry the send into quiet hours.
  deniedByClock(policy.recheckAtDispatch(quote, approval, CONFIG, { now: bratislava('00:10', '2026-10-08') }), /quiet hours/);
  // An action the policy did not deny at 23:50 is denied when it is dispatched at 00:10.
  notDeniedByClock(policy.decide(B, CONFIG, { now: bratislava('23:50') }));
  deniedByClock(policy.recheckAtDispatch(B, undefined, CONFIG, { now: bratislava('00:10', '2026-10-08') }), /quiet hours/);
  // Pending stays ask, a rejection is a deny, and a dispatch without a clock reading is denied.
  assert.equal(policy.recheckAtDispatch(quote, { status: 'pending' }, CONFIG, { now: bratislava('23:55') }).decision, 'ask');
  assert.equal(policy.recheckAtDispatch(quote, { status: 'rejected' }, CONFIG, { now: bratislava('23:55') }).decision, 'deny');
  deniedByClock(policy.recheckAtDispatch(quote, approval, CONFIG, {}), /no trusted clock/);
});

test('OS-POL-02: the policy never reads the system clock, only the reading the caller passes', (t) => {
  const day = bratislava('10:00');
  const night = bratislava('00:30', '2026-10-08');
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-07T22:30:00Z') }); // system clock: 00:30 in Bratislava
  notDeniedByClock(policy.decide(B, CONFIG, { now: day }));
  t.mock.timers.setTime(Date.parse('2026-10-07T08:00:00Z')); // system clock: 10:00 in Bratislava
  deniedByClock(policy.decide(B, CONFIG, { now: night }), /quiet hours/);
});
