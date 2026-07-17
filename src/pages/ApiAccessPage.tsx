import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Check,
  Edit3,
  Filter,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import claudeIcon from '../assets/icons/claude.svg';
import codexIcon from '../assets/icons/codex.svg';
import deepseekIcon from '../assets/icons/deepseek.svg';
import geminiIcon from '../assets/icons/gemini.svg';
import openaiIcon from '../assets/icons/openai-light.svg';
import {
  isRecord,
  managementApi,
  maskSecret,
  readBoolean,
  readNumber,
  readString,
  responseList,
} from '../services/managementApi';
import {
  fetchModels,
  modelsFromRecord,
  normalizeBaseUrl,
  type ModelOption,
  type ModelProvider,
} from '../services/modelService';
import { modelMatchesRule } from '../services/oauthModels';

export type ProviderSection =
  | 'gemini-api-key'
  | 'codex-api-key'
  | 'claude-api-key'
  | 'openai-compatibility';

export type ProviderCategory = ProviderSection | 'deepseek';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const OPENAI_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const DEEPSEEK_THINKING_LEVELS = OPENAI_THINKING_LEVELS;

type ProviderDefinition = {
  id: ProviderCategory;
  section: ProviderSection;
  responseKey: string;
  label: string;
  icon: string;
  openAi: boolean;
};

type ProviderRow = {
  section: ProviderSection;
  index: number;
  record: Record<string, unknown>;
  name: string;
  apiKey: string;
  apiKeys: string[];
  baseUrl: string;
  models: ModelOption[];
  disabled: boolean;
  priority: number | null;
  authIndex: string;
};

export type ProviderDraft = {
  name: string;
  apiKey: string;
  baseUrl: string;
  priority: string;
  models: ModelOption[];
  prefix?: string;
  headersText?: string;
  excludedModelsText?: string;
  disableCooling?: boolean;
  websockets?: boolean;
  testModel?: string;
  thinkingLevels?: string[];
  disabled?: boolean;
  cloakMode?: string;
  cloakStrictMode?: boolean;
  cloakSensitiveWordsText?: string;
  cloakCacheUserId?: boolean;
};

const providerDefinitions: ProviderDefinition[] = [
  { id: 'codex-api-key', section: 'codex-api-key', responseKey: 'codex-api-key', label: 'Codex', icon: codexIcon, openAi: false },
  {
    id: 'openai-compatibility',
    section: 'openai-compatibility',
    responseKey: 'openai-compatibility',
    label: 'OpenAI 兼容',
    icon: openaiIcon,
    openAi: true,
  },
  {
    id: 'deepseek',
    section: 'openai-compatibility',
    responseKey: 'openai-compatibility',
    label: 'DeepSeek',
    icon: deepseekIcon,
    openAi: true,
  },
  { id: 'claude-api-key', section: 'claude-api-key', responseKey: 'claude-api-key', label: 'Claude', icon: claudeIcon, openAi: false },
  { id: 'gemini-api-key', section: 'gemini-api-key', responseKey: 'gemini-api-key', label: 'Gemini', icon: geminiIcon, openAi: false },
];

export const providerSectionOrder = providerDefinitions.map((definition) => definition.id);

const providerLoadDefinitions = providerDefinitions.filter(
  (definition, index, definitions) =>
    definitions.findIndex((item) => item.section === definition.section) === index,
);

const emptyRecords = (): Record<ProviderSection, Record<string, unknown>[]> => ({
  'gemini-api-key': [],
  'codex-api-key': [],
  'claude-api-key': [],
  'openai-compatibility': [],
});

const definitionFor = (category: ProviderCategory) =>
  providerDefinitions.find((item) => item.id === category) ?? providerDefinitions[0];

const isDeepSeekRecord = (record: Record<string, unknown>) => {
  const name = readString(record, 'name').trim().toLowerCase();
  const baseUrl = readString(record, 'base-url', 'baseUrl').trim().toLowerCase();
  return name.includes('deepseek') || /^https?:\/\/api\.deepseek\.com(?:\/|$)/i.test(baseUrl);
};

export const providerCategoryMatchesRecord = (
  category: ProviderCategory,
  record: Record<string, unknown>,
) => {
  if (category === 'deepseek') return isDeepSeekRecord(record);
  if (category === 'openai-compatibility') return !isDeepSeekRecord(record);
  return true;
};

export const sectionRecordsFromConfig = (payload: unknown, section: ProviderSection) =>
  isRecord(payload) && Array.isArray(payload[section])
    ? payload[section].filter(isRecord)
    : [];

const rowFromRecord = (
  section: ProviderSection,
  record: Record<string, unknown>,
  index: number,
): ProviderRow => {
  const entries = definitionFor(section).openAi && Array.isArray(record['api-key-entries'])
    ? record['api-key-entries'].filter(isRecord)
    : [];
  const entry = entries[0] ?? null;
  const apiKeys = entries
    .map((item) => readString(item, 'api-key', 'apiKey'))
    .filter(Boolean);
  const singleApiKey = readString(record, 'api-key', 'apiKey');
  const excludedModels = Array.isArray(record['excluded-models'])
    ? record['excluded-models'].map(String)
    : [];
  return {
    section,
    index,
    record,
    name: definitionFor(section).openAi
      ? readString(record, 'name') || `OpenAI 兼容 ${index + 1}`
      : definitionFor(section).label,
    apiKey: entry ? readString(entry, 'api-key', 'apiKey') : singleApiKey,
    apiKeys: entry ? apiKeys : singleApiKey ? [singleApiKey] : [],
    baseUrl: readString(record, 'base-url', 'baseUrl'),
    models: modelsFromRecord(record.models),
    disabled: definitionFor(section).openAi
      ? readBoolean(record, 'disabled')
      : excludedModels.some((model) => model.trim() === '*'),
    priority: readNumber(record, 'priority'),
    authIndex: entry
      ? readString(entry, 'auth-index', 'authIndex')
      : readString(record, 'auth-index', 'authIndex'),
  };
};

