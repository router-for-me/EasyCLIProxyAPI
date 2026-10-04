/** Usage API values describe the route, not the brand implied by a model name. */
export function usageProviderDetails(provider: string, authType = '') {
  const rawProvider = provider.trim();
  const rawAuthType = authType.trim();
  const labels: Record<string, string> = {
    codex: 'Codex', claude: 'Claude', gemini: 'Gemini', aistudio: 'AI Studio',
    antigravity: 'Antigravity', openai: 'OpenAI', 'openai-compatibility': 'OpenAI Compatible',
    vertex: 'Vertex AI', 'vertex-ai': 'Vertex AI', xai: 'xAI', grok: 'Grok',
  };
  return {
    name: labels[rawProvider.toLowerCase()] ?? (rawProvider || '—'),
    access: rawAuthType.toLowerCase() === 'apikey' ? 'API'
      : rawAuthType.toLowerCase() === 'oauth' ? 'OAuth'
        : rawAuthType && rawAuthType.toLowerCase() !== 'unknown' ? rawAuthType : '',
    rawProvider,
    rawAuthType,
  };
}
