import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, SlidersHorizontal, X } from 'lucide-react';
import { Switch } from '../../components/Switch';
import { useI18n } from '../../i18n';
import type {
  AccountSummary,
  PlatformRuntimeStatus,
  SwitchAccountOptions,
  SwitchPlatformId,
} from '../../services/accountSwitch';

const QUICK_SETTINGS_KEY = 'cpa-gui.account-switch.quick-settings.v1';

export interface PlatformSwitchPreferences {
  decoupleCpaProxy: boolean;
  refreshBeforeSwitch: boolean;
  /** null means automatically follow all installed companion targets */
  syncTargets: string[] | null;
  restartClient: boolean;
  /** false (default) => true 1-click instant switching like cockpit-tools */
  confirmBeforeSwitch: boolean;
}

export type QuickSettingsMap = Partial<
  Record<SwitchPlatformId | '__global__', PlatformSwitchPreferences>
>;

export const DEFAULT_SWITCH_PREFERENCES: PlatformSwitchPreferences = {
  decoupleCpaProxy: true,
  refreshBeforeSwitch: true,
  syncTargets: null,
  restartClient: false,
  confirmBeforeSwitch: false,
};

export function loadQuickSettingsMap(): QuickSettingsMap {
  try {
    const raw = window.localStorage.getItem(QUICK_SETTINGS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as QuickSettingsMap;
    }
  } catch {
    /* ignore storage errors */
  }
  return {};
}

export function saveQuickSettingsMap(map: QuickSettingsMap): void {
  try {
    window.localStorage.setItem(QUICK_SETTINGS_KEY, JSON.stringify(map));
  } catch {
    /* ignore storage errors */
  }
}

export function getPlatformSwitchPreferences(
  map: QuickSettingsMap,
  platform: SwitchPlatformId | null,
): PlatformSwitchPreferences {
  const globalPref = map.__global__ ?? DEFAULT_SWITCH_PREFERENCES;
  const platPref = platform ? map[platform] : undefined;
  return {
    ...DEFAULT_SWITCH_PREFERENCES,
    ...globalPref,
    ...(platPref ?? {}),
  };
}

export function resolveSwitchOptions(
  status: PlatformRuntimeStatus,
  account: AccountSummary,
  pref: PlatformSwitchPreferences,
): SwitchAccountOptions {
  const installedTargetIds = status.syncTargets
    .filter((item) => item.installed)
    .map((item) => item.id);
  const validTargetIds = new Set(status.syncTargets.map((item) => item.id));
  const resolvedSync =
    pref.syncTargets === null
      ? installedTargetIds
      : pref.syncTargets.filter((id) => validTargetIds.has(id));

  return {
    decoupleCpaProxy:
      pref.decoupleCpaProxy &&
      (status.proxy.mode === 'cpa_proxy' || status.proxy.mode === 'custom_proxy'),
    refreshBeforeSwitch: pref.refreshBeforeSwitch && account.hasRefreshToken,
    syncTargets: resolvedSync,
    restartClient:
      pref.restartClient && status.supportsClientRestart && status.running,
  };
}

interface SwitchQuickSettingsPopoverProps {
  status?: PlatformRuntimeStatus;
  preferences: PlatformSwitchPreferences;
  onUpdate: (patch: Partial<PlatformSwitchPreferences>) => void;
}

