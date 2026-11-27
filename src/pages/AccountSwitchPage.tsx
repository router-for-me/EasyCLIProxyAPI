import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CalendarClock,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Edit3,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LayoutGrid,
  List,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  Rows3,
  Search,
  ShieldAlert,
  Sliders,
  Trash2,
  Unplug,
  Upload,
  X,
} from 'lucide-react';
import { useI18n } from '../i18n';
import { usePrivacyMask } from '../privacy';
import type { AccountSwitchCategoryFilter } from '../navigation';
import { BrandIcon } from '../components/BrandIcon';
import { Notice } from '../components/Notice';
import { EmptyState } from '../components/EmptyState';
import {
  accountSwitchApi,
  PLATFORM_VISUAL_META,
  type AccountGroup,
  type AccountSummary,
  type AccountSwitchCatalog,
  type PlatformRuntimeStatus,
  type SwitchAccountOptions,
  type SwitchPlatformId,
} from '../services/accountSwitch';
import {
  AddAccountDialog,
  AssignGroupDialog,
  DeleteConfirmDialog,
  EditAccountMetaDialog,
  ExportJsonDialog,
  ManageGroupsDialog,
  SwitchAccountDialog,
} from './accountSwitch/AccountSwitchDialogs';
import { AccountSwitchOverview } from './accountSwitch/AccountSwitchOverview';
import {
  SwitchQuickSettingsPopover,
  getPlatformSwitchPreferences,
  loadQuickSettingsMap,
  resolveSwitchOptions,
  saveQuickSettingsMap,
  type PlatformSwitchPreferences,
  type QuickSettingsMap,
} from './accountSwitch/SwitchQuickSettingsPopover';
import {
  averageRemainingQuota,
  BRAND_ICON_KEY,
  describeAccountExpiry,
  effectiveExpiryMs,
  formatAbsoluteDateTime,
  formatRelativeTime,
  formatResetCountdown,
  isMonoDarkIcon,
  localizeQuotaMetricDetail,
  localizeQuotaMetricLabel,
  quotaTone,
  tierBadgeVariant,
} from './accountSwitch/AccountSwitchHelpers';
import './AccountSwitchPage.css';

type ActiveView = 'overview' | SwitchPlatformId;
type LayoutMode = 'compact' | 'list' | 'cards';
type SortBy = 'default' | 'quota' | 'expires_at' | 'last_used' | 'label';

const VIEW_MODE_KEY = 'cpa-gui.account-switch.layout-mode.v3';

