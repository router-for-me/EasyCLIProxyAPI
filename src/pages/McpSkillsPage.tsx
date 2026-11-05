import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Blocks,
  Check,
  ChevronDown,
  Copy,
  Edit3,
  ExternalLink,
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
      setSkillsTone(isMissing ? 'warn' : 'error');
      setSkillsError(isMissing ? t('backendNotReady') : `${t('loadFailed')}: ${errorMessage(err)}`);
      setSkills([]);
    }

    setLoading(false);
  }, [selectedServerId, locale]);

  useEffect(() => {
    void loadData();
  }, []);

  // Sync selected server
  const selectedServer = useMemo(
    () => servers.find((s) => s.id === selectedServerId) ?? (servers.length > 0 ? servers[0] : null),
    [servers, selectedServerId]
  );

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
    } catch (err) {
      setServers((prev) =>
        prev.map((s) => (s.id === server.id ? { ...s, enabled: previousEnabled } : s))
      );
      const errText = errorMessage(err) || t('toggleFailed');
      setRowErrors((prev) => ({ ...prev, [server.id]: errText }));
      setTimeout(() => {
        setRowErrors((prev) => {
          const copy = { ...prev };
          delete copy[server.id];
          return copy;
        });
      }, 4000);
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
    } catch (err) {
      setSkills((prev) =>
        prev.map((s) => (s.path === skill.path ? { ...s, enabled: previousEnabled } : s))
      );
      if (selectedSkill?.path === skill.path) {
        setSelectedSkill((prev) => (prev ? { ...prev, enabled: previousEnabled } : null));
      }
      const errText = errorMessage(err) || t('toggleFailed');
      setRowErrors((prev) => ({ ...prev, [skill.path]: errText }));
      setTimeout(() => {
        setRowErrors((prev) => {
          const copy = { ...prev };
          delete copy[skill.path];
          return copy;
        });
      }, 4000);
    }
  };

  // Delete server
  const handleDeleteServer = async (id: string) => {
    try {
      await deleteMcpServer(id);
      setServers((prev) => prev.filter((s) => s.id !== id));
      setConfirmingDeleteServerId(null);
      if (selectedServerId === id) {
        const remaining = servers.filter((s) => s.id !== id);
        setSelectedServerId(remaining.length > 0 ? remaining[0].id : null);
      }
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
      const json = await exportMcpServersJson();
      await navigator.clipboard.writeText(json);
      setExportCopied(true);
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

  // Save server
  const handleSaveServer = async () => {
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
      await saveMcpServer(serverToSave);
      setServers((prev) => {
        const idx = prev.findIndex((s) => s.id === serverToSave.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = serverToSave;
          return next;
        }
        return [...prev, serverToSave];
      });
      setSelectedServerId(serverToSave.id);
      setServerDialogOpen(false);
    } catch (err) {
      setActionNotice({ tone: 'error', message: `${t('save')}: ${errorMessage(err)}` });
    } finally {
      setSavingServer(false);
    }
  };

  // Submit Import
  const handleImportSubmit = async () => {
    if (!importRaw.trim()) return;
    try {
      JSON.parse(importRaw);
    } catch {
      setImportError(t('invalidJson'));
      return;
    }

    setImporting(true);
    setImportError(null);
    try {
      const result = await importMcpServersJson(importRaw.trim());
      setImportResult(result);
      void loadData();
    } catch (err) {
      setImportError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  // Copy raw JSON
  const handleCopyRawJson = async (server: McpServer) => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(server, null, 2));
      setJsonCopied(true);
      setTimeout(() => setJsonCopied(false), 2000);
    } catch {
      // ignore
    }
  };

  // Copy skill path
  const handleCopySkillPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
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
                  disabled={servers.length === 0}
                  onClick={() => {
                    setMoreOpen(false);
                    void handleExport();
                  }}
                >
                  {exportCopied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
                  <span>{exportCopied ? t('copied') : t('export')}</span>
                </button>
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
              label: t('tabMcp'),
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
                      aria-label={t('cancel')}
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

              {/* Filter chips */}
              <SegmentedControl
                className="mcp-filter-chips"
                aria-label="Server filter"
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

              {/* Server count bar */}
              <div className="mcp-list-meta-bar">
                <span>
                  {t('serverCount', {
                    count: filteredServers.length,
                    total: servers.length,
                  })}
                </span>
              </div>

              {/* Server List */}
              <div className="mcp-server-list" role="list">
                {loading ? (
                  <div className="mcp-skeleton-list" aria-busy="true">
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
                      <button
                        key={server.id}
                        type="button"
                        role="listitem"
                        className={`mcp-server-row-button ${isSelected ? 'active' : ''}`}
                        onClick={() => setSelectedServerId(server.id)}
                      >
                        <div className="mcp-server-row-left">
                          <span
                            className={`mcp-status-dot ${server.enabled ? 'active' : 'inactive'}`}
                            aria-hidden="true"
                          />
                          <div className="mcp-server-row-info">
                            <div className="mcp-server-row-heading">
                              <span className="mcp-server-name">{server.name}</span>
                              <span
                                className={`mcp-transport-badge transport-${server.transport}`}
                              >
                                {server.transport}
                              </span>
                            </div>
                            <span className="mcp-server-row-desc-line" title={cmdOrUrl}>
                              {cmdOrUrl || t('none')}
                            </span>
                          </div>
                        </div>
                        <div
                          className="mcp-server-row-right"
                          onClick={(e) => e.stopPropagation()}
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          {rowErrors[server.id] && (
                            <span className="mcp-row-error" role="alert" title={rowErrors[server.id]}>
                              {rowErrors[server.id]}
                            </span>
                          )}
                          <Switch
                            checked={server.enabled}
                            aria-checked={server.enabled}
                            size="sm"
                            aria-label={`${server.name} status`}
                            onChange={(e) => {
                              e.stopPropagation();
                              void handleToggleServer(server);
                            }}
                          />
                        </div>
                      </button>
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
                  <div className="mcp-skeleton-header">
                    <div className="mcp-skeleton-bar" style={{ width: '40%', height: 20 }} />
                    <div className="mcp-skeleton-bar" style={{ width: 80, height: 28 }} />
                  </div>
                  <div className="mcp-skeleton-bar" style={{ width: '65%', height: 13, marginTop: 12 }} />
                  <div className="mcp-skeleton-divider" />
                  <div className="mcp-skeleton-grid">
                    <div className="mcp-skeleton-bar" style={{ width: '30%', height: 13 }} />
                    <div className="mcp-skeleton-bar" style={{ width: '60%', height: 13 }} />
                    <div className="mcp-skeleton-bar" style={{ width: '30%', height: 13 }} />
                    <div className="mcp-skeleton-bar" style={{ width: '85%', height: 13 }} />
                    <div className="mcp-skeleton-bar" style={{ width: '30%', height: 13 }} />
                    <div className="mcp-skeleton-bar" style={{ width: '45%', height: 13 }} />
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
                          className={`mcp-status-dot ${selectedServer.enabled ? 'active' : 'inactive'}`}
                          style={{ width: 10, height: 10 }}
                          aria-hidden="true"
                        />
                      </div>
                    </div>
                    {confirmingDeleteServerId === selectedServer.id ? (
                      <div className="mcp-delete-confirm-box">
                        <span>
                          {t('deleteConfirmTitle', { name: selectedServer.name })}
                        </span>
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
                              <th>Key</th>
                              <th>Value</th>
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
                              <th>Header</th>
                              <th>Value</th>
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
                  <p className="mcp-placeholder-text">{t('selectServerHint')}</p>
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
                      aria-label={t('cancel')}
                    >
                      <X size={14} aria-hidden="true" />
                    </button>
                  )}
                </div>

                {/* Source Filter chips */}
                <SegmentedControl
                  className="mcp-filter-chips"
                  aria-label="Skill source"
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
              </div>

              <div className="skills-toolbar-right">
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
              </div>
            </div>

            {/* Layout when a skill is selected vs normal grid */}
            <div
              style={{ marginTop: 20 }}
              className={selectedSkill ? 'skills-split-container' : undefined}
            >
              {/* Cards Grid */}
              <div className={selectedSkill ? 'skills-split-list' : undefined}>
                {loading ? (
                  <div className="skills-grid">
                    {Array.from({ length: 6 }).map((_, idx) => (
                      <div key={idx} className="mcp-skeleton-card" />
                    ))}
                  </div>
                ) : (
                  <>
                    {skillsError && (
                      <div
                        className={`mcp-inline-error-strip${skillsTone === 'warn' ? ' mcp-inline-error-strip--warn' : ''}`}
                        role="alert"
                        style={{ marginBottom: 16 }}
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
                  <div className="skills-grid">
                    {filteredSkills.map((skill) => {
                      const isSelected = selectedSkill?.id === skill.id;
                      return (
                        <button
                          key={skill.id}
                          type="button"
                          className={`skill-card ${isSelected ? 'active' : ''}`}
                          onClick={() => handleSelectSkill(skill)}
                        >
                          <div className="skill-card-header">
                            <div className="skill-card-heading">
                              <h3 className="skill-card-name" title={skill.name}>
                                {skill.name}
                              </h3>
                              <span className={`skill-source-badge source-${skill.source}`}>
                                {sourceBadgeLabel(skill.source)}
                              </span>
                            </div>
                            <div
                              className="skill-card-switch-wrap"
                              onClick={(e) => e.stopPropagation()}
                              onKeyDown={(e) => e.stopPropagation()}
                            >
                              {rowErrors[skill.path] && (
                                <span className="mcp-row-error" role="alert" title={rowErrors[skill.path]}>
                                  {rowErrors[skill.path]}
                                </span>
                              )}
                              <Switch
                                checked={skill.enabled}
                                aria-checked={skill.enabled}
                                size="sm"
                                aria-label={`${skill.name} status`}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  void handleToggleSkill(skill);
                                }}
                              />
                            </div>
                          </div>

                          <p className="skill-card-description" title={skill.description}>
                            {skill.description || t('noDescription')}
                          </p>

                          <div className="skill-card-meta-line muted">
                            <span className="skill-card-file-count">{t('filesCount', { count: skill.fileCount })}</span>
                            <span className="skill-card-meta-dot">·</span>
                            <span className="skill-card-path" title={skill.path}>{skill.path}</span>
                          </div>
                        </button>
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
                            {selectedSkill.source}
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
                            aria-label={`${selectedSkill.name} status`}
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
                        <div>
                          <p>{t('loadingSkill')}</p>
                          <div className="mcp-skeleton-bar" style={{ width: '90%' }} />
                          <div className="mcp-skeleton-bar" style={{ width: '100%' }} />
                          <div className="mcp-skeleton-bar" style={{ width: '75%' }} />
                          <div className="mcp-skeleton-bar" style={{ width: '85%' }} />
                        </div>
                      ) : skillDetailError ? (
                        <Notice tone="error">
                          <p>{skillDetailError}</p>
                          <button
                            type="button"
                            className="secondary-button compact-button"
                            onClick={() => void fetchSkillDetail(selectedSkill.path)}
                            style={{ marginTop: 8 }}
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
                {formValidation.nameError && (
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
              />
            </div>

            {/* Transport Selector */}
            <div className="mcp-form-field">
              <label>
                <span>{t('transport')}</span>
              </label>
              <div className="mcp-transport-selector">
                {(['stdio', 'http', 'sse'] as const).map((trans) => (
                  <button
                    key={trans}
                    type="button"
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
                    {formValidation.commandError && (
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
                  />
                </div>

                <div className="mcp-form-field">
                  <label htmlFor="mcp-field-args">
                    <span>{t('argsLabel')}</span>
                    <span className="mcp-field-hint">{t('argsHint')}</span>
                  </label>
                  <textarea
                    id="mcp-field-args"
                    className="config-dialog-text-input"
                    rows={4}
                    placeholder={t('argsPlaceholder')}
                    value={formArgs}
                    onChange={(e) => setFormArgs(e.target.value)}
                    style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                  />
                </div>
              </>
            ) : (
              <div className="mcp-form-field">
                <label htmlFor="mcp-field-url">
                  <span>{t('url')}</span>
                  {formValidation.urlError && (
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
                />
              </div>
            )}

            {/* Environment Variables */}
            <div className="mcp-form-field">
              <label>
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
              </label>
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
                      aria-label="Remove"
                    >
                      <X size={15} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>

            {/* Headers */}
            <div className="mcp-form-field">
              <label>
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
              </label>
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
                      aria-label="Remove"
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
            <div className="mcp-form-field" style={{ paddingTop: 4 }}>
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
                  className="config-dialog-text-input"
                  rows={10}
                  placeholder={`{\n  "mcpServers": {\n    "example": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]\n    }\n  }\n}`}
                  value={importRaw}
                  onChange={(e) => setImportRaw(e.target.value)}
                  style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, lineHeight: 1.5 }}
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
