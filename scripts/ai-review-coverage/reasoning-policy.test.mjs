import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { deriveModels, renderJobSummary } from './measure-review-coverage.mjs';
import { evaluate } from './assert-review-coverage.mjs';
import { canonicalReasoningConfig, configuredControl, readReasoningModes } from './reasoning-policy.mjs';

const MIMO = 'xiaomi/mimo-v2.5-pro';
const env = { OPENROUTER_MODEL_REASONING_MODES: JSON.stringify({ [MIMO]: 'enabled' }) };
const reasoning = { requestedThinking: 'high', piThinking: 'high', configuredMode: 'enabled', effectiveControl: 'provider-default', adapted: true };
const healthy = () => JSON.parse(readFileSync(new URL('./fixtures/council/healthy-council.json', import.meta.url), 'utf8'));

describe('reasoning compatibility coverage', () => {
  it('preserves sanitized logical and physical request telemetry', () => {
    const models = deriveModels({ modelRuns: [{ role: 'reviewer', modelLabel: MIMO, reasoning: { ...reasoning, rawReasoning: 'do not publish' } }], attempts: [{ actualModel: MIMO, reasoning }] }, env);
    expect(models.runs[0].reasoning).toEqual(reasoning);
    expect(models.attempts[0].reasoning).toEqual(reasoning);
    expect(models.configured.reasoning_modes).toEqual({ [MIMO]: 'enabled' });
    expect(JSON.stringify(models)).not.toContain('do not publish');
  });

  it('keeps legacy evidence parseable without an override', () => {
    expect(evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(healthy()), env: {} }).exitCode).toBe(0);
  });

  it('rejects a configured override with missing telemetry even if the producer claims COMPLETE', () => {
    const coverage = healthy();
    coverage.models.configured.reasoning_modes = { [MIMO]: 'enabled' };
    coverage.models.runs[0].model_label = MIMO;
    coverage.models.runs[0].actual_model_label = MIMO;
    const result = evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(coverage), env });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('U9');
  });
});

const current = () => JSON.parse(readFileSync(new URL('./fixtures/council/mimo-reasoning-complete.json', import.meta.url), 'utf8'));

describe('reasoning gate positive and negative controls', () => {
  it('passes complete new evidence and renders the effective control', () => {
    const coverage = current();
    expect(evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(coverage), env }).exitCode).toBe(0);
    expect(renderJobSummary(coverage)).toContain('configuredMode=enabled; effectiveControl=provider-default');
  });

  it.each(['[]', '{', '{"xiaomi/mimo-v2.5-pro":"high"}', '{"":"enabled"}'])('rejects invalid configured map %s', (raw) => {
    const result = evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(current()), env: { OPENROUTER_MODEL_REASONING_MODES: raw } });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('U9');
  });

  it('rejects a wrong MiMo control and missing attempt telemetry', () => {
    for (const mutate of [
      (c) => { c.models.runs[1].reasoning = { ...reasoning, effectiveControl: 'named-effort', effort: 'high' }; },
      (c) => { delete c.models.attempts[1].reasoning; },
      (c) => { c.models.attempts = null; },
      (c) => { delete c.models.configured.reasoning_modes; },
    ]) {
      const coverage = current(); mutate(coverage);
      expect(evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(coverage), env }).exitCode).toBe(1);
    }
  });

  it('compares failover telemetry against the actual replacement model', () => {
    const coverage = current();
    const r = coverage.models.runs[1];
    r.actual_model_label = r.model_label = 'openrouter/deepseek/deepseek-v4-pro';
    r.failover_used = true;
    r.reasoning = { ...reasoning, configuredMode: 'effort', effectiveControl: 'named-effort', effort: 'high', adapted: false };
    const second = { ...coverage.models.attempts[1], actual_model: r.actual_model_label, attempt: 2, failover: true, reasoning: r.reasoning };
    coverage.models.attempts.push(second);
    expect(evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(coverage), env }).exitCode).toBe(0);
    second.reasoning = reasoning;
    expect(evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(coverage), env }).exitCode).toBe(1);
  });
});

