import { createRoot } from 'react-dom/client';
import { mockIPC } from '@tauri-apps/api/mocks';
import { I18nProvider } from '../../src/i18n';
import { AgentSystemPromptDialog } from '../../src/pages/AgentSystemPromptDialog';
import type { AgentClientId } from '../../src/services/agents';
import type { AgentSystemPromptEditorSaveRequest, AgentSystemPromptEditorSnapshot } from '../../src/services/agentSystemPrompts';
import '../../src/styles/index.css';

const params = new URLSearchParams(location.search);
const client = (params.get('client') ?? 'claude-desktop') as AgentClientId;
const defaultSource = params.get('source') ?? 'template';
const template = `Built-in example for ${client}`;
const builtinDefaultPrompt = defaultSource === 'observed' ? 'Captured prompt' : template;
const modelIds = ['model-one', 'model-two'];
const saves: AgentSystemPromptEditorSaveRequest[] = [];
const supportsSwitch = client === 'claude-code' || client === 'claude-desktop';
let settings: AgentSystemPromptEditorSaveRequest | null = params.has('legacy') ? {
  client, defaultCustomized: true, defaultPrompt: 'Legacy default', defaultMode: 'append',
  defaultPreserveDynamicContext: false,
  models: [{ id: 'model-one', customized: true, prompt: 'Legacy model', mode: 'prepend', preserveDynamicContext: true }],
} : null;
Object.assign(window, { fixtureSaves: saves });
localStorage.setItem('easy-cli-proxy-api.locale', 'zh-CN');
document.documentElement.dataset.theme = 'light';

function snapshot(): AgentSystemPromptEditorSnapshot {
  const defaultCustomized = settings?.defaultCustomized ?? false;
  const defaultPrompt = defaultCustomized ? settings!.defaultPrompt : builtinDefaultPrompt;
  const overridesEnabled = settings?.overridesEnabled ?? null;
  const proxyActive = (!supportsSwitch || overridesEnabled !== false)
    && (defaultCustomized || Boolean(settings?.models.some((item) => item.customized)));
  return {
    client, defaultSource, builtinDefaultPrompt, defaultPrompt, defaultCustomized, proxyActive,
    ...(supportsSwitch && { overridesEnabled }),
    coreTlsEnabled: params.has('tls'),
    proxyPort: proxyActive ? 9191 : null,
    defaultMode: defaultCustomized ? settings!.defaultMode : 'replace',
    defaultPreserveDynamicContext: defaultCustomized ? settings!.defaultPreserveDynamicContext : true,
    models: modelIds.map((id) => {
      const rule = settings?.models.find((model) => model.id === id && model.customized);
      return rule ? { ...rule, defaultPrompt } : {
        id, defaultPrompt, customized: false, prompt: defaultPrompt, mode: 'replace', preserveDynamicContext: true,
      };
    }),
  };
}

mockIPC((command, args) => {
  if (command === 'get_agent_system_prompt_editor') return snapshot();
  if (command === 'save_agent_system_prompt_editor') {
    settings = (args as { request: AgentSystemPromptEditorSaveRequest }).request;
    saves.push(settings);
    return snapshot();
  }
  if (command === 'set_app_locale') return null;
  throw new Error(`Unexpected command: ${command}`);
});

createRoot(document.getElementById('root')!).render(
  <I18nProvider>
    <AgentSystemPromptDialog client={client} clientName={client} onClose={() => {}} onSaved={() => {}} />
  </I18nProvider>,
);