export function SwitchQuickSettingsPopover({
  status,
  preferences,
  onUpdate,
}: SwitchQuickSettingsPopoverProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; width: number }>(
    { top: 56, left: 16, width: 352 },
  );

  const updatePosition = useCallback(() => {
    const btn = triggerRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = Math.min(356, window.innerWidth - 32);
    const rightAligned = rect.right - width;
    const preferredLeft =
      rightAligned >= 272 || rect.left + width > window.innerWidth - 16
        ? rightAligned
        : rect.left;
    // Clamp cleanly inside viewport so wrapped headers never clip past left/right edge
    const left = Math.max(
      16,
      Math.min(preferredLeft, window.innerWidth - width - 16),
    );
    const top = Math.min(rect.bottom + 8, window.innerHeight - 160);
    setCoords({ top, left, width });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
  }, [open, updatePosition]);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (
        !triggerRef.current?.contains(target) &&
        !popoverRef.current?.contains(target)
      ) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, updatePosition]);

  const activeSyncIds =
    status && preferences.syncTargets === null
      ? status.syncTargets.filter((item) => item.installed).map((item) => item.id)
      : preferences.syncTargets ?? [];

  const toggleSyncTarget = (id: string) => {
    const next = activeSyncIds.includes(id)
      ? activeSyncIds.filter((item) => item !== id)
      : [...activeSyncIds, id];
    onUpdate({ syncTargets: next });
  };

  const popoverNode = open ? (
    <div
      ref={popoverRef}
      className="fd-qs-popover fd-qs-popover-portal"
      role="dialog"
      aria-label={t('accountSwitch.quickSettings.title')}
      style={{
        top: `${coords.top}px`,
        left: `${coords.left}px`,
        width: `${coords.width}px`,
      }}
    >
      <div className="fd-qs-head">
        <div className="fd-qs-title">
          <strong>
            {status
              ? t('accountSwitch.quickSettings.platformTitle', {
                  platform: status.displayName,
                })
              : t('accountSwitch.quickSettings.title')}
          </strong>
          <span>{t('accountSwitch.quickSettings.subtitle')}</span>
        </div>
        <button
          type="button"
          className="fd-card-icon"
          aria-label={t('common.close')}
          onClick={() => setOpen(false)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </div>

      <div className="fd-qs-body">
        <div className="fd-qs-row">
          <div className="fd-qs-label">
            <strong>{t('accountSwitch.quickSettings.decouple')}</strong>
            <small>{t('accountSwitch.quickSettings.decoupleHint')}</small>
          </div>
          <Switch
            checked={preferences.decoupleCpaProxy}
            onChange={(e) => onUpdate({ decoupleCpaProxy: e.target.checked })}
            aria-label={t('accountSwitch.quickSettings.decouple')}
          />
        </div>

        <div className="fd-qs-row">
          <div className="fd-qs-label">
            <strong>{t('accountSwitch.quickSettings.refreshToken')}</strong>
            <small>{t('accountSwitch.quickSettings.refreshTokenHint')}</small>
          </div>
          <Switch
            checked={preferences.refreshBeforeSwitch}
            onChange={(e) => onUpdate({ refreshBeforeSwitch: e.target.checked })}
            aria-label={t('accountSwitch.quickSettings.refreshToken')}
          />
        </div>

        {!status || status.supportsClientRestart ? (
          <div className="fd-qs-row">
            <div className="fd-qs-label">
              <strong>{t('accountSwitch.quickSettings.restartClient')}</strong>
              <small>{t('accountSwitch.quickSettings.restartClientHint')}</small>
            </div>
            <Switch
              checked={preferences.restartClient}
              onChange={(e) => onUpdate({ restartClient: e.target.checked })}
              aria-label={t('accountSwitch.quickSettings.restartClient')}
            />
          </div>
        ) : null}

        {status && status.syncTargets.length > 0 ? (
          <div className="fd-qs-sync">
            <div className="fd-qs-sync-head">
              <Link2 size={13} aria-hidden="true" />
              <span>{t('accountSwitch.switchDialog.syncTitle')}</span>
            </div>
            <div className="fd-qs-sync-list">
              {status.syncTargets.map((target) => {
                const checked = activeSyncIds.includes(target.id);
                return (
                  <label key={target.id} className="fd-qs-sync-item">
                    <input
                      type="checkbox"
                      className="fd-check"
                      checked={checked}
                      onChange={() => toggleSyncTarget(target.id)}
                    />
                    <span>{target.label}</span>
                    <em className={target.installed ? 'installed' : ''}>
                      {t(
                        target.installed
                          ? 'accountSwitch.status.installed'
                          : 'accountSwitch.status.notInstalled',
                      )}
                    </em>
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="fd-qs-divider" />

        <div className="fd-qs-row">
          <div className="fd-qs-label">
            <strong>{t('accountSwitch.quickSettings.confirmSwitch')}</strong>
            <small>{t('accountSwitch.quickSettings.confirmSwitchHint')}</small>
          </div>
          <Switch
            checked={preferences.confirmBeforeSwitch}
            onChange={(e) => onUpdate({ confirmBeforeSwitch: e.target.checked })}
            aria-label={t('accountSwitch.quickSettings.confirmSwitch')}
          />
        </div>
      </div>
    </div>
  ) : null;

  return (
    <div className="fd-qs-wrap">
      <button
        ref={triggerRef}
        type="button"
        className={['fd-subtle-btn', open ? 'is-accent' : '']
          .filter(Boolean)
          .join(' ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('accountSwitch.quickSettings.button')}
        onClick={() => setOpen((prev) => !prev)}
      >
        <SlidersHorizontal size={13} aria-hidden="true" />
        <span>{t('accountSwitch.quickSettings.button')}</span>
      </button>

      {popoverNode
        ? typeof document !== 'undefined'
          ? createPortal(popoverNode, document.body)
          : popoverNode
        : null}
    </div>
  );
}