const CAPPED_MAP = { [MIMO]: { mode: 'enabled', max_tokens: 12000 } };
const cappedEnv = { OPENROUTER_MODEL_REASONING_MODES: JSON.stringify(CAPPED_MAP) };
const capped = () => JSON.parse(readFileSync(new URL('./fixtures/council/mimo-reasoning-capped.json', import.meta.url), 'utf8'));

describe('per-model reasoning budget — the gate mirrors elek\'s map schema exactly', () => {
  it('parses the object form to the same canonical shape elek produces, and rejects what elek rejects', () => {
    expect(readReasoningModes(JSON.stringify(CAPPED_MAP))).toEqual(CAPPED_MAP);
    expect(readReasoningModes(JSON.stringify({ ['openrouter/' + MIMO]: CAPPED_MAP[MIMO] }))).toEqual(CAPPED_MAP);
    expect(configuredControl(CAPPED_MAP, 'openrouter/' + MIMO)).toEqual({ mode: 'enabled', maxTokens: 12000 });
    expect(configuredControl(CAPPED_MAP, 'z-ai/glm-5.3-flash')).toEqual({ mode: 'effort' });
    expect(canonicalReasoningConfig('effort')).toBe('effort');
    for (const bad of [
      { mode: 'enabled' }, { max_tokens: 10 }, { mode: 'enabled', max_tokens: 0 }, { mode: 'enabled', max_tokens: -5 },
      { mode: 'enabled', max_tokens: 1.5 }, { mode: 'enabled', max_tokens: '10' }, { mode: 'enabled', max_token: 10 },
      { mode: 'enabled', max_tokens: 10, extra: 1 }, { mode: 'high', max_tokens: 10 }, [], null, 'high',
    ]) {
      expect(canonicalReasoningConfig(bad), JSON.stringify(bad)).toBeUndefined();
      expect(() => readReasoningModes(JSON.stringify({ [MIMO]: bad }))).toThrow(/invalid reasoning mode map/);
    }
    // Same model spelled two ways with DIFFERENT budgets is a conflict; with the same budget it is not.
    expect(() => readReasoningModes(JSON.stringify({ [MIMO]: CAPPED_MAP[MIMO], ['openrouter/' + MIMO]: { mode: 'enabled', max_tokens: 1 } }))).toThrow();
    expect(readReasoningModes(JSON.stringify({ [MIMO]: CAPPED_MAP[MIMO], ['openrouter/' + MIMO]: CAPPED_MAP[MIMO] }))).toEqual(CAPPED_MAP);
  });

  it('passes a capped MiMo whose telemetry shows the cap, and renders it', () => {
    const coverage = capped();
    expect(evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(coverage), env: cappedEnv }).exitCode).toBe(0);
    expect(renderJobSummary(coverage)).toContain('configuredMode=enabled; effectiveControl=max-tokens; maxTokens=12000');
  });

  it('fails U9 when a budget is configured but the run reports provider-default — the cap was not applied', () => {
    const coverage = capped();
    coverage.models.runs[1].reasoning = { ...reasoning }; // provider-default, adapted
    const result = evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(coverage), env: cappedEnv });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toMatch(/U9 .*configured reasoning budget not applied/);
  });

  it('fails U9 when the applied budget differs from the configured one', () => {
    const coverage = capped();
    coverage.models.attempts[1].reasoning = { ...coverage.models.attempts[1].reasoning, maxTokens: 4096 };
    const result = evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(coverage), env: cappedEnv });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('configured reasoning budget not applied');
  });

  it('fails U9 on a producer/gate mismatch between a budgeted and an unbudgeted map', () => {
    // The record was produced under the capped map; the gate is handed the plain one.
    const result = evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(capped()), env });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join('\n')).toContain('producer/gate reasoning mode configuration mismatch');
  });

  it('still accepts the unbudgeted map and its provider-default evidence unchanged', () => {
    expect(evaluate({ reviewResult: 'success', coverageRaw: JSON.stringify(current()), env }).exitCode).toBe(0);
  });
});
