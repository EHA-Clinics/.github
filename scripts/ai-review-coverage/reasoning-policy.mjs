/** Control-only reasoning evidence shared by the coverage producer and asserter. */
export const normalizeReasoningModel = (id) => String(id ?? '').trim().replace(/^openrouter\//, '');

export function readReasoningModes(raw = '') {
  if (!String(raw).trim()) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid reasoning mode map');
  const result = {};
  for (const [key, mode] of Object.entries(value)) {
    const id = normalizeReasoningModel(key);
    if (!/^[a-z0-9~][a-z0-9._~-]*\/[a-z0-9][a-z0-9._:-]*$/.test(id) ||
      !['effort', 'enabled'].includes(mode) || (Object.hasOwn(result, id) && result[id] !== mode)) {
      throw new Error('invalid reasoning mode map');
    }
    result[id] = mode;
  }
  return result;
}

export function sanitizeReasoning(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const levels = ['off', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  if (!levels.includes(raw.requestedThinking) || !levels.includes(raw.piThinking) ||
    !['effort', 'enabled'].includes(raw.configuredMode) ||
    !['off', 'named-effort', 'provider-default', 'max-tokens'].includes(raw.effectiveControl) ||
    typeof raw.adapted !== 'boolean') return null;
  const control = raw.effectiveControl;
  if (control === 'named-effort' && (!levels.includes(raw.effort) || raw.maxTokens !== undefined)) return null;
  if (control === 'max-tokens' && (!Number.isSafeInteger(raw.maxTokens) || raw.maxTokens <= 0 || raw.effort !== undefined)) return null;
  if (['off', 'provider-default'].includes(control) && (raw.effort !== undefined || raw.maxTokens !== undefined)) return null;
  if (raw.configuredMode === 'enabled' && control === 'named-effort') return null;
  if (control === 'off' && raw.piThinking !== 'off' && raw.requestedThinking !== 'off') return null;
  return {
    requestedThinking: raw.requestedThinking, piThinking: raw.piThinking,
    configuredMode: raw.configuredMode, effectiveControl: control, adapted: raw.adapted,
    ...(control === 'named-effort' ? { effort: raw.effort } : {}),
    ...(control === 'max-tokens' ? { maxTokens: raw.maxTokens } : {}),
  };
}

export function reasoningProblems(models, configuredRaw) {
  let recorded;
  let configured;
  try {
    recorded = readReasoningModes(JSON.stringify(models?.configured?.reasoning_modes === undefined ? {} : models.configured.reasoning_modes));
    configured = configuredRaw === undefined ? recorded : readReasoningModes(configuredRaw);
  } catch { return ['invalid reasoning mode configuration']; }
  const stable = (map) => JSON.stringify(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
  if (models?.configured?.reasoning_mode_error || stable(recorded) !== stable(configured)) {
    return ['producer/gate reasoning mode configuration mismatch'];
  }
  const required = Object.keys(configured).length > 0;
  const problems = [];
  for (const [kind, records] of [['logical runs', models?.runs], ['physical attempts', models?.attempts]]) {
    if (required && (!Array.isArray(records) || records.length === 0)) {
      problems.push(`reasoning telemetry missing for ${kind}`);
      continue;
    }
    for (const record of records ?? []) {
      if (!required && record.reasoning === undefined) continue;
      const r = sanitizeReasoning(record.reasoning);
      const model = normalizeReasoningModel(record.actual_model_label ?? record.model_label ?? record.actual_model);
      const expected = configured[model] ?? 'effort';
      if (!r || r.configuredMode !== expected ||
        (expected === 'enabled' && r.effectiveControl === 'provider-default' && !r.adapted)) {
        problems.push(`missing or inconsistent reasoning telemetry in ${kind}`);
      }
    }
  }
  return [...new Set(problems)];
}

export function formatReasoning(raw) {
  const r = sanitizeReasoning(raw);
  if (!r) return 'unreported';
  return `requested=${r.requestedThinking}; configuredMode=${r.configuredMode}; effectiveControl=${r.effectiveControl}` +
    (r.effort ? `; effort=${r.effort}` : '') + (r.maxTokens !== undefined ? `; maxTokens=${r.maxTokens}` : '');
}