export const stripResponseFields = (record: Record<string, unknown>) => {
  const next = { ...record };
  delete next['auth-index'];
  delete next.authIndex;
  delete next.auth_index;
  if (Array.isArray(next['api-key-entries'])) {
    next['api-key-entries'] = next['api-key-entries']
      .filter(isRecord)
      .map((entry) => {
        const clean = { ...entry };
        delete clean['auth-index'];
        delete clean.authIndex;
        delete clean.auth_index;
        return clean;
      });
  }
  return next;
};

const mergeModelRecords = (current: unknown, selected: ModelOption[]) => {
  const existing = Array.isArray(current) ? current : [];
  return selected.map((model) => {
    const name = model.name.trim();
    const matched = existing.find(
      (item) => isRecord(item) && readString(item, 'name').toLowerCase() === name.toLowerCase(),
    );
    const next: Record<string, unknown> = isRecord(matched) ? { ...matched } : {};
    next.name = name;
    const alias = model.alias?.trim();
    if (alias && alias !== name) next.alias = alias;
    else delete next.alias;
    if (model.thinking) next.thinking = { ...model.thinking };
    return next;
  });
};

export const exclusionsForModelSelection = (
  currentText: string,
  discoveredModels: ModelOption[],
  selectedModelNames: Iterable<string>,
) => {
  const discovered = new Map<string, string>();
  discoveredModels.forEach((model) => {
    const name = model.name.trim();
    if (name && !discovered.has(name.toLowerCase())) discovered.set(name.toLowerCase(), name);
  });
  const selected = new Set(
    Array.from(selectedModelNames, (name) => name.trim().toLowerCase()).filter(Boolean),
  );
  const rules = currentText
    .split(/[,\n]/)
    .map((value) => value.trim())
    .filter(Boolean);
  const next = rules.filter((rule) => !discovered.has(rule.toLowerCase()));

  if (selected.size > 0) {
    discovered.forEach((name, key) => {
      if (!selected.has(key)) next.push(name);
    });
  }

  return next
    .filter((rule, index, values) =>
      values.findIndex((value) => value.toLowerCase() === rule.toLowerCase()) === index,
    )
    .join('\n');
};

export const modelSelectionForDiscovery = (
  section: ProviderSection,
  configuredModels: ModelOption[],
  discoveredModels: ModelOption[],
  excludedModelsText: string,
) => {
  const configured = new Set(
    configuredModels.map((model) => model.name.trim().toLowerCase()).filter(Boolean),
  );
  if (configured.size > 0) return configured;

  const excludedRules = excludedModelsText
    .split(/[,\n]/)
    .map((rule) => rule.trim())
    .filter(Boolean);
  return new Set(
    discoveredModels
      .filter((model) => !excludedRules.some((rule) => modelMatchesRule(model.name, rule)))
      .map((model) => model.name.toLowerCase()),
  );
};

export const allModelSelectionForDiscovery = (models: ModelOption[]) =>
  new Set(models.map((model) => model.name.trim().toLowerCase()).filter(Boolean));

const mergeOpenAiApiKeyEntries = (current: unknown, apiKey: string) => {
  const entries = Array.isArray(current) ? current.filter(isRecord) : [];
  const keys = apiKey
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter((value, index, values) => value && values.indexOf(value) === index);
  const usedIndexes = new Set<number>();
  return keys.map((key, index) => {
    let matchedIndex = entries.findIndex(
      (entry, entryIndex) =>
        !usedIndexes.has(entryIndex) && readString(entry, 'api-key', 'apiKey') === key,
    );
    if (matchedIndex < 0 && entries[index] && !usedIndexes.has(index)) matchedIndex = index;
    if (matchedIndex >= 0) usedIndexes.add(matchedIndex);
    const next = matchedIndex >= 0 ? stripResponseFields(entries[matchedIndex]) : {};
    next['api-key'] = key;
    return next;
  });
};

const thinkingLevelsFromModels = (models: ModelOption[]): string[] => {
  const levels: string[] = [];
  models.forEach((model) => {
    const configured = model.thinking?.levels;
    if (!Array.isArray(configured)) return;
    configured.forEach((level) => {
      const normalized = String(level).trim().toLowerCase();
      if (normalized && !levels.includes(normalized)) {
        levels.push(normalized);
      }
    });
  });
  return levels;
};

const draftFromRow = (row: ProviderRow): ProviderDraft => ({
  name: row.name,
  apiKey: definitionFor(row.section).openAi ? row.apiKeys.join('\n') : row.apiKey,
  baseUrl: row.baseUrl,
  priority: row.priority === null ? '' : String(row.priority),
  models: row.models,
  prefix: readString(row.record, 'prefix'),
  headersText: isRecord(row.record.headers)
    ? Object.entries(row.record.headers)
      .map(([key, value]) => `${key}: ${String(value)}`)
      .join('\n')
    : '',
  excludedModelsText: Array.isArray(row.record['excluded-models'])
    ? row.record['excluded-models'].map(String).filter((model) => model.trim() !== '*').join('\n')
    : '',
  disableCooling: readBoolean(row.record, 'disable-cooling', 'disableCooling'),
  websockets: readBoolean(row.record, 'websockets'),
  testModel: readString(row.record, 'test-model', 'testModel'),
  thinkingLevels: definitionFor(row.section).openAi
    ? thinkingLevelsFromModels(row.models)
    : undefined,
  disabled: row.disabled,
  cloakMode: isRecord(row.record.cloak) ? readString(row.record.cloak, 'mode') : '',
  cloakStrictMode: isRecord(row.record.cloak)
    ? readBoolean(row.record.cloak, 'strict-mode', 'strictMode')
    : false,
  cloakSensitiveWordsText:
    isRecord(row.record.cloak) && Array.isArray(row.record.cloak['sensitive-words'])
      ? row.record.cloak['sensitive-words'].map(String).join('\n')
      : '',
  cloakCacheUserId: isRecord(row.record.cloak)
    ? readBoolean(row.record.cloak, 'cache-user-id', 'cacheUserId')
    : false,
});

