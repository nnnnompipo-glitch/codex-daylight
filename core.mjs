/** Pure scheduling and quota policy; this module never starts a model request. */
export const defaultSettings = Object.freeze({
  enabled: false,
  times: Object.freeze(['08:00', '13:00', '18:00']),
  activeStart: '07:00',
  activeEnd: '23:00',
  pollSeconds: 60,
  model: ''
});

const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const minuteOfDay = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const pad = value => String(value).padStart(2, '0');
const localDate = value => `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;

function instant(value) {
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) throw new Error('时间无效。');
  return result;
}

function validTime(value, name) {
  if (typeof value !== 'string' || !timePattern.test(value.trim())) {
    throw new Error(`${name}必须使用 HH:mm 格式，例如 08:00。`);
  }
  return value.trim();
}

/** Missing fields use defaults; unrecognized fields are not persisted. */
export function validateSettings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('设置格式无效。');
  const settings = { ...defaultSettings, ...input };
  if (typeof settings.enabled !== 'boolean') throw new Error('启用计划必须为开或关。');
  const activeStart = validTime(settings.activeStart, '开始时间');
  const activeEnd = validTime(settings.activeEnd, '结束时间');
  if (activeStart >= activeEnd) throw new Error('开始时间必须早于结束时间，暂不支持跨夜时段。');
  if (!Array.isArray(settings.times) || settings.times.length === 0 || settings.times.length > 128) {
    throw new Error('请填写 1 至 12 个每日激活时间。');
  }
  const times = [...new Set(settings.times.map(value => validTime(value, '激活时间')))].sort();
  if (times.length > 12) throw new Error('每日最多设置 12 个不同的激活时间。');
  if (times.some(value => value < activeStart || value >= activeEnd)) {
    throw new Error('激活时间必须在允许时段内，且早于结束时间。');
  }
  if (!Number.isInteger(settings.pollSeconds) || settings.pollSeconds < 30 || settings.pollSeconds > 600) {
    throw new Error('同步间隔必须为 30 至 600 秒的整数。');
  }
  if (typeof settings.model !== 'string' || settings.model.trim().length > 100 || /[\x00-\x1f\x7f]/.test(settings.model)) {
    throw new Error('模型名称必须为最多 100 字的单行文本。');
  }
  return { enabled: settings.enabled, times, activeStart, activeEnd, pollSeconds: settings.pollSeconds, model: settings.model.trim() };
}

function normalizeWindow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const usedPercent = typeof value.usedPercent === 'number' && Number.isFinite(value.usedPercent) && value.usedPercent >= 0 && value.usedPercent <= 100
    ? value.usedPercent : null;
  const windowDurationMins = Number.isInteger(value.windowDurationMins) && value.windowDurationMins > 0
    ? value.windowDurationMins : null;
  const resetsAt = Number.isInteger(value.resetsAt) && value.resetsAt > 0 && value.resetsAt <= 8_640_000_000_000
    ? value.resetsAt : null;
  return { usedPercent, remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent), windowDurationMins, resetsAt };
}

/** Return null rather than displaying an unrelated metering bucket as Codex. */
export function normalizeQuota(result, now = Date.now()) {
  const fromMap = result?.rateLimitsByLimitId?.codex;
  const single = result?.rateLimits;
  // This RPC's legacy single bucket predates limitId. An explicit other ID is never Codex.
  const legacy = single && typeof single === 'object' && !Array.isArray(single)
    && (single.limitId == null || single.limitId === 'codex') ? single : null;
  const bucket = fromMap && typeof fromMap === 'object' && !Array.isArray(fromMap)
    ? fromMap : legacy;
  if (!bucket) return null;
  const primary = normalizeWindow(bucket.primary);
  const secondary = normalizeWindow(bucket.secondary);
  return {
    fetchedAt: instant(now).toISOString(),
    bucketId: 'codex',
    primary,
    secondary,
    fiveHour: [primary, secondary].find(value => value?.windowDurationMins === 300) ?? null,
    planType: typeof bucket.planType === 'string' ? bucket.planType : null,
    rateLimitReachedType: typeof bucket.rateLimitReachedType === 'string' && bucket.rateLimitReachedType.trim()
      ? bucket.rateLimitReachedType.trim() : null,
    stale: false
  };
}

function slotFor(date, time) {
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Number(time.slice(0, 2)), Number(time.slice(3)), 0, 0);
  const day = localDate(at);
  return { at: at.toISOString(), time, label: `${day} ${time}`, key: `${day}/${time}` };
}

/** Plan dates in the computer's local timezone, never by adding fixed 24h durations. */
export function computeNextActivation(settings, now = Date.now(), completedKeys = []) {
  const config = validateSettings(settings);
  if (!config.enabled) return null;
  const current = instant(now);
  const completed = new Set(completedKeys);
  for (let offset = 0; offset < 7; offset++) {
    const day = new Date(current.getFullYear(), current.getMonth(), current.getDate() + offset, 12);
    for (const time of config.times) {
      const slot = slotFor(day, time);
      if (new Date(slot.at).getTime() >= current.getTime() && !completed.has(slot.key)) return slot;
    }
  }
  return null;
}

/** At most the latest due slot is returned, so waking from sleep cannot produce a burst. */
export function dueActivations(settings, now = Date.now(), completedKeys = [], graceMs = 120_000) {
  const config = validateSettings(settings);
  if (!config.enabled) return [];
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new Error('激活宽限时间无效。');
  const current = instant(now);
  const minute = current.getHours() * 60 + current.getMinutes();
  if (minute < minuteOfDay(config.activeStart) || minute >= minuteOfDay(config.activeEnd)) return [];
  const due = config.times.map(time => slotFor(current, time)).filter(slot => {
    const elapsed = current.getTime() - new Date(slot.at).getTime();
    return elapsed >= 0 && elapsed <= graceMs;
  });
  const latest = due.at(-1);
  return latest && !new Set(completedKeys).has(latest.key) ? [latest] : [];
}

/** A trigger can start a small request, but cannot promise to move a service reset. */
export function activationDecision(quota, settings, now = Date.now()) {
  const config = validateSettings(settings);
  const current = instant(now);
  const minute = current.getHours() * 60 + current.getMinutes();
  if (minute < minuteOfDay(config.activeStart) || minute >= minuteOfDay(config.activeEnd)) {
    return { allow: false, reason: '不在允许激活的时间段内。' };
  }
  if (!quota || quota.bucketId !== 'codex') return { allow: false, reason: '尚未读取到 Codex 额度，请先刷新。' };
  const fetched = new Date(quota.fetchedAt).getTime();
  if (quota.stale || !Number.isFinite(fetched) || current.getTime() - fetched > 120_000 || fetched - current.getTime() > 5_000) {
    return { allow: false, reason: '额度信息已过期或时间有偏差，请先刷新。' };
  }
  if (quota.rateLimitReachedType != null && quota.rateLimitReachedType !== '') {
    return { allow: false, reason: '服务端已报告达到用量限制，等待实际额度恢复。' };
  }
  const windows = [quota.primary, quota.secondary].filter(Boolean);
  const fiveHour = windows.find(value => value.windowDurationMins === 300);
  if (!fiveHour) return { allow: false, reason: '未识别到五小时额度窗口，暂不自动激活。' };
  if (windows.some(value => value.usedPercent === null || !Number.isFinite(value.usedPercent) || value.usedPercent < 0 || value.usedPercent > 100)) {
    return { allow: false, reason: '额度用量信息不完整，请先刷新。' };
  }
  if (windows.some(value => value.usedPercent >= 100)) return { allow: false, reason: '五小时或其他共享额度已用尽，等待服务端恢复。' };
  if (fiveHour.usedPercent > 0) return { allow: false, reason: '当前五小时窗口已在使用，无需额外消耗额度激活。' };
  // A fresh zero usage report permits one new request even if the service has not supplied
  // the next window's reset timestamp. Do not infer or promise that timestamp here.
  return { allow: true, reason: '用量为零，可发送一次轻量请求；实际恢复时间以服务端更新为准。' };
}
