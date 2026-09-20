/** Control-only reasoning evidence shared by the coverage producer and asserter. */
export const normalizeReasoningModel = (id) => String(id ?? '').trim().replace(/^openrouter\//, '');

/**
 * Canonical form of one map entry, mirroring elek's `canonicalReasoningConfig` exactly: a bare
 * mode string when unbudgeted, `{ mode, max_tokens }` (those two keys, that order) when budgeted.
 * Undefined means "not a valid entry". Extra or misspelt keys are invalid — `max_token` must not
 * silently mean "no budget".
 */
export function canonicalReasoningConfig(raw) {
  if (raw === 'effort' || raw === 'enabled') return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (Object.keys(raw).sort().join(',') !== 'max_tokens,mode') return undefined;
  const { mode, max_tokens } = raw;
  if (mode !== 'effort' && mode !== 'enabled') return undefined;
  if (!Number.isSafeInteger(max_tokens) || max_tokens <= 0) return undefined;
  return { mode, max_tokens };
}

export function readReasoningModes(raw = '') {
  if (!String(raw).trim()) return {};
  const value = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid reasoning mode map');
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    const id = normalizeReasoningModel(key);
    const config = canonicalReasoningConfig(entry);
    if (!/^[a-z0-9~][a-z0-9._~-]*\/[a-z0-9][a-z0-9._:-]*$/.test(id) || config === undefined ||
      (Object.hasOwn(result, id) && JSON.stringify(result[id]) !== JSON.stringify(config))) {
      throw new Error('invalid reasoning mode map');
    }
    result[id] = config;
  }
  return result;
}

/** The control a model is configured with: `{ mode, maxTokens? }`. Unlisted models are `effort`. */
export function configuredControl(map, modelId) {
  const config = map[normalizeReasoningModel(modelId)];
  if (config === undefined) return { mode: 'effort' };
  if (typeof config === 'string') return { mode: config };
  return { mode: config.mode, maxTokens: config.max_tokens };
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
      const expected = configuredControl(configured, model);
      if (!r || r.configuredMode !== expected.mode) {
        problems.push(`missing or inconsistent reasoning telemetry in ${kind}`);
        continue;
      }
      if (expected.maxTokens !== undefined) {
        // A configured budget must be VISIBLE in what was sent: control `max-tokens` with that
        // exact number. `provider-default` here means the cap was configured and not applied —
        // the gap between "we set a budget" and "the model ran unbounded" is the whole point.
        if (r.effectiveControl !== 'max-tokens' || r.maxTokens !== expected.maxTokens) {
          problems.push(`configured reasoning budget not applied in ${kind}`);
        }
      } else if (expected.mode === 'enabled' && r.effectiveControl === 'provider-default' && !r.adapted) {
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
