// Percentages are consumption, never remaining allowance. Missing readings do
// not become zero; a stopped connection cannot make an old report look live.
export function limitInfo(limits, { connected = true, now = Date.now() } = {}) {
  const windows = (Array.isArray(limits?.windows) ? limits.windows : []).filter(w => w && [300, 10080].includes(w.minutes) && typeof w.usedPercentage === 'number' && Number.isFinite(w.usedPercentage) && w.usedPercentage >= 0 && w.usedPercentage <= 100)
  const observedAt = typeof limits?.observedAt === 'number' && Number.isFinite(limits.observedAt) && limits.observedAt > 0 && limits.observedAt <= now + 60_000 ? limits.observedAt : null
  return { windows, observedAt, source: ['usagebar', 'statusline'].includes(limits?.source) ? limits.source : 'unknown',
    stale: !connected || !!limits?.stale || !observedAt || now - observedAt > 30 * 60_000 }
}
