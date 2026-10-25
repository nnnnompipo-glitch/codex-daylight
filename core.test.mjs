import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultSettings, validateSettings, normalizeQuota, computeNextActivation, dueActivations, activationDecision } from './core.mjs';

const at = (day, hour, minute, second = 0) => new Date(2026, 9, day, hour, minute, second).getTime();
const config = overrides => validateSettings({ ...defaultSettings, enabled: true, ...overrides });
const quota = (now, primary = {}, secondary = null) => normalizeQuota({ rateLimits: {
  limitId: 'codex',
  primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(now / 1_000) + 3_600, ...primary },
  secondary
} }, now);

test('settings use safe defaults and canonicalize times without inventing enabled state', () => {
  assert.equal(validateSettings({}).enabled, false);
  assert.deepEqual(config({ times: ['18:00', '08:00', '08:00', '13:00'] }).times, ['08:00', '13:00', '18:00']);
  assert.deepEqual(defaultSettings.times, ['08:00', '13:00', '18:00']);
  assert.equal(Object.hasOwn(validateSettings({ unknown: 'ignored' }), 'unknown'), false);
});

test('settings reject invalid clocks, overnight windows, out-of-window slots and unsafe polling', () => {
  for (const input of [
    { enabled: 'true' }, { times: ['8:00'] }, { times: ['24:00'] }, { times: [] },
    { activeStart: '23:00', activeEnd: '07:00' }, { times: ['23:00'] },
    { times: Array.from({ length: 13 }, (_, i) => `08:${String(i).padStart(2, '0')}`) },
    { pollSeconds: 29 }, { pollSeconds: 601 }, { pollSeconds: 30.5 }, { model: 'x'.repeat(101) }
  ]) assert.throws(() => config(input), Error);
});

test('Codex map bucket takes precedence and unrelated buckets are never substituted', () => {
  const now = at(25, 8, 0);
  const result = normalizeQuota({
    rateLimits: { limitId: 'codex', primary: { usedPercent: 90 } },
    rateLimitsByLimitId: { codex: { primary: { usedPercent: 20 } }, image: { primary: { usedPercent: 0 } } }
  }, now);
  assert.equal(result.primary.usedPercent, 20);
  assert.equal(result.primary.remainingPercent, 80);
  assert.equal(normalizeQuota({ rateLimits: { limitId: 'image' } }, now), null);
  assert.equal(normalizeQuota({ rateLimitsByLimitId: { image: {} } }, now), null);
});

test('legacy single-bucket responses without limitId remain readable while explicit other IDs are rejected', () => {
  const now = at(25, 8, 0);
  const value = normalizeQuota({ rateLimits: { primary: { usedPercent: 0, windowDurationMins: 300 } } }, now);
  assert.equal(value.bucketId, 'codex');
  assert.equal(value.fiveHour.usedPercent, 0);
  assert.equal(normalizeQuota({ rateLimits: { limitId: 'images', primary: { usedPercent: 0, windowDurationMins: 300 } } }, now), null);
});

test('unknown and malformed quota values remain unknown rather than becoming zero', () => {
  const now = at(25, 8, 0);
  const result = quota(now, { usedPercent: null, windowDurationMins: undefined, resetsAt: '123' });
  assert.deepEqual(result.primary, { usedPercent: null, remainingPercent: null, windowDurationMins: null, resetsAt: null });
  assert.equal(result.fiveHour, null);
  assert.equal(quota(now, { usedPercent: 101 }).primary.usedPercent, null);
  assert.equal(quota(now, { usedPercent: NaN }).primary.usedPercent, null);
  assert.equal(quota(now, { resetsAt: 0 }).primary.resetsAt, null);
  assert.equal(quota(now, { usedPercent: 12.5 }).primary.remainingPercent, 87.5);
});

test('next activation follows local calendar across midnight and skips completed slots', () => {
  const settings = config({ times: ['08:00', '13:00'] });
  const next = computeNextActivation(settings, at(25, 23, 59));
  assert.equal(next.key, '2026-10-26/08:00');
  assert.equal(new Date(next.at).getTime(), at(26, 8, 0));
  assert.equal(computeNextActivation(settings, at(25, 8, 0), ['2026-10-25/08:00']).key, '2026-10-25/13:00');
  assert.equal(computeNextActivation({ ...settings, enabled: false }, at(25, 8, 0)), null);
});

