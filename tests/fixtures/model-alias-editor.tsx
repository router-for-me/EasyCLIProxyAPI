import React from 'react';
import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { ThinkingAliasesPage } from '../../src/pages/ThinkingAliasesPage';
import '../../src/styles.css';

localStorage.setItem('easy-cli-proxy-api.locale', 'en');
const calls: { cmd: string; args: Record<string, unknown> }[] = [];
(window as any).fixtureCalls = calls;
(window as any).fixtureFailSave = false;
(window as any).fixtureCurrentEffort = null;
const source = {
  id: 'openai-compatibility:0:0:provider-revision', model: 'public-gpt', displayName: null,
  provider: 'Provider', kind: 'openai-compatible', protocol: 'openai', reasoningLevels: ['low', 'high'],
};
let entry = {
  sourceModel: 'upstream-gpt', alias: 'my-alias', effort: 'high', provider: 'Provider',
  kind: 'openai-compatible', oauthChannel: null,
};
mockIPC(async (cmd, rawArgs) => {
  const args = (rawArgs ?? {}) as Record<string, any>;
  calls.push({ cmd, args });
  if (cmd === 'set_app_locale') return null;
  if (cmd === 'get_thinking_aliases') return [entry];
  if (cmd === 'get_speed_aliases') return [];
  if (['get_model_alias_sources', 'get_thinking_alias_sources', 'get_speed_alias_sources'].includes(cmd)) return [source];
  if (cmd === 'get_model_alias_edit_source') return {
    source: { ...source, id: `alias-edit:${args.alias}`, model: 'upstream-gpt' },
    revision: `revision:${args.alias}`, effort: (window as any).fixtureCurrentEffort ?? entry.effort, fast: false,
  };
  if (cmd === 'create_thinking_alias') {
    if ((window as any).fixtureFailSave) throw new Error('Save failed: configuration changed');
    entry = { ...entry, alias: args.alias, effort: args.effort };
    return [entry];
  }
  throw new Error(`Unhandled fixture command: ${cmd}`);
});
createRoot(document.getElementById('root')!).render(
  <I18nProvider><main style={{ padding: 24 }}><ThinkingAliasesPage /></main></I18nProvider>,
);
