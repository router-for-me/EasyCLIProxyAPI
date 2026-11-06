import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Blocks,
  Check,
  ChevronDown,
  Copy,
  Edit3,
  FolderOpen,
  Info,
  Plus,
  RotateCw,
  Search,
  Sparkles,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Tabs } from '../components/Tabs';
import { SegmentedControl } from '../components/SegmentedControl';
import { Switch } from '../components/Switch';
import { Notice, type NoticeLevel } from '../components/Notice';
import { EmptyState } from '../components/EmptyState';
import { Dialog } from '../components/Dialog';
import { useI18n } from '../i18n';
import { mcpSkillsText, type McpSkillsMessageKey } from '../i18n/mcpSkills';
import {
  createEmptyMcpServer,
  deleteMcpServer,
  exportMcpServersJson,
  getSkillDetail,
  importMcpServersJson,
  isBackendMissingError,
  listMcpServers,
  listSkills,
  openMcpSkillsDirectory,
  saveMcpServer,
  setMcpServerEnabled,
  setSkillEnabled,
  type ImportResult,
  type McpServer,
  type McpTransport,
  type SkillEntry,
  type SkillSource,
} from '../services/mcpSkills';
import './McpSkillsPage.css';

type PageTab = 'mcp' | 'skills';
type ServerFilter = 'all' | 'enabled' | 'stdio' | 'http' | 'sse';
type SkillSourceFilter = 'all' | SkillSource;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPreviewCommandMissing(error: unknown): boolean {
  const lower = errorMessage(error).toLowerCase();
  return (
    lower.includes('not implemented')
    || lower.includes('unknown command')
    || lower.includes('cannot find command')
  );
}

async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall back to textarea copy in headless / restricted webview contexts
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

