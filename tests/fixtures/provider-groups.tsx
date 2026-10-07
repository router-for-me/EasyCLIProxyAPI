import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import {
  ApiAccessPage,
  apiAccessRemarkLocatorFromRecord,
  providerRemarkIdentity,
  type ApiAccessRemarkLocator,
  type ProviderSection,
} from '../../src/pages/ApiAccessPage';
import '../../src/styles/index.css';

const query = new URLSearchParams(location.search);
const denseLayout = query.get('layout') === 'dense';
const remarkScenario = query.get('scenario') === 'remarks';
const remarkStorageKey = 'provider-groups-fixture-remarks';
localStorage.setItem('easy-cli-proxy-api.locale', query.get('locale') ?? 'en');
const fixture = window as typeof window & { groupFixture: { groups: Record<string, unknown>[], openaiGroups: Record<string, unknown>[], writes: unknown[], probes: unknown[] } };
fixture.groupFixture = {
  groups: denseLayout ? [
    {
      name: 'Mock Atlas primary', 'base-url': 'https://atlas.example.test/v1', priority: 10,
      models: [{ name: 'mock-codex-large' }, { name: 'mock-codex-small' }, { name: 'mock-codex-fast' }],
      keys: [{ 'api-key': 'mock-atlas-key-one' }, { 'api-key': 'mock-atlas-key-two' }, { 'api-key': 'mock-atlas-key-three' }],
    },
    {
      name: 'Mock Borealis partial',
      'base-url': 'https://borealis-layout-only.example.test/a-deliberately-long-routing-path/organization-fictional-team/workspace-for-responsive-layout-verification/openai-compatible/v1',
      priority: 0, models: [{ name: 'mock-codex-reasoning' }, { name: 'mock-codex-compact' }],
      keys: [{ 'api-key': 'mock-borealis-active' }, { 'api-key': 'mock-borealis-paused', 'excluded-models': ['*'] }],
    },
    {
      name: 'Mock Cirrus gateway with a deliberately long fictional group name',
      'base-url': 'https://cirrus.example.test/v1', priority: null,
      models: [{ name: 'mock-codex-standard' }], keys: [{ 'api-key': 'mock-cirrus-only-key' }],
    },
    {
      name: 'Mock Dusk disabled', 'base-url': 'https://dusk.example.test/v1', priority: 5,
      'excluded-models': ['*'], models: [],
      keys: [{ 'api-key': 'mock-dusk-key-one' }, { 'api-key': 'mock-dusk-key-two' }],
    },
  ] : [{ name: 'Primary gateway', 'base-url': 'https://gateway.example.test/v1', priority: 2,
    headers: { 'X-Group': 'shared' }, models: [{ name: 'gpt-original' }, { name: 'gpt-original', alias: 'gpt-fast' }],
    keys: [{ 'api-key': 'key-inherited', weight: 2, priority: null },
      { 'api-key': 'key-overridden', weight: 5, priority: 0, 'proxy-url': 'direct', headers: { 'X-Key': 'second' }, models: [{ name: 'private-model' }], 'excluded-models': [], 'disable-cooling': false }],
  }, { name: 'Backup gateway', 'base-url': 'https://backup.example.test/v1', models: [{ name: 'backup-model' }], keys: [{ 'api-key': 'backup-key' }] }],
  openaiGroups: [], writes: [], probes: [],
};
const denseRemarks = [
  'Fictional layout fixture · 三个测试密钥',
  'One fictional key paused · 用于检查部分启用状态',
  '仅用于响应式布局测试的虚构备注：故意保留很长的说明，验证窄窗口中的名称、备注、URL、密钥数量和操作仍然清楚。 Fictional layout-only remark with enough text to exercise wrapping and truncation without real credentials or services.',
  'Disabled fictional group · 无已配置模型',
];
const remarks = new Map<string, string>();
if (denseLayout) fixture.groupFixture.groups.forEach((group, index) => {
  remarks.set(providerRemarkIdentity('codex-api-key', apiAccessRemarkLocatorFromRecord('codex-api-key', group)), denseRemarks[index]);
});
if (remarkScenario) {
  const persisted = sessionStorage.getItem(remarkStorageKey);
  if (persisted) {
    const state = JSON.parse(persisted) as { groups: Record<string, unknown>[]; remarks: [string, string][] };
    fixture.groupFixture.groups = state.groups;
    state.remarks.forEach(([identity, remark]) => remarks.set(identity, remark));
  } else {
    remarks.set(providerRemarkIdentity('codex-api-key', apiAccessRemarkLocatorFromRecord('codex-api-key', fixture.groupFixture.groups[0])), 'Existing group note');
  }
}
const persistRemarkScenario = () => {
  if (remarkScenario) sessionStorage.setItem(remarkStorageKey, JSON.stringify({ groups: fixture.groupFixture.groups, remarks: [...remarks] }));
};
const resolveRemark = (section: ProviderSection, locator: ApiAccessRemarkLocator) => {
  const candidates = [locator];
  if (['gemini-api-key', 'codex-api-key', 'claude-api-key'].includes(section) && locator.providerName) {
    candidates.push({ ...locator, providerName: '' });
  }
  for (const candidate of candidates) {
    for (const record of [candidate, { ...candidate, configIdentity: '' }]) {
      const identity = providerRemarkIdentity(section, record);
      if (remarks.has(identity)) return remarks.get(identity)!;
    }
  }
  return '';
};
mockIPC((cmd, args: any) => {
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'resolve_api_access_remarks') return args.queries.map((item: ApiAccessRemarkLocator & { providerSection: ProviderSection }) =>
    resolveRemark(item.providerSection, item));
  if (cmd === 'save_api_access_remark') {
    const update = args.update as { providerSection: ProviderSection; previousRecords: ApiAccessRemarkLocator[]; records: ApiAccessRemarkLocator[]; allRecords: ApiAccessRemarkLocator[]; remark: string };
    const identity = (record: ApiAccessRemarkLocator) => providerRemarkIdentity(update.providerSection, record);
    const allRecords = new Set(update.allRecords.map(identity));
    const replacing = new Set([...update.previousRecords, ...update.records].map(identity));
    const migrations = update.allRecords.map(record => [identity(record), resolveRemark(update.providerSection, record)] as const);
    // Match the backend: discard orphaned/group identities, replace explicit updates,
    // then migrate surviving records, including intentionally empty remarks.
    for (const stored of remarks.keys()) {
      if (JSON.parse(stored)[0] === update.providerSection && (!allRecords.has(stored) || replacing.has(stored))) remarks.delete(stored);
    }
    update.records.forEach(record => remarks.set(identity(record), update.remark.trim()));
    migrations.forEach(([stored, remark]) => { if (!remarks.has(stored)) remarks.set(stored, remark); });
    persistRemarkScenario();
    return null;
  }
  if (cmd !== 'management_request') throw new Error(`Unexpected ${cmd}`);
  const request = args.request;
  if (request.path === '/requests/api-call') {
    fixture.groupFixture.probes.push(request.body);
    return { status_code: 200, body: { data: [{ id: 'gpt-original' }, { id: 'new-discovered' }] } };
  }
  if (request.method === 'GET') {
    if (request.path === '/config/api-keys/codex') return structuredClone(fixture.groupFixture.groups);
    if (request.path === '/config/api-keys/openai-compatibility') return structuredClone(fixture.groupFixture.openaiGroups);
    return [];
  }
  if (!['/config/api-keys/codex', '/config/api-keys/openai-compatibility'].includes(request.path) || request.method !== 'PUT') throw new Error('Unexpected mutation');
  fixture.groupFixture.writes.push(structuredClone(request.body));
  if (request.path === '/config/api-keys/codex') fixture.groupFixture.groups = structuredClone(request.body);
  else fixture.groupFixture.openaiGroups = structuredClone(request.body);
  persistRemarkScenario();
  return { status: 'ok' };
});
createRoot(document.getElementById('root')!).render(<I18nProvider><div className="app-shell"><aside className="sidebar" /><div className="workspace"><main className="content"><ApiAccessPage /></main></div></div></I18nProvider>);
