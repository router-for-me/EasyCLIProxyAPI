import {
  type CSSProperties,
  FormEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  sortableKeyboardCoordinates,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS as DndCss } from '@dnd-kit/utilities';
import {
  Check,
  Edit3,
  Filter,
  GripVertical,
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
import {
  checkProviderModelHealth,
  checkProviderModelsHealth,
  mergeProviderHealthModels,
  PROVIDER_HEALTH_TIMEOUT_MS,
  type ProviderHealthCheckOptions,
  type ProviderModelHealthResult,
} from '../services/providerHealthCheck';
import { modelMatchesRule } from '../services/oauthModels';
import { getCurrentLocale, translate, useI18n, type MessageKey } from '../i18n';

export type ProviderSection =
  | 'gemini-api-key'
  | 'codex-api-key'
  | 'claude-api-key'
  | 'openai-compatibility';

export type ProviderCategory = ProviderSection | 'deepseek';

export const DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
export const OPENAI_THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const DEEPSEEK_THINKING_LEVELS = ['low', 'high', 'max'] as const;

type ProviderDefinition = {
  id: ProviderCategory;
  section: ProviderSection;
  responseKey: string;
  label: string;
  labelKey?: MessageKey;
  icon: string;
  openAi: boolean;
};

const getProviderLabel = (definition: ProviderDefinition, tFn?: (key: MessageKey) => string): string => {
  if (definition.labelKey) {
    return tFn ? tFn(definition.labelKey) : translate(getCurrentLocale(), definition.labelKey);
  }
  return definition.label;
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
  remark: string;
};

const providerDragId = (
  row: Pick<ProviderRow, 'section' | 'name' | 'apiKey' | 'baseUrl'>,
) => {
  const identity = `${row.section}\u0000${row.name}\u0000${row.apiKey}\u0000${row.baseUrl}`;
  let hash = 2166136261;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${row.section}:${(hash >>> 0).toString(36)}`;
};

function SortableProviderRow({
  row,
  disabled,
  dragLabel,
  isDragOver,
  children,
}: {
  row: ProviderRow;
  disabled: boolean;
  dragLabel: string;
  isDragOver: boolean;
  children: ReactNode;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: providerDragId(row),
    disabled,
    transition: {
      duration: 220,
      easing: 'cubic-bezier(0.2, 0, 0, 1)',
    },
  });
  const renderedTransform = transform
    ? {
      ...transform,
      scaleX: isDragging ? 1.012 : transform.scaleX,
      scaleY: isDragging ? 1.012 : transform.scaleY,
    }
    : transform;
  const style: CSSProperties = {
    position: 'relative',
    zIndex: isDragging ? 2 : undefined,
    transform: DndCss.Transform.toString(renderedTransform),
    transition: isDragging ? undefined : transition,
  };

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`real-provider-row${isDragging ? ' dragging' : ''}${isDragOver && !isDragging ? ' drag-over' : ''}`}
    >
      <button
        type="button"
        className="icon-button quiet provider-drag-handle"
        disabled={disabled}
        aria-label={dragLabel}
        title={dragLabel}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={17} aria-hidden="true" />
      </button>
      {children}
    </article>
  );
}

type ProviderSaveResult =
  | { saved: true }
  | { saved: false; error: string; target: 'form' | 'models' };

const requestErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export type ProviderDraft = {
  name: string;
  apiKey: string;
  remark: string;
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
  { id: 'codex-api-key', section: 'codex-api-key', responseKey: 'codex-api-key', label: 'Codex API', icon: codexIcon, openAi: false },
  {
    id: 'openai-compatibility',
    section: 'openai-compatibility',
    responseKey: 'openai-compatibility',
    label: 'OpenAI Compatible',
    labelKey: 'apiAccess.provider.openaiCompatibility',
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
      ? readString(record, 'name') || translate(getCurrentLocale(), 'apiAccess.compatibleName', { number: index + 1 })
      : getProviderLabel(definitionFor(section)),
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
    remark: '',
  };
};

const providerRemarkIdentity = (section: ProviderSection, apiKeys: string[]) =>
  `${section}\u0000${apiKeys.join('\u0000')}`;

const providerHealthIdentity = (row: ProviderRow) => [
  row.section,
  row.index,
  row.name,
  row.baseUrl,
  row.authIndex,
  readString(row.record, 'test-model', 'testModel'),
  row.apiKeys.join('\u0000'),
  row.models.map((model) => model.name).join('\u0000'),
].join('\u0001');

const providerModelType = (section: ProviderSection): ModelProvider => {
  if (section === 'gemini-api-key') return 'gemini';
  if (section === 'claude-api-key') return 'claude';
  if (section === 'codex-api-key') return 'codex';
  return 'openai';
};

const providerHeadersFromRecord = (record: Record<string, unknown>) =>
  isRecord(record.headers)
    ? Object.fromEntries(Object.entries(record.headers).map(([key, value]) => [key, String(value)]))
    : {};

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
  const seen = new Set<string>();
  return selected.reduce<Record<string, unknown>[]>((models, model) => {
    const name = model.name.trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) return models;
    seen.add(key);
    const matched = existing.find(
      (item) => isRecord(item) && readString(item, 'name').toLowerCase() === name.toLowerCase(),
    );
    const next: Record<string, unknown> = isRecord(matched) ? { ...matched } : {};
    next.name = name;
    const alias = model.alias?.trim();
    if (alias && alias !== name) next.alias = alias;
    else delete next.alias;
    if (model.thinking) next.thinking = { ...model.thinking };
    models.push(next);
    return models;
  }, []);
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

export const parseProviderApiKeys = (value: string) => value
  .split(/\r?\n/)
  .map((item) => item.trim())
  .filter((item, index, values) => item && values.indexOf(item) === index);

const mergeOpenAiApiKeyEntries = (current: unknown, apiKey: string) => {
  const entries = Array.isArray(current) ? current.filter(isRecord) : [];
  const keys = parseProviderApiKeys(apiKey);
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

const draftFromRow = (row: ProviderRow): ProviderDraft => {
  const definition = definitionFor(row.section);
  const isDeepSeek = row.section === 'openai-compatibility' && isDeepSeekRecord(row.record);
  return {
    name: row.name,
    apiKey: definition.openAi ? row.apiKeys.join('\n') : row.apiKey,
    remark: row.remark || (definition.openAi && !isDeepSeek ? row.name : ''),
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
    thinkingLevels: definition.openAi
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
  };
};

const emptyProviderDraft = (): ProviderDraft => ({
  name: '',
  apiKey: '',
  remark: '',
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

export const createProviderDraft = (category: ProviderCategory): ProviderDraft => {
  const draft = emptyProviderDraft();
  if (category === 'openai-compatibility') return { ...draft, thinkingLevels: [] };
  if (category !== 'deepseek') return draft;
  return {
    ...draft,
    name: 'DeepSeek',
    remark: '',
    baseUrl: DEEPSEEK_BASE_URL,
    thinkingLevels: [...DEEPSEEK_THINKING_LEVELS],
  };
};

export const applyProviderRemarkIdentity = (
  category: ProviderCategory,
  draft: ProviderDraft,
): ProviderDraft => category === 'deepseek'
  ? { ...draft, name: draft.name.trim() || 'DeepSeek' }
  : definitionFor(category).openAi
    ? { ...draft, name: draft.remark.trim() }
    : draft;

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
    if (separator <= 0) throw new Error(translate(getCurrentLocale(), 'apiAccess.error.headerMissingColon', { number: index + 1 }));
    const key = trimmed.slice(0, separator).trim();
    const headerValue = trimmed.slice(separator + 1).trim();
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || !headerValue) {
      throw new Error(translate(getCurrentLocale(), 'apiAccess.error.headerInvalid', { number: index + 1 }));
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

const providerIdentityMatches = (
  row: ProviderRecordIdentity,
  record: Record<string, unknown>,
) => {
  if (definitionFor(row.section).openAi) {
    return readString(record, 'name') === row.name;
  }
  return (
    readString(record, 'api-key', 'apiKey') === row.apiKey
    && readString(record, 'base-url', 'baseUrl') === row.baseUrl
  );
};

export type ProviderRecordIdentity = Pick<
  ProviderRow,
  'section' | 'index' | 'name' | 'apiKey' | 'baseUrl'
>;

const providerPrimaryIdentityMatches = (
  row: ProviderRecordIdentity,
  record: Record<string, unknown>,
) => definitionFor(row.section).openAi
  ? readString(record, 'name') === row.name
  : readString(record, 'api-key', 'apiKey') === row.apiKey;

export const resolveProviderRecordIndex = (
  records: Record<string, unknown>[],
  row: ProviderRecordIdentity,
) => {
  const exactIndex = records.findIndex((record) => providerIdentityMatches(row, record));
  if (exactIndex >= 0) return exactIndex;

  const indexedRecord = records[row.index];
  if (indexedRecord && providerPrimaryIdentityMatches(row, indexedRecord)) {
    return row.index;
  }

  const primaryMatches = records
    .map((record, index) => ({ record, index }))
    .filter(({ record }) => providerPrimaryIdentityMatches(row, record));
  return primaryMatches.length === 1 ? primaryMatches[0].index : -1;
};

export const reorderProviderRecords = (
  records: Record<string, unknown>[],
  scopeRows: ProviderRecordIdentity[],
  source: ProviderRecordIdentity,
  target: ProviderRecordIdentity,
) => {
  const sourceIndex = resolveProviderRecordIndex(records, source);
  const targetIndex = resolveProviderRecordIndex(records, target);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return null;

  const scopedIndexes = scopeRows
    .map((row) => resolveProviderRecordIndex(records, row))
    .filter((index, position, indexes) => index >= 0 && indexes.indexOf(index) === position)
    .sort((left, right) => left - right);
  const sourcePosition = scopedIndexes.indexOf(sourceIndex);
  const targetPosition = scopedIndexes.indexOf(targetIndex);
  if (sourcePosition < 0 || targetPosition < 0) return null;

  const reordered = scopedIndexes.map((index) => stripResponseFields(records[index]));
  const [moved] = reordered.splice(sourcePosition, 1);
  reordered.splice(targetPosition, 0, moved);

  const next = records.map(stripResponseFields);
  scopedIndexes.forEach((recordIndex, position) => {
    next[recordIndex] = reordered[position];
  });
  return next;
};

export const providerRecordWithDisabledState = (
  section: ProviderSection,
  record: Record<string, unknown>,
  disabled: boolean,
) => {
  const nextRecord = stripResponseFields(record);
  if (definitionFor(section).openAi) {
    nextRecord.disabled = disabled;
    return nextRecord;
  }

  const excludedModels = Array.isArray(nextRecord['excluded-models'])
    ? nextRecord['excluded-models'].map(String).filter((model) => model.trim() !== '*')
    : [];
  if (disabled) excludedModels.push('*');
  if (excludedModels.length > 0) nextRecord['excluded-models'] = excludedModels;
  else delete nextRecord['excluded-models'];
  return nextRecord;
};

export function ApiAccessPage() {
  const { t } = useI18n();
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
  const [apiAccessRemarks, setApiAccessRemarks] = useState<Record<string, string>>({});
  const [healthDialogRow, setHealthDialogRow] = useState<ProviderRow | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const activeDefinition = definitionFor(activeCategory);
  const activeSection = activeDefinition.section;
  const dragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
            failures.push(`${getProviderLabel(definition, t)}：${String(result.reason)}`);
          }
        });
        return next;
      });
      if (failures.length > 0) {
        setError(t('apiAccess.error.partialLoad', { errors: failures.join('; ') }));
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

  useEffect(() => {
    const providerRows = (Object.entries(records) as [ProviderSection, Record<string, unknown>[]][])
      .flatMap(([section, items]) => items.map((record, index) => rowFromRecord(section, record, index)));
    if (providerRows.length === 0) {
      setApiAccessRemarks({});
      return;
    }
    let disposed = false;
    void invoke<string[]>('resolve_api_access_remarks', {
      queries: providerRows.map((row) => ({
        providerSection: row.section,
        apiKeys: row.apiKeys,
      })),
    }).then((remarks) => {
      if (disposed) return;
      setApiAccessRemarks(Object.fromEntries(providerRows.map((row, index) => [
        providerRemarkIdentity(row.section, row.apiKeys),
        remarks[index] ?? '',
      ])));
    }).catch(() => {
      if (!disposed) setApiAccessRemarks({});
    });
    return () => {
      disposed = true;
    };
  }, [records]);

  const rows = useMemo(
    () =>
      records[activeSection]
        .map((record, index) => rowFromRecord(activeSection, record, index))
        .map((row) => ({
          ...row,
          remark: apiAccessRemarks[providerRemarkIdentity(row.section, row.apiKeys)] ?? '',
        }))
        .filter((row) => providerCategoryMatchesRecord(activeCategory, row.record))
        .filter((row) => {
          const query = filter.trim().toLowerCase();
          if (!query) return true;
          return [row.remark || row.name, row.apiKey, row.baseUrl, row.models.map((model) => model.name).join(' ')]
            .join(' ')
            .toLowerCase()
            .includes(query);
        }),
    [activeCategory, activeSection, apiAccessRemarks, filter, records],
  );

  const openCreate = () => {
    setError('');
    setEditingRow(null);
    setDialogDraft(createProviderDraft(activeCategory));
    setDialogOpen(true);
  };

  const openEdit = (row: ProviderRow) => {
    setError('');
    setEditingRow(row);
    const draft = draftFromRow(row);
    setDialogDraft(activeCategory === 'deepseek'
      ? { ...draft, thinkingLevels: [...DEEPSEEK_THINKING_LEVELS] }
      : draft);
    setDialogOpen(true);
  };

  const saveProvider = async (nextDraft: ProviderDraft): Promise<ProviderSaveResult> => {
    const definition = activeDefinition;
    const preparedDraft = applyProviderRemarkIdentity(
      activeCategory,
      applyProviderPreset(activeCategory, nextDraft),
    );
    const preparedDraftForSave = {
      ...preparedDraft,
      models: preparedDraft.models.filter((model) => model.name.trim()),
    };
    const baseUrlRequired = definition.openAi || definition.section === 'codex-api-key';
    const remarkRequired = definition.openAi && activeCategory !== 'deepseek';
    const parsedApiKeys = parseProviderApiKeys(preparedDraft.apiKey);
    if (
      parsedApiKeys.length === 0
      || (remarkRequired && !preparedDraft.remark.trim())
      || (baseUrlRequired && !preparedDraft.baseUrl.trim())
    ) {
      return {
        saved: false,
        target: 'form',
        error: definition.openAi
          ? t('apiAccess.error.requiredAll')
          : baseUrlRequired
            ? t('apiAccess.error.requiredBaseKey')
            : t('apiAccess.error.requiredKey'),
      };
    }
    if (Array.from(preparedDraft.remark.trim()).length > 80 || /[\u0000-\u001f\u007f]/.test(preparedDraft.remark)) {
      return { saved: false, target: 'form', error: t('apiAccess.error.remarkInvalid') };
    }
    let baseUrl = preparedDraft.baseUrl.trim();
    let providerHeaders: Record<string, string> = {};
    try {
      if (baseUrl) baseUrl = normalizeBaseUrl(baseUrl);
      if (baseUrlRequired && !baseUrl) throw new Error(t('apiAccess.error.baseRequired', { provider: getProviderLabel(definition, t) }));
      providerHeaders = parseProviderHeaders(preparedDraft.headersText ?? '');
    } catch (requestError) {
      return { saved: false, target: 'form', error: requestErrorMessage(requestError) };
    }
    setBusy(true);
    setError('');
    try {
      let draftToSave = { ...preparedDraftForSave, baseUrl };
      if (definition.openAi && draftToSave.models.length === 0) {
        let fetchedModels: ModelOption[];
        try {
          fetchedModels = await fetchModels(
            'openai',
            baseUrl,
            parsedApiKeys[0],
            editingRow?.authIndex,
            providerHeaders,
          );
          if (fetchedModels.length === 0) {
            throw new Error(t('apiAccess.error.noModels'));
          }
        } catch (requestError) {
          return {
            saved: false,
            target: 'models',
            error: requestErrorMessage(requestError),
          };
        }
        draftToSave = applyProviderPreset(activeCategory, {
          ...draftToSave,
          models: fetchedModels,
        });
      }
      const latestConfig = await managementApi.get('/config');
      const current = sectionRecordsFromConfig(latestConfig, activeSection);
      let nextList: Record<string, unknown>[];
      let targetIndex = -1;
      let currentRecord: Record<string, unknown> | undefined;

      if (editingRow) {
        targetIndex = resolveProviderRecordIndex(current, editingRow);
        if (targetIndex < 0) {
          throw new Error(t('apiAccess.error.stale'));
        }
        currentRecord = current[targetIndex];
      }

      const duplicate = current.some((record, index) => {
        if (index === targetIndex) return false;
        if (definition.openAi) return readString(record, 'name') === preparedDraft.name.trim();
        return parsedApiKeys.some((apiKey) => (
          readString(record, 'api-key', 'apiKey').trim() === apiKey
          && readString(record, 'base-url', 'baseUrl').trim() === baseUrl
        ));
      });
      if (duplicate) throw new Error(t('apiAccess.error.duplicate'));

      const recordsToSave = definition.openAi
        ? [buildProviderRecord(activeSection, draftToSave, currentRecord)]
        : parsedApiKeys.map((apiKey) => buildProviderRecord(
          activeSection,
          { ...draftToSave, apiKey },
          currentRecord,
        ));
      nextList = editingRow
        ? [
          ...current.slice(0, targetIndex),
          ...recordsToSave,
          ...current.slice(targetIndex + 1),
        ]
        : [...current, ...recordsToSave];

      await managementApi.put(`/${activeSection}`, nextList.map(stripResponseFields));
      await invoke('save_api_access_remark', {
        update: {
          providerSection: activeSection,
          previousApiKeys: editingRow?.apiKeys ?? [],
          apiKeys: parsedApiKeys,
          remark: draftToSave.remark,
        },
      });
      setNotice(editingRow ? t('apiAccess.notice.updated') : t('apiAccess.notice.added'));
      await loadProviders();
      return { saved: true };
    } catch (requestError) {
      return { saved: false, target: 'form', error: requestErrorMessage(requestError) };
    } finally {
      setBusy(false);
    }
  };

  const deleteRow = async (row: ProviderRow) => {
    if (!window.confirm(t('apiAccess.deleteConfirm', { remark: row.remark || row.name }))) return;
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
      await invoke('save_api_access_remark', {
        update: {
          providerSection: row.section,
          previousApiKeys: row.apiKeys,
          apiKeys: [],
          remark: '',
        },
      });
      setNotice(t('apiAccess.notice.deleted'));
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
    setNotice('');
    try {
      const latestConfig = await managementApi.get('/config');
      const latestRows = sectionRecordsFromConfig(latestConfig, row.section);
      const targetIndex = resolveProviderRecordIndex(latestRows, row);
      if (targetIndex < 0) {
        throw new Error(t('apiAccess.error.stale'));
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
        const nextRecord = providerRecordWithDisabledState(
          row.section,
          latestRecord,
          !currentlyDisabled,
        );
        const nextRows = latestRows.map((record, index) =>
          index === targetIndex ? nextRecord : stripResponseFields(record),
        );
        await managementApi.put(`/${row.section}`, nextRows);
      }
      if (!currentlyDisabled) setNotice(t('apiAccess.notice.disabled'));
      await loadProviders();
    } catch (requestError) {
      setError(String(requestError));
    } finally {
      setBusy(false);
    }
  };

  const reorderProviders = async (source: ProviderRow, target: ProviderRow) => {
    if (source.section !== target.section || source.index === target.index) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const latestConfig = await managementApi.get('/config');
      const latestRows = sectionRecordsFromConfig(latestConfig, source.section);
      const nextRows = reorderProviderRecords(latestRows, rows, source, target);
      if (!nextRows) throw new Error(t('apiAccess.error.stale'));
      await managementApi.put(`/${source.section}`, nextRows);
      await loadProviders();
    } catch (requestError) {
      await loadProviders();
      setError(requestErrorMessage(requestError));
    } finally {
      setDragOverId(null);
      setBusy(false);
    }
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragOverId(null);
    const source = rows.find((row) => providerDragId(row) === String(event.active.id));
    const target = rows.find((row) => providerDragId(row) === String(event.over?.id ?? ''));
    if (!source || !target || source.index === target.index) return;

    const optimisticRows = reorderProviderRecords(
      records[source.section],
      rows,
      source,
      target,
    );
    if (optimisticRows) {
      setRecords((current) => ({ ...current, [source.section]: optimisticRows }));
    }
    void reorderProviders(source, target);
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
          <h1>{t('apiAccess.title')}</h1>
        </div>
        <div className="management-heading-actions">
          <span className="muted-summary">{t('apiAccess.count', { count: totalCount })}</span>
          <button type="button" className="secondary-button compact-button" onClick={() => void loadProviders()} disabled={loading || busy}>
            <RefreshCw size={16} aria-hidden="true" />
            {t('common.refresh')}
          </button>
          <button type="button" className="primary-button compact-button" onClick={openCreate} disabled={loading || busy}>
            <Plus size={16} aria-hidden="true" />
            {t('apiAccess.add')}
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
              <span title={getProviderLabel(definition, t)}>{getProviderLabel(definition, t)}</span>
              <strong>{countForDefinition(definition)}</strong>
            </button>
          ))}
        </aside>

        <section className="panel provider-resource-panel">
          <div className="management-panel-heading">
            <div>
              <h2 title={getProviderLabel(activeDefinition, t)}>{getProviderLabel(activeDefinition, t)}</h2>
              <span>{t('apiAccess.matches', { count: rows.length })}</span>
            </div>
            <div className="management-toolbar compact-toolbar">
              <Search size={16} aria-hidden="true" />
              <input value={filter} onChange={(event) => setFilter(event.currentTarget.value)} placeholder={t('apiAccess.search')} />
            </div>
          </div>

          {loading ? (
            <div className="management-loading"><LoaderCircle size={20} className="spin" />{t('apiAccess.loading')}</div>
          ) : rows.length === 0 ? (
            <div className="management-empty">
              <Filter size={24} aria-hidden="true" />
              <strong>{filter ? t('apiAccess.empty.filtered') : t('apiAccess.empty.none')}</strong>
              <span>{filter ? t('apiAccess.empty.tryKeyword') : t('apiAccess.empty.addFirst')}</span>
            </div>
          ) : (
            <DndContext
              sensors={dragSensors}
              collisionDetection={closestCenter}
              onDragStart={() => setNotice('')}
              onDragOver={({ over }) => setDragOverId(over ? String(over.id) : null)}
              onDragCancel={() => setDragOverId(null)}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={rows.map(providerDragId)}
                strategy={verticalListSortingStrategy}
              >
                <div className="real-provider-list">
                  {rows.map((row) => (
                    <SortableProviderRow
                      key={providerDragId(row)}
                      row={row}
                      disabled={busy || rows.length < 2}
                      dragLabel={t('apiAccess.dragHandle', { remark: row.remark || row.name })}
                      isDragOver={dragOverId === providerDragId(row)}
                    >
                  <div className="provider-row-main">
                    <div className="provider-row-title">
                      <strong title={row.remark || row.name}>{row.remark || row.name}</strong>
                    </div>
                    <code title={definitionFor(row.section).openAi ? t('apiAccess.keys.count', { count: row.apiKeys.length }) : undefined}>
                      {definitionFor(row.section).openAi && row.apiKeys.length > 1
                        ? t('apiAccess.keys.summary', { key: maskSecret(row.apiKey), count: row.apiKeys.length })
                        : maskSecret(row.apiKey)}
                    </code>
                    <span className="provider-row-url" title={row.baseUrl || undefined}>{row.baseUrl || t('apiAccess.defaultUrl')}</span>
                    {row.models.length > 0 ? <span className="provider-row-models">{t('apiAccess.models.summary', { count: row.models.length })}</span> : null}
                  </div>
                  {row.priority === null ? null : (
                    <div className="provider-row-meta">
                      <span>{t('apiAccess.priorityValue', { priority: row.priority })}</span>
                    </div>
                  )}
                  <div className="provider-row-actions">
                    <button
                      type="button"
                      className="secondary-button provider-health-button"
                      onClick={() => setHealthDialogRow(row)}
                      disabled={busy}
                    >
                      {t('apiAccess.health.action')}
                    </button>
                    <label className="provider-enabled-control" title={row.disabled ? t('apiAccess.enable') : t('apiAccess.disable')}>
                      <span>{row.disabled ? t('apiAccess.status.disabled') : t('apiAccess.status.enabled')}</span>
                      <span className="switch-control">
                        <input
                          type="checkbox"
                          checked={!row.disabled}
                          onChange={() => void toggleProvider(row)}
                          disabled={busy}
                          aria-label={t('apiAccess.toggleAria', { remark: row.remark || row.name, action: row.disabled ? t('common.enable') : t('common.disable') })}
                        />
                        <span className="switch-track" />
                      </span>
                    </label>
                    <button type="button" className="icon-button quiet" onClick={() => openEdit(row)} disabled={busy} title={t('common.edit')}>
                      <Edit3 size={16} />
                    </button>
                    <button type="button" className="icon-button danger" onClick={() => void deleteRow(row)} disabled={busy} title={t('common.delete')}>
                      <Trash2 size={16} />
                    </button>
                  </div>
                    </SortableProviderRow>
                  ))}
                </div>
              </SortableContext>
            </DndContext>
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
      {healthDialogRow ? (
        <ProviderHealthDialog
          key={providerHealthIdentity(healthDialogRow)}
          row={healthDialogRow}
          onClose={() => setHealthDialogRow(null)}
        />
      ) : null}
    </section>
  );
}

type ProviderHealthDialogProps = {
  row: ProviderRow;
  onClose: () => void;
};

type ProviderModelHealthState = { status: 'checking' } | ProviderModelHealthResult;

function ProviderHealthDialog({ row, onClose }: ProviderHealthDialogProps) {
  const { t } = useI18n();
  const configuredModels = useMemo(
    () => mergeProviderHealthModels([], row.models),
    [row.models],
  );
  const [models, setModels] = useState<ModelOption[]>(configuredModels);
  const [modelLoading, setModelLoading] = useState(true);
  const [modelError, setModelError] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<Record<string, ProviderModelHealthState>>({});
  const [checkingAll, setCheckingAll] = useState(false);

  const healthOptions = useMemo<ProviderHealthCheckOptions>(() => ({
    provider: providerModelType(row.section),
    baseUrl: row.baseUrl,
    apiKeys: row.apiKeys,
    authIndex: row.authIndex,
    customHeaders: providerHeadersFromRecord(row.record),
    timeoutMs: PROVIDER_HEALTH_TIMEOUT_MS,
  }), [row]);

  useEffect(() => {
    let disposed = false;
    setModelLoading(true);
    setModelError('');
    void fetchModels(
      healthOptions.provider,
      healthOptions.baseUrl,
      row.apiKeys.find((key) => key.trim()) ?? '',
      healthOptions.authIndex,
      healthOptions.customHeaders,
      healthOptions.timeoutMs,
    ).then((discovered) => {
      if (!disposed) setModels(mergeProviderHealthModels(discovered, row.models));
    }).catch((requestError) => {
      if (!disposed) setModelError(String(requestError).replace(/^Error:\s*/i, ''));
    }).finally(() => {
      if (!disposed) setModelLoading(false);
    });
    return () => {
      disposed = true;
    };
  }, [healthOptions, row.apiKeys, row.models]);

  const visibleModels = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return models;
    return models.filter((model) =>
      `${model.name} ${model.alias ?? ''}`.toLowerCase().includes(query),
    );
  }, [models, search]);

  const resultValues = Object.values(results);
  const checkedCount = resultValues.filter((result) => result.status !== 'checking').length;
  const healthyCount = resultValues.filter((result) => result.status === 'healthy').length;
  const failedCount = resultValues.filter((result) => result.status === 'failed').length;
  const hasCheckingModel = resultValues.some((result) => result.status === 'checking');

  const saveResult = (result: ProviderModelHealthResult) => {
    setResults((current) => ({
      ...current,
      [result.model.toLowerCase()]: result,
    }));
  };

  const checkOneModel = async (model: ModelOption) => {
    const key = model.name.toLowerCase();
    setResults((current) => ({ ...current, [key]: { status: 'checking' } }));
    saveResult(await checkProviderModelHealth(healthOptions, model.name));
  };

  const checkAllModels = async () => {
    if (models.length === 0) return;
    setCheckingAll(true);
    setResults(Object.fromEntries(models.map((model) => [
      model.name.toLowerCase(),
      { status: 'checking' } satisfies ProviderModelHealthState,
    ])));
    try {
      await checkProviderModelsHealth(healthOptions, models, saveResult);
    } finally {
      setCheckingAll(false);
    }
  };

  const statusLabel = (state: ProviderModelHealthState | undefined) => {
    if (!state) return t('apiAccess.health.notChecked');
    if (state.status === 'checking') return t('apiAccess.health.checking');
    return state.status === 'healthy'
      ? t('apiAccess.health.healthy')
      : t('apiAccess.health.failed');
  };

  return (
    <div className="model-discovery-backdrop" onMouseDown={(event) => event.currentTarget === event.target && onClose()}>
      <section className="model-discovery-dialog provider-health-dialog" role="dialog" aria-modal="true" aria-labelledby="provider-health-title">
        <div className="model-discovery-header">
          <div>
            <h2 id="provider-health-title">{t('apiAccess.health.title')}</h2>
            <span>{t('apiAccess.health.description', { provider: row.remark || row.name })}</span>
          </div>
          <button type="button" className="icon-button quiet" onClick={onClose} title={t('common.close')}>
            <X size={18} />
          </button>
        </div>

        <div className="model-discovery-search">
          <Search size={16} aria-hidden="true" />
          <input value={search} onChange={(event) => setSearch(event.currentTarget.value)} placeholder={t('apiAccess.health.search')} />
        </div>

        <div className="provider-health-overview">
          <p>{t('apiAccess.health.warning')}</p>
          <span>{t('apiAccess.health.summary', {
            checked: checkedCount,
            total: models.length,
            healthy: healthyCount,
            failed: failedCount,
          })}</span>
          {modelError ? (
            <small className="error" title={modelError}>{t('apiAccess.health.modelLoadFailed', { error: modelError })}</small>
          ) : modelLoading ? (
            <small>{t('apiAccess.health.loadingModels')}</small>
          ) : null}
        </div>

        <div className="model-discovery-list provider-health-model-list">
          {modelLoading && models.length === 0 ? (
            <div className="model-discovery-message"><LoaderCircle size={20} className="spin" /><strong>{t('apiAccess.health.loadingModels')}</strong></div>
          ) : visibleModels.length === 0 ? (
            <div className="model-discovery-message"><strong>{models.length ? t('apiAccess.health.noMatch') : t('apiAccess.health.noModel')}</strong></div>
          ) : visibleModels.map((model) => {
            const state = results[model.name.toLowerCase()];
            const checked = state && state.status !== 'checking' ? state : null;
            const error = checked?.status === 'failed'
              ? checked.errorCode === 'missing-direct-key'
                ? t('apiAccess.health.missingDirectKey')
                : checked.timedOut
                  ? t('apiAccess.health.timeout')
                  : checked.error || t('apiAccess.health.failed')
              : '';
            const latencyTitle = checked?.firstTokenLatencyMs !== undefined
              ? t('apiAccess.health.firstTokenLatencyResult', { latency: checked.firstTokenLatencyMs })
              : checked?.responseLatencyMs !== undefined
                ? t('apiAccess.health.responseLatencyResult', { latency: checked.responseLatencyMs })
                : error || undefined;
            const latencyInline = checked?.firstTokenLatencyMs !== undefined
              ? t('apiAccess.health.firstTokenInline', { latency: checked.firstTokenLatencyMs })
              : checked?.responseLatencyMs !== undefined
                ? t('apiAccess.health.responseInline', { latency: checked.responseLatencyMs })
                : '';
            return (
              <div className={`provider-health-model-row ${checked?.status === 'failed' ? 'failed' : ''}`} key={model.name}>
                <div className="provider-health-model-name">
                  <strong title={model.name}>{model.name}</strong>
                  {error
                    ? <small className="error" title={error}>{error}</small>
                    : model.alias
                      ? <small title={model.alias}>{model.alias}</small>
                      : null}
                </div>
                <span
                  className={`state-pill provider-health-pill ${state?.status === 'checking' ? 'checking' : checked?.status === 'healthy' ? 'success' : checked?.status === 'failed' ? 'error' : ''}`}
                  title={latencyTitle}
                >
                  {statusLabel(state)}
                  {latencyInline ? ` · ${latencyInline}` : ''}
                </span>
                <button
                  type="button"
                  className="secondary-button compact-button provider-health-single-button"
                  onClick={() => void checkOneModel(model)}
                  disabled={modelLoading || checkingAll || state?.status === 'checking'}
                >
                  {checked ? t('apiAccess.health.retryOne') : t('apiAccess.health.checkOne')}
                </button>
              </div>
            );
          })}
        </div>

        <div className="model-discovery-actions provider-health-actions">
          <button type="button" className="secondary-button compact-button" onClick={onClose}>{t('common.close')}</button>
          <button
            type="button"
            className="primary-button compact-button"
            onClick={() => void checkAllModels()}
            disabled={modelLoading || models.length === 0 || hasCheckingModel}
          >
            {checkingAll
              ? t('apiAccess.health.checkingProgress', { checked: checkedCount, total: models.length })
              : t('apiAccess.health.checkAll')}
          </button>
        </div>
      </section>
    </div>
  );
}

type ApiProviderDialogProps = {
  activeCategory: ProviderCategory;
  editingRow: ProviderRow | null;
  initialDraft: ProviderDraft;
  busy: boolean;
  onClose: () => void;
  onSave: (draft: ProviderDraft) => Promise<ProviderSaveResult>;
};

function ApiProviderDialog({
  activeCategory,
  editingRow,
  initialDraft,
  busy,
  onClose,
  onSave,
}: ApiProviderDialogProps) {
  const { t } = useI18n();
  const definition = definitionFor(activeCategory);
  const activeSection = definition.section;
  const [draft, setDraft] = useState<ProviderDraft>(initialDraft);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const [formError, setFormError] = useState('');
  const [discoveredModels, setDiscoveredModels] = useState<ModelOption[]>([]);
  const [modelDiscoveryOpen, setModelDiscoveryOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const [thinkingLevelInput, setThinkingLevelInput] = useState('');
  const [selectedModelNames, setSelectedModelNames] = useState<Set<string>>(
    () => new Set(initialDraft.models.map((model) => model.name.toLowerCase())),
  );
  const modelCardRef = useRef<HTMLDivElement>(null);

  const modelOptions = useMemo(() => {
    const options = new Map<string, ModelOption>();
    [...discoveredModels, ...draft.models].forEach((model) => {
      const name = model.name.trim();
      if (name) options.set(name.toLowerCase(), { ...model, name });
    });
    return Array.from(options.values());
  }, [discoveredModels, draft.models]);

  const configuredModels = useMemo(
    () => draft.models.filter((model) => model.name.trim()),
    [draft.models],
  );

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
    field: 'apiKey' | 'remark' | 'baseUrl' | 'priority' | 'prefix' | 'headersText' | 'excludedModelsText' | 'testModel' | 'cloakMode' | 'cloakSensitiveWordsText',
    value: string,
  ) => {
    setFormError('');
    if (field === 'apiKey' || field === 'baseUrl' || field === 'headersText') {
      setModelError('');
    }
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const updateBooleanField = (
    field: 'disableCooling' | 'websockets' | 'cloakStrictMode' | 'cloakCacheUserId',
    value: boolean,
  ) => {
    setFormError('');
    setDraft((current) => ({ ...current, [field]: value }));
  };

  const updateModel = (index: number, patch: Partial<ModelOption>) => {
    setDraft((current) => ({
      ...current,
      models: current.models.map((model, modelIndex) =>
        modelIndex === index ? { ...model, ...patch } : model,
      ),
    }));
  };

  const addModel = () => {
    setDraft((current) => ({
      ...current,
      models: [...current.models, { name: '', alias: '' }],
    }));
  };

  const removeModel = (index: number) => {
    setDraft((current) => ({
      ...current,
      models: current.models.filter((_, modelIndex) => modelIndex !== index),
    }));
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
      setModelError(t('apiAccess.error.enterBaseUrl'));
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
      setSelectedModelNames(new Set(
        [...models, ...draft.models]
          .map((model) => model.name.trim().toLowerCase())
          .filter(Boolean),
      ));
      if (!models.length) setModelError(t('apiAccess.error.noAvailableModels'));
    } catch (requestError) {
      setModelError(requestErrorMessage(requestError));
    } finally {
      setModelLoading(false);
    }
  };

  const openModelDiscovery = () => {
    const baseUrlRequired =
      activeSection === 'codex-api-key' || activeSection === 'openai-compatibility';
    if (baseUrlRequired && !draft.baseUrl.trim()) {
      setModelError(t('apiAccess.error.baseBeforeModels'));
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
    setFormError('');
    const result = await onSave(draft);
    if (result.saved) {
      onClose();
      return;
    }
    if (result.target === 'models') {
      setModelError(result.error);
      window.requestAnimationFrame(() => {
        modelCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return;
    }
    setFormError(result.error);
  };

  const hasModelExclusions = activeSection !== 'openai-compatibility'
    && Boolean(draft.excludedModelsText?.trim());
  const modelSummaryTitle = configuredModels.length > 0
    ? t('apiAccess.models.selected', { count: configuredModels.length })
    : hasModelExclusions
      ? t('apiAccess.models.restricted')
      : activeSection === 'openai-compatibility'
        ? t('apiAccess.models.autoAll')
        : t('apiAccess.models.upstreamDefault');
  const modelSummaryDetail = configuredModels.length > 0
    ? configuredModels.slice(0, 3).map((model) => model.name).join('、')
    : hasModelExclusions
      ? t('apiAccess.models.hiddenHint')
      : activeSection === 'openai-compatibility'
        ? t('apiAccess.models.autoHint')
        : t('apiAccess.models.allHint');

  return (
    <>
      <div className="config-dialog-backdrop" onMouseDown={(event) => event.currentTarget === event.target && !busy && onClose()}>
      <form className="config-dialog management-dialog api-provider-dialog" onSubmit={(event) => void submit(event)}>
        <div className="config-dialog-heading">
          <div>
            <Plus size={19} aria-hidden="true" />
            <h2>{editingRow ? t('apiAccess.dialog.edit') : t('apiAccess.dialog.add')}</h2>
          </div>
          <button type="button" className="icon-button quiet" onClick={onClose} disabled={busy} title={t('common.close')}>
            <X size={18} />
          </button>
        </div>
        <label><span>{t('apiAccess.field.remark')}</span><input autoFocus={definition.openAi} value={draft.remark} maxLength={80} onChange={(event) => updateTextField('remark', event.currentTarget.value)} placeholder={t('apiAccess.remarkPlaceholder')} /></label>
        <label className="multiline-field">
          <span>{t('apiAccess.field.keysMany')}</span>
          <textarea
            autoFocus={!definition.openAi}
            value={draft.apiKey}
            onChange={(event) => updateTextField('apiKey', event.currentTarget.value)}
            placeholder={'sk-...\nsk-...'}
            rows={3}
          />
        </label>
        <label><span>Base URL</span><input value={draft.baseUrl} onChange={(event) => updateTextField('baseUrl', event.currentTarget.value)} placeholder={activeSection === 'codex-api-key' || activeSection === 'openai-compatibility' ? t('apiAccess.baseRequiredPlaceholder') : t('apiAccess.baseOptionalPlaceholder')} /></label>
        {activeCategory === 'deepseek' ? (
          <div className="provider-preset-summary">
            <img src={deepseekIcon} alt="" className="provider-logo" />
            <div>
              <strong>{t('apiAccess.preset.title')}</strong>
              <span>{t('apiAccess.preset.description')}</span>
            </div>
          </div>
        ) : null}
        {activeCategory === 'deepseek' ? (
          <div className="thinking-level-config">
            <div className="thinking-level-heading">
              <strong>{t('apiAccess.thinking.builtIn')}</strong>
              <span>{t('apiAccess.thinking.builtInDescription')}</span>
            </div>
            <div className="thinking-level-tags readonly">
              {DEEPSEEK_THINKING_LEVELS.map((level) => <span key={level}>{level}</span>)}
            </div>
          </div>
        ) : activeCategory === 'openai-compatibility' ? (
          <div className="thinking-level-config">
            <div className="thinking-level-heading">
              <strong>{t('apiAccess.thinking.title')}</strong>
              <span>{t('apiAccess.thinking.description')}</span>
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
                placeholder={t('apiAccess.thinking.placeholder')}
              />
              <button type="button" className="secondary-button compact-button" onClick={addThinkingLevel} disabled={!thinkingLevelInput.trim()}>
                <Plus size={14} />{t('apiAccess.thinking.add')}
              </button>
            </div>
            {(draft.thinkingLevels?.length ?? 0) > 0 ? (
              <div className="thinking-level-tags">
                {draft.thinkingLevels?.map((level) => (
                  <span key={level}>
                    {level}
                    <button type="button" onClick={() => removeThinkingLevel(level)} title={t('apiAccess.thinking.delete', { level })} aria-label={t('apiAccess.thinking.deleteAria', { level })}>
                      <X size={12} />
                    </button>
                  </span>
                ))}
              </div>
            ) : <small className="thinking-level-empty">{t('apiAccess.thinking.empty')}</small>}
            </div>
        ) : null}
        <div className="model-config-card" ref={modelCardRef}>
          <div className="model-config-heading">
            <div><span>{t('apiAccess.models.title')}</span><small>{t('apiAccess.models.description')}</small></div>
            <button type="button" className="secondary-button compact-button" onClick={openModelDiscovery} disabled={busy}>
              <RefreshCw size={15} />{t('apiAccess.models.fetch')}
            </button>
          </div>
          <div className={`model-config-summary ${configuredModels.length || hasModelExclusions ? 'has-models' : ''}`}>
            <strong>{modelSummaryTitle}</strong>
            <span>{modelSummaryDetail}</span>
          </div>
          <div className="model-config-entries">
            {draft.models.map((model, index) => (
              <div className="model-config-entry" key={index}>
                <input
                  value={model.name}
                  onChange={(event) => updateModel(index, { name: event.currentTarget.value })}
                  placeholder={t('apiAccess.models.namePlaceholder')}
                  aria-label={t('apiAccess.models.namePlaceholder')}
                  disabled={busy}
                />
                <input
                  value={model.alias ?? ''}
                  onChange={(event) => updateModel(index, { alias: event.currentTarget.value })}
                  placeholder={t('apiAccess.models.aliasPlaceholder')}
                  aria-label={t('apiAccess.models.aliasPlaceholder')}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="icon-button quiet danger"
                  onClick={() => removeModel(index)}
                  disabled={busy}
                  title={t('apiAccess.models.remove')}
                  aria-label={t('apiAccess.models.remove')}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="secondary-button compact-button model-config-add" onClick={addModel} disabled={busy}>
              <Plus size={14} />{t('apiAccess.models.add')}
            </button>
          </div>
          {modelError && !modelDiscoveryOpen ? <small className="model-picker-error">{modelError}</small> : null}
        </div>
        <label><span>{t('apiAccess.field.priority')}</span><input inputMode="numeric" value={draft.priority} onChange={(event) => updateTextField('priority', event.currentTarget.value.replace(/\D/g, ''))} placeholder={t('common.optional')} /></label>
        <details className="provider-advanced-settings">
          <summary>{t('apiAccess.advanced')}</summary>
          <div className="provider-advanced-fields">
            <label><span>{t('apiAccess.field.prefix')}</span><input value={draft.prefix ?? ''} onChange={(event) => updateTextField('prefix', event.currentTarget.value)} placeholder={t('apiAccess.prefixPlaceholder')} /></label>
            <label className="multiline-field">
              <span>{t('apiAccess.field.headers')}</span>
              <textarea value={draft.headersText ?? ''} onChange={(event) => updateTextField('headersText', event.currentTarget.value)} rows={3} placeholder={'X-Team: production\nAuthorization: Bearer ...'} />
            </label>
            {activeSection !== 'openai-compatibility' ? (
              <label className="multiline-field">
                <span>{t('apiAccess.field.excludedModels')}</span>
                <textarea value={draft.excludedModelsText ?? ''} onChange={(event) => updateTextField('excludedModelsText', event.currentTarget.value)} rows={3} placeholder={'model-old-*\nmodel-preview'} />
              </label>
            ) : null}
            {activeSection === 'openai-compatibility' ? (
              <label><span>{t('apiAccess.field.testModel')}</span><input value={draft.testModel ?? ''} onChange={(event) => updateTextField('testModel', event.currentTarget.value)} placeholder={t('common.optional')} /></label>
            ) : null}
            {activeSection === 'claude-api-key' ? (
              <div className="provider-cloak-settings">
                <label>
                  <span>{t('apiAccess.cloak.mode')}</span>
                  <select value={draft.cloakMode ?? ''} onChange={(event) => updateTextField('cloakMode', event.currentTarget.value)}>
                    <option value="">{t('apiAccess.cloak.default')}</option>
                    <option value="auto">Auto</option>
                    <option value="always">Always</option>
                    <option value="never">Never</option>
                  </select>
                </label>
                <label className="multiline-field">
                  <span>{t('apiAccess.cloak.words')}</span>
                  <textarea value={draft.cloakSensitiveWordsText ?? ''} onChange={(event) => updateTextField('cloakSensitiveWordsText', event.currentTarget.value)} rows={3} placeholder={'internal-name\nworkspace-id'} />
                </label>
                <div className="provider-advanced-toggle">
                  <div><strong>{t('apiAccess.cloak.strict')}</strong><span>{t('apiAccess.cloak.strictDescription')}</span></div>
                  <label className="switch-control" title={t('apiAccess.cloak.enableStrict')}><input type="checkbox" checked={Boolean(draft.cloakStrictMode)} onChange={(event) => updateBooleanField('cloakStrictMode', event.currentTarget.checked)} /><span className="switch-track" /></label>
                </div>
                <div className="provider-advanced-toggle">
                  <div><strong>{t('apiAccess.cloak.cacheUser')}</strong><span>{t('apiAccess.cloak.cacheUserDescription')}</span></div>
                  <label className="switch-control" title={t('apiAccess.cloak.cacheUser')}><input type="checkbox" checked={Boolean(draft.cloakCacheUserId)} onChange={(event) => updateBooleanField('cloakCacheUserId', event.currentTarget.checked)} /><span className="switch-track" /></label>
                </div>
              </div>
            ) : null}
            {activeSection === 'codex-api-key' ? (
              <div className="provider-advanced-toggle">
                <div><strong>WebSocket</strong><span>{t('apiAccess.websocket.description')}</span></div>
                <label className="switch-control" title={t('apiAccess.websocket.enable')}><input type="checkbox" checked={Boolean(draft.websockets)} onChange={(event) => updateBooleanField('websockets', event.currentTarget.checked)} /><span className="switch-track" /></label>
              </div>
            ) : null}
            <div className="provider-advanced-toggle">
              <div><strong>{t('apiAccess.cooling.title')}</strong><span>{t('apiAccess.cooling.description')}</span></div>
              <label className="switch-control" title={t('apiAccess.cooling.title')}><input type="checkbox" checked={Boolean(draft.disableCooling)} onChange={(event) => updateBooleanField('disableCooling', event.currentTarget.checked)} /><span className="switch-track" /></label>
            </div>
          </div>
        </details>
        {formError ? (
          <div className="management-alert error api-provider-dialog-error" role="alert">
            {formError}
          </div>
        ) : null}
        <div className="config-dialog-actions two-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>{t('common.cancel')}</button>
          <button type="submit" className="primary-button" disabled={busy}>{busy ? t('common.saving') : t('common.save')}</button>
        </div>
      </form>
      </div>

      {modelDiscoveryOpen ? (
        <div className="model-discovery-backdrop" onMouseDown={(event) => event.currentTarget === event.target && setModelDiscoveryOpen(false)}>
          <section className="model-discovery-dialog" role="dialog" aria-modal="true" aria-labelledby="model-discovery-title">
            <div className="model-discovery-header">
              <div><h2 id="model-discovery-title">{t('apiAccess.modelDialog.title')}</h2><span>{getProviderLabel(definition, t)}</span></div>
              <button type="button" className="icon-button quiet" onClick={() => setModelDiscoveryOpen(false)} title={t('common.close')}><X size={18} /></button>
            </div>

            <div className="model-discovery-search">
              <Search size={16} aria-hidden="true" />
              <input value={modelSearch} onChange={(event) => setModelSearch(event.currentTarget.value)} placeholder={t('agents.model.search')} />
              <button type="button" className="secondary-button compact-button" onClick={() => void discoverModels()} disabled={modelLoading}>
                <RefreshCw size={15} className={modelLoading ? 'spin' : ''} />{t('common.refresh')}
              </button>
            </div>

            <div className="model-discovery-toolbar">
              <span>{t('apiAccess.modelDialog.summary', { found: modelOptions.length, selected: selectedModelNames.size })}</span>
              <div>
                <button type="button" className="secondary-button compact-button" onClick={toggleAllVisibleModels} disabled={modelLoading || visibleModelOptions.length === 0}>{allVisibleModelsSelected ? t('apiAccess.modelDialog.deselectAll') : t('apiAccess.modelDialog.selectVisible')}</button>
                <button type="button" className="secondary-button compact-button" onClick={() => setSelectedModelNames(new Set())} disabled={modelLoading || selectedModelNames.size === 0}>{t('common.clear')}</button>
              </div>
            </div>

            <div className="model-discovery-content">
              {modelLoading ? (
                <div className="model-discovery-message"><LoaderCircle size={20} className="spin" />{t('apiAccess.modelDialog.fetching')}</div>
              ) : modelError && modelOptions.length === 0 ? (
                <div className="model-discovery-message error"><strong>{t('apiAccess.modelDialog.fetchFailed')}</strong><span>{modelError}</span></div>
              ) : visibleModelOptions.length === 0 ? (
                <div className="model-discovery-message"><strong>{modelOptions.length ? t('apiAccess.modelDialog.noMatch') : t('apiAccess.modelDialog.none')}</strong><span>{modelOptions.length ? t('apiAccess.modelDialog.tryKeyword') : t('apiAccess.modelDialog.checkCredentials')}</span></div>
              ) : (
                <div className="model-discovery-results">
                  {modelError ? (
                    <div className="model-discovery-inline-error" role="alert">
                      <strong>{t('apiAccess.modelDialog.fetchFailed')}</strong>
                      <span title={modelError}>{modelError}</span>
                    </div>
                  ) : null}
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
                </div>
              )}
            </div>

            <div className="model-discovery-actions">
              <button type="button" className="secondary-button" onClick={() => setModelDiscoveryOpen(false)}>{t('common.cancel')}</button>
              <button type="button" className="primary-button" onClick={applyModelSelection} disabled={modelLoading}>{t('apiAccess.modelDialog.apply', { count: selectedModelNames.size })}</button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
