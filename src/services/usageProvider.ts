/** Usage API values describe the route, not the brand implied by a model name. */
export function usageProviderDetails(provider: string, authType = '') {
  const rawProvider = provider.trim();
  const rawAuthType = authType.trim();
  const labels: Record<string, string> = {
    codex: 'Codex', 'codex-oauth': 'Codex', 'openai-oauth': 'Codex',
    claude: 'Claude', 'claude-oauth': 'Claude',
    gemini: 'Gemini', 'gemini-oauth': 'Gemini', aistudio: 'AI Studio',
    antigravity: 'Antigravity', 'antigravity-oauth': 'Antigravity',
    openai: 'OpenAI', 'openai-compatibility': 'OpenAI Compatible',
    vertex: 'Vertex AI', 'vertex-ai': 'Vertex AI', xai: 'xAI', grok: 'Grok',
    kimi: 'Kimi', 'kimi-ai': 'Kimi', 'kimi-oauth': 'Kimi',
    deepseek: 'DeepSeek', devin: 'Devin', cognition: 'Devin',
    meta: 'Muse', muse: 'Muse', zai: 'z.ai', 'z.ai': 'z.ai',
    trae: 'Trae', workbuddy: 'WorkBuddy', qoder: 'Qoder',
    qwen: 'Qwen', 'qwen-oauth': 'Qwen', iflow: 'iFlow', copilot: 'GitHub Copilot',
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

export function usageClientDetails(userAgent?: string | null) {
  const raw = (userAgent ?? '').trim();
  if (!raw) return { name: '', raw: '' };
  const lower = raw.toLowerCase();
  const matchers: Array<[RegExp, string]> = [
    [/\bcodex(?:-tui|-cli|_cli_rs)?\b/, 'Codex'],
    [/\b(?:claude-cli|claude-code|anthropic-claude-code)\b/, 'Claude Code'],
    [/\bclaude(?:-desktop)?\b/, 'Claude Desktop'],
    [/\bgemini-cli\b/, 'Gemini CLI'],
    [/\bopencode\b/, 'OpenCode'],
    [/\bzcode\b/, 'ZCode'],
    [/\b(?:pi-coding-agent|omp|oh-my-pi)\b/, 'Pi'],
    [/\bkimi(?:-cli|-code)?\b/, 'Kimi Code'],
    [/\bgrok(?:-cli|-shell|-pager)?\b/, 'Grok Build'],
    [/\bantigravity\b/, 'Antigravity'],
    [/\b(?:githubcopilot|copilot)\b/, 'Copilot'],
    [/\bworkbuddy\b/, 'WorkBuddy'],
    [/\bopenclaw\b/, 'OpenClaw'],
    [/\bhermes\b/, 'Hermes'],
  ];
  for (const [pattern, label] of matchers) {
    if (pattern.test(lower)) return { name: label, raw };
  }
  return { name: '', raw };
}