const emptyProviderDraft = (): ProviderDraft => ({
  name: '',
  apiKey: '',
  baseUrl: '',
  priority: '',
  models: [],
  prefix: '',
  headersText: '',
  excludedModelsText: '',
  disableCooling: false,
  websockets: false,
  testModel: '',
  disabled: false,
  cloakMode: '',
  cloakStrictMode: false,
  cloakSensitiveWordsText: '',
  cloakCacheUserId: false,
});

const deepSeekDefaultModels = (): ModelOption[] => [
  {
    name: 'deepseek-chat',
    thinking: { levels: [...DEEPSEEK_THINKING_LEVELS] },
  },
  {
    name: 'deepseek-reasoner',
    thinking: { levels: [...DEEPSEEK_THINKING_LEVELS] },
  },
];

export const createProviderDraft = (category: ProviderCategory): ProviderDraft => {
  const draft = emptyProviderDraft();
  if (category === 'openai-compatibility') return { ...draft, thinkingLevels: [] };
  if (category !== 'deepseek') return draft;
  return {
    ...draft,
    name: 'DeepSeek',
    baseUrl: DEEPSEEK_BASE_URL,
    models: deepSeekDefaultModels(),
    thinkingLevels: [...DEEPSEEK_THINKING_LEVELS],
  };
};

export const applyProviderPreset = (
  category: ProviderCategory,
  draft: ProviderDraft,
): ProviderDraft => {
  if (!definitionFor(category).openAi || draft.thinkingLevels === undefined) return draft;
  const levels = category === 'deepseek'
    ? [...DEEPSEEK_THINKING_LEVELS]
    : draft.thinkingLevels;
  return {
    ...draft,
    models: draft.models.map((model) => {
      const thinking = { ...model.thinking };
      if (levels.length > 0) thinking.levels = [...levels];
      else delete thinking.levels;
      const { thinking: _thinking, ...withoutThinking } = model;
      return Object.keys(thinking).length > 0
        ? { ...withoutThinking, thinking }
        : withoutThinking;
    }),
  };
};

export const parseProviderHeaders = (value: string): Record<string, string> => {
  const headers: Record<string, string> = {};
  value.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) throw new Error(`自定义请求头第 ${index + 1} 行缺少冒号`);
    const key = trimmed.slice(0, separator).trim();
    const headerValue = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || !headerValue) {
      throw new Error(`自定义请求头第 ${index + 1} 行格式无效`);
    }
    const duplicateKey = Object.keys(headers).find(
      (current) => current.toLowerCase() === key.toLowerCase(),
    );
    if (duplicateKey) delete headers[duplicateKey];
    headers[key] = headerValue;
  });
  return headers;
};

const applyAdvancedFields = (
  next: Record<string, unknown>,
  section: ProviderSection,
  draft: ProviderDraft,
) => {
  if (draft.prefix !== undefined) {
    const prefix = draft.prefix.trim();
    if (prefix) next.prefix = prefix;
    else delete next.prefix;
  }
  if (draft.headersText !== undefined) {
    const headers = parseProviderHeaders(draft.headersText);
    if (Object.keys(headers).length > 0) next.headers = headers;
    else delete next.headers;
  }
  if (draft.excludedModelsText !== undefined && section !== 'openai-compatibility') {
    const excludedModels = draft.excludedModelsText
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter((value, index, values) =>
        value && values.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index,
      );
    if (draft.disabled && !excludedModels.includes('*')) excludedModels.push('*');
    if (excludedModels.length > 0) next['excluded-models'] = excludedModels;
    else delete next['excluded-models'];
  }
  if (draft.disableCooling !== undefined) {
    if (draft.disableCooling) next['disable-cooling'] = true;
    else delete next['disable-cooling'];
  }
  if (draft.websockets !== undefined && section === 'codex-api-key') {
    next.websockets = draft.websockets;
  }
  if (draft.testModel !== undefined && section === 'openai-compatibility') {
    const testModel = draft.testModel.trim();
    if (testModel) next['test-model'] = testModel;
    else delete next['test-model'];
  }
  if (
    section === 'claude-api-key'
    && (
      draft.cloakMode !== undefined
      || draft.cloakStrictMode !== undefined
      || draft.cloakSensitiveWordsText !== undefined
      || draft.cloakCacheUserId !== undefined
    )
  ) {
    const cloak: Record<string, unknown> = isRecord(next.cloak) ? { ...next.cloak } : {};
    const mode = draft.cloakMode?.trim();
    if (mode) cloak.mode = mode;
    else delete cloak.mode;
    delete cloak.strictMode;
    if (draft.cloakStrictMode) cloak['strict-mode'] = true;
    else delete cloak['strict-mode'];
    const sensitiveWords = (draft.cloakSensitiveWordsText ?? '')
      .split(/[,\n]/)
      .map((value) => value.trim())
      .filter((value, index, values) => value && values.indexOf(value) === index);
    if (sensitiveWords.length > 0) cloak['sensitive-words'] = sensitiveWords;
    else delete cloak['sensitive-words'];
    delete cloak.sensitiveWords;
    delete cloak.cacheUserId;
    if (draft.cloakCacheUserId) cloak['cache-user-id'] = true;
    else delete cloak['cache-user-id'];
    if (Object.keys(cloak).length > 0) next.cloak = cloak;
    else delete next.cloak;
  }
  return next;
};

export const buildProviderRecord = (
  section: ProviderSection,
  draft: ProviderDraft,
  current?: Record<string, unknown>,
) => {
  const record = current ? stripResponseFields(current) : {};
  const priorityText = draft.priority.trim();
  const priority = priorityText ? Number(priorityText) : null;
  const models = mergeModelRecords(record.models, draft.models);
  if (definitionFor(section).openAi) {
    const next: Record<string, unknown> = {
      ...record,
      name: draft.name.trim(),
      'base-url': draft.baseUrl.trim(),
      'api-key-entries': mergeOpenAiApiKeyEntries(
        record['api-key-entries'],
        draft.apiKey.trim(),
      ),
      models,
    };
    if (priority !== null && Number.isFinite(priority)) next.priority = priority;
    else delete next.priority;
    return applyAdvancedFields(next, section, draft);
  }

  const next: Record<string, unknown> = {
    ...record,
    'api-key': draft.apiKey.trim(),
    models,
  };
  if (draft.baseUrl.trim()) next['base-url'] = draft.baseUrl.trim();
  else delete next['base-url'];
  if (priority !== null && Number.isFinite(priority)) next.priority = priority;
  else delete next.priority;
  return applyAdvancedFields(next, section, draft);
};