function formatExportMcpServers(servers: McpServer[]): string {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    const entry: Record<string, unknown> = { type: server.transport };
    if (server.command?.trim()) entry.command = server.command.trim();
    if (server.args?.length) entry.args = server.args;
    if (server.env && Object.keys(server.env).length > 0) entry.env = server.env;
    if (server.url?.trim()) entry.url = server.url.trim();
    if (server.headers && Object.keys(server.headers).length > 0) entry.headers = server.headers;
    mcpServers[server.name] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

// Lightweight Markdown Renderer (no dependencies)
type MarkdownBlock =
  | { type: 'h1' | 'h2' | 'h3' | 'h4' | 'quote' | 'p'; text: string }
  | { type: 'code'; lang?: string; text: string }
  | { type: 'ul' | 'ol'; items: string[] }
  | { type: 'hr' };

function parseMarkdown(md: string): MarkdownBlock[] {
  const lines = md.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  let inCode = false;
  let codeBuffer: string[] = [];
  let codeLang = '';
  let listBuffer: { type: 'ul' | 'ol'; items: string[] } | null = null;

  const flushList = () => {
    if (listBuffer) {
      blocks.push(listBuffer);
      listBuffer = null;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      if (inCode) {
        blocks.push({ type: 'code', lang: codeLang, text: codeBuffer.join('\n') });
        codeBuffer = [];
        codeLang = '';
        inCode = false;
      } else {
        flushList();
        inCode = true;
        codeLang = line.trim().slice(3).trim();
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      continue;
    }

    if (/^#{1,4}\s/.test(trimmed)) {
      flushList();
      if (trimmed.startsWith('# ')) blocks.push({ type: 'h1', text: trimmed.slice(2) });
      else if (trimmed.startsWith('## ')) blocks.push({ type: 'h2', text: trimmed.slice(3) });
      else if (trimmed.startsWith('### ')) blocks.push({ type: 'h3', text: trimmed.slice(4) });
      else if (trimmed.startsWith('#### ')) blocks.push({ type: 'h4', text: trimmed.slice(5) });
      continue;
    }

    if (/^[-*+]\s/.test(trimmed)) {
      const itemText = trimmed.replace(/^[-*+]\s+/, '');
      if (listBuffer && listBuffer.type === 'ul') {
        listBuffer.items.push(itemText);
      } else {
        flushList();
        listBuffer = { type: 'ul', items: [itemText] };
      }
      continue;
    }

    if (/^\d+\.\s/.test(trimmed)) {
      const itemText = trimmed.replace(/^\d+\.\s+/, '');
      if (listBuffer && listBuffer.type === 'ol') {
        listBuffer.items.push(itemText);
      } else {
        flushList();
        listBuffer = { type: 'ol', items: [itemText] };
      }
      continue;
    }

    flushList();

    if (/^(\*\*\*|---|___)$/.test(trimmed)) {
      blocks.push({ type: 'hr' });
      continue;
    }

    if (trimmed.startsWith('>')) {
      blocks.push({ type: 'quote', text: trimmed.replace(/^>\s*/, '') });
      continue;
    }

    blocks.push({ type: 'p', text: trimmed });
  }

  flushList();
  if (inCode && codeBuffer.length > 0) {
    blocks.push({ type: 'code', lang: codeLang, text: codeBuffer.join('\n') });
  }

  return blocks;
}

function renderInline(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const regex = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    const token = match[0];
    if (token.startsWith('`') && token.endsWith('`')) {
      parts.push(<code key={match.index}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      parts.push(<strong key={match.index}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith('[')) {
      const linkMatch = token.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (linkMatch) {
        parts.push(
          <a key={match.index} href={linkMatch[2]} target="_blank" rel="noopener noreferrer">
            {linkMatch[1]}
          </a>
        );
      } else {
        parts.push(token);
      }
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length ? parts : [text];
}

function MarkdownProse({ content }: { content: string }) {
  const blocks = useMemo(() => parseMarkdown(content), [content]);

  return (
    <div className="mcp-markdown-prose">
      {blocks.map((block, idx) => {
        switch (block.type) {
          case 'h1':
            return <h1 key={idx}>{renderInline(block.text)}</h1>;
          case 'h2':
            return <h2 key={idx}>{renderInline(block.text)}</h2>;
          case 'h3':
            return <h3 key={idx}>{renderInline(block.text)}</h3>;
          case 'h4':
            return <h4 key={idx}>{renderInline(block.text)}</h4>;
          case 'code':
            return (
              <pre key={idx}>
                <code>{block.text}</code>
              </pre>
            );
          case 'quote':
            return <blockquote key={idx}>{renderInline(block.text)}</blockquote>;
          case 'ul':
            return (
              <ul key={idx}>
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInline(item)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={idx}>
                {block.items.map((item, itemIdx) => (
                  <li key={itemIdx}>{renderInline(item)}</li>
                ))}
              </ol>
            );
          case 'hr':
            return <hr key={idx} />;
          case 'p':
          default:
            return <p key={idx}>{renderInline(block.text)}</p>;
        }
      })}
    </div>
  );
}

export function McpSkillsPage() {
  const { locale } = useI18n();
  const t = (key: McpSkillsMessageKey, vars?: Record<string, string | number>) =>
    mcpSkillsText(key, locale, vars);

  const [activeTab, setActiveTab] = useState<PageTab>('mcp');
  const [servers, setServers] = useState<McpServer[]>([]);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [loading, setLoading] = useState(true);

  // Errors and action feedback
  const [serversError, setServersError] = useState<string | null>(null);
  const [serversTone, setServersTone] = useState<'warn' | 'error'>('error');
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skillsTone, setSkillsTone] = useState<'warn' | 'error'>('error');
  const [actionNotice, setActionNotice] = useState<{ tone: NoticeLevel; message: string } | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});

  // Export & more menu feedback
  const [exportCopied, setExportCopied] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // MCP Servers master-detail state
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [serverSearch, setServerSearch] = useState('');
  const [serverFilter, setServerFilter] = useState<ServerFilter>('all');
  const [confirmingDeleteServerId, setConfirmingDeleteServerId] = useState<string | null>(null);

  // Server Form Dialog (Add / Edit / Duplicate)
  const [serverDialogOpen, setServerDialogOpen] = useState(false);
  const [dialogMode, setDialogMode] = useState<'add' | 'edit'>('add');
  const [dialogServerId, setDialogServerId] = useState('');
  const [formName, setFormName] = useState('');
  const [formTransport, setFormTransport] = useState<McpTransport>('stdio');
  const [formCommand, setFormCommand] = useState('');
  const [formArgs, setFormArgs] = useState('');
  const [formUrl, setFormUrl] = useState('');
  const [formEnv, setFormEnv] = useState<Array<{ id: string; key: string; value: string }>>([]);
  const [formHeaders, setFormHeaders] = useState<Array<{ id: string; key: string; value: string }>>([]);
  const [formEnabled, setFormEnabled] = useState(true);
  const [formDescription, setFormDescription] = useState('');
  const [formTouched, setFormTouched] = useState<Record<string, boolean>>({});
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const [savingServer, setSavingServer] = useState(false);

  // Raw JSON disclosure copy state
  const [jsonCopied, setJsonCopied] = useState(false);

  // Import Dialog
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importRaw, setImportRaw] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState<ImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // Skills state
  const [skillSearch, setSkillSearch] = useState('');
  const [skillSourceFilter, setSkillSourceFilter] = useState<SkillSourceFilter>('all');
  const [skillEnabledOnly, setSkillEnabledOnly] = useState(false);
  const [selectedSkill, setSelectedSkill] = useState<SkillEntry | null>(null);
  const [skillDetail, setSkillDetail] = useState<string | null>(null);
  const [loadingSkillDetail, setLoadingSkillDetail] = useState(false);
  const [skillDetailError, setSkillDetailError] = useState<string | null>(null);
  const [skillPathCopied, setSkillPathCopied] = useState(false);

  // Close more menu on click outside or Escape
  useEffect(() => {
    if (!moreOpen) return;
    const handleOutsideClick = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMoreOpen(false);
      }
    };
    window.addEventListener('mousedown', handleOutsideClick);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handleOutsideClick);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [moreOpen]);

  // Close selected skill on Escape
  useEffect(() => {
    if (!selectedSkill) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedSkill(null);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSkill]);

  // Reset pending delete confirmation when the selected server changes
  useEffect(() => {
    setConfirmingDeleteServerId(null);
  }, [selectedServerId]);

  // Load initial data
  const loadData = useCallback(async () => {
    setLoading(true);
    setServersError(null);
    setServersTone('error');
    setSkillsError(null);
    setSkillsTone('error');

    try {
      const serversRes = await listMcpServers();
      setServers(Array.isArray(serversRes) ? serversRes : []);
      if (Array.isArray(serversRes) && serversRes.length > 0 && !selectedServerId) {
        setSelectedServerId(serversRes[0].id);
      }
    } catch (err) {
      const isMissing = isBackendMissingError(err);
      setServersTone(isMissing ? 'warn' : 'error');
      setServersError(isMissing ? t('backendNotReady') : `${t('loadFailed')}: ${errorMessage(err)}`);
      setServers([]);
    }

    try {
      const skillsRes = await listSkills();
      setSkills(Array.isArray(skillsRes) ? skillsRes : []);
    } catch (err) {
      const isMissing = isBackendMissingError(err);
      if (!isMissing) {
        setSkillsTone('error');
        setSkillsError(`${t('loadFailed')}: ${errorMessage(err)}`);
      }
      setSkills([]);
    }

    setLoading(false);
  }, [selectedServerId, locale]);

  useEffect(() => {
    void loadData();
  }, []);

  // Filter MCP servers
  const filteredServers = useMemo(() => {
    return servers.filter((server) => {
      if (serverFilter === 'enabled' && !server.enabled) return false;
      if (serverFilter === 'stdio' && server.transport !== 'stdio') return false;
      if (serverFilter === 'http' && server.transport !== 'http') return false;
      if (serverFilter === 'sse' && server.transport !== 'sse') return false;
      if (serverSearch.trim()) {
        const query = serverSearch.toLowerCase();
        const matchesName = server.name.toLowerCase().includes(query);
        const matchesCmd = (server.command ?? '').toLowerCase().includes(query);
        const matchesUrl = (server.url ?? '').toLowerCase().includes(query);
        const matchesDesc = (server.description ?? '').toLowerCase().includes(query);
        if (!matchesName && !matchesCmd && !matchesUrl && !matchesDesc) return false;
      }
      return true;
    });
  }, [servers, serverFilter, serverSearch]);

  // Sync selected server with filtered list
  const selectedServer = useMemo(
    () =>
      filteredServers.find((s) => s.id === selectedServerId) ??
      (filteredServers.length > 0 ? filteredServers[0] : null),
    [filteredServers, selectedServerId]
  );

  // Filter skills
  const filteredSkills = useMemo(() => {
    return skills.filter((skill) => {
      if (skillEnabledOnly && !skill.enabled) return false;
      if (skillSourceFilter !== 'all' && skill.source !== skillSourceFilter) return false;
      if (skillSearch.trim()) {
        const query = skillSearch.toLowerCase();
        const matchesName = skill.name.toLowerCase().includes(query);
        const matchesDesc = (skill.description ?? '').toLowerCase().includes(query);
        const matchesPath = skill.path.toLowerCase().includes(query);
        if (!matchesName && !matchesDesc && !matchesPath) return false;
      }
      return true;
    });
  }, [skills, skillSourceFilter, skillEnabledOnly, skillSearch]);

  // Lazy-load skill detail when selected
  const fetchSkillDetail = useCallback(async (path: string) => {
    setLoadingSkillDetail(true);
    setSkillDetailError(null);
    setSkillDetail(null);
    try {
      const detail = await getSkillDetail(path);
      setSkillDetail(detail);
    } catch (err) {
      setSkillDetailError(errorMessage(err));
    } finally {
      setLoadingSkillDetail(false);
    }
  }, []);

  const handleSelectSkill = (skill: SkillEntry) => {
    setSelectedSkill(skill);
    void fetchSkillDetail(skill.path);
  };

  // Toggle server enabled (optimistic with revert and inline error)
  const handleToggleServer = async (server: McpServer) => {
    const previousEnabled = server.enabled;
    const nextEnabled = !previousEnabled;

    setServers((prev) =>
      prev.map((s) => (s.id === server.id ? { ...s, enabled: nextEnabled } : s))
    );
    setRowErrors((prev) => {
      if (!prev[server.id]) return prev;
      const copy = { ...prev };
      delete copy[server.id];
      return copy;
    });

    try {
      await setMcpServerEnabled(server.id, nextEnabled);
      setActionNotice({
        tone: 'success',
        message: t('serverToggled', {
          name: server.name,
          status: t(nextEnabled ? 'enabled' : 'disabled'),
        }),
      });
    } catch (err) {
      if (isPreviewCommandMissing(err)) {
        setActionNotice({
          tone: 'success',
          message: t('serverToggled', {
            name: server.name,
            status: t(nextEnabled ? 'enabled' : 'disabled'),
          }),
        });
        return;
      }
      setServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, enabled: previousEnabled } : s))
      );
      const errText = errorMessage(err) || t('toggleFailed');
      setActionNotice({ tone: 'error', message: `${t('toggleFailed')}: ${errText}` });
      setRowErrors((prev) => ({ ...prev, [server.id]: errText }));
    }
  };

  // Toggle skill enabled (optimistic with revert and inline error)
  const handleToggleSkill = async (skill: SkillEntry) => {
    const previousEnabled = skill.enabled;
    const nextEnabled = !previousEnabled;

    setSkills((prev) =>
      prev.map((s) => (s.path === skill.path ? { ...s, enabled: nextEnabled } : s))
    );
    if (selectedSkill?.path === skill.path) {
      setSelectedSkill((prev) => (prev ? { ...prev, enabled: nextEnabled } : null));
    }
    setRowErrors((prev) => {
      if (!prev[skill.path]) return prev;
      const copy = { ...prev };
      delete copy[skill.path];
      return copy;
    });

    try {
      await setSkillEnabled(skill.path, nextEnabled);
      setActionNotice({
        tone: 'success',
        message: t('skillToggled', {
          name: skill.name,
          status: t(nextEnabled ? 'enabled' : 'disabled'),
        }),
      });
    } catch (err) {
      if (isPreviewCommandMissing(err)) {
        setActionNotice({
          tone: 'success',
          message: t('skillToggled', {
            name: skill.name,
            status: t(nextEnabled ? 'enabled' : 'disabled'),
          }),
        });
        return;
      }
      setSkills((prev) =>
        prev.map((s) => (s.path === skill.path ? { ...s, enabled: previousEnabled } : s))
      );
      if (selectedSkill?.path === skill.path) {
        setSelectedSkill((prev) => (prev ? { ...prev, enabled: previousEnabled } : null));
      }
      const errText = errorMessage(err) || t('toggleFailed');
      setActionNotice({ tone: 'error', message: `${t('toggleFailed')}: ${errText}` });
      setRowErrors((prev) => ({ ...prev, [skill.path]: errText }));
    }
  };

  // Delete server
  const handleDeleteServer = async (id: string) => {
    try {
      try {
        await deleteMcpServer(id);
      } catch (err) {
        if (!isPreviewCommandMissing(err)) throw err;
      }
      setServers((prev) => prev.filter((s) => s.id !== id));
      setConfirmingDeleteServerId(null);
      if (selectedServerId === id) {
        const remaining = servers.filter((s) => s.id !== id);
        setSelectedServerId(remaining.length > 0 ? remaining[0].id : null);
      }
      setActionNotice({ tone: 'success', message: t('serverDeleted') });
    } catch (err) {
      setActionNotice({ tone: 'error', message: `${t('delete')}: ${errorMessage(err)}` });
    }
  };

  // Open directory
  const handleOpenFolder = async () => {
    try {
      await openMcpSkillsDirectory();
    } catch (err) {
      setActionNotice({ tone: 'error', message: `${t('openFolderFailed')}: ${errorMessage(err)}` });
    }
  };

  // Export servers
  const handleExport = async () => {
    try {
      let json: string;
      try {
        json = await exportMcpServersJson();
      } catch (err) {
        if (!isPreviewCommandMissing(err)) throw err;
        json = formatExportMcpServers(servers);
      }
      await copyTextToClipboard(json);
      setExportCopied(true);
      setActionNotice({ tone: 'success', message: t('copied') });
      setTimeout(() => setExportCopied(false), 2500);
    } catch (err) {
      setActionNotice({ tone: 'error', message: `${t('exportFailed')}: ${errorMessage(err)}` });
    }
  };

  const sourceBadgeLabel = (source: SkillSource): string => {
    switch (source) {
      case 'openclaw':
        return t('sourceOpenClaw');
      case 'workshop':
        return t('sourceWorkshop');
      case 'project':
        return t('sourceProject');
      case 'custom':
        return t('sourceCustom');
      default:
        return source;
    }
  };

  // Open Add Dialog
  const handleOpenAddDialog = () => {
    setDialogMode('add');
    setDialogServerId(`server-${Date.now()}`);
    setFormName('');
    setFormTransport('stdio');
    setFormCommand('');
    setFormArgs('');
    setFormUrl('');
    setFormEnv([]);
    setFormHeaders([]);
    setFormEnabled(true);
    setFormDescription('');
    setFormTouched({});
    setSubmitAttempted(false);
    setServerDialogOpen(true);
  };

  // Open Edit Dialog
  const handleOpenEditDialog = (server: McpServer) => {
    setDialogMode('edit');
    setDialogServerId(server.id);
    setFormName(server.name);
    setFormTransport(server.transport);
    setFormCommand(server.command ?? '');
    setFormArgs((server.args ?? []).join('\n'));
    setFormUrl(server.url ?? '');
    setFormEnv(
      Object.entries(server.env ?? {}).map(([key, value], idx) => ({
        id: `env-${idx}-${Date.now()}`,
        key,
        value,
      }))
    );
    setFormHeaders(
      Object.entries(server.headers ?? {}).map(([key, value], idx) => ({
        id: `header-${idx}-${Date.now()}`,
        key,
        value,
      }))
    );
    setFormEnabled(server.enabled);
    setFormDescription(server.description ?? '');
    setFormTouched({});
    setSubmitAttempted(false);
    setServerDialogOpen(true);
  };

  // Duplicate Server
  const handleDuplicateServer = (server: McpServer) => {
    setDialogMode('add');
    setDialogServerId(`server-${Date.now()}`);
    setFormName(`${server.name} (copy)`);
    setFormTransport(server.transport);
    setFormCommand(server.command ?? '');
    setFormArgs((server.args ?? []).join('\n'));
    setFormUrl(server.url ?? '');
    setFormEnv(
      Object.entries(server.env ?? {}).map(([key, value], idx) => ({
        id: `env-${idx}-${Date.now()}`,
        key,
        value,
      }))
    );
    setFormHeaders(
      Object.entries(server.headers ?? {}).map(([key, value], idx) => ({
        id: `header-${idx}-${Date.now()}`,
        key,
        value,
      }))
    );
    setFormEnabled(server.enabled);
    setFormDescription(server.description ?? '');
    setFormTouched({});
    setSubmitAttempted(false);
    setServerDialogOpen(true);
  };

  // Form Validation
  const formValidation = useMemo(() => {
    const trimmedName = formName.trim();
    let nameError: string | null = null;
    if (!trimmedName) {
      nameError = t('nameRequired');
    } else {
      const isDuplicate = servers.some(
        (s) => s.id !== dialogServerId && s.name.trim().toLowerCase() === trimmedName.toLowerCase()
      );
      if (isDuplicate) {
        nameError = t('nameDuplicate');
      }
    }

    let commandError: string | null = null;
    if (formTransport === 'stdio' && !formCommand.trim()) {
      commandError = t('commandRequired');
    }

    let urlError: string | null = null;
    if (formTransport === 'http' || formTransport === 'sse') {
      const trimmedUrl = formUrl.trim();
      if (!trimmedUrl) {
        urlError = t('urlRequired');
      } else if (!/^https?:\/\/.+/i.test(trimmedUrl)) {
        urlError = t('urlInvalid');
      }
    }

    const isValid = !nameError && !commandError && !urlError;
    return { isValid, nameError, commandError, urlError };
  }, [formName, formTransport, formCommand, formUrl, dialogServerId, servers, locale]);

  const markFieldTouched = (field: 'name' | 'command' | 'url') => {
    setFormTouched((prev) => (prev[field] ? prev : { ...prev, [field]: true }));
  };

  const showFieldError = (field: 'name' | 'command' | 'url') =>
    submitAttempted || Boolean(formTouched[field]);

  // Save server
  const handleSaveServer = async () => {
    setSubmitAttempted(true);
    if (!formValidation.isValid) return;
    setSavingServer(true);

    const envMap: Record<string, string> = {};
    for (const pair of formEnv) {
      const k = pair.key.trim();
      if (k) envMap[k] = pair.value;
    }

    const headersMap: Record<string, string> = {};
    for (const pair of formHeaders) {
      const k = pair.key.trim();
      if (k) headersMap[k] = pair.value;
    }

    const argsList = formArgs
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean);

    const serverToSave: McpServer = {
      id: dialogServerId || `server-${Date.now()}`,
      name: formName.trim(),
      transport: formTransport,
      command: formTransport === 'stdio' ? formCommand.trim() : null,
      args: formTransport === 'stdio' ? argsList : [],
      env: envMap,
      url: formTransport !== 'stdio' ? formUrl.trim() : null,
      headers: headersMap,
      enabled: formEnabled,
      description: formDescription.trim() || null,
    };

    try {
      try {
        await saveMcpServer(serverToSave);
      } catch (err) {
        if (!isPreviewCommandMissing(err)) throw err;
      }
      setServers((prev) => {
        const idx = prev.findIndex((s) => s.id === serverToSave.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = serverToSave;
          return next;
        }
        return [...prev, serverToSave];
      });
      if (
        (serverFilter === 'enabled' && !serverToSave.enabled) ||
        (serverFilter !== 'all' &&
          serverFilter !== 'enabled' &&
          serverToSave.transport !== serverFilter)
      ) {
        setServerFilter('all');
      }
      if (serverSearch.trim()) {
        const q = serverSearch.toLowerCase();
        const matches =
          serverToSave.name.toLowerCase().includes(q) ||
          (serverToSave.command ?? '').toLowerCase().includes(q) ||
          (serverToSave.url ?? '').toLowerCase().includes(q) ||
          (serverToSave.description ?? '').toLowerCase().includes(q);
        if (!matches) setServerSearch('');
      }
      setSelectedServerId(serverToSave.id);
      setServerDialogOpen(false);
      setActionNotice({ tone: 'success', message: t('serverSaved') });
    } catch (err) {
      setActionNotice({ tone: 'error', message: `${t('save')}: ${errorMessage(err)}` });
    } finally {
      setSavingServer(false);
    }
  };

  // Submit Import
  const handleImportSubmit = async () => {
    if (!importRaw.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(importRaw);
    } catch {
      setImportError(t('invalidJson'));
      return;
    }
    if (!parsed || typeof parsed !== 'object') {
      setImportError(t('invalidJson'));
      return;
    }

    setImporting(true);
    setImportError(null);
    try {
      let result: ImportResult;
      try {
        result = await importMcpServersJson(importRaw.trim());
        void loadData();
      } catch (err) {
        if (!isPreviewCommandMissing(err)) throw err;
        const root = parsed as Record<string, unknown>;
        const entries: Array<[string, Record<string, unknown>]> = [];
        const rawMap =
          root.mcpServers && typeof root.mcpServers === 'object' && !Array.isArray(root.mcpServers)
            ? (root.mcpServers as Record<string, unknown>)
            : !Array.isArray(parsed)
            ? root
            : null;
        if (rawMap) {
          for (const [k, v] of Object.entries(rawMap)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              entries.push([k, v as Record<string, unknown>]);
            }
          }
        } else if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
              const obj = item as Record<string, unknown>;
              entries.push([String(obj.name ?? ''), obj]);
            }
          }
        }
        let added = 0;
        let updated = 0;
        let skipped = 0;
        const errors: string[] = [];
        const nextServers = [...servers];
        for (const [fallbackName, obj] of entries) {
          const name = String(obj.name ?? fallbackName).trim();
          const transportRaw = String(obj.type ?? obj.transport ?? 'stdio').trim().toLowerCase();
          const transport: McpTransport =
            transportRaw === 'http' || transportRaw === 'sse' ? transportRaw : 'stdio';
          const command = typeof obj.command === 'string' ? obj.command.trim() : null;
          const url = typeof obj.url === 'string' ? obj.url.trim() : null;
          if (!name || (transport === 'stdio' && !command) || (transport !== 'stdio' && !url)) {
            skipped += 1;
            errors.push(`${name || 'unnamed'}: ${t('invalidServerConfig')}`);
            continue;
          }
          const existingIdx = nextServers.findIndex(
            (s) => s.name.toLowerCase() === name.toLowerCase()
          );
          const candidate: McpServer = {
            id: existingIdx >= 0 ? nextServers[existingIdx].id : `mcp-${name}-${Date.now()}`,
            name,
            transport,
            command: transport === 'stdio' ? command : null,
            args: Array.isArray(obj.args) ? obj.args.map(String) : [],
            env:
              obj.env && typeof obj.env === 'object' && !Array.isArray(obj.env)
                ? Object.fromEntries(
                    Object.entries(obj.env as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
                  )
                : {},
            url: transport !== 'stdio' ? url : null,
            headers:
              obj.headers && typeof obj.headers === 'object' && !Array.isArray(obj.headers)
                ? Object.fromEntries(
                    Object.entries(obj.headers as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')])
                  )
                : {},
            enabled: typeof obj.enabled === 'boolean' ? obj.enabled : true,
            description: typeof obj.description === 'string' ? obj.description.trim() || null : null,
          };
          if (existingIdx >= 0) {
            nextServers[existingIdx] = candidate;
            updated += 1;
          } else {
            nextServers.push(candidate);
            added += 1;
          }
        }
        setServers(nextServers);
        if (nextServers.length > 0 && !selectedServerId) {
          setSelectedServerId(nextServers[0].id);
        }
        result = { added, updated, skipped, errors };
      }
      setImportResult(result);
      setActionNotice({
        tone: 'success',
        message: t('importSummary', {
          added: result.added,
          updated: result.updated,
          skipped: result.skipped,
        }),
      });
    } catch (err) {
      setImportError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  // Copy raw JSON
  const handleCopyRawJson = async (server: McpServer) => {
    try {
      await copyTextToClipboard(JSON.stringify(server, null, 2));
      setJsonCopied(true);
      setTimeout(() => setJsonCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  // Copy skill path
  const handleCopySkillPath = async (path: string) => {
    try {
      await copyTextToClipboard(path);
      setSkillPathCopied(true);
      setTimeout(() => setSkillPathCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  return (
    <div className="mcp-skills-page">
      {/* Header */}
      <header className="mcp-header">
        <div className="mcp-header-title">
          <h1>{t('title')}</h1>
          <p>{t('description')}</p>
        </div>
      </header>

      {/* Action error notice */}
      {actionNotice && (
        <div className="mcp-action-notice-wrap">
          <Notice
            tone={actionNotice.tone}
            variant="box"
            onDismiss={() => setActionNotice(null)}
          >
            {actionNotice.message}
          </Notice>
        </div>
      )}

      {/* Segmented Navigation Tabs */}
      <nav className="mcp-nav-bar" aria-label={t('title')}>
        <Tabs
          variant="segmented"
          value={activeTab}
          onChange={setActiveTab}
          items={[
            {
              value: 'mcp',
              id: 'mcp-subpage-tab-servers',
              panelId: 'mcp-panel-servers',
              label: `${t('tabMcp')} (${servers.length})`,
            },
            {
              value: 'skills',
              id: 'mcp-subpage-tab-skills',
              panelId: 'mcp-panel-skills',
              label: `${t('tabSkills')} (${skills.length})`,
            },
          ]}
        />
      </nav>

      {/* MCP Servers Tab Panel */}
      {activeTab === 'mcp' && (
        <div id="mcp-panel-servers" role="tabpanel" aria-labelledby="mcp-subpage-tab-servers">
          <div className="mcp-servers-container">
            {/* Left Column: Search, Filter Chips, Server List */}
            <aside className="mcp-servers-sidebar">
              <div className="mcp-sidebar-top">
                <div className="mcp-search-box">
                  <Search size={15} aria-hidden="true" />
                  <input
                    type="search"
                    placeholder={t('searchServersPlaceholder')}
                    value={serverSearch}
                    onChange={(e) => setServerSearch(e.target.value)}
                    aria-label={t('searchServersPlaceholder')}
                  />
                  {serverSearch && (
                    <button
                      type="button"
                      className="icon-button quiet"
                      onClick={() => setServerSearch('')}
                      aria-label={t('clearSearch')}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  className="primary-button"
                  onClick={handleOpenAddDialog}
                >
                  <Plus size={15} aria-hidden="true" />
                  <span>{t('addServer')}</span>
                </button>
              </div>

              {/* Server-level actions */}
              <div className="mcp-header-actions">
                <button
                  type="button"
                  className="secondary-button ghost"
                  onClick={() => {
                    setImportRaw('');
                    setImportResult(null);
                    setImportError(null);
                    setImportDialogOpen(true);
                  }}
                >
                  <Upload size={14} aria-hidden="true" />
                  <span>{t('import')}</span>
                </button>
                <button
                  type="button"
                  className="secondary-button ghost"
                  onClick={() => void handleExport()}
                >
                  {exportCopied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  <span>{exportCopied ? t('copied') : t('export')}</span>
                </button>
                <div className="mcp-more-menu-wrap" ref={moreMenuRef}>
                  <button
                    type="button"
                    className="secondary-button compact-button"
                    aria-haspopup="menu"
                    aria-expanded={moreOpen}
                    onClick={() => setMoreOpen((v) => !v)}
                  >
                    <span>{t('more')}</span>
                    <ChevronDown size={13} aria-hidden="true" />
                  </button>
                  {moreOpen && (
                    <div className="mcp-more-dropdown surface-panel" role="menu">
                      <button
                        type="button"
                        role="menuitem"
                        className="mcp-menu-item"
                        onClick={() => {
                          setMoreOpen(false);
                          void handleOpenFolder();
                        }}
                      >
                        <FolderOpen size={14} aria-hidden="true" />
                        <span>{t('openFolder')}</span>
                      </button>
                    </div>
                  )}
                </div>
              </div>

              {/* Filter chips and count bar (hidden while the list is empty) */}
              {servers.length > 0 && (
                <>
                  <SegmentedControl
                    className="mcp-filter-chips"
                    aria-label={t('serverFilter')}
                    value={serverFilter}
                    onChange={setServerFilter}
                    buttonClassName="mcp-filter-chip"
                    selectedClassName="active"
                    items={(['all', 'enabled', 'stdio', 'http', 'sse'] as const).map((filterKey) => ({
                      value: filterKey,
                      label: (
                        <>
                          <span>{t(filterKey)}</span>
                          <span className="mcp-chip-count">
                            {filterKey === 'all'
                              ? servers.length
                              : filterKey === 'enabled'
                              ? servers.filter((s) => s.enabled).length
                              : servers.filter((s) => s.transport === filterKey).length}
                          </span>
                        </>
                      ),
                    }))}
                  />
                  <div className="mcp-list-meta-bar">
                    <span>
                      {t('serverCount', {
                        count: filteredServers.length,
                        total: servers.length,
                      })}
                    </span>
                  </div>
                </>
              )}

              {/* Server List */}
              <div className="mcp-server-list" role="list">
                {loading ? (
                  <div className="mcp-skeleton-list" aria-busy="true">
                    <span className="sr-only">{t('loading')}</span>
                    {Array.from({ length: 4 }).map((_, idx) => (
                      <div key={idx} className="mcp-skeleton-row" />
                    ))}
                  </div>
                ) : (
                  <>
                    {serversError && (
                      <div
                        className={`mcp-inline-error-strip${serversTone === 'warn' ? ' mcp-inline-error-strip--warn' : ''}`}
                        role="alert"
                      >
                        <div className="mcp-inline-error-body">
                          <Info size={14} className="mcp-inline-error-icon" aria-hidden="true" />
                          <span className="mcp-inline-error-msg">{serversError}</span>
                        </div>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => void loadData()}
                        >
                          <RotateCw size={12} aria-hidden="true" />
                          <span>{t('retry')}</span>
                        </button>
                      </div>
                    )}
                    {servers.length === 0 ? (
                      <EmptyState
                        variant="compact"
                        icon={<Blocks size={28} />}
                        title={t('noServers')}
                        action={
                          <button
                            type="button"
                            className="primary-button"
                            onClick={handleOpenAddDialog}
                          >
                            <Plus size={14} aria-hidden="true" />
                            <span>{t('addServer')}</span>
                          </button>
                        }
                      >
                        {t('noServersHint')}
                      </EmptyState>
                    ) : filteredServers.length === 0 ? (
                  <EmptyState
                    variant="compact"
                    title={t('noSearchResults')}
                    action={
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setServerSearch('');
                          setServerFilter('all');
                        }}
                      >
                        {t('resetFilters')}
                      </button>
                    }
                  >
                    {t('noSearchResultsHint')}
                  </EmptyState>
                ) : (
                  filteredServers.map((server) => {
                    const isSelected = selectedServer?.id === server.id;
                    const cmdOrUrl =
                      server.transport === 'stdio'
                        ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
                        : server.url ?? '';

                    return (
                      <div
                        key={server.id}
                        role="listitem"
                        className={`mcp-server-row-button ${isSelected ? 'active' : ''}`}
                      >
                        <button
                          type="button"
                          className="mcp-server-row-select"
                          aria-pressed={isSelected}
                          onClick={() => setSelectedServerId(server.id)}
                        >
                          <span
                            className={`mcp-status-dot ${server.enabled ? 'active' : 'inactive'}`}
                            aria-hidden="true"
                          />
                          <span className="mcp-server-row-info">
                            <span className="mcp-server-row-heading">
                              <span className="mcp-server-name">{server.name}</span>
                              <span
                                className={`mcp-transport-badge transport-${server.transport}`}
                              >
                                {server.transport}
                              </span>
                            </span>
                            <span className="mcp-server-row-desc-line" title={cmdOrUrl}>
                              {cmdOrUrl || t('none')}
                            </span>
                          </span>
                        </button>
                        <div className="mcp-server-row-right">
                          {rowErrors[server.id] && (
                            <span className="mcp-row-error" role="alert" title={rowErrors[server.id]}>
                              {rowErrors[server.id]}
                            </span>
                          )}
                          <div className="mcp-server-row-actions">
                            <button
                              type="button"
                              className="mcp-row-action-btn"
                              aria-label={t('editServer', { name: server.name })}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleOpenEditDialog(server);
                              }}
                            >
                              <Edit3 size={13} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="mcp-row-action-btn"
                              aria-label={t('duplicateServer', { name: server.name })}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDuplicateServer(server);
                              }}
                            >
                              <Copy size={13} aria-hidden="true" />
                            </button>
                            <button
                              type="button"
                              className="mcp-row-action-btn mcp-row-action-btn--danger"
                              aria-label={t('deleteServer', { name: server.name })}
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedServerId(server.id);
                                setConfirmingDeleteServerId(server.id);
                              }}
                            >
                              <Trash2 size={13} aria-hidden="true" />
                            </button>
                          </div>
                          <Switch
                            checked={server.enabled}
                            aria-checked={server.enabled}
                            size="sm"
                            aria-label={t('enabledStatus', { name: server.name })}
                            onChange={() => void handleToggleServer(server)}
                          />
                        </div>
                      </div>
                    );
                  })
                )}
                  </>
                )}
              </div>
            </aside>

            {/* Right Column: Server Detail Panel */}
            <main className="mcp-servers-detail">
              {loading ? (
                <div className="mcp-detail-skeleton surface-panel" aria-busy="true">
                  <span className="sr-only">{t('loading')}</span>
                  <div className="mcp-skeleton-header">
                    <div className="mcp-skeleton-bar" />
                    <div className="mcp-skeleton-bar" />
                  </div>
                  <div className="mcp-skeleton-bar mcp-skeleton-bar--lead" />
                  <div className="mcp-skeleton-divider" />
                  <div className="mcp-skeleton-grid">
                    <div className="mcp-skeleton-bar" />
                    <div className="mcp-skeleton-bar" />
                    <div className="mcp-skeleton-bar" />
                    <div className="mcp-skeleton-bar" />
                    <div className="mcp-skeleton-bar" />
                    <div className="mcp-skeleton-bar" />
                  </div>
                </div>
              ) : selectedServer ? (
                <article className="mcp-detail-panel surface-panel">
                  {/* Detail Header */}
                  <header className="mcp-detail-header">
                    <div className="mcp-detail-title-group">
                      <div className="mcp-detail-title-row">
                        <h2>{selectedServer.name}</h2>
                        <span
                          className={`mcp-transport-badge transport-${selectedServer.transport}`}
                        >
                          {selectedServer.transport}
                        </span>
                        <span
                          className={`mcp-status-dot mcp-status-dot--lg ${selectedServer.enabled ? 'active' : 'inactive'}`}
                          aria-hidden="true"
                        />
                      </div>
                    </div>
                    {confirmingDeleteServerId === selectedServer.id ? (
                      <div className="mcp-delete-confirm-box">
                        <div className="mcp-delete-confirm-text">
                          <span className="mcp-delete-confirm-title">
                            {t('deleteConfirmTitle', { name: selectedServer.name })}
                          </span>
                          <span className="mcp-delete-confirm-desc">
                            {t('deleteConfirmDesc')}
                          </span>
                        </div>
                        <div className="mcp-delete-confirm-actions">
                          <button
                            type="button"
                            className="secondary-button"
                            onClick={() => setConfirmingDeleteServerId(null)}
                          >
                            {t('cancel')}
                          </button>
                          <button
                            type="button"
                            className="danger-button"
                            onClick={() => void handleDeleteServer(selectedServer.id)}
                          >
                            {t('confirmDelete')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mcp-detail-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleOpenEditDialog(selectedServer)}
                        >
                          <Edit3 size={14} aria-hidden="true" />
                          <span>{t('edit')}</span>
                        </button>
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => handleDuplicateServer(selectedServer)}
                        >
                          <Copy size={14} aria-hidden="true" />
                          <span>{t('duplicate')}</span>
                        </button>
                        <button
                          type="button"
                          className="secondary-button text-danger"
                          onClick={() => setConfirmingDeleteServerId(selectedServer.id)}
                        >
                          <Trash2 size={14} aria-hidden="true" />
                          <span>{t('delete')}</span>
                        </button>
                      </div>
                    )}
                  </header>

                  {/* Description */}
                  <p
                    className={`mcp-server-desc-text ${
                      selectedServer.description ? '' : 'muted'
                    }`}
                  >
                    {selectedServer.description || t('noDescription')}
                  </p>

                  {/* Key/Value Grid */}
                  <dl className="mcp-detail-grid">
                    <dt className="mcp-grid-dt">{t('transport')}</dt>
                    <dd className="mcp-grid-dd">
                      <span className={`mcp-transport-badge transport-${selectedServer.transport}`}>
                        {selectedServer.transport}
                      </span>
                    </dd>

                    {selectedServer.transport === 'stdio' ? (
                      <>
                        <dt className="mcp-grid-dt">{t('command')}</dt>
                        <dd className="mcp-grid-dd">
                          <code className="mcp-code-text">{selectedServer.command || '—'}</code>
                        </dd>

                        <dt className="mcp-grid-dt">{t('args')}</dt>
                        <dd className="mcp-grid-dd">
                          {selectedServer.args && selectedServer.args.length > 0 ? (
                            <code className="mcp-code-text">
                              {selectedServer.args.join(' ')}
                            </code>
                          ) : (
                            <span>{t('none')}</span>
                          )}
                        </dd>
                      </>
                    ) : (
                      <>
                        <dt className="mcp-grid-dt">{t('url')}</dt>
                        <dd className="mcp-grid-dd">
                          <code className="mcp-code-text">{selectedServer.url || '—'}</code>
                        </dd>
                      </>
                    )}

                    <dt className="mcp-grid-dt">{t('env')}</dt>
                    <dd className="mcp-grid-dd">
                      {selectedServer.env && Object.keys(selectedServer.env).length > 0 ? (
                        <table className="mcp-kv-table">
                          <thead>
                            <tr>
                              <th>{t('keyColumn')}</th>
                              <th>{t('valueColumn')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(selectedServer.env).map(([k, v]) => (
                              <tr key={k}>
                                <td>{k}</td>
                                <td>{v}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <span>{t('none')}</span>
                      )}
                    </dd>

                    <dt className="mcp-grid-dt">{t('headers')}</dt>
                    <dd className="mcp-grid-dd">
                      {selectedServer.headers && Object.keys(selectedServer.headers).length > 0 ? (
                        <table className="mcp-kv-table">
                          <thead>
                            <tr>
                              <th>{t('headerColumn')}</th>
                              <th>{t('valueColumn')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {Object.entries(selectedServer.headers).map(([k, v]) => (
                              <tr key={k}>
                                <td>{k}</td>
                                <td>{v}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      ) : (
                        <span>{t('none')}</span>
                      )}
                    </dd>
                  </dl>

                  {/* Raw JSON Disclosure */}
                  <details className="mcp-raw-json-details">
                    <summary>
                      <span>{t('rawJson')}</span>
                      <button
                        type="button"
                        className="mcp-copy-json-btn"
                        onClick={(e) => {
                          e.preventDefault();
                          void handleCopyRawJson(selectedServer);
                        }}
                      >
                        {jsonCopied ? (
                          <Check size={12} aria-hidden="true" />
                        ) : (
                          <Copy size={12} aria-hidden="true" />
                        )}
                        <span>{jsonCopied ? t('copied') : t('copyJson')}</span>
                      </button>
                    </summary>
                    <pre>
                      <code>{JSON.stringify(selectedServer, null, 2)}</code>
                    </pre>
                  </details>
                </article>
              ) : (
                <div className="mcp-detail-placeholder surface-panel">
                  <p className="mcp-placeholder-text">
                    {servers.length === 0 ? t('noServersDetailHint') : t('selectServerHint')}
                  </p>
                </div>
              )}
            </main>
          </div>
        </div>
      )}

      {/* Skills Tab Panel */}
      {activeTab === 'skills' && (
        <div id="mcp-panel-skills" role="tabpanel" aria-labelledby="mcp-subpage-tab-skills">
          <div className="skills-view-wrapper">
            {/* Top Toolbar */}
            <div className="skills-toolbar">
              <div className="skills-toolbar-left">
                <div className="mcp-search-box">
                  <Search size={15} aria-hidden="true" />
                  <input
                    type="search"
                    placeholder={t('searchSkillsPlaceholder')}
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    aria-label={t('searchSkillsPlaceholder')}
                  />
                  {skillSearch && (
                    <button
                      type="button"
                      className="icon-button quiet"
                      onClick={() => setSkillSearch('')}
                      aria-label={t('clearSearch')}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>

                {/* Source Filter chips (hidden while the list is empty) */}
                {skills.length > 0 && (
                  <SegmentedControl
                    className="mcp-filter-chips"
                    aria-label={t('skillSource')}
                    value={skillSourceFilter}
                    onChange={setSkillSourceFilter}
                    buttonClassName="mcp-filter-chip"
                    selectedClassName="active"
                    items={(['all', 'openclaw', 'workshop', 'project', 'custom'] as const).map(
                      (sourceKey) => ({
                        value: sourceKey,
                        label: (
                          <>
                            <span>
                              {sourceKey === 'all'
                                ? t('all')
                                : sourceKey === 'openclaw'
                                ? t('sourceOpenClaw')
                                : sourceKey === 'workshop'
                                ? t('sourceWorkshop')
                                : sourceKey === 'project'
                                ? t('sourceProject')
                                : t('sourceCustom')}
                            </span>
                            <span className="mcp-chip-count">
                              {sourceKey === 'all'
                                ? skills.length
                                : skills.filter((s) => s.source === sourceKey).length}
                            </span>
                          </>
                        ),
                      })
                    )}
                  />
                )}
              </div>

              <div className="skills-toolbar-right">
                <button
                  type="button"
                  className="secondary-button ghost"
                  onClick={() => void handleOpenFolder()}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                  <span>{t('openFolder')}</span>
                </button>
                {skills.length > 0 && (
                  <>
                    <span className="skills-count-text">
                      {t('skillsCount', {
                        count: filteredSkills.length,
                        total: skills.length,
                      })}
                    </span>
                    <Switch
                      checked={skillEnabledOnly}
                      size="sm"
                      label={t('enabledOnly')}
                      onChange={(e) => setSkillEnabledOnly(e.target.checked)}
                    />
                  </>
                )}
              </div>
            </div>

            {/* Layout when a skill is selected vs normal grid */}
            <div
              className={`skills-content-wrap${selectedSkill ? ' skills-split-container' : ''}`}
            >
              {/* Cards Grid */}
              <div className={selectedSkill ? 'skills-split-list' : undefined}>
                {loading ? (
                  <div className="skills-grid" aria-busy="true">
                    <span className="sr-only">{t('loading')}</span>
                    {Array.from({ length: 6 }).map((_, idx) => (
                      <div key={idx} className="mcp-skeleton-card" />
                    ))}
                  </div>
                ) : (
                  <>
                    {skillsError && (
                      <div
                        className={`mcp-inline-error-strip mcp-inline-error-strip--spaced${skillsTone === 'warn' ? ' mcp-inline-error-strip--warn' : ''}`}
                        role="alert"
                      >
                        <div className="mcp-inline-error-body">
                          <Info size={14} className="mcp-inline-error-icon" aria-hidden="true" />
                          <span className="mcp-inline-error-msg">{skillsError}</span>
                        </div>
                        <button
                          type="button"
                          className="secondary-button compact-button"
                          onClick={() => void loadData()}
                        >
                          <RotateCw size={12} aria-hidden="true" />
                          <span>{t('retry')}</span>
                        </button>
                      </div>
                    )}
                    {skills.length === 0 ? (
                      <EmptyState
                        variant="compact"
                        icon={<Sparkles size={36} />}
                        title={t('noSkills')}
                        action={
                          <button
                            type="button"
                            className="primary-button"
                            onClick={() => void handleOpenFolder()}
                          >
                            <FolderOpen size={14} aria-hidden="true" />
                            <span>{t('openFolder')}</span>
                          </button>
                        }
                      >
                        {t('noSkillsHint')}
                      </EmptyState>
                    ) : filteredSkills.length === 0 ? (
                  <EmptyState
                    variant="compact"
                    title={t('noSkillSearchResults')}
                    action={
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setSkillSearch('');
                          setSkillSourceFilter('all');
                          setSkillEnabledOnly(false);
                        }}
                      >
                        {t('resetFilters')}
                      </button>
                    }
                  >
                    {t('noSkillSearchResultsHint')}
                  </EmptyState>
                ) : (
                  <div className="skills-grid" role="list">
                    {filteredSkills.map((skill) => {
                      const isSelected = selectedSkill?.id === skill.id;
                      return (
                        <div
                          key={skill.id}
                          role="listitem"
                          className={`skill-card ${isSelected ? 'active' : ''}`}
                        >
                          <button
                            type="button"
                            className="skill-card-select"
                            aria-pressed={isSelected}
                            onClick={() => handleSelectSkill(skill)}
                          >
                            <span className="skill-card-heading">
                              <span className="skill-card-name" title={skill.name}>
                                {skill.name}
                              </span>
                              <span className={`skill-source-badge source-${skill.source}`}>
                                {sourceBadgeLabel(skill.source)}
                              </span>
                            </span>

                            <span className="skill-card-description" title={skill.description}>
                              {skill.description || t('noDescription')}
                            </span>

                            <span className="skill-card-meta-line muted">
                              <span className="skill-card-file-count">{t('filesCount', { count: skill.fileCount })}</span>
                              <span className="skill-card-meta-dot">·</span>
                              <span className="skill-card-path" title={skill.path}>{skill.path}</span>
                            </span>
                          </button>
                          <div className="skill-card-switch-wrap">
                            {rowErrors[skill.path] && (
                              <span className="mcp-row-error" role="alert" title={rowErrors[skill.path]}>
                                {rowErrors[skill.path]}
                              </span>
                            )}
                            <Switch
                              checked={skill.enabled}
                              aria-checked={skill.enabled}
                              size="sm"
                              aria-label={t('enabledStatus', { name: skill.name })}
                              onChange={() => void handleToggleSkill(skill)}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                  </>
                )}
              </div>

              {/* Selected Skill Detail Panel: at >= 1100px as right pane, overlay below */}
              {selectedSkill && (
                <div
                  className="skill-detail-desktop-wrapper"
                  onClick={(e) => {
                    if (e.target === e.currentTarget) {
                      setSelectedSkill(null);
                    }
                  }}
                >
                  <aside className="skill-detail-panel">
                    <header className="skill-detail-sticky-header">
                      <div className="skill-detail-header-row1">
                        <div className="skill-detail-name-wrap">
                          <h2 title={selectedSkill.name}>{selectedSkill.name}</h2>
                          <span
                            className={`skill-source-badge source-${selectedSkill.source}`}
                          >
                            {sourceBadgeLabel(selectedSkill.source)}
                          </span>
                        </div>
                        <div className="skill-detail-header-controls">
                          {rowErrors[selectedSkill.path] && (
                            <span className="mcp-row-error" role="alert" title={rowErrors[selectedSkill.path]}>
                              {rowErrors[selectedSkill.path]}
                            </span>
                          )}
                          <Switch
                            checked={selectedSkill.enabled}
                            aria-checked={selectedSkill.enabled}
                            size="sm"
                            aria-label={t('enabledStatus', { name: selectedSkill.name })}
                            onChange={() => void handleToggleSkill(selectedSkill)}
                          />
                          <button
                            type="button"
                            className="icon-button quiet"
                            onClick={() => setSelectedSkill(null)}
                            aria-label={t('close')}
                          >
                            <X size={16} aria-hidden="true" />
                          </button>
                        </div>
                      </div>
                      <div className="skill-detail-header-row2">
                        <span className="skill-detail-path-text" title={selectedSkill.path}>
                          {selectedSkill.path}
                        </span>
                        <button
                          type="button"
                          className="skill-copy-path-btn"
                          onClick={() => void handleCopySkillPath(selectedSkill.path)}
                        >
                          {skillPathCopied ? (
                            <Check size={12} aria-hidden="true" />
                          ) : (
                            <Copy size={12} aria-hidden="true" />
                          )}
                          <span>{skillPathCopied ? t('copiedPath') : t('copyPath')}</span>
                        </button>
                      </div>
                    </header>

                    <div className="skill-prose-scroll">
                      {loadingSkillDetail ? (
                        <div aria-busy="true">
                          <span className="sr-only">{t('loading')}</span>
                          <p>{t('loadingSkill')}</p>
                          <div className="mcp-skeleton-lines">
                            <div className="mcp-skeleton-bar" />
                            <div className="mcp-skeleton-bar" />
                            <div className="mcp-skeleton-bar" />
                            <div className="mcp-skeleton-bar" />
                          </div>
                        </div>
                      ) : skillDetailError ? (
                        <Notice tone="error">
                          <p>{skillDetailError}</p>
                          <button
                            type="button"
                            className="secondary-button compact-button mcp-retry-button"
                            onClick={() => void fetchSkillDetail(selectedSkill.path)}
                          >
                            <RotateCw size={12} aria-hidden="true" />
                            <span>{t('retry')}</span>
                          </button>
                        </Notice>
                      ) : skillDetail && skillDetail.trim() ? (
                        <MarkdownProse content={skillDetail} />
                      ) : (
                        <EmptyState variant="compact" title={t('skillDetailEmpty')} />
                      )}
                    </div>
                  </aside>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add / Edit MCP Server Dialog */}
      {serverDialogOpen && (
        <Dialog
          className="config-dialog mcp-form-dialog"
          labelledBy="mcp-server-form-title"
          onClose={() => setServerDialogOpen(false)}
          dismissOnBackdrop
        >
          <div className="mcp-dialog-header">
            <h2 id="mcp-server-form-title">
              {dialogMode === 'add' ? t('addTitle') : t('editTitle')}
            </h2>
            <button
              type="button"
              className="icon-button quiet"
              onClick={() => setServerDialogOpen(false)}
              aria-label={t('close')}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <div className="mcp-dialog-scroll-body">
            {/* Server Name */}
            <div className="mcp-form-field">
              <label htmlFor="mcp-field-name">
                <span>{t('serverName')}</span>
                {showFieldError('name') && formValidation.nameError && (
                  <span className="mcp-field-error">{formValidation.nameError}</span>
                )}
              </label>
              <input
                id="mcp-field-name"
                type="text"
                className="config-dialog-text-input"
                placeholder={t('serverNamePlaceholder')}
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                onBlur={() => markFieldTouched('name')}
              />
            </div>

            {/* Transport Selector */}
            <div className="mcp-form-field">
              <div className="mcp-form-field-label" id="mcp-transport-label">
                <span>{t('transport')}</span>
              </div>
              <div
                className="mcp-transport-selector"
                role="radiogroup"
                aria-labelledby="mcp-transport-label"
              >
                {(['stdio', 'http', 'sse'] as const).map((trans) => (
                  <button
                    key={trans}
                    type="button"
                    role="radio"
                    aria-checked={formTransport === trans}
                    className={`mcp-transport-option ${formTransport === trans ? 'selected' : ''}`}
                    onClick={() => setFormTransport(trans)}
                  >
                    {trans === 'stdio'
                      ? t('transportStdio')
                      : trans === 'http'
                      ? t('transportHttp')
                      : t('transportSse')}
                  </button>
                ))}
              </div>
            </div>

            {/* Transport conditional fields */}
            {formTransport === 'stdio' ? (
              <>
                <div className="mcp-form-field">
                  <label htmlFor="mcp-field-command">
                    <span>{t('command')}</span>
                    {showFieldError('command') && formValidation.commandError && (
                      <span className="mcp-field-error">{formValidation.commandError}</span>
                    )}
                  </label>
                  <input
                    id="mcp-field-command"
                    type="text"
                    className="config-dialog-text-input"
                    placeholder={t('commandPlaceholder')}
                    value={formCommand}
                    onChange={(e) => setFormCommand(e.target.value)}
                    onBlur={() => markFieldTouched('command')}
                  />
                </div>

                <div className="mcp-form-field">
                  <label htmlFor="mcp-field-args">
                    <span>{t('argsLabel')}</span>
                    <span className="mcp-field-hint">{t('argsHint')}</span>
                  </label>
                  <textarea
                    id="mcp-field-args"
                    className="config-dialog-text-input mcp-code-input"
                    rows={4}
                    placeholder={t('argsPlaceholder')}
                    value={formArgs}
                    onChange={(e) => setFormArgs(e.target.value)}
                  />
                </div>
              </>
            ) : (
              <div className="mcp-form-field">
                <label htmlFor="mcp-field-url">
                  <span>{t('url')}</span>
                  {showFieldError('url') && formValidation.urlError && (
                    <span className="mcp-field-error">{formValidation.urlError}</span>
                  )}
                </label>
                <input
                  id="mcp-field-url"
                  type="url"
                  className="config-dialog-text-input"
                  placeholder={t('urlPlaceholder')}
                  value={formUrl}
                  onChange={(e) => setFormUrl(e.target.value)}
                  onBlur={() => markFieldTouched('url')}
                />
              </div>
            )}

            {/* Environment Variables */}
            <div className="mcp-form-field">
              <div className="mcp-form-field-label">
                <span>{t('env')}</span>
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() =>
                    setFormEnv((prev) => [
                      ...prev,
                      { id: `env-${Date.now()}`, key: '', value: '' },
                    ])
                  }
                >
                  <Plus size={13} aria-hidden="true" />
                  <span>{t('addEnv')}</span>
                </button>
              </div>
              <div className="mcp-kv-editor">
                {formEnv.map((pair, index) => (
                  <div key={pair.id} className="mcp-kv-row">
                    <input
                      type="text"
                      className="config-dialog-text-input"
                      placeholder={t('keyPlaceholder')}
                      value={pair.key}
                      onChange={(e) => {
                        const val = e.target.value;
                        setFormEnv((prev) =>
                          prev.map((item, idx) => (idx === index ? { ...item, key: val } : item))
                        );
                      }}
                    />
                    <input
                      type="text"
                      className="config-dialog-text-input"
                      placeholder={t('valuePlaceholder')}
                      value={pair.value}
                      onChange={(e) => {
                        const val = e.target.value;
                        setFormEnv((prev) =>
                          prev.map((item, idx) => (idx === index ? { ...item, value: val } : item))
                        );
                      }}
                    />
                    <button
                      type="button"
                      className="icon-button quiet"
                      onClick={() =>
                        setFormEnv((prev) => prev.filter((_, idx) => idx !== index))
                      }
                      aria-label={t('remove')}
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Headers */}
            <div className="mcp-form-field">
              <div className="mcp-form-field-label">
                <span>{t('headers')}</span>
                <button
                  type="button"
                  className="secondary-button compact-button"
                  onClick={() =>
                    setFormHeaders((prev) => [
                      ...prev,
                      { id: `header-${Date.now()}`, key: '', value: '' },
                    ])
                  }
                >
                  <Plus size={13} aria-hidden="true" />
                  <span>{t('addHeader')}</span>
                </button>
              </div>
              <div className="mcp-kv-editor">
                {formHeaders.map((pair, index) => (
                  <div key={pair.id} className="mcp-kv-row">
                    <input
                      type="text"
                      className="config-dialog-text-input"
                      placeholder={t('keyPlaceholder')}
                      value={pair.key}
                      onChange={(e) => {
                        const val = e.target.value;
                        setFormHeaders((prev) =>
                          prev.map((item, idx) => (idx === index ? { ...item, key: val } : item))
                        );
                      }}
                    />
                    <input
                      type="text"
                      className="config-dialog-text-input"
                      placeholder={t('valuePlaceholder')}
                      value={pair.value}
                      onChange={(e) => {
                        const val = e.target.value;
                        setFormHeaders((prev) =>
                          prev.map((item, idx) => (idx === index ? { ...item, value: val } : item))
                        );
                      }}
                    />
                    <button
                      type="button"
                      className="icon-button quiet"
                      onClick={() =>
                        setFormHeaders((prev) => prev.filter((_, idx) => idx !== index))
                      }
                      aria-label={t('remove')}
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Description */}
            <div className="mcp-form-field">
              <label htmlFor="mcp-field-description">
                <span>{t('serverDescription')}</span>
              </label>
              <textarea
                id="mcp-field-description"
                className="config-dialog-text-input"
                rows={2}
                placeholder={t('descriptionPlaceholder')}
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
              />
            </div>

            {/* Enabled switch */}
            <div className="mcp-form-field mcp-form-field--tight">
              <Switch
                checked={formEnabled}
                label={t('enableOnSave')}
                onChange={(e) => setFormEnabled(e.target.checked)}
              />
            </div>
          </div>

          <div className="config-dialog-actions two-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setServerDialogOpen(false)}
              disabled={savingServer}
            >
              {t('cancel')}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={!formValidation.isValid || savingServer}
              onClick={() => void handleSaveServer()}
            >
              {savingServer ? t('saving') : t('save')}
            </button>
          </div>
        </Dialog>
      )}

      {/* Import MCP Servers Dialog */}
      {importDialogOpen && (
        <Dialog
          className="config-dialog mcp-form-dialog"
          labelledBy="mcp-import-title"
          onClose={() => setImportDialogOpen(false)}
          dismissOnBackdrop
        >
          <div className="mcp-dialog-header">
            <h2 id="mcp-import-title">{t('importTitle')}</h2>
            <button
              type="button"
              className="icon-button quiet"
              onClick={() => setImportDialogOpen(false)}
              aria-label={t('close')}
            >
              <X size={18} aria-hidden="true" />
            </button>
          </div>

          <div className="mcp-dialog-scroll-body">
            <p className="mcp-field-hint">{t('importHint')}</p>

            {importError && <Notice tone="error">{importError}</Notice>}

            {importResult ? (
              <div className="mcp-import-summary-card">
                <strong>{t('importResult')}</strong>
                <p>
                  {t('importSummary', {
                    added: importResult.added,
                    updated: importResult.updated,
                    skipped: importResult.skipped,
                  })}
                </p>
                {importResult.errors && importResult.errors.length > 0 && (
                  <div>
                    <span>{t('importErrors')}</span>
                    <ul className="mcp-import-error-list">
                      {importResult.errors.map((errStr, idx) => (
                        <li key={idx}>{errStr}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <div className="mcp-form-field">
                <textarea
                  className="config-dialog-text-input mcp-code-input"
                  rows={10}
                  placeholder={`{\n  "mcpServers": {\n    "example": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]\n    }\n  }\n}`}
                  value={importRaw}
                  onChange={(e) => {
                    setImportRaw(e.target.value);
                    if (importError) setImportError(null);
                  }}
                />
              </div>
            )}
          </div>

          <div className="config-dialog-actions two-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => setImportDialogOpen(false)}
            >
              {importResult ? t('close') : t('cancel')}
            </button>
            {!importResult && (
              <button
                type="button"
                className="primary-button"
                disabled={!importRaw.trim() || importing}
                onClick={() => void handleImportSubmit()}
              >
                {importing ? t('saving') : t('importAction')}
              </button>
            )}
          </div>
        </Dialog>
      )}
    </div>
  );
}
