import { isRecord } from './managementApi';
import type { DashboardRequest } from './dashboardActivity';
import { modelMatchesRule } from './oauthModels';

export type ConfiguredModel = { model: string; alias?: string };
/** Show explicit, unconditional overrides only; a model's name is not reasoning evidence. */
export function explicitReasoning(payload: unknown, model: ConfiguredModel): string | null {
  if (!isRecord(payload) || !Array.isArray(payload.override)) return null;
  let value: string | null = null;
  for (const rule of payload.override) {
    if (!isRecord(rule) || !Array.isArray(rule.models) || !isRecord(rule.params)) continue;
    const matches = rule.models.filter(m => isRecord(m) && typeof m.name === 'string'
      && [model.model, model.alias].some(name => name && modelMatchesRule(name, m.name as string)));
    if (!matches.length) continue;
    if (matches.some(m => !isRecord(m) || Object.keys(m).some(k => !['name', 'protocol'].includes(k)))
      || Object.keys(rule).some(k => !['models', 'params'].includes(k))) return null;
    const config = rule.params['generationConfig.thinkingConfig'];
    const candidate = isRecord(config) ? config.thinkingLevel : rule.params['generationConfig.thinkingConfig.thinkingLevel'] ?? rule.params.reasoning_effort;
    if (candidate !== undefined) value = typeof candidate === 'string' && /^(minimal|low|medium|high|xhigh|max|auto|none)$/.test(candidate) ? candidate : null;
  }
  // Conditional/raw/filter rules can change the result; don't pretend to resolve them here.
  if (['override-raw', 'filter'].some(k => Array.isArray(payload[k]) && payload[k].length)) return null;
  return value;
}

export function failureKind(item: Pick<DashboardRequest, 'failure_status' | 'failure_body'>): 'auth' | 'limit' | 'model' | 'network' | 'other' {
  if (item.failure_status === 401 || item.failure_status === 403) return 'auth';
  if (item.failure_status === 429) return 'limit';
  if (/model.*(not found|unsupported|invalid)/i.test(item.failure_body ?? '')) return 'model';
  if ((item.failure_status ?? 0) >= 500 || /timeout|timed out|connection refused|network/i.test(item.failure_body ?? '')) return 'network';
  return 'other';
}