test('due slots do not replay after a missed wakeup or repeat within the same minute', () => {
  const settings = config({ times: ['08:00', '13:00'] });
  assert.equal(dueActivations(settings, at(25, 8, 0, 30)).length, 1);
  assert.deepEqual(dueActivations(settings, at(25, 8, 0, 50), ['2026-10-25/08:00']), []);
  assert.deepEqual(dueActivations(settings, at(25, 8, 3)), []);
  assert.deepEqual(dueActivations(settings, at(25, 23, 0)), []);
  assert.deepEqual(dueActivations({ ...settings, enabled: false }, at(25, 8, 0)), []);
});

test('waking up near multiple slots considers only the latest, never an older completed backlog', () => {
  const settings = config({ times: ['08:00', '08:01'] });
  assert.deepEqual(dueActivations(settings, at(25, 8, 1, 30)).map(value => value.time), ['08:01']);
  assert.deepEqual(dueActivations(settings, at(25, 8, 1, 30), ['2026-10-25/08:01']), []);
});

test('activation is allowed only with a fresh known unused five-hour window', () => {
  const now = at(25, 8, 0);
  const settings = config();
  assert.equal(activationDecision(quota(now), settings, now).allow, true);
  assert.equal(activationDecision(quota(now), { ...settings, enabled: false }, now).allow, true, 'manual trigger can run while schedule is paused');
  for (const value of [null, { ...quota(now), stale: true }, { ...quota(now), fetchedAt: new Date(now - 120_001).toISOString() },
    { ...quota(now), fetchedAt: new Date(now + 60_000).toISOString() }, quota(now, { usedPercent: null }),
    quota(now, { windowDurationMins: 60 })
  ]) assert.equal(activationDecision(value, settings, now).allow, false);
});

test('fresh zero usage permits a new request without inventing a missing or expired reset timestamp', () => {
  const now = at(25, 8, 0);
  for (const resetsAt of [null, undefined, 'invalid', Math.floor(now / 1_000), Math.floor(now / 1_000) - 3_600]) {
    const value = quota(now, { resetsAt });
    assert.equal(activationDecision(value, config(), now).allow, true);
    assert.equal(value.primary.resetsAt, typeof resetsAt === 'number' ? resetsAt : null);
    assert.equal(activationDecision(quota(now, { usedPercent: 1, resetsAt }), config(), now).allow, false);
  }
});

test('an explicit server limit classification blocks inference even when reported usage is zero', () => {
  const now = at(25, 8, 0);
  const value = normalizeQuota({ rateLimits: {
    limitId: 'codex', rateLimitReachedType: '  weekly  ',
    primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: null }
  } }, now);
  assert.equal(value.rateLimitReachedType, 'weekly');
  assert.equal(activationDecision(value, config(), now).allow, false);
  assert.match(activationDecision(value, config(), now).reason, /服务端/);
  for (const rateLimitReachedType of [null, undefined, '', '  ', { unexpected: 'raw' }]) {
    assert.equal(normalizeQuota({ rateLimits: { limitId: 'codex', rateLimitReachedType } }, now).rateLimitReachedType, null);
  }
});

test('a five-hour window may be secondary rather than primary', () => {
  const now = at(25, 8, 0);
  const value = quota(now,
    { usedPercent: 20, windowDurationMins: 10_080 },
    { usedPercent: 0, windowDurationMins: 300, resetsAt: Math.floor(now / 1_000) + 3_600 });
  assert.equal(value.fiveHour, value.secondary);
  assert.equal(activationDecision(value, config(), now).allow, true);
});

test('used windows skip extra activation and a depleted weekly window blocks it', () => {
  const now = at(25, 8, 0);
  const settings = config();
  assert.match(activationDecision(quota(now, { usedPercent: 5 }), settings, now).reason, /已在使用/);
  const result = quota(now, {}, { usedPercent: 100, windowDurationMins: 10_080, resetsAt: Math.floor(now / 1_000) + 86_400 });
  assert.equal(activationDecision(result, settings, now).allow, false);
  assert.match(activationDecision(result, settings, now).reason, /已用尽/);
  assert.equal(activationDecision(quota(now, {}, { windowDurationMins: 10_080 }), settings, now).allow, false);
});

test('quiet hours are respected for manual activation as well', () => {
  const now = at(25, 23, 0);
  assert.match(activationDecision(quota(now), config(), now).reason, /不在允许/);
});