export function AccountSwitchPage({
  remoteCpaActive = false,
}: {
  remoteCpaActive?: boolean;
}) {
  const { locale, t } = useI18n();
  const mask = usePrivacyMask();

  const [catalog, setCatalog] = useState<AccountSwitchCatalog | null>(null);
  const [accountsByPlatform, setAccountsByPlatform] = useState<
    Partial<Record<SwitchPlatformId, AccountSummary[]>>
  >({});
  const [activeView, setActiveView] = useState<ActiveView>('overview');
  const [overviewCategory, setOverviewCategory] =
    useState<AccountSwitchCategoryFilter>('all');
  const [groups, setGroups] = useState<AccountGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [refreshingPlatformId, setRefreshingPlatformId] =
    useState<SwitchPlatformId | null>(null);
  const [quotaBusyIds, setQuotaBusyIds] = useState<Set<string>>(new Set());
  const [switchingAccountId, setSwitchingAccountId] = useState<string | null>(
    null,
  );
  const [decouplingPlatform, setDecouplingPlatform] =
    useState<SwitchPlatformId | null>(null);
  const [restarting, setRestarting] = useState(false);
  const [copiedAccountId, setCopiedAccountId] = useState<string | null>(null);
  const [dismissedLocalNotice, setDismissedLocalNotice] = useState<Set<string>>(
    new Set(),
  );
  const [notice, setNotice] = useState<{
    level: 'success' | 'error' | 'info';
    text: string;
  } | null>(null);

  // Quick Switch Preferences (Cockpit-style per-platform persisted settings)
  const [quickSettingsMap, setQuickSettingsMap] = useState<QuickSettingsMap>(
    () => loadQuickSettingsMap(),
  );

  // Popovers & refs
  const [platformMenuOpen, setPlatformMenuOpen] = useState(false);
  const platformMenuRef = useRef<HTMLDivElement | null>(null);
  const [filterPopoverOpen, setFilterPopoverOpen] = useState(false);
  const filterPopoverRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // Filters, session-only tag grouping (never traps layout across reloads!), sorting, layout mode
  const [search, setSearch] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [selectedPlans, setSelectedPlans] = useState<string[]>([]);
  const [groupByTag, setGroupByTag] = useState<boolean>(false);
  const [collapsedTagGroups, setCollapsedTagGroups] = useState<Set<string>>(
    new Set(),
  );
  const [sortBy, setSortBy] = useState<SortBy>('default');
  const [sortDir, setSortDir] = useState<'desc' | 'asc'>('desc');
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => {
    try {
      const saved = window.localStorage.getItem(VIEW_MODE_KEY);
      if (saved === 'compact' || saved === 'list' || saved === 'cards')
        return saved;
    } catch {
      /* ignore */
    }
    return 'cards';
  });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Inline double-click alias rename state
  const [inlineRenameId, setInlineRenameId] = useState<string | null>(null);
  const [inlineRenameValue, setInlineRenameValue] = useState('');

  // Dialogs
  const [addDialogTarget, setAddDialogTarget] = useState<{
    platform: SwitchPlatformId;
    tab: 'local' | 'oauth' | 'cpa' | 'json';
  } | null>(null);
  const [switchTarget, setSwitchTarget] = useState<{
    platform: SwitchPlatformId;
    account: AccountSummary;
  } | null>(null);
  const [editingAccount, setEditingAccount] = useState<AccountSummary | null>(
    null,
  );
  const [groupsDialogOpen, setGroupsDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{
    platform: SwitchPlatformId;
    accounts: AccountSummary[];
  } | null>(null);
  const [deletingBusy, setDeletingBusy] = useState(false);
  const [assignGroupOpen, setAssignGroupOpen] = useState(false);
  const [assignGroupBusy, setAssignGroupBusy] = useState(false);
  const [exportPreview, setExportPreview] = useState<{
    platformName: string;
    filePrefix: string;
    jsonContent: string;
  } | null>(null);

  const selectedPlatform: SwitchPlatformId | null =
    activeView === 'overview' ? null : activeView;

  const activePreferences = useMemo(
    () => getPlatformSwitchPreferences(quickSettingsMap, selectedPlatform),
    [quickSettingsMap, selectedPlatform],
  );

  const handleUpdateQuickSettings = useCallback(
    (patch: Partial<PlatformSwitchPreferences>) => {
      const key = selectedPlatform ?? '__global__';
      setQuickSettingsMap((prev) => {
        const current = getPlatformSwitchPreferences(prev, selectedPlatform);
        const next: QuickSettingsMap = {
          ...prev,
          [key]: { ...current, ...patch },
        };
        saveQuickSettingsMap(next);
        return next;
      });
    },
    [selectedPlatform],
  );

  const updateLayoutMode = (next: LayoutMode) => {
    setLayoutMode(next);
    try {
      window.localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      /* ignore */
    }
  };

  // Auto-dismiss transient success toasts
  useEffect(() => {
    if (!notice || notice.level !== 'success') return undefined;
    const timer = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Outside-click & Esc closing for popovers
  useEffect(() => {
    if (!platformMenuOpen && !filterPopoverOpen) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (platformMenuOpen && !platformMenuRef.current?.contains(target)) {
        setPlatformMenuOpen(false);
      }
      if (filterPopoverOpen && !filterPopoverRef.current?.contains(target)) {
        setFilterPopoverOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setPlatformMenuOpen(false);
        setFilterPopoverOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [platformMenuOpen, filterPopoverOpen]);

  // '/' quick-focus search shortcut in platform view
  useEffect(() => {
    if (!selectedPlatform) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        target?.isContentEditable
      ) {
        return;
      }
      event.preventDefault();
      searchInputRef.current?.focus();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [selectedPlatform]);

  const loadPlatformAccounts = useCallback(async (platform: SwitchPlatformId) => {
    setRefreshingPlatformId(platform);
    try {
      const payload = await accountSwitchApi.listAccounts(platform);
      setAccountsByPlatform((prev) => ({
        ...prev,
        [platform]: payload.accounts,
      }));
      setGroups(payload.groups);
      setCatalog((prev) =>
        prev
          ? {
              ...prev,
              groups: payload.groups,
              platforms: prev.platforms.map((item) =>
                item.platform === platform ? payload.status : item,
              ),
            }
          : prev,
      );
      return payload;
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      setRefreshingPlatformId((curr) => (curr === platform ? null : curr));
    }
  }, []);

  const loadCatalogAndAccounts = useCallback(async () => {
    setRefreshingAll(true);
    try {
      const data = await accountSwitchApi.getCatalog();
      setCatalog(data);
      setGroups(data.groups);

      const configured = data.platforms.filter((item) => item.accountCount > 0);
      const payloads = await Promise.all(
        configured.map((item) =>
          accountSwitchApi.listAccounts(item.platform).catch(() => null),
        ),
      );

      setAccountsByPlatform((prev) => {
        const next: Partial<Record<SwitchPlatformId, AccountSummary[]>> = {
          ...prev,
        };
        for (const p of data.platforms) {
          if (p.accountCount === 0 && !(p.platform in next)) {
            next[p.platform] = [];
          }
        }
        for (const payload of payloads) {
          if (payload) {
            next[payload.platform] = payload.accounts;
          }
        }
        return next;
      });
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRefreshingAll(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalogAndAccounts();
  }, [loadCatalogAndAccounts]);

  const navigateToView = useCallback(
    (next: ActiveView) => {
      setActiveView(next);
      setPlatformMenuOpen(false);
      setFilterPopoverOpen(false);
      setSelectedIds(new Set());
      setSelectedTags([]);
      setSelectedPlans([]);
      setGroupByTag(false);
      setGroupFilter('all');
      setSearch('');
      setInlineRenameId(null);
      if (next !== 'overview') {
        void loadPlatformAccounts(next);
      }
    },
    [loadPlatformAccounts],
  );

  const activeStatus: PlatformRuntimeStatus | undefined = useMemo(
    () =>
      selectedPlatform
        ? catalog?.platforms.find((p) => p.platform === selectedPlatform)
        : undefined,
    [catalog, selectedPlatform],
  );

  const currentAccounts = useMemo(
    () => (selectedPlatform ? accountsByPlatform[selectedPlatform] ?? [] : []),
    [accountsByPlatform, selectedPlatform],
  );

  const quickNavPlatforms = useMemo(() => {
    const all = catalog?.platforms ?? [];
    return all.filter(
      (item) => item.accountCount > 0 || item.platform === selectedPlatform,
    );
  }, [catalog, selectedPlatform]);

  const cliPlatforms = useMemo(
    () =>
      (catalog?.platforms ?? []).filter(
        (item) => item.category === 'official-cli',
      ),
    [catalog],
  );

  const idePlatforms = useMemo(
    () =>
      (catalog?.platforms ?? []).filter((item) => item.category === 'ai-ide'),
    [catalog],
  );

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const acc of currentAccounts) {
      for (const tag of acc.tags) set.add(tag);
    }
    return Array.from(set).sort();
  }, [currentAccounts]);

  const allPlans = useMemo(() => {
    const set = new Set<string>();
    for (const acc of currentAccounts) {
      if (acc.planType?.trim()) set.add(acc.planType.trim());
    }
    return Array.from(set).sort();
  }, [currentAccounts]);

  const activeFilterCount =
    selectedPlans.length + selectedTags.length + (groupByTag ? 1 : 0);

  const groupNameMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groups) map.set(group.id, group.name);
    return map;
  }, [groups]);

  const groupCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const list of Object.values(accountsByPlatform)) {
      if (!list) continue;
      for (const acc of list) {
        if (acc.groupId) {
          counts[acc.groupId] = (counts[acc.groupId] ?? 0) + 1;
        }
      }
    }
    return counts;
  }, [accountsByPlatform]);

  const filteredAccounts = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = currentAccounts.filter((acc) => {
      if (groupFilter === 'ungrouped' && acc.groupId) return false;
      if (
        groupFilter !== 'all' &&
        groupFilter !== 'ungrouped' &&
        acc.groupId !== groupFilter
      ) {
        return false;
      }
      if (
        selectedTags.length > 0 &&
        !selectedTags.some((tag) => acc.tags.includes(tag))
      ) {
        return false;
      }
      if (
        selectedPlans.length > 0 &&
        (!acc.planType || !selectedPlans.includes(acc.planType.trim()))
      ) {
        return false;
      }
      if (q) {
        const hay = [
          acc.label,
          acc.email ?? '',
          acc.accountId ?? '',
          acc.notes ?? '',
          acc.planType ?? '',
          ...acc.tags,
        ]
          .join(' ')
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const sorted = [...matched];
    const dir = sortDir === 'desc' ? -1 : 1;
    sorted.sort((left, right) => {
      if (sortBy === 'default') {
        if (left.isActive !== right.isActive) return left.isActive ? -1 : 1;
        return (
          (right.updatedAt - left.updatedAt) * (sortDir === 'desc' ? 1 : -1)
        );
      }
      if (sortBy === 'quota') {
        return (
          (averageRemainingQuota(left) - averageRemainingQuota(right)) * dir
        );
      }
      if (sortBy === 'expires_at') {
        // desc => soonest expiring first so urgent renewals surface at top
        return (effectiveExpiryMs(left) - effectiveExpiryMs(right)) * (sortDir === 'desc' ? 1 : -1);
      }
      if (sortBy === 'last_used') {
        return ((left.lastUsedAt ?? 0) - (right.lastUsedAt ?? 0)) * dir;
      }
      return left.label.localeCompare(right.label) * dir;
    });
    return sorted;
  }, [
    currentAccounts,
    groupFilter,
    selectedTags,
    selectedPlans,
    search,
    sortBy,
    sortDir,
  ]);

  const groupedByTagSections = useMemo(() => {
    if (!groupByTag) return null;
    const map = new Map<string, AccountSummary[]>();
    const untaggedKey = '__untagged__';
    for (const acc of filteredAccounts) {
      if (acc.tags.length === 0) {
        const list = map.get(untaggedKey) ?? [];
        list.push(acc);
        map.set(untaggedKey, list);
      } else {
        for (const tag of acc.tags) {
          const list = map.get(tag) ?? [];
          list.push(acc);
          map.set(tag, list);
        }
      }
    }
    const keys = Array.from(map.keys()).sort((a, b) => {
      if (a === untaggedKey) return 1;
      if (b === untaggedKey) return -1;
      return a.localeCompare(b);
    });
    return keys.map((key) => ({
      key,
      label:
        key === untaggedKey ? t('accountSwitch.filter.untagged') : `#${key}`,
      accounts: map.get(key) ?? [],
    }));
  }, [groupByTag, filteredAccounts, t]);

  const allFilteredSelected =
    filteredAccounts.length > 0 &&
    filteredAccounts.every((item) => selectedIds.has(item.id));

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredAccounts.map((item) => item.id)));
    }
  };

  const toggleSelectAccount = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleTagValue = (tag: string) => {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((item) => item !== tag) : [...prev, tag],
    );
  };

  const togglePlanValue = (plan: string) => {
    setSelectedPlans((prev) =>
      prev.includes(plan)
        ? prev.filter((item) => item !== plan)
        : [...prev, plan],
    );
  };

  const handleCopyAccount = useCallback(
    async (account: AccountSummary) => {
      const value = account.email || account.label;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        /* ignore clipboard rejection */
      }
      setCopiedAccountId(account.id);
      setNotice({
        level: 'success',
        text: t('accountSwitch.msg.copiedEmail', { label: mask.text(value) }),
      });
      window.setTimeout(() => {
        setCopiedAccountId((curr) => (curr === account.id ? null : curr));
      }, 1600);
    },
    [t, mask],
  );

  const handleCommitInlineRename = async (account: AccountSummary) => {
    const trimmed = inlineRenameValue.trim();
    setInlineRenameId(null);
    if (!selectedPlatform || !trimmed || trimmed === account.label) return;
    try {
      await accountSwitchApi.updateMeta(selectedPlatform, account.id, {
        label: trimmed,
      });
      setNotice({ level: 'success', text: t('accountSwitch.msg.aliasUpdated') });
      await loadPlatformAccounts(selectedPlatform);
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleDecoupleProxy = async (platform: SwitchPlatformId) => {
    setDecouplingPlatform(platform);
    setNotice(null);
    try {
      const result = await accountSwitchApi.decoupleProxy(platform);
      setCatalog((prev) =>
        prev
          ? {
              ...prev,
              platforms: prev.platforms.map((item) =>
                item.platform === platform ? result.status : item,
              ),
            }
          : prev,
      );
      setNotice({
        level: 'success',
        text: t('accountSwitch.msg.decoupled', {
          platform: result.status.displayName,
        }),
      });
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDecouplingPlatform(null);
    }
  };

  const handleQuickCaptureLocal = async (platform: SwitchPlatformId) => {
    setNotice(null);
    try {
      const captured = await accountSwitchApi.importLocal(platform);
      setNotice({
        level: 'success',
        text: t('accountSwitch.msg.importedLocal', {
          label: mask.text(captured.label),
        }),
      });
      await loadPlatformAccounts(platform);
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const executeSwitch = useCallback(
    async (
      platform: SwitchPlatformId,
      account: AccountSummary,
      options: SwitchAccountOptions,
    ) => {
      const status = catalog?.platforms.find((p) => p.platform === platform);
      if (!status) return;
      setSwitchingAccountId(account.id);
      setNotice(null);
      try {
        const result = await accountSwitchApi.switchAccount(
          platform,
          account.id,
          options,
        );
        const syncSummary = result.syncResults
          .filter((s) => s.status === 'synced')
          .map((s) => s.target)
          .join(', ');
        const baseMsg = t(
          result.decoupledProxy
            ? 'accountSwitch.msg.switchedDecoupled'
            : 'accountSwitch.msg.switched',
          {
            platform: status.displayName,
            label: mask.text(account.label),
          },
        );
        setNotice({
          level: 'success',
          text: syncSummary ? `${baseMsg} (+ ${syncSummary})` : baseMsg,
        });
        setSwitchTarget(null);
        await loadPlatformAccounts(platform);
      } catch (err) {
        setNotice({
          level: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setSwitchingAccountId(null);
      }
    },
    [catalog, loadPlatformAccounts, mask, t],
  );

  // 1-click instant switch using Quick Settings (Shift+Click or setting enables dialog)
  const handleRequestSwitch = useCallback(
    (
      platform: SwitchPlatformId,
      account: AccountSummary,
      forceDialog = false,
    ) => {
      if (switchingAccountId !== null) return;
      const status = catalog?.platforms.find((p) => p.platform === platform);
      if (!status) return;
      const pref = getPlatformSwitchPreferences(quickSettingsMap, platform);
      if (forceDialog || pref.confirmBeforeSwitch) {
        setSwitchTarget({ platform, account });
        return;
      }
      const options = resolveSwitchOptions(status, account, pref);
      void executeSwitch(platform, account, options);
    },
    [catalog, executeSwitch, quickSettingsMap, switchingAccountId],
  );

  const handleRefreshQuota = async (
    platform: SwitchPlatformId,
    ids?: string[],
  ) => {
    const list = accountsByPlatform[platform] ?? [];
    const targetIds = ids?.length ? ids : list.map((a) => a.id);
    if (targetIds.length === 0) return;
    setQuotaBusyIds((prev) => new Set([...prev, ...targetIds]));
    setRefreshingPlatformId(platform);
    try {
      const res = await accountSwitchApi.refreshQuota(platform, targetIds);
      await loadPlatformAccounts(platform);
      setNotice({
        level:
          res.errors.length > 0 && res.updated.length === 0
            ? 'error'
            : 'success',
        text:
          res.errors.length > 0 && res.updated.length === 0
            ? res.errors[0]
            : t('accountSwitch.msg.quotaRefreshed', {
                count: res.updated.length,
              }),
      });
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setQuotaBusyIds((prev) => {
        const next = new Set(prev);
        targetIds.forEach((id) => next.delete(id));
        return next;
      });
      setRefreshingPlatformId((curr) => (curr === platform ? null : curr));
    }
  };

  const handleOpenExportDialog = async (
    platform: SwitchPlatformId,
    explicitIds?: string[],
  ) => {
    const status = catalog?.platforms.find((p) => p.platform === platform);
    try {
      const ids =
        explicitIds && explicitIds.length > 0
          ? explicitIds
          : selectedIds.size > 0
            ? Array.from(selectedIds)
            : undefined;
      const json = await accountSwitchApi.exportJson(platform, ids);
      setExportPreview({
        platformName: status?.displayName ?? platform,
        filePrefix: platform,
        jsonContent: json,
      });
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    setDeletingBusy(true);
    try {
      const ids = deleteTarget.accounts.map((a) => a.id);
      const count = await accountSwitchApi.deleteAccounts(
        deleteTarget.platform,
        ids,
      );
      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setNotice({
        level: 'success',
        text: t('accountSwitch.msg.deleted', { count }),
      });
      const targetPlat = deleteTarget.platform;
      setDeleteTarget(null);
      await loadPlatformAccounts(targetPlat);
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setDeletingBusy(false);
    }
  };

  const handleBatchAssignGroup = async (groupId: string | null) => {
    if (!selectedPlatform || selectedIds.size === 0) return;
    setAssignGroupBusy(true);
    try {
      const ids = Array.from(selectedIds);
      await Promise.all(
        ids.map((id) =>
          accountSwitchApi.updateMeta(selectedPlatform, id, { groupId }),
        ),
      );
      setAssignGroupOpen(false);
      setSelectedIds(new Set());
      const groupName = groupId ? groupNameMap.get(groupId) ?? '' : '';
      setNotice({
        level: 'success',
        text: groupId
          ? t('accountSwitch.msg.groupAssigned', {
              count: ids.length,
              group: groupName,
            })
          : t('accountSwitch.msg.groupRemoved', { count: ids.length }),
      });
      await loadPlatformAccounts(selectedPlatform);
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAssignGroupBusy(false);
    }
  };

  const handleCreateGroupAndAssign = async (name: string) => {
    if (!selectedPlatform || selectedIds.size === 0) return;
    setAssignGroupBusy(true);
    try {
      const nextGroups = await accountSwitchApi.manageGroups({
        action: 'create',
        name,
        color: '#3b82f6',
      });
      setGroups(nextGroups);
      const created = nextGroups[nextGroups.length - 1];
      if (!created) return;
      const ids = Array.from(selectedIds);
      await Promise.all(
        ids.map((id) =>
          accountSwitchApi.updateMeta(selectedPlatform, id, {
            groupId: created.id,
          }),
        ),
      );
      setAssignGroupOpen(false);
      setSelectedIds(new Set());
      setNotice({
        level: 'success',
        text: t('accountSwitch.msg.groupAssigned', {
          count: ids.length,
          group: created.name,
        }),
      });
      await loadPlatformAccounts(selectedPlatform);
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setAssignGroupBusy(false);
    }
  };

  const handleRestartClient = async (platform: SwitchPlatformId) => {
    const status = catalog?.platforms.find((p) => p.platform === platform);
    if (!status) return;
    setRestarting(true);
    try {
      await accountSwitchApi.restartClient(platform);
      setNotice({
        level: 'success',
        text: t('accountSwitch.msg.restarted', { platform: status.displayName }),
      });
      await loadPlatformAccounts(platform);
    } catch (err) {
      setNotice({
        level: 'error',
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setRestarting(false);
    }
  };

  const addDialogStatus = addDialogTarget
    ? catalog?.platforms.find((p) => p.platform === addDialogTarget.platform)
    : undefined;
  const switchDialogStatus = switchTarget
    ? catalog?.platforms.find((p) => p.platform === switchTarget.platform)
    : undefined;

  const renderAccountNameCell = (account: AccountSummary) => {
    const displayLabel = mask.text(account.label);
    const isRenaming = inlineRenameId === account.id;
    const isCopied = copiedAccountId === account.id;

    if (isRenaming) {
      return (
        <input
          type="text"
          className="fd-inline-rename-input"
          value={inlineRenameValue}
          autoFocus
          onChange={(e) => setInlineRenameValue(e.target.value)}
          onBlur={() => void handleCommitInlineRename(account)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleCommitInlineRename(account);
            } else if (e.key === 'Escape') {
              e.stopPropagation();
              setInlineRenameId(null);
            }
          }}
        />
      );
    }

    return (
      <div className="fd-name-group">
        <span
          className="fd-card-email"
          title={`${displayLabel} · ${t('accountSwitch.actions.doubleClickRename')}`}
          onDoubleClick={() => {
            setInlineRenameId(account.id);
            setInlineRenameValue(account.label);
          }}
        >
          {displayLabel}
        </span>
        <button
          type="button"
          className={['fd-copy-mini', isCopied ? 'is-copied' : '']
            .filter(Boolean)
            .join(' ')}
          title={t(
            isCopied
              ? 'accountSwitch.actions.copied'
              : 'accountSwitch.actions.copyEmail',
          )}
          aria-label={t('accountSwitch.actions.copyEmail')}
          onClick={() => void handleCopyAccount(account)}
        >
          {isCopied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
    );
  };

  const renderIconActions = (
    platform: SwitchPlatformId,
    account: AccountSummary,
  ) => {
    const isQuotaLoading = quotaBusyIds.has(account.id);
    return (
      <div className="fd-card-icon-group">
        <button
          type="button"
          className="fd-card-icon"
          title={t('accountSwitch.actions.refreshQuota')}
          aria-label={t('accountSwitch.actions.refreshQuota')}
          disabled={isQuotaLoading}
          onClick={() => void handleRefreshQuota(platform, [account.id])}
        >
          <RotateCw
            size={13}
            className={isQuotaLoading ? 'spin' : ''}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          className="fd-card-icon"
          title={t('accountSwitch.actions.editMeta')}
          aria-label={t('accountSwitch.actions.editMeta')}
          onClick={() => setEditingAccount(account)}
        >
          <Edit3 size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="fd-card-icon"
          title={t('accountSwitch.actions.exportSingle')}
          aria-label={t('accountSwitch.actions.exportSingle')}
          onClick={() => void handleOpenExportDialog(platform, [account.id])}
        >
          <Upload size={13} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="fd-card-icon is-danger"
          title={t('accountSwitch.actions.delete')}
          aria-label={t('accountSwitch.actions.delete')}
          onClick={() => setDeleteTarget({ platform, accounts: [account] })}
        >
          <Trash2 size={13} aria-hidden="true" />
        </button>
      </div>
    );
  };

  const renderSwitchCta = (
    platform: SwitchPlatformId,
    account: AccountSummary,
  ) => {
    const isSwitching = switchingAccountId === account.id;
    if (account.isActive) {
      return (
        <span className="fd-active-label">
          <i className="fd-live-dot" aria-hidden="true" />
          <span>{t('accountSwitch.actions.active')}</span>
        </span>
      );
    }
    return (
      <button
        type="button"
        className="fd-row-switch-btn"
        disabled={switchingAccountId !== null}
        title={t('accountSwitch.actions.switchWithOptions')}
        onClick={(event) =>
          handleRequestSwitch(platform, account, event.shiftKey)
        }
      >
        {isSwitching ? (
          <Loader2 size={12} className="spin" aria-hidden="true" />
        ) : null}
        <span>
          {t(
            isSwitching
              ? 'accountSwitch.actions.switching'
              : 'accountSwitch.actions.switchShort',
          )}
        </span>
        {!isSwitching ? <ArrowRight size={12} aria-hidden="true" /> : null}
      </button>
    );
  };

  const renderAccountsCollection = (
    platform: SwitchPlatformId,
    accounts: AccountSummary[],
  ) => {
    if (layoutMode === 'cards') {
      return (
        <div className="fd-cards-grid">
          {accounts.map((account) => {
            const isSelected = selectedIds.has(account.id);
            const groupObj = account.groupId
              ? groups.find((g) => g.id === account.groupId)
              : undefined;
            const displayLabel = mask.text(account.label);
            const tierClass = tierBadgeVariant(account.planType);
            const metrics = account.lastQuota?.metrics.slice(0, 4) ?? [];
            const expiry = describeAccountExpiry(account, locale, t);

            return (
              <article
                key={account.id}
                data-account-id={account.id}
                className={[
                  'surface-card fd-account-card',
                  account.isActive ? 'is-active' : '',
                  isSelected ? 'is-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className="fd-card-head">
                  <input
                    type="checkbox"
                    className="fd-check"
                    checked={isSelected}
                    onChange={() => toggleSelectAccount(account.id)}
                    aria-label={displayLabel}
                  />
                  {renderAccountNameCell(account)}
                  {account.planType ? (
                    <span className={`fd-tier-pill tier-${tierClass}`}>
                      {account.planType}
                    </span>
                  ) : null}
                </div>

                {/* Clean quiet subtitle: Group · Tags (no noisy boxes or truncated fragments) */}
                {groupObj || account.tags.length > 0 || account.notes ? (
                  <div
                    className="fd-card-meta-row"
                    title={account.notes ?? undefined}
                  >
                    {groupObj ? (
                      <span className="fd-meta-group">{groupObj.name}</span>
                    ) : null}
                    {account.tags.slice(0, 2).map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        className="fd-meta-tag"
                        onClick={() => toggleTagValue(tag)}
                      >
                        #{tag}
                      </button>
                    ))}
                    {!groupObj && account.tags.length === 0 && account.notes ? (
                      <span className="fd-card-note">{account.notes}</span>
                    ) : null}
                  </div>
                ) : null}

                {/* Elevated Inset Quota Panel (Fully Localized 6px Gradient Meters) */}
                <div className="fd-card-meters">
                  {metrics.length > 0 ? (
                    <div className="fd-meter-grid">
                      {metrics.map((metric) => {
                        const pct = metric.remainingPercent;
                        const tone = quotaTone(pct);
                        const reset = formatResetCountdown(metric.resetAt, t);
                        const absReset = formatAbsoluteDateTime(
                          metric.resetAt,
                          locale,
                          false,
                        );
                        const detail = localizeQuotaMetricDetail(
                          metric.detail,
                          t,
                        );
                        return (
                          <div
                            key={metric.id}
                            className="fd-meter"
                            title={
                              absReset
                                ? t('accountSwitch.quota.resetAtTooltip', {
                                    time: absReset,
                                  })
                                : undefined
                            }
                          >
                            <div className="fd-meter-head">
                              <span className="fd-meter-label">
                                {localizeQuotaMetricLabel(metric, t)}
                                {detail ? (
                                  <small className="fd-meter-reset">
                                    {' '}
                                    · {detail}
                                  </small>
                                ) : reset ? (
                                  <small className="fd-meter-reset">
                                    {' '}
                                    · {reset}
                                  </small>
                                ) : null}
                              </span>
                              <strong className={`fd-meter-pct tone-${tone}`}>
                                {pct !== null ? `${Math.round(pct)}%` : '—'}
                              </strong>
                            </div>
                            <div className="fd-meter-track">
                              <div
                                className={`fd-meter-fill tone-${tone}`}
                                style={{
                                  width: `${Math.max(0, Math.min(100, pct ?? 0))}%`,
                                }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <span className="fd-quota-muted">
                      {account.lastQuota?.error ??
                        t('accountSwitch.card.noQuota')}
                    </span>
                  )}
                </div>

                {/* Clean Account / Plan Expiration Line */}
                <div
                  className={`fd-card-expiry tone-${expiry.tone}`}
                  data-account-expiry={account.id}
                  title={expiry.tooltip}
                >
                  {expiry.kind === 'plan' ? (
                    <CalendarClock size={12} aria-hidden="true" />
                  ) : (
                    <KeyRound size={12} aria-hidden="true" />
                  )}
                  <span>{expiry.label}</span>
                </div>

                {/* Balanced Footer: Quiet Tools on Left, Clear Action on Right */}
                <div className="fd-card-foot">
                  {renderIconActions(platform, account)}
                  {renderSwitchCta(platform, account)}
                </div>
              </article>
            );
          })}
        </div>
      );
    }

    if (layoutMode === 'list') {
      return (
        <div className="surface-card fd-table-shell">
          <table className="fd-table">
            <thead>
              <tr>
                <th style={{ width: 38 }}>
                  <input
                    type="checkbox"
                    className="fd-check"
                    checked={allFilteredSelected}
                    onChange={toggleSelectAll}
                    aria-label={t('accountSwitch.selection.selectAll')}
                  />
                </th>
                <th>{t('accountSwitch.table.account')}</th>
                <th style={{ width: 86 }}>{t('accountSwitch.table.plan')}</th>
                <th style={{ minWidth: 210 }}>{t('accountSwitch.table.quota')}</th>
                <th style={{ minWidth: 138 }}>{t('accountSwitch.table.expires')}</th>
                <th style={{ width: 88 }}>{t('accountSwitch.table.lastUsed')}</th>
                <th style={{ minWidth: 220, textAlign: 'right' }}>
                  {t('accountSwitch.table.actions')}
                </th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => {
                const isSelected = selectedIds.has(account.id);
                const displayLabel = mask.text(account.label);
                const tierClass = tierBadgeVariant(account.planType);
                const metrics = account.lastQuota?.metrics.slice(0, 2) ?? [];
                const expiry = describeAccountExpiry(account, locale, t);
                return (
                  <tr
                    key={account.id}
                    data-account-id={account.id}
                    className={[
                      account.isActive ? 'is-active' : '',
                      isSelected ? 'is-selected' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <td>
                      <input
                        type="checkbox"
                        className="fd-check"
                        checked={isSelected}
                        onChange={() => toggleSelectAccount(account.id)}
                        aria-label={displayLabel}
                      />
                    </td>
                    <td>
                      <div className="fd-table-account">
                        {account.isActive ? (
                          <span className="fd-active-dot" aria-hidden="true" />
                        ) : null}
                        {renderAccountNameCell(account)}
                      </div>
                    </td>
                    <td>
                      {account.planType ? (
                        <span className={`fd-tier-pill tier-${tierClass}`}>
                          {account.planType}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {metrics.length > 0 ? (
                        <div className="fd-table-meters">
                          {metrics.map((metric) => {
                            const pct = metric.remainingPercent;
                            const tone = quotaTone(pct);
                            const absReset = formatAbsoluteDateTime(
                              metric.resetAt,
                              locale,
                              false,
                            );
                            return (
                              <div
                                key={metric.id}
                                className="fd-table-meter"
                                title={
                                  absReset
                                    ? t('accountSwitch.quota.resetAtTooltip', {
                                        time: absReset,
                                      })
                                    : undefined
                                }
                              >
                                <span>{localizeQuotaMetricLabel(metric, t)}</span>
                                <div className="fd-meter-track">
                                  <div
                                    className={`fd-meter-fill tone-${tone}`}
                                    style={{
                                      width: `${Math.max(0, Math.min(100, pct ?? 0))}%`,
                                    }}
                                  />
                                </div>
                                <strong className={`tone-${tone}`}>
                                  {pct !== null ? `${Math.round(pct)}%` : '—'}
                                </strong>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <span className="fd-quota-muted">—</span>
                      )}
                    </td>
                    <td>
                      <span
                        className={`fd-expiry-pill tone-${expiry.tone}`}
                        title={expiry.tooltip}
                      >
                        {expiry.kind === 'plan' ? (
                          <CalendarClock size={11} aria-hidden="true" />
                        ) : expiry.kind === 'token' ? (
                          <KeyRound size={11} aria-hidden="true" />
                        ) : null}
                        <span>{expiry.compactLabel}</span>
                      </span>
                    </td>
                    <td className="fd-card-time">
                      {account.lastUsedAt
                        ? formatRelativeTime(account.lastUsedAt, t)
                        : t('accountSwitch.card.neverUsed')}
                    </td>
                    <td>
                      <div className="fd-card-actions is-right">
                        {renderSwitchCta(platform, account)}
                        {renderIconActions(platform, account)}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      );
    }

    return (
      <div className="fd-compact-list">
        {accounts.map((account) => {
          const isSelected = selectedIds.has(account.id);
          const displayLabel = mask.text(account.label);
          const tierClass = tierBadgeVariant(account.planType);
          const metrics = account.lastQuota?.metrics.slice(0, 2) ?? [];
          return (
            <div
              key={account.id}
              data-account-id={account.id}
              className={[
                'surface-card fd-compact-row',
                account.isActive ? 'is-active' : '',
                isSelected ? 'is-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              <input
                type="checkbox"
                className="fd-check"
                checked={isSelected}
                onChange={() => toggleSelectAccount(account.id)}
                aria-label={displayLabel}
              />
              {account.isActive ? (
                <span className="fd-active-dot" aria-hidden="true" />
              ) : null}
              {renderAccountNameCell(account)}
              {account.planType ? (
                <span className={`fd-tier-pill is-xs tier-${tierClass}`}>
                  {account.planType}
                </span>
              ) : null}

              <div className="fd-compact-quotas">
                {(() => {
                  const expiry = describeAccountExpiry(account, locale, t);
                  return expiry.kind !== 'none' ? (
                    <span
                      className={`fd-expiry-pill tone-${expiry.tone}`}
                      title={expiry.tooltip}
                    >
                      {expiry.kind === 'plan' ? (
                        <CalendarClock size={11} aria-hidden="true" />
                      ) : (
                        <KeyRound size={11} aria-hidden="true" />
                      )}
                      <span>{expiry.compactLabel}</span>
                    </span>
                  ) : null;
                })()}
                {metrics.map((metric) => {
                  const pct = metric.remainingPercent;
                  const tone = quotaTone(pct);
                  return (
                    <span
                      key={metric.id}
                      className={`fd-compact-pill tone-${tone}`}
                    >
                      {localizeQuotaMetricLabel(metric, t)}{' '}
                      {pct !== null ? `${Math.round(pct)}%` : '—'}
                    </span>
                  );
                })}
              </div>

              <div className="fd-card-actions is-right">
                {renderSwitchCta(platform, account)}
                {renderIconActions(platform, account)}
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderPlatformSwitcherPopover = () => (
    <div className="fd-switcher" ref={platformMenuRef}>
      <button
        type="button"
        className={['as-plat-pill as-plat-more', platformMenuOpen ? 'is-open' : '']
          .filter(Boolean)
          .join(' ')}
        aria-haspopup="listbox"
        aria-expanded={platformMenuOpen}
        onClick={() => setPlatformMenuOpen((prev) => !prev)}
      >
        <span>{t('accountSwitch.nav.morePlatforms')}</span>
        <ChevronDown size={13} aria-hidden="true" />
      </button>

      {platformMenuOpen ? (
        <div className="fd-switcher-popover" role="listbox">
          <div className="fd-switcher-group">
            <div className="fd-switcher-heading">
              {t('accountSwitch.category.officialCli')} ({cliPlatforms.length})
            </div>
            {cliPlatforms.map((item) => {
              const isActive = activeView === item.platform;
              return (
                <button
                  key={item.platform}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-switcher-platform={item.platform}
                  className={['fd-switcher-opt', isActive ? 'is-active' : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => navigateToView(item.platform)}
                >
                  <span
                    className={[
                      'fd-icon-slot',
                      isMonoDarkIcon(item.platform) ? 'fd-mono-icon' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <BrandIcon name={BRAND_ICON_KEY[item.platform]} size={16} />
                  </span>
                  <span className="fd-switcher-opt-text">
                    <strong>{item.displayName}</strong>
                    <small>{PLATFORM_VISUAL_META[item.platform].clientHint}</small>
                  </span>
                  {item.proxy.mode === 'cpa_proxy' ? (
                    <i className="fd-amber-dot" />
                  ) : null}
                  <span className="fd-switcher-count">{item.accountCount}</span>
                  {isActive ? (
                    <Check size={14} className="fd-switcher-check" />
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="fd-switcher-divider" />

          <div className="fd-switcher-group">
            <div className="fd-switcher-heading">
              {t('accountSwitch.category.aiIde')} ({idePlatforms.length})
            </div>
            {idePlatforms.map((item) => {
              const isActive = activeView === item.platform;
              return (
                <button
                  key={item.platform}
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  data-switcher-platform={item.platform}
                  className={['fd-switcher-opt', isActive ? 'is-active' : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => navigateToView(item.platform)}
                >
                  <span
                    className={[
                      'fd-icon-slot',
                      isMonoDarkIcon(item.platform) ? 'fd-mono-icon' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <BrandIcon name={BRAND_ICON_KEY[item.platform]} size={16} />
                  </span>
                  <span className="fd-switcher-opt-text">
                    <strong>{item.displayName}</strong>
                    <small>{PLATFORM_VISUAL_META[item.platform].clientHint}</small>
                  </span>
                  {item.proxy.mode === 'cpa_proxy' ? (
                    <i className="fd-amber-dot" />
                  ) : null}
                  <span className="fd-switcher-count">{item.accountCount}</span>
                  {isActive ? (
                    <Check size={14} className="fd-switcher-check" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );

  const showLocalCaptureStrip = Boolean(
    activeStatus &&
      selectedPlatform &&
      activeStatus.localCredential.detected &&
      !activeStatus.localCredential.matchedAccountId &&
      !dismissedLocalNotice.has(selectedPlatform),
  );

  return (
    <section
      className="page management-page account-switch-page"
      aria-label={t('accountSwitch.title')}
    >
      {/* ZONE 1A: Crisp Single-Line Page Header (Only 3 Clean Actions!) */}
      <header className="fd-topbar">
        <div className="fd-topbar-left">
          <h1>{t('accountSwitch.title')}</h1>
          {activeStatus ? (
            <span
              className={`fd-status-chip ${
                activeStatus.proxy.mode === 'direct' ? 'is-emerald' : 'is-amber'
              }`}
            >
              <i className="fd-live-dot" aria-hidden="true" />
              <span>
                {t(
                  activeStatus.proxy.mode === 'cpa_proxy'
                    ? 'accountSwitch.status.cpaProxy'
                    : activeStatus.proxy.mode === 'custom_proxy'
                      ? 'accountSwitch.status.customProxy'
                      : 'accountSwitch.status.direct',
                )}
              </span>
            </span>
          ) : (
            <span className="fd-status-chip is-emerald">
              <i className="fd-live-dot" aria-hidden="true" />
              <span>{t('accountSwitch.offlineReady')}</span>
            </span>
          )}
        </div>

        <div className="fd-topbar-actions">
          <SwitchQuickSettingsPopover
            status={activeStatus}
            preferences={activePreferences}
            onUpdate={handleUpdateQuickSettings}
          />

          <button
            type="button"
            className="fd-ghost-icon"
            title={t('accountSwitch.actions.refreshAll')}
            aria-label={t('accountSwitch.actions.refreshAll')}
            disabled={refreshingAll || refreshingPlatformId !== null}
            onClick={() =>
              void (selectedPlatform
                ? loadPlatformAccounts(selectedPlatform)
                : loadCatalogAndAccounts())
            }
          >
            <RefreshCw
              size={15}
              className={
                refreshingAll || refreshingPlatformId !== null ? 'spin' : ''
              }
              aria-hidden="true"
            />
          </button>

          {!selectedPlatform || activeStatus?.supportsCpaImport ? (
            <button
              type="button"
              className="secondary-button compact-button"
              onClick={() =>
                setAddDialogTarget({
                  platform: selectedPlatform ?? 'codex',
                  tab: 'cpa',
                })
              }
            >
              <Download size={14} aria-hidden="true" />
              <span>{t('accountSwitch.actions.importCpa')}</span>
            </button>
          ) : null}

          <button
            type="button"
            className="primary-button compact-button"
            onClick={() =>
              setAddDialogTarget({
                platform: selectedPlatform ?? 'codex',
                tab: 'local',
              })
            }
          >
            <Plus size={14} aria-hidden="true" />
            <span>{t('accountSwitch.actions.addAccount')}</span>
          </button>
        </div>
      </header>

      {/* ZONE 1B: Native EasyCLIProxyAPI Pill Platform Strip (Consistent Across Overview & Platforms!) */}
      {catalog ? (
        <div className="as-platform-strip">
          <div className="as-platform-pills" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'overview'}
              data-nav-view="overview"
              className={[
                'as-plat-pill',
                activeView === 'overview' ? 'is-active' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => navigateToView('overview')}
            >
              <LayoutDashboard size={14} aria-hidden="true" />
              <span>{t('accountSwitch.nav.overview')}</span>
            </button>

            {quickNavPlatforms.map((item) => {
              const isActive = activeView === item.platform;
              const isProxy = item.proxy.mode === 'cpa_proxy';
              return (
                <button
                  key={item.platform}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  data-platform-id={item.platform}
                  className={['as-plat-pill', isActive ? 'is-active' : '']
                    .filter(Boolean)
                    .join(' ')}
                  title={PLATFORM_VISUAL_META[item.platform].clientHint}
                  onClick={() => navigateToView(item.platform)}
                >
                  <span
                    className={[
                      'fd-icon-slot',
                      isMonoDarkIcon(item.platform) ? 'fd-mono-icon' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <BrandIcon name={BRAND_ICON_KEY[item.platform]} size={15} />
                  </span>
                  <span>{item.displayName}</span>
                  {item.accountCount > 0 ? (
                    <span className="as-plat-count">{item.accountCount}</span>
                  ) : null}
                  {isProxy ? <i className="fd-amber-dot" /> : null}
                </button>
              );
            })}
          </div>

          {renderPlatformSwitcherPopover()}
        </div>
      ) : null}

      {remoteCpaActive ? (
        <Notice tone="info">{t('accountSwitch.remoteNotice')}</Notice>
      ) : null}

      {/* Main Content Stage */}
      {loading && !catalog ? (
        <div className="fd-loading">
          <Loader2 size={22} className="spin" aria-hidden="true" />
        </div>
      ) : activeView === 'overview' && catalog ? (
        <AccountSwitchOverview
          platforms={catalog.platforms}
          accountsByPlatform={accountsByPlatform}
          categoryFilter={overviewCategory}
          onCategoryChange={setOverviewCategory}
          onSelectPlatform={(platform) => navigateToView(platform)}
          onQuickSwitch={(platform, account, forceDialog) =>
            handleRequestSwitch(platform, account, forceDialog)
          }
          onQuickAdd={(platform) =>
            setAddDialogTarget({ platform, tab: 'local' })
          }
          onDecoupleProxy={(platform) => void handleDecoupleProxy(platform)}
          onRefreshPlatformQuota={(platform) => void handleRefreshQuota(platform)}
          onCopyAccount={(account) => void handleCopyAccount(account)}
          copiedAccountId={copiedAccountId}
          switchingAccountId={switchingAccountId}
          decouplingPlatform={decouplingPlatform}
          refreshingPlatformId={refreshingPlatformId}
        />
      ) : activeStatus && selectedPlatform ? (
        <div className="fd-workspace">
          {/* ZONE 2: Borderless Unified Toolbar sitting directly on the calm paper canvas */}
          <div className="as-toolbar">
            <div className="as-toolbar-left">
              <input
                type="checkbox"
                className="fd-check"
                checked={allFilteredSelected}
                disabled={filteredAccounts.length === 0}
                onChange={toggleSelectAll}
                aria-label={t('accountSwitch.selection.selectAll')}
                title={t('accountSwitch.selection.selectAll')}
              />

              <div className="fd-group-pills" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={groupFilter === 'all'}
                  className={['fd-gpill', groupFilter === 'all' ? 'active' : '']
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => setGroupFilter('all')}
                >
                  <span>{t('accountSwitch.filter.allGroups')}</span>
                  <em>{currentAccounts.length}</em>
                </button>
                {groups.map((group) => {
                  const count = currentAccounts.filter(
                    (acc) => acc.groupId === group.id,
                  ).length;
                  const active = groupFilter === group.id;
                  return (
                    <button
                      key={group.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={['fd-gpill', active ? 'active' : '']
                        .filter(Boolean)
                        .join(' ')}
                      onClick={() => setGroupFilter(group.id)}
                    >
                      <span>{group.name}</span>
                      <em>{count}</em>
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="fd-gpill-add"
                  title={t('accountSwitch.actions.manageGroups')}
                  aria-label={t('accountSwitch.actions.manageGroups')}
                  onClick={() => setGroupsDialogOpen(true)}
                >
                  <Plus size={13} aria-hidden="true" />
                </button>
              </div>
            </div>

            <div className="as-toolbar-right">
              <div className="fd-search">
                <Search size={13} aria-hidden="true" />
                <input
                  ref={searchInputRef}
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={t('accountSwitch.searchPlaceholder')}
                  aria-label={t('accountSwitch.searchPlaceholder')}
                />
              </div>

              {/* Single Unified Filter Popover (Plans + Tags + Group-by-Tag) */}
              {allPlans.length > 1 || allTags.length > 0 ? (
                <div className="fd-tag-wrap" ref={filterPopoverRef}>
                  <button
                    type="button"
                    className={[
                      'fd-subtle-btn',
                      activeFilterCount > 0 ? 'is-accent' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    aria-expanded={filterPopoverOpen}
                    onClick={() => setFilterPopoverOpen((prev) => !prev)}
                  >
                    <Sliders size={13} aria-hidden="true" />
                    <span>{t('accountSwitch.filter.combined')}</span>
                    {activeFilterCount > 0 ? (
                      <em className="as-filter-badge">{activeFilterCount}</em>
                    ) : null}
                  </button>

                  {filterPopoverOpen ? (
                    <div className="fd-tag-popover as-unified-filter-popover">
                      {allPlans.length > 1 ? (
                        <div className="as-filter-section">
                          <span className="as-filter-heading">
                            {t('accountSwitch.filter.plans')}
                          </span>
                          <div className="as-filter-chips">
                            {allPlans.map((plan) => {
                              const active = selectedPlans.includes(plan);
                              return (
                                <button
                                  key={plan}
                                  type="button"
                                  className={[
                                    'as-filter-chip',
                                    active ? 'is-active' : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' ')}
                                  onClick={() => togglePlanValue(plan)}
                                >
                                  {plan}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      {allTags.length > 0 ? (
                        <div className="as-filter-section">
                          <span className="as-filter-heading">
                            {t('accountSwitch.filter.tags')}
                          </span>
                          <div className="as-filter-chips">
                            {allTags.map((tag) => {
                              const active = selectedTags.includes(tag);
                              return (
                                <button
                                  key={tag}
                                  type="button"
                                  className={[
                                    'as-filter-chip',
                                    active ? 'is-active' : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' ')}
                                  onClick={() => toggleTagValue(tag)}
                                >
                                  #{tag}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ) : null}

                      {allTags.length > 0 ? (
                        <>
                          <div className="fd-tag-sep" />
                          <label className="fd-tag-option fd-tag-group-toggle">
                            <input
                              type="checkbox"
                              className="fd-check"
                              checked={groupByTag}
                              onChange={(e) => {
                                setGroupByTag(e.target.checked);
                                setCollapsedTagGroups(new Set());
                              }}
                            />
                            <span>{t('accountSwitch.filter.groupByTag')}</span>
                          </label>
                        </>
                      ) : null}

                      {activeFilterCount > 0 ? (
                        <button
                          type="button"
                          className="fd-tag-clear"
                          onClick={() => {
                            setSelectedPlans([]);
                            setSelectedTags([]);
                            setGroupByTag(false);
                          }}
                        >
                          {t('accountSwitch.filter.clear')}
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="fd-sort-wrap">
                <select
                  className="fd-sort-select"
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value as SortBy)}
                  aria-label={t('accountSwitch.sort.default')}
                >
                  <option value="default">{t('accountSwitch.sort.default')}</option>
                  <option value="quota">{t('accountSwitch.sort.quota')}</option>
                  <option value="expires_at">{t('accountSwitch.sort.expiresAt')}</option>
                  <option value="last_used">{t('accountSwitch.sort.lastUsed')}</option>
                  <option value="label">{t('accountSwitch.sort.label')}</option>
                </select>
                <button
                  type="button"
                  className="fd-ghost-icon"
                  title={t('accountSwitch.sort.toggleDir')}
                  aria-label={t('accountSwitch.sort.toggleDir')}
                  onClick={() =>
                    setSortDir((prev) => (prev === 'desc' ? 'asc' : 'desc'))
                  }
                >
                  {sortDir === 'desc' ? (
                    <ArrowDown size={13} aria-hidden="true" />
                  ) : (
                    <ArrowUp size={13} aria-hidden="true" />
                  )}
                </button>
              </div>

              <div className="fd-view-seg" role="group">
                <button
                  type="button"
                  className={layoutMode === 'cards' ? 'active' : ''}
                  title={t('accountSwitch.view.cards')}
                  aria-label={t('accountSwitch.view.cards')}
                  onClick={() => updateLayoutMode('cards')}
                >
                  <LayoutGrid size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={layoutMode === 'list' ? 'active' : ''}
                  title={t('accountSwitch.view.list')}
                  aria-label={t('accountSwitch.view.list')}
                  onClick={() => updateLayoutMode('list')}
                >
                  <List size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={layoutMode === 'compact' ? 'active' : ''}
                  title={t('accountSwitch.view.compact')}
                  aria-label={t('accountSwitch.view.compact')}
                  onClick={() => updateLayoutMode('compact')}
                >
                  <Rows3 size={14} aria-hidden="true" />
                </button>
              </div>

              <div className="as-toolbar-icons">
                <button
                  type="button"
                  className="fd-ghost-icon"
                  title={t('accountSwitch.actions.refreshQuota')}
                  aria-label={t('accountSwitch.actions.refreshQuota')}
                  disabled={currentAccounts.length === 0 || quotaBusyIds.size > 0}
                  onClick={() => void handleRefreshQuota(selectedPlatform)}
                >
                  <Gauge size={14} aria-hidden="true" />
                </button>

                <button
                  type="button"
                  className="fd-ghost-icon"
                  title={t('accountSwitch.actions.exportJson')}
                  aria-label={t('accountSwitch.actions.exportJson')}
                  disabled={currentAccounts.length === 0}
                  onClick={() => void handleOpenExportDialog(selectedPlatform)}
                >
                  <Upload size={14} aria-hidden="true" />
                </button>

                {activeStatus.supportsClientRestart && activeStatus.running ? (
                  <button
                    type="button"
                    className="fd-ghost-icon"
                    title={t('accountSwitch.actions.restartClient')}
                    aria-label={t('accountSwitch.actions.restartClient')}
                    disabled={restarting}
                    onClick={() => void handleRestartClient(selectedPlatform)}
                  >
                    <RotateCw
                      size={14}
                      className={restarting ? 'spin' : ''}
                      aria-hidden="true"
                    />
                  </button>
                ) : null}

                <button
                  type="button"
                  className="fd-ghost-icon"
                  title={t('accountSwitch.actions.manageGroups')}
                  aria-label={t('accountSwitch.actions.manageGroups')}
                  onClick={() => setGroupsDialogOpen(true)}
                >
                  <FolderOpen size={14} aria-hidden="true" />
                </button>
              </div>
            </div>
          </div>

          {/* Quiet Architectural Contextual Notices (no loud red/pink full-width banners) */}
          {activeStatus.proxy.mode === 'cpa_proxy' ||
          activeStatus.proxy.mode === 'custom_proxy' ? (
            <div
              className="fd-inline-alert is-warning"
              role="alert"
              title={activeStatus.proxy.detail ?? undefined}
            >
              <ShieldAlert size={15} aria-hidden="true" />
              <span className="fd-inline-alert-copy">
                <strong>
                  {t(
                    activeStatus.proxy.mode === 'cpa_proxy'
                      ? 'accountSwitch.proxyBanner.cpaTitle'
                      : 'accountSwitch.proxyBanner.customTitle',
                    { platform: activeStatus.displayName },
                  )}
                </strong>
              </span>
              {activeStatus.proxy.canDecouple ? (
                <button
                  type="button"
                  className="fd-alert-cta"
                  disabled={decouplingPlatform === selectedPlatform}
                  onClick={() => void handleDecoupleProxy(selectedPlatform)}
                >
                  <Unplug size={13} aria-hidden="true" />
                  <span>
                    {t(
                      decouplingPlatform === selectedPlatform
                        ? 'accountSwitch.actions.decoupling'
                        : 'accountSwitch.actions.decoupleProxy',
                    )}
                  </span>
                </button>
              ) : null}
            </div>
          ) : null}

          {showLocalCaptureStrip ? (
            <div className="fd-inline-alert is-info">
              <KeyRound size={14} aria-hidden="true" />
              <span className="fd-inline-alert-copy">
                <strong>
                  {t('accountSwitch.localDetected', {
                    label: mask.text(
                      activeStatus.localCredential.label ??
                        activeStatus.displayName,
                    ),
                  })}
                </strong>
                <small>{t('accountSwitch.localUnimported')}</small>
              </span>
              <button
                type="button"
                className="fd-subtle-btn is-accent"
                onClick={() => void handleQuickCaptureLocal(selectedPlatform)}
              >
                {t('accountSwitch.actions.importLocal')}
              </button>
              <button
                type="button"
                className="fd-card-icon"
                aria-label={t('common.close')}
                onClick={() =>
                  setDismissedLocalNotice((prev) =>
                    new Set([...prev, selectedPlatform]),
                  )
                }
              >
                <X size={13} aria-hidden="true" />
              </button>
            </div>
          ) : null}

          {/* Main Account Stage */}
          {filteredAccounts.length === 0 ? (
            <EmptyState
              title={t('accountSwitch.empty.title', {
                platform: activeStatus.displayName,
              })}
              action={
                <button
                  type="button"
                  className="primary-button"
                  onClick={() =>
                    setAddDialogTarget({
                      platform: selectedPlatform,
                      tab: 'local',
                    })
                  }
                >
                  <Plus size={15} aria-hidden="true" />
                  <span>{t('accountSwitch.actions.addAccount')}</span>
                </button>
              }
            >
              {t('accountSwitch.empty.desc')}
            </EmptyState>
          ) : groupedByTagSections ? (
            <div className="fd-tag-sections">
              {groupedByTagSections.map((section) => {
                const collapsed = collapsedTagGroups.has(section.key);
                return (
                  <div
                    key={section.key}
                    className="fd-tag-section"
                    data-tag-group={section.key}
                  >
                    <button
                      type="button"
                      className="fd-tag-section-head"
                      aria-expanded={!collapsed}
                      onClick={() =>
                        setCollapsedTagGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(section.key)) next.delete(section.key);
                          else next.add(section.key);
                          return next;
                        })
                      }
                    >
                      {collapsed ? (
                        <ChevronRight size={14} aria-hidden="true" />
                      ) : (
                        <ChevronDown size={14} aria-hidden="true" />
                      )}
                      <span>{section.label}</span>
                      <em>{section.accounts.length}</em>
                    </button>
                    {!collapsed
                      ? renderAccountsCollection(
                          selectedPlatform,
                          section.accounts,
                        )
                      : null}
                  </div>
                );
              })}
            </div>
          ) : (
            renderAccountsCollection(selectedPlatform, filteredAccounts)
          )}

          {/* Cockpit-Enhanced Floating Batch Bar */}
          {selectedIds.size > 0 ? (
            <div className="fd-floating-batch" role="region">
              <span className="fd-batch-count">
                {t('accountSwitch.selection.selected', {
                  count: selectedIds.size,
                })}
              </span>
              <i className="fd-batch-sep" aria-hidden="true" />
              <button
                type="button"
                className="fd-batch-btn"
                onClick={() => setAssignGroupOpen(true)}
              >
                <FolderPlus size={13} aria-hidden="true" />
                <span>{t('accountSwitch.actions.addToGroup')}</span>
              </button>
              {groupFilter !== 'all' && groupFilter !== 'ungrouped' ? (
                <button
                  type="button"
                  className="fd-batch-btn"
                  disabled={assignGroupBusy}
                  onClick={() => void handleBatchAssignGroup(null)}
                >
                  <FolderMinus size={13} aria-hidden="true" />
                  <span>{t('accountSwitch.actions.removeFromGroup')}</span>
                </button>
              ) : null}
              <button
                type="button"
                className="fd-batch-btn"
                onClick={() =>
                  void handleOpenExportDialog(
                    selectedPlatform,
                    Array.from(selectedIds),
                  )
                }
              >
                <Upload size={13} aria-hidden="true" />
                <span>{t('accountSwitch.actions.exportSelected')}</span>
              </button>
              <button
                type="button"
                className="fd-batch-btn"
                disabled={quotaBusyIds.size > 0}
                onClick={() =>
                  void handleRefreshQuota(
                    selectedPlatform,
                    Array.from(selectedIds),
                  )
                }
              >
                <Gauge size={13} aria-hidden="true" />
                <span>{t('accountSwitch.actions.refreshSelectedQuota')}</span>
              </button>
              <button
                type="button"
                className="fd-batch-btn is-danger"
                onClick={() => {
                  const targets = currentAccounts.filter((acc) =>
                    selectedIds.has(acc.id),
                  );
                  if (targets.length > 0) {
                    setDeleteTarget({
                      platform: selectedPlatform,
                      accounts: targets,
                    });
                  }
                }}
              >
                <Trash2 size={13} aria-hidden="true" />
                <span>
                  {t('accountSwitch.actions.deleteSelected', {
                    count: selectedIds.size,
                  })}
                </span>
              </button>
              <button
                type="button"
                className="fd-batch-close"
                title={t('accountSwitch.selection.clear')}
                aria-label={t('accountSwitch.selection.clear')}
                onClick={() => setSelectedIds(new Set())}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Floating Non-Intrusive Toast (Zero Layout Shift!) */}
      {notice ? (
        <div
          className={`as-floating-toast is-${notice.level}`}
          role={notice.level === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          {notice.level === 'error' ? (
            <ShieldAlert size={15} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={15} aria-hidden="true" />
          )}
          <span>{notice.text}</span>
          <button
            type="button"
            aria-label={t('common.close')}
            onClick={() => setNotice(null)}
          >
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}

      {/* Dialogs */}
      {addDialogTarget && addDialogStatus ? (
        <AddAccountDialog
          platform={addDialogTarget.platform}
          status={addDialogStatus}
          initialTab={addDialogTarget.tab}
          remoteCpaActive={remoteCpaActive}
          onClose={() => setAddDialogTarget(null)}
          onImported={(msg: string) => {
            setNotice({ level: 'success', text: msg });
            setAddDialogTarget(null);
            void loadCatalogAndAccounts();
          }}
        />
      ) : null}

      {switchTarget && switchDialogStatus ? (
        <SwitchAccountDialog
          status={switchDialogStatus}
          account={switchTarget.account}
          initialOptions={resolveSwitchOptions(
            switchDialogStatus,
            switchTarget.account,
            getPlatformSwitchPreferences(
              quickSettingsMap,
              switchTarget.platform,
            ),
          )}
          busy={switchingAccountId === switchTarget.account.id}
          onClose={() => setSwitchTarget(null)}
          onConfirm={(options) =>
            void executeSwitch(
              switchTarget.platform,
              switchTarget.account,
              options,
            )
          }
        />
      ) : null}

      {editingAccount && selectedPlatform ? (
        <EditAccountMetaDialog
          account={editingAccount}
          groups={groups}
          availableTags={allTags}
          onClose={() => setEditingAccount(null)}
          onSave={async (patch) => {
            await accountSwitchApi.updateMeta(
              selectedPlatform,
              editingAccount.id,
              patch,
            );
            setEditingAccount(null);
            await loadPlatformAccounts(selectedPlatform);
          }}
        />
      ) : null}

      {groupsDialogOpen ? (
        <ManageGroupsDialog
          groups={groups}
          groupCounts={groupCounts}
          onClose={() => setGroupsDialogOpen(false)}
          onChanged={(nextGroups: AccountGroup[]) => {
            setGroups(nextGroups);
            if (selectedPlatform) {
              void loadPlatformAccounts(selectedPlatform);
            }
          }}
        />
      ) : null}

      {deleteTarget ? (
        <DeleteConfirmDialog
          accounts={deleteTarget.accounts}
          busy={deletingBusy}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => void handleConfirmDelete()}
        />
      ) : null}

      {assignGroupOpen && selectedPlatform ? (
        <AssignGroupDialog
          selectedCount={selectedIds.size}
          groups={groups}
          busy={assignGroupBusy}
          onClose={() => setAssignGroupOpen(false)}
          onApply={handleBatchAssignGroup}
          onCreateAndApply={handleCreateGroupAndAssign}
        />
      ) : null}

      {exportPreview ? (
        <ExportJsonDialog
          platformName={exportPreview.platformName}
          filePrefix={exportPreview.filePrefix}
          jsonContent={exportPreview.jsonContent}
          onClose={() => setExportPreview(null)}
        />
      ) : null}
    </section>
  );
}