const providerIdentityMatches = (row: ProviderRow, record: Record<string, unknown>) => {
  if (definitionFor(row.section).openAi) {
    return readString(record, 'name') === row.name;
  }
  return (
    readString(record, 'api-key', 'apiKey') === row.apiKey
    && readString(record, 'base-url', 'baseUrl') === row.baseUrl
  );
};

export function ApiAccessPage() {
  const [records, setRecords] = useState(emptyRecords);
  const [activeCategory, setActiveCategory] = useState<ProviderCategory>('codex-api-key');
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingRow, setEditingRow] = useState<ProviderRow | null>(null);
  const [dialogDraft, setDialogDraft] = useState<ProviderDraft>(emptyProviderDraft);
  const activeDefinition = definitionFor(activeCategory);
  const activeSection = activeDefinition.section;

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const responses = await Promise.allSettled(
        providerLoadDefinitions.map(async (definition) => ({
          section: definition.section,
          records: responseList(
            await managementApi.get(`/${definition.section}`),
            definition.responseKey,
          ),
        })),
      );
      const failures: string[] = [];
      setRecords((current) => {
        const next = { ...current };
        responses.forEach((result, index) => {
          const definition = providerLoadDefinitions[index];
          if (result.status === 'fulfilled') {
            next[result.value.section] = result.value.records;
          } else {
            failures.push(`${definition.label}：${String(result.reason)}`);
          }
        });
        return next;
      });
      if (failures.length > 0) {
        setError(`部分接入读取失败：${failures.join('；')}`);
      }
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const rows = useMemo(
    () =>
      records[activeSection]
        .map((record, index) => rowFromRecord(activeSection, record, index))
        .filter((row) => providerCategoryMatchesRecord(activeCategory, row.record))
        .filter((row) => {
          const query = filter.trim().toLowerCase();
          if (!query) return true;
          return [row.name, row.apiKey, row.baseUrl, row.models.map((model) => model.name).join(' ')]
            .join(' ')
            .toLowerCase()
            .includes(query);
        }),
    [activeCategory, activeSection, filter, records],
  );

  const openCreate = () => {
    setEditingRow(null);
    setDialogDraft(createProviderDraft(activeCategory));
    setDialogOpen(true);
  };

  const openEdit = (row: ProviderRow) => {
    setEditingRow(row);
    const draft = draftFromRow(row);
    setDialogDraft(activeCategory === 'deepseek'
      ? { ...draft, thinkingLevels: [...DEEPSEEK_THINKING_LEVELS] }
      : draft);
    setDialogOpen(true);
  };

  const saveProvider = async (nextDraft: ProviderDraft): Promise<boolean> => {
    const definition = activeDefinition;
    const preparedDraft = applyProviderPreset(activeCategory, nextDraft);
    const baseUrlRequired = definition.openAi || definition.section === 'codex-api-key';
    const parsedApiKeys = preparedDraft.apiKey
      .split(/\r?\n/)
      .map((value) => value.trim())
      .filter(Boolean);
    if (
      parsedApiKeys.length === 0
      || (definition.openAi && !preparedDraft.name.trim())
      || (baseUrlRequired && !preparedDraft.baseUrl.trim())
    ) {
      setError(
        definition.openAi
          ? '名称、Base URL 和密钥不能为空'
          : baseUrlRequired
            ? 'Base URL 和 API 密钥不能为空'
            : 'API 密钥不能为空',
      );
      return false;
    }
    let baseUrl = preparedDraft.baseUrl.trim();
    let providerHeaders: Record<string, string> = {};
    try {
      if (baseUrl) baseUrl = normalizeBaseUrl(baseUrl);
      if (baseUrlRequired && !baseUrl) throw new Error(`${definition.label} 接入必须填写 Base URL`);
      providerHeaders = parseProviderHeaders(preparedDraft.headersText ?? '');
    } catch (requestError) {
      setError(String(requestError));
      return false;
    }
    setBusy(true);
    setError('');
    try {
      let draftToSave = { ...preparedDraft, baseUrl };
      if (definition.openAi && draftToSave.models.length === 0) {
        const fetchedModels = await fetchModels(
          'openai',
          baseUrl,
          parsedApiKeys[0],
          editingRow?.authIndex,
          providerHeaders,
        );
        if (fetchedModels.length === 0) {
          throw new Error('没有发现可放行的模型，请确认 Base URL 和 API 密钥');
        }
        draftToSave = applyProviderPreset(activeCategory, {
          ...draftToSave,
          models: fetchedModels,
        });
      }
      const latestConfig = await managementApi.get('/config');
      const current = sectionRecordsFromConfig(latestConfig, activeSection);
      let nextList: Record<string, unknown>[];

      if (editingRow) {
        const targetIndex = current.findIndex((record) =>
          providerIdentityMatches(editingRow, record),
        );
        if (targetIndex < 0) {
          throw new Error('接入配置已被其他操作修改，请刷新后重试');
        }
        const nextRecord = buildProviderRecord(
          activeSection,
          draftToSave,
          current[targetIndex],
        );
        nextList = current.map((record, index) =>
          index === targetIndex ? nextRecord : record,
        );
      } else {
        const duplicate = current.some((record) =>
          definition.openAi
            ? readString(record, 'name') === preparedDraft.name.trim()
            : readString(record, 'api-key', 'apiKey') === preparedDraft.apiKey.trim()
              && readString(record, 'base-url', 'baseUrl') === baseUrl,
        );
        if (duplicate) throw new Error('相同的接入配置已经存在');
        nextList = [
          ...current,
          buildProviderRecord(activeSection, draftToSave),
        ];
      }

      await managementApi.put(`/${activeSection}`, nextList.map(stripResponseFields));
      setNotice(editingRow ? '接入已更新' : '接入已新增');
      await loadProviders();
      return true;
    } catch (requestError) {
      setError(String(requestError));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const deleteRow = async (row: ProviderRow) => {
    if (!window.confirm(`确定删除「${row.name}」吗？`)) return;
    setBusy(true);
    setError('');
    try {
      if (definitionFor(row.section).openAi) {
        await managementApi.delete('/openai-compatibility', { query: { name: row.name } });
      } else {
        await managementApi.delete(`/${row.section}`, {
          query: { 'api-key': row.apiKey, 'base-url': row.baseUrl },
        });
      }
      setNotice('接入已删除');
      await loadProviders();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const toggleProvider = async (row: ProviderRow) => {
    setBusy(true);
    setError('');
    try {
      const latestConfig = await managementApi.get('/config');
      const latestRows = sectionRecordsFromConfig(latestConfig, row.section);
      const targetIndex = latestRows.findIndex((record) => providerIdentityMatches(row, record));
      if (targetIndex < 0) {
        throw new Error('接入配置已被其他操作修改，请刷新后重试');
      }
      const latestRecord = latestRows[targetIndex];
      const definition = definitionFor(row.section);
      const currentlyDisabled = definition.openAi
        ? readBoolean(latestRecord, 'disabled')
        : Array.isArray(latestRecord['excluded-models'])
          && latestRecord['excluded-models'].some((model) => String(model).trim() === '*');
      if (definition.openAi) {
        await managementApi.patch('/openai-compatibility', {
          index: targetIndex,
          value: { disabled: !currentlyDisabled },
        });
      } else {
        const nextRecord = stripResponseFields(latestRecord);
        const excludedModels = Array.isArray(nextRecord['excluded-models'])
          ? nextRecord['excluded-models'].map(String).filter((model) => model.trim() !== '*')
          : [];
        if (!currentlyDisabled) excludedModels.push('*');
        if (excludedModels.length > 0) nextRecord['excluded-models'] = excludedModels;
        else delete nextRecord['excluded-models'];
        await managementApi.patch(`/${row.section}`, {
          index: targetIndex,
          value: nextRecord,
        });
      }
      setNotice(currentlyDisabled ? '接入已启用' : '接入已停用');
      await loadProviders();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const totalCount = Object.values(records).reduce((sum, items) => sum + items.length, 0);

  const countForDefinition = (definition: ProviderDefinition) =>
    records[definition.section].filter((record) =>
      providerCategoryMatchesRecord(definition.id, record)
    ).length;

  return (
    <section className="page management-page api-access-page">
      <header className="management-header">
        <div>
          <span>Providers</span>
          <h1>API 接入</h1>
        </div>
        <div className="management-heading-actions">
          <span className="muted-summary">{totalCount} 个接入</span>
          <button type="button" className="secondary-button compact-button" onClick={() => void loadProviders()} disabled={loading || busy}>
            <RefreshCw size={16} aria-hidden="true" />
            刷新
          </button>
          <button type="button" className="primary-button compact-button" onClick={openCreate} disabled={loading || busy}>
            <Plus size={16} aria-hidden="true" />
            新增
          </button>
        </div>
      </header>

      {error ? <div className="management-alert error">{error}</div> : null}
      {notice ? <div className="management-alert success">{notice}</div> : null}

      <div className="provider-workbench real-provider-workbench">
        <aside className="panel provider-category-panel">
          {providerDefinitions.map((definition) => (
            <button
              type="button"
              key={definition.id}
              className={definition.id === activeCategory ? 'active' : ''}
              onClick={() => setActiveCategory(definition.id)}
              disabled={busy}
            >
              <img src={definition.icon} alt="" className="provider-logo" />
              <span title={definition.label}>{definition.label}</span>
              <strong>{countForDefinition(definition)}</strong>
            </button>
          ))}
        </aside>

        <section className="panel provider-resource-panel">
          <div className="management-panel-heading">
            <div>
              <h2 title={activeDefinition.label}>{activeDefinition.label}</h2>
              <span>{rows.length} 个匹配接入</span>
            </div>
            <div className="management-toolbar compact-toolbar">
              <Search size={16} aria-hidden="true" />
              <input value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder="搜索名称、密钥或地址" />
            </div>
          </div>

          {loading ? (
            <div className="management-loading"><LoaderCircle size={20} className="spin" />读取配置中</div>
          ) : rows.length === 0 ? (
            <div className="management-empty">
              <Filter size={24} aria-hidden="true" />
              <strong>{filter ? '没有匹配的接入' : '暂无接入配置'}</strong>
              <span>{filter ? '换个关键词试试' : '点击右上角“新增”添加第一个接入'}</span>
            </div>
          ) : (
            <div className="real-provider-list">
              {rows.map((row) => (
                <article className="real-provider-row" key={`${row.section}-${row.index}-${row.authIndex}`}>
                  <div className="provider-row-main">
                    <div className="provider-row-title">
                      <strong title={row.name}>{row.name}</strong>
                    </div>
                    <code title={definitionFor(row.section).openAi ? `${row.apiKeys.length} 个密钥` : undefined}>
                      {definitionFor(row.section).openAi && row.apiKeys.length > 1
                        ? `${maskSecret(row.apiKey)} · 共 ${row.apiKeys.length} 个密钥`
                        : maskSecret(row.apiKey)}
                    </code>
                    <span className="provider-row-url" title={row.baseUrl || undefined}>{row.baseUrl || '使用默认地址'}</span>
                    {row.models.length > 0 ? <span className="provider-row-models" title={row.models.map((model) => model.name).join(', ')}>模型 {row.models.length} 个 · {row.models.slice(0, 3).map((model) => model.name).join(', ')}</span> : null}
                  </div>
                  <div className="provider-row-meta">
                    {row.priority === null ? null : <span>优先级 {row.priority}</span>}
                    {row.authIndex ? <span title={row.authIndex}>运行时凭据 {row.authIndex.slice(0, 8)}…</span> : null}
                  </div>
                  <div className="provider-row-actions">
                    <label className="provider-enabled-control" title={row.disabled ? '启用接入' : '停用接入'}>
                      <span>{row.disabled ? '已停用' : '已启用'}</span>
                      <span className="switch-control">
                        <input
                          type="checkbox"
                          checked={!row.disabled}
                          onChange={() => void toggleProvider(row)}
                          disabled={busy}
                          aria-label={`${row.name} 接入${row.disabled ? '启用' : '停用'}开关`}
                        />
                        <span className="switch-track" />
                      </span>
                    </label>
                    <button type="button" className="icon-button quiet" onClick={() => openEdit(row)} disabled={busy} title="编辑">
                      <Edit3 size={16} />
                    </button>
                    <button type="button" className="icon-button danger" onClick={() => void deleteRow(row)} disabled={busy} title="删除">
                      <Trash2 size={16} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      {dialogOpen ? (
        <ApiProviderDialog
          activeCategory={activeCategory}
          editingRow={editingRow}
          initialDraft={dialogDraft}
          busy={busy}
          onClose={() => setDialogOpen(false)}
          onSave={saveProvider}
        />
      ) : null}
    </section>
  );
}

type ApiProviderDialogProps = {
  activeCategory: ProviderCategory;
  editingRow: ProviderRow | null;
  initialDraft: ProviderDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: ProviderDraft) => Promise<boolean>;
};

function ApiProviderDialog({
  activeCategory,
  editingRow,
  initialDraft,
  busy,
  onClose,
  onSave,
}: ApiProviderDialogProps) {
  const definition = definitionFor(activeCategory);
  const activeSection = definition.section;
  const [draft, setDraft] = useState<ProviderDraft>(initialDraft);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<ModelOption[]>([]);
  const [modelDiscoveryOpen, setModelDiscoveryOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [thinkingLevelInput, setThinkingLevelInput] = useState('');
  const [selectedModelNames, setSelectedModelNames] = useState<Set<string>>(
    () => new Set(initialDraft.models.map((model) => model.name.toLowerCase())),
  );

  const modelOptions = useMemo(() => {
    const options = new Map<string, ModelOption>();
    [...discoveredModels, ...draft.models].forEach((model) => {
      const name = model.name.trim();
      if (name) options.set(name.toLowerCase(), { ...model, name });
    });
    return Array.from(options.values());
  }, [discoveredModels, draft.models]);

  const visibleModelOptions = useMemo(() => {
    const query = modelSearch.trim().toLowerCase();
    if (!query) return modelOptions;
    return modelOptions.filter((model) =>
      `${model.name} ${model.alias ?? ''}`.toLowerCase().includes(query),
    );
  }, [modelOptions, modelSearch]);

  const allVisibleModelsSelected = visibleModelOptions.length > 0
    && visibleModelOptions.every((model) => selectedModelNames.has(model.name.toLowerCase()));

  const updateTextField = (
    field: 'name' | 'apiKey' | 'baseUrl' | 'priority' | 'prefix' | 'headersText' | 'excludedModelsText' | 'testModel' | 'cloakMode' | 'cloakSensitiveWordsText',
    value: string,
  ) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const updateBooleanField = (
    field: 'disableCooling' | 'websockets' | 'cloakStrictMode' | 'cloakCacheUserId',
    value: boolean,
  ) => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const addThinkingLevel = () => {
    const level = thinkingLevelInput.trim().toLowerCase();
    if (!level) return;
    setDraft((current) => {
      const levels = current.thinkingLevels ?? [];
      if (levels.some((item) => item.toLowerCase() === level)) return current;
      return {
        ...current,
        thinkingLevels: [...levels, level],
      };
    });
    setThinkingLevelInput('');
  };

  const removeThinkingLevel = (level: string) => {
    setDraft((current) => ({
      ...current,
      thinkingLevels: (current.thinkingLevels ?? []).filter((item) => item !== level),
    }));
  };

  const discoverModels = async () => {
    const baseUrlRequired =
      activeSection === 'codex-api-key' || activeSection === 'openai-compatibility';
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setModelError('请先填写 Base URL');
      return;
    }
    setModelLoading(true);
    setModelError('');
    try {
      const provider: ModelProvider = definition.section === 'gemini-api-key'
        ? 'gemini'
        : definition.section === 'claude-api-key'
          ? 'claude'
          : definition.section === 'codex-api-key'
            ? 'codex'
            : 'openai';
      const modelApiKey = draft.apiKey.split(/\r?\n/).map((value) => value.trim()).find(Boolean) ?? '';
      const fetchedModels = await fetchModels(
        provider,
        draft.baseUrl,
        modelApiKey,
        editingRow?.authIndex,
        parseProviderHeaders(draft.headersText ?? ''),
      );
      const models = applyProviderPreset(
        activeCategory,
        { ...draft, models: fetchedModels },
      ).models;
      setDiscoveredModels(models);
      setSelectedModelNames(allModelSelectionForDiscovery(models));
      if (!models.length) setModelError('未发现可用模型');
    } catch (requestError) {
      setDiscoveredModels([]);
      setModelError(String(requestError));
    } finally {
      setModelLoading(false);
    }
  };

  const openModelDiscovery = () => {
    const baseUrlRequired =
      activeSection === 'codex-api-key' || activeSection === 'openai-compatibility';
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setModelError('请先填写 Base URL，再获取模型');
      return;
    }
    setModelSearch('');
    setSelectedModelNames(new Set(draft.models.map((model) => model.name.toLowerCase())));
    setModelDiscoveryOpen(true);
    void discoverModels();
  };

  const toggleModelSelection = (model: ModelOption) => {
    const key = model.name.toLowerCase();
    setSelectedModelNames((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisibleModels = () => {
    setSelectedModelNames((current) => {
      const next = new Set(current);
      visibleModelOptions.forEach((model) => {
        const key = model.name.toLowerCase();
        if (allVisibleModelsSelected) next.delete(key);
        else next.add(key);
      });
      return next;
    });
  };

  const applyModelSelection = () => {
    const models = modelOptions.filter((model) =>
      selectedModelNames.has(model.name.toLowerCase()),
    );
    setDraft((current) => ({
      ...current,
      models,
      excludedModelsText: activeSection === 'openai-compatibility'
        ? current.excludedModelsText
        : exclusionsForModelSelection(
            current.excludedModelsText ?? '',
            discoveredModels,
            selectedModelNames,
          ),
    }));
    setModelDiscoveryOpen(false);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onSave(draft)) onClose();
  };

  const hasModelExclusions = activeSection !== 'openai-compatibility'
    && Boolean(draft.excludedModelsText?.trim());
  const modelSummaryTitle = draft.models.length > 0
    ? `已选择 ${draft.models.length} 个模型`
    : hasModelExclusions
      ? '已配置模型限制'
      : activeSection === 'openai-compatibility'
        ? '保存时默认开放全部模型'
        : '使用上游默认模型';
  const modelSummaryDetail = draft.models.length > 0
    ? draft.models.slice(0, 3).map((model) => model.name).join('、')
    : hasModelExclusions
      ? '未勾选的模型不会出现在开放列表'
      : activeSection === 'openai-compatibility'
        ? '保存接入时会自动获取模型，也可提前取消不需要的项目'
        : '当前开放上游全部模型';

  return (
    <>
      <div className="config-dialog-backdrop" onMouseDown={(event) => event.currentTarget === event.target && !busy && onClose()}>
      <form className="config-dialog management-dialog api-provider-dialog" onSubmit={(event) => void submit(event)}>
        <div className="config-dialog-heading">
          <div>
            <Plus size={19} aria-hidden="true" />
            <h2>{editingRow ? '编辑 API 接入' : '新增 API 接入'}</h2>
          </div>
          <button type="button" className="icon-button quiet" onClick={onClose} disabled={busy} title="关闭">
            <X size={18} />
          </button>
        </div>
        {definition.openAi ? (
          <label><span>名称</span><input autoFocus value={draft.name} onChange={(event) => updateTextField('name', event.currentTarget.value)} placeholder="openrouter" /></label>
        ) : null}
        <label className={definition.openAi ? 'multiline-field' : undefined}>
          <span>{definition.openAi ? 'API 密钥（每行一个）' : 'API 密钥'}</span>
          {definition.openAi ? (
            <textarea value={draft.apiKey} onChange={(event) => updateTextField('apiKey', event.currentTarget.value)} placeholder={'sk-...\nsk-...'} rows={3} />
          ) : (
            <input autoFocus type="password" value={draft.apiKey} onChange={(event) => updateTextField('apiKey', event.currentTarget.value)} placeholder="sk-..." />
          )}
        </label>
        <label><span>Base URL</span><input value={draft.baseUrl} onChange={(event) => updateTextField('baseUrl', event.currentTarget.value)} placeholder={activeSection === 'codex-api-key' || activeSection === 'openai-compatibility' ? '必填，例如 https://api.example.com' : '可选，留空使用默认地址'} /></label>
        {activeCategory === 'deepseek' ? (
          <div className="provider-preset-summary">
            <img src={deepseekIcon} alt="" className="provider-logo" />
            <div>
              <strong>OpenAI 兼容预设</strong>
              <span>已预填 DeepSeek 官方地址与常用模型</span>
            </div>
          </div>
        ) : null}
        {activeCategory === 'deepseek' ? (
          <div className="thinking-level-config">
            <div className="thinking-level-heading">
              <strong>内置思考等级</strong>
              <span>自动应用到当前开放的全部模型</span>
            </div>
            <div className="thinking-level-tags readonly">
              {DEEPSEEK_THINKING_LEVELS.map((level) => <span key={level}>{level}</span>)}
            </div>
          </div>
        ) : activeCategory === 'openai-compatibility' ? (
          <div className="thinking-level-config">
            <div className="thinking-level-heading">
              <strong>思考等级</strong>
              <span>按上游支持情况自行添加</span>
            </div>
            <div className="thinking-level-entry">
              <input
                value={thinkingLevelInput}
                onChange={(event) => setThinkingLevelInput(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addThinkingLevel();
                  }
                }}
                placeholder="例如 low、medium 或自定义等级"
              />
              <button type="button" className="secondary-button compact-button" onClick={addThinkingLevel} disabled={!thinkingLevelInput.trim()}>
                <Plus size={14} />添加
              </button>
            </div>
            {(draft.thinkingLevels?.length ?? 0) > 0 ? (
              <div className="thinking-level-tags">
                {draft.thinkingLevels?.map((level) => (
                  <span key={level}>
                    {level}
                    <button type="button" onClick={() => removeThinkingLevel(level)} title={`删除 ${level}`} aria-label={`删除思考等级 ${level}`}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : <small className="thinking-level-empty">未添加时不写入 thinking.levels</small>}
            </div>
        ) : null}
        <div className="model-config-card">
          <div className="model-config-heading">
            <div><span>模型</span><small>勾选表示当前开放，取消勾选后将从模型列表隐藏</small></div>
            <button type="button" className="secondary-button compact-button" onClick={openModelDiscovery} disabled={busy}>
              <RefreshCw size={15} />获取模型
            </button>
          </div>
          <div className={`model-config-summary ${draft.models.length || hasModelExclusions ? 'has-models' : ''}`}>
            <strong>{modelSummaryTitle}</strong>
            <span>{modelSummaryDetail}</span>
          </div>
          {modelError && !modelDiscoveryOpen ? <small className="model-picker-error">{modelError}</small> : null}
        </div>
        <label><span>优先级</span><input inputMode="numeric" value={draft.priority} onChange={(event) => updateTextField('priority', event.currentTarget.value.replace(/\D/g, ''))} placeholder="可选" /></label>
        <details className="provider-advanced-settings">
          <summary>高级设置</summary>
          <div className="provider-advanced-fields">
            <label><span>模型前缀</span><input value={draft.prefix ?? ''} onChange={(event) => updateTextField('prefix', event.currentTarget.value)} placeholder="可选，例如 team-a" /></label>
            <label className="multiline-field">
              <span>自定义请求头（每行 Name: Value）</span>
              <textarea value={draft.headersText ?? ''} onChange={(event) => updateTextField('headersText', event.currentTarget.value)} rows={3} placeholder={'X-Team: production\nAuthorization: Bearer ...'} />
            </label>
            {activeSection !== 'openai-compatibility' ? (
              <label className="multiline-field">
                <span>排除模型（每行一个，支持通配符）</span>
                <textarea value={draft.excludedModelsText ?? ''} onChange={(event) => updateTextField('excludedModelsText', event.currentTarget.value)} rows={3} placeholder={'model-old-*\nmodel-preview'} />
              </label>
            ) : null}
            {activeSection === 'openai-compatibility' ? (
              <label><span>测试模型</span><input value={draft.testModel ?? ''} onChange={(event) => updateTextField('testModel', event.currentTarget.value)} placeholder="可选" /></label>
            ) : null}
            {activeSection === 'claude-api-key' ? (
              <div className="provider-cloak-settings">
                <label>
                  <span>Claude 伪装模式</span>
                  <select value={draft.cloakMode ?? ''} onChange={(event) => updateTextField('cloakMode', event.currentTarget.value)}>
                    <option value="">默认（auto）</option>
                    <option value="auto">Auto</option>
                    <option value="always">Always</option>
                    <option value="never">Never</option>
                  </select>
                </label>
                <label className="multiline-field">
                  <span>伪装敏感词（每行一个）</span>
                  <textarea value={draft.cloakSensitiveWordsText ?? ''} onChange={(event) => updateTextField('cloakSensitiveWordsText', event.currentTarget.value)} rows={3} placeholder={'internal-name\nworkspace-id'} />
                </label>
                <div className="provider-advanced-toggle">
                  <div><strong>严格模式</strong><span>仅保留 Claude Code 系统提示</span></div>
                  <label className="switch-control" title="启用严格模式"><input type="checkbox" checked={Boolean(draft.cloakStrictMode)} onChange={(event) => updateBooleanField('cloakStrictMode', event.currentTarget.checked)} /><span className="switch-track" /></label>
                </div>
                <div className="provider-advanced-toggle">
                  <div><strong>缓存用户标识</strong><span>复用伪装后的用户标识</span></div>
                  <label className="switch-control" title="缓存用户标识"><input type="checkbox" checked={Boolean(draft.cloakCacheUserId)} onChange={(event) => updateBooleanField('cloakCacheUserId', event.currentTarget.checked)} /><span className="switch-track" /></label>
                </div>
              </div>
            ) : null}
            {activeSection === 'codex-api-key' ? (
              <div className="provider-advanced-toggle">
                <div><strong>WebSocket</strong><span>为该 Codex 接入启用 WebSocket</span></div>
                <label className="switch-control" title="启用 WebSocket"><input type="checkbox" checked={Boolean(draft.websockets)} onChange={(event) => updateBooleanField('websockets', event.currentTarget.checked)} /><span className="switch-track" /></label>
              </div>
            ) : null}
            <div className="provider-advanced-toggle">
              <div><strong>禁用冷却</strong><span>上游限流后仍允许继续选择该接入</span></div>
              <label className="switch-control" title="禁用冷却"><input type="checkbox" checked={Boolean(draft.disableCooling)} onChange={(event) => updateBooleanField('disableCooling', event.currentTarget.checked)} /><span className="switch-track" /></label>
            </div>
          </div>
        </details>
        <div className="config-dialog-actions two-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>取消</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? '保存中' : '保存'}</button>
        </div>
      </form>
      </div>

      {modelDiscoveryOpen ? (
        <div className="model-discovery-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setModelDiscoveryOpen(false)}>
          <section className="model-discovery-dialog" role="dialog" aria-modal="true" aria-labelledby="model-discovery-title">
            <div className="model-discovery-header">
              <div><h2 id="model-discovery-title">选择模型</h2><span>{definition.label}</span></div>
              <button type="button" className="icon-button quiet" onClick={() => setModelDiscoveryOpen(false)} title="关闭"><X size={18} /></button>
            </div>

            <div className="model-discovery-search">
              <Search size={16} aria-hidden="true" />
              <input value={modelSearch} onChange={(event) => setModelSearch(event.currentTarget.value)} placeholder="搜索模型名称或别名" />
              <button type="button" className="secondary-button compact-button" onClick={() => void discoverModels()} disabled={modelLoading}>
                <RefreshCw size={15} className={modelLoading ? 'spin' : ''} />刷新
              </button>
            </div>

            <div className="model-discovery-toolbar">
              <span>找到 {modelOptions.length} 个 · 已选择 {selectedModelNames.size} 个</span>
              <div>
                <button type="button" className="secondary-button compact-button" onClick={toggleAllVisibleModels} disabled={modelLoading || visibleModelOptions.length === 0}>{allVisibleModelsSelected ? '取消全选' : '全选当前'}</button>
                <button type="button" className="secondary-button compact-button" onClick={() => setSelectedModelNames(new Set())} disabled={modelLoading || selectedModelNames.size === 0}>清空</button>
              </div>
            </div>

            <div className="model-discovery-content">
              {modelLoading ? (
                <div className="model-discovery-message"><LoaderCircle size={20} className="spin" />正在获取模型</div>
              ) : modelError ? (
                <div className="model-discovery-message error"><strong>获取模型失败</strong><span>{modelError}</span></div>
              ) : visibleModelOptions.length === 0 ? (
                <div className="model-discovery-message"><strong>{modelOptions.length ? '没有匹配的模型' : '未发现模型'}</strong><span>{modelOptions.length ? '换个关键词试试' : '请检查 Base URL 和 API 密钥'}</span></div>
              ) : (
                <div className="model-discovery-list">
                  {visibleModelOptions.map((model) => {
                    const checked = selectedModelNames.has(model.name.toLowerCase());
                    return (
                      <label className={`model-discovery-row ${checked ? 'selected' : ''}`} key={model.name}>
                        <input type="checkbox" checked={checked} onChange={() => toggleModelSelection(model)} />
                        <span><strong title={model.name}>{model.name}</strong>{model.alias ? <small title={model.alias}>{model.alias}</small> : null}</span>
                        {checked ? <Check size={16} aria-hidden="true" /> : null}
                      </label>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="model-discovery-actions">
              <button type="button" className="secondary-button" onClick={() => setModelDiscoveryOpen(false)}>取消</button>
              <button type="button" className="primary-button" onClick={applyModelSelection} disabled={modelLoading}>应用选择（{selectedModelNames.size}）</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
