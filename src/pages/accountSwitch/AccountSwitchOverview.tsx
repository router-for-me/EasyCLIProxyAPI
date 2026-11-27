import { useMemo, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  CalendarClock,
  Check,
  CheckCircle2,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  RotateCw,
  Search,
  Unplug,
} from 'lucide-react';
import { useI18n } from '../../i18n';
import { usePrivacyMask } from '../../privacy';
import type { AccountSwitchCategoryFilter } from '../../navigation';
import { BrandIcon } from '../../components/BrandIcon';
import {
  PLATFORM_VISUAL_META,
  platformsInCategory,
  type AccountSummary,
  type PlatformRuntimeStatus,
  type SwitchPlatformId,
} from '../../services/accountSwitch';
import {
  averageRemainingQuota,
  BRAND_ICON_KEY,
  describeAccountExpiry,
  formatAbsoluteDateTime,
  formatResetCountdown,
  isMonoDarkIcon,
  localizeQuotaMetricDetail,
  localizeQuotaMetricLabel,
  quotaTone,
  tierBadgeVariant,
} from './AccountSwitchHelpers';

type OverviewTab = AccountSwitchCategoryFilter | 'all-accounts';

interface AccountSwitchOverviewProps {
  platforms: PlatformRuntimeStatus[];
  accountsByPlatform: Partial<Record<SwitchPlatformId, AccountSummary[]>>;
  categoryFilter: AccountSwitchCategoryFilter;
  onCategoryChange: (next: AccountSwitchCategoryFilter) => void;
  onSelectPlatform: (platform: SwitchPlatformId) => void;
  onQuickSwitch: (
    platform: SwitchPlatformId,
    account: AccountSummary,
    forceDialog?: boolean,
  ) => void;
  onQuickAdd: (platform: SwitchPlatformId) => void;
  onDecoupleProxy: (platform: SwitchPlatformId) => void;
  onRefreshPlatformQuota: (platform: SwitchPlatformId) => void;
  onCopyAccount: (account: AccountSummary) => void;
  copiedAccountId: string | null;
  switchingAccountId: string | null;
  decouplingPlatform: SwitchPlatformId | null;
  refreshingPlatformId: SwitchPlatformId | null;
}

export function AccountSwitchOverview({
  platforms,
  accountsByPlatform,
  categoryFilter,
  onCategoryChange,
  onSelectPlatform,
  onQuickSwitch,
  onQuickAdd,
  onDecoupleProxy,
  onRefreshPlatformQuota,
  onCopyAccount,
  copiedAccountId,
  switchingAccountId,
  decouplingPlatform,
  refreshingPlatformId,
}: AccountSwitchOverviewProps) {
  const { locale, t } = useI18n();
  const mask = usePrivacyMask();
  const [showAllAccounts, setShowAllAccounts] = useState(false);
  const [globalSearch, setGlobalSearch] = useState('');

  const totalAccounts = platforms.reduce((sum, item) => sum + item.accountCount, 0);
  const configuredPlatforms = platforms.filter((item) => item.accountCount > 0);
  const directCount = configuredPlatforms.filter((item) => item.proxy.mode === 'direct').length;
  const proxyPlatforms = configuredPlatforms.filter(
    (item) => item.proxy.mode === 'cpa_proxy' || item.proxy.mode === 'custom_proxy',
  );

  const filteredConfigured = platformsInCategory(configuredPlatforms, categoryFilter);
  const unconfiguredPlatforms = platformsInCategory(
    platforms.filter((item) => item.accountCount === 0),
    categoryFilter,
  );

  const categoryCounts = {
    all: platforms.length,
    cli: platforms.filter((p) => p.category === 'official-cli').length,
    ide: platforms.filter((p) => p.category === 'ai-ide').length,
  };

  const activeTab: OverviewTab = showAllAccounts ? 'all-accounts' : categoryFilter;

  const allPlatformRows = useMemo(() => {
    const q = globalSearch.trim().toLowerCase();
    const rows: Array<{ status: PlatformRuntimeStatus; account: AccountSummary }> = [];
    for (const status of platforms) {
      const list = accountsByPlatform[status.platform] ?? [];
      for (const account of list) {
        if (q) {
          const hay = [
            status.displayName,
            account.label,
            account.email ?? '',
            account.planType ?? '',
            account.notes ?? '',
            ...account.tags,
          ]
            .join(' ')
            .toLowerCase();
          if (!hay.includes(q)) continue;
        }
        rows.push({ status, account });
      }
    }
    rows.sort((a, b) => {
      if (a.account.isActive !== b.account.isActive) {
        return a.account.isActive ? -1 : 1;
      }
      return averageRemainingQuota(b.account) - averageRemainingQuota(a.account);
    });
    return rows;
  }, [platforms, accountsByPlatform, globalSearch]);

  const handleSelectTab = (tab: OverviewTab) => {
    if (tab === 'all-accounts') {
      setShowAllAccounts(true);
    } else {
      setShowAllAccounts(false);
      onCategoryChange(tab);
    }
  };

  return (
    <div className="fd-overview">
      {/* 1. Typographic Metrics Strip + Borderless Category & All-Accounts Tabs */}
      <div className="fd-ribbon">
        <div className="fd-kpis">
          <button
            type="button"
            className="fd-kpi fd-kpi-clickable"
            onClick={() => handleSelectTab('all-accounts')}
          >
            <strong>{totalAccounts}</strong>
            <span>{t('accountSwitch.overview.kpiAccounts')}</span>
          </button>
          <i className="fd-kpi-sep" aria-hidden="true" />
          <div className="fd-kpi">
            <strong>
              {configuredPlatforms.length}
              <em>/{platforms.length}</em>
            </strong>
            <span>{t('accountSwitch.overview.kpiPlatforms')}</span>
          </div>
          <i className="fd-kpi-sep" aria-hidden="true" />
          <div className="fd-kpi">
            <strong className="is-emerald">{directCount}</strong>
            <span>{t('accountSwitch.overview.kpiDirect')}</span>
          </div>
          {proxyPlatforms.length > 0 ? (
            <>
              <i className="fd-kpi-sep" aria-hidden="true" />
              <button
                type="button"
                className="fd-kpi fd-kpi-clickable"
                onClick={() => onSelectPlatform(proxyPlatforms[0].platform)}
              >
                <strong className="is-amber">{proxyPlatforms.length}</strong>
                <span>{t('accountSwitch.overview.kpiProxy')}</span>
              </button>
            </>
          ) : null}
        </div>

        <div
          className="fd-underline-tabs"
          role="tablist"
          aria-label={t('app.nav.accountSwitching.subpages')}
        >
          {(
            [
              ['all', t('accountSwitch.category.all'), categoryCounts.all],
              ['official-cli', t('accountSwitch.category.officialCli'), categoryCounts.cli],
              ['ai-ide', t('accountSwitch.category.aiIde'), categoryCounts.ide],
              [
                'all-accounts',
                t('accountSwitch.overview.allAccountsTab'),
                totalAccounts,
              ],
            ] as const
          ).map(([tabId, label, count]) => (
            <button
              key={tabId}
              type="button"
              role="tab"
              aria-selected={activeTab === tabId}
              className={['fd-utab', activeTab === tabId ? 'active' : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => handleSelectTab(tabId)}
            >
              <span>{label}</span>
              <em>{count}</em>
            </button>
          ))}
        </div>
      </div>

      {/* 2A. Cockpit-Style Cross-Platform All-Accounts Quick Switch View */}
      {showAllAccounts ? (
        <div className="fd-all-accounts">
          <div className="fd-all-accounts-bar">
            <div className="fd-search fd-search-wide">
              <Search size={13} aria-hidden="true" />
              <input
                type="search"
                value={globalSearch}
                onChange={(e) => setGlobalSearch(e.target.value)}
                placeholder={t('accountSwitch.overview.allAccountsSearch')}
                aria-label={t('accountSwitch.overview.allAccountsSearch')}
              />
            </div>
          </div>

          {allPlatformRows.length === 0 ? (
            <div className="fd-all-empty">
              {t('accountSwitch.overview.allAccountsEmpty')}
            </div>
          ) : (
            <div className="fd-compact-list">
              {allPlatformRows.map(({ status, account }) => {
                const displayLabel = mask.text(account.label);
                const isSwitching = switchingAccountId === account.id;
                const isCopied = copiedAccountId === account.id;
                const metrics = account.lastQuota?.metrics.slice(0, 2) ?? [];
                return (
                  <div
                    key={`${status.platform}:${account.id}`}
                    data-all-account-id={account.id}
                    className={[
                      'fd-compact-row',
                      account.isActive ? 'is-active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <button
                      type="button"
                      className="fd-platform-tag-btn"
                      onClick={() => onSelectPlatform(status.platform)}
                      title={status.displayName}
                    >
                      <span
                        className={[
                          'fd-icon-slot',
                          isMonoDarkIcon(status.platform) ? 'fd-mono-icon' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <BrandIcon name={BRAND_ICON_KEY[status.platform]} size={14} />
                      </span>
                      <span>{status.displayName}</span>
                    </button>

                    {account.isActive ? (
                      <span className="fd-active-dot" aria-hidden="true" />
                    ) : null}

                    <span className="fd-card-email" title={displayLabel}>
                      {displayLabel}
                    </span>

                    <button
                      type="button"
                      className={[
                        'fd-copy-mini',
                        isCopied ? 'is-copied' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      title={t(
                        isCopied
                          ? 'accountSwitch.actions.copied'
                          : 'accountSwitch.actions.copyEmail',
                      )}
                      aria-label={t('accountSwitch.actions.copyEmail')}
                      onClick={() => onCopyAccount(account)}
                    >
                      {isCopied ? <Check size={12} /> : <Copy size={12} />}
                    </button>

                    {account.planType ? (
                      <span
                        className={`fd-tier-pill is-xs tier-${tierBadgeVariant(
                          account.planType,
                        )}`}
                      >
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
                      {account.isActive ? (
                        <span className="fd-active-label">
                          <CheckCircle2 size={13} aria-hidden="true" />
                          <span>{t('accountSwitch.actions.active')}</span>
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="fd-row-switch-btn"
                          disabled={switchingAccountId !== null}
                          title={t('accountSwitch.actions.switchWithOptions')}
                          onClick={(event) =>
                            onQuickSwitch(
                              status.platform,
                              account,
                              event.shiftKey,
                            )
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
                          {!isSwitching ? (
                            <ArrowRight size={12} aria-hidden="true" />
                          ) : null}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        <>
          {/* 2B. Signature Editorial 2-Column Platform Flight Deck */}
          {filteredConfigured.length > 0 ? (
            <div className="fd-deck-grid">
              {filteredConfigured.map((platform) => {
                const list = accountsByPlatform[platform.platform] ?? [];
                const activeAccount =
                  list.find((item) => item.isActive || item.id === platform.activeAccountId) ??
                  list[0] ??
                  null;
                const standbyAccounts = [...list]
                  .filter((item) => item.id !== activeAccount?.id)
                  .sort((a, b) => averageRemainingQuota(b) - averageRemainingQuota(a));

                const isProxy =
                  platform.proxy.mode === 'cpa_proxy' ||
                  platform.proxy.mode === 'custom_proxy';
                const isRefreshing = refreshingPlatformId === platform.platform;
                const isDecoupling = decouplingPlatform === platform.platform;
                const activeMetrics = activeAccount?.lastQuota?.metrics.slice(0, 2) ?? [];
                const isActiveCopied = activeAccount && copiedAccountId === activeAccount.id;

                return (
                  <article
                    key={platform.platform}
                    className={['fd-deck-card', isProxy ? 'has-proxy' : '']
                      .filter(Boolean)
                      .join(' ')}
                    data-overview-card={platform.platform}
                  >
                    {/* Card Header */}
                    <div className="fd-deck-head">
                      <button
                        type="button"
                        className="fd-deck-brand"
                        onClick={() => onSelectPlatform(platform.platform)}
                      >
                        <span
                          className={[
                            'fd-brand-tile',
                            isMonoDarkIcon(platform.platform) ? 'fd-mono-icon' : '',
                          ]
                            .filter(Boolean)
                            .join(' ')}
                        >
                          <BrandIcon name={BRAND_ICON_KEY[platform.platform]} size={18} />
                        </span>
                        <span className="fd-brand-meta">
                          <strong>{platform.displayName}</strong>
                          <small>{PLATFORM_VISUAL_META[platform.platform].clientHint}</small>
                        </span>
                      </button>

                      <div className="fd-deck-head-right">
                        {isProxy && platform.proxy.canDecouple ? (
                          <button
                            type="button"
                            className="fd-status-chip is-amber"
                            disabled={isDecoupling}
                            onClick={() => onDecoupleProxy(platform.platform)}
                            title={t('accountSwitch.actions.decoupleProxy')}
                          >
                            <Unplug size={12} aria-hidden="true" />
                            <span>{t('accountSwitch.actions.decoupleProxy')}</span>
                          </button>
                        ) : (
                          <span className="fd-status-chip is-emerald">
                            <i className="fd-live-dot" aria-hidden="true" />
                            <span>{t('accountSwitch.status.direct')}</span>
                          </span>
                        )}

                        <button
                          type="button"
                          className="fd-ghost-icon"
                          disabled={isRefreshing}
                          title={t('accountSwitch.actions.refreshQuota')}
                          aria-label={t('accountSwitch.actions.refreshQuota')}
                          onClick={() => onRefreshPlatformQuota(platform.platform)}
                        >
                          <RotateCw
                            size={13}
                            className={isRefreshing ? 'spin' : ''}
                            aria-hidden="true"
                          />
                        </button>
                      </div>
                    </div>

                    {/* Active Account Hero Spotlight */}
                    {activeAccount ? (
                      <div className="fd-active-spotlight">
                        <div className="fd-spotlight-top">
                          <span className="fd-active-dot" aria-hidden="true" />
                          <span
                            className="fd-spotlight-email"
                            title={mask.text(activeAccount.label)}
                          >
                            {mask.text(activeAccount.label)}
                          </span>
                          <button
                            type="button"
                            className={[
                              'fd-copy-mini',
                              isActiveCopied ? 'is-copied' : '',
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            title={t(
                              isActiveCopied
                                ? 'accountSwitch.actions.copied'
                                : 'accountSwitch.actions.copyEmail',
                            )}
                            aria-label={t('accountSwitch.actions.copyEmail')}
                            onClick={() => onCopyAccount(activeAccount)}
                          >
                            {isActiveCopied ? <Check size={12} /> : <Copy size={12} />}
                          </button>
                          {activeAccount.planType ? (
                            <span
                              className={`fd-tier-pill tier-${tierBadgeVariant(
                                activeAccount.planType,
                              )}`}
                            >
                              {activeAccount.planType}
                            </span>
                          ) : null}
                        </div>

                        {activeMetrics.length > 0 ? (
                          <div className="fd-meter-grid">
                            {activeMetrics.map((metric) => {
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
                                          · ↻ {reset}
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
                            {t('accountSwitch.card.noQuota')}
                          </span>
                        )}

                        {(() => {
                          const expiry = describeAccountExpiry(
                            activeAccount,
                            locale,
                            t,
                          );
                          if (expiry.kind === 'none') return null;
                          return (
                            <div
                              className={`fd-card-expiry tone-${expiry.tone}`}
                              title={expiry.tooltip}
                            >
                              {expiry.kind === 'plan' ? (
                                <CalendarClock size={12} aria-hidden="true" />
                              ) : (
                                <KeyRound size={12} aria-hidden="true" />
                              )}
                              <span>{expiry.label}</span>
                            </div>
                          );
                        })()}
                      </div>
                    ) : null}

                    {/* Standby Quick-Switch Pool (True 1-Click Instant Switch Rows!) */}
                    <div className="fd-standby-section">
                      {standbyAccounts.length > 0 ? (
                        <>
                          <span className="fd-standby-heading">
                            {t('accountSwitch.overview.standbyPool')}
                          </span>
                          <div className="fd-standby-list">
                            {standbyAccounts.slice(0, 2).map((candidate) => {
                              const avg = averageRemainingQuota(candidate);
                              const tone = avg >= 0 ? quotaTone(avg) : 'medium';
                              const firstMetric = candidate.lastQuota?.metrics[0];
                              const isSwitching = switchingAccountId === candidate.id;
                              return (
                                <div
                                  key={candidate.id}
                                  className="fd-standby-row"
                                  data-standby-account={candidate.id}
                                >
                                  <span
                                    className="fd-standby-email"
                                    title={mask.text(candidate.label)}
                                  >
                                    {mask.text(candidate.label)}
                                  </span>
                                  {candidate.planType ? (
                                    <span
                                      className={`fd-tier-pill is-xs tier-${tierBadgeVariant(
                                        candidate.planType,
                                      )}`}
                                    >
                                      {candidate.planType}
                                    </span>
                                  ) : null}
                                  {firstMetric && firstMetric.remainingPercent !== null ? (
                                    <span className={`fd-standby-pct tone-${tone}`}>
                                      {Math.round(firstMetric.remainingPercent)}%
                                    </span>
                                  ) : null}
                                  <button
                                    type="button"
                                    className="fd-row-switch-btn"
                                    disabled={switchingAccountId !== null}
                                    title={t('accountSwitch.actions.switchWithOptions')}
                                    onClick={(event) =>
                                      onQuickSwitch(
                                        platform.platform,
                                        candidate,
                                        event.shiftKey,
                                      )
                                    }
                                  >
                                    {isSwitching ? (
                                      <Loader2
                                        size={12}
                                        className="spin"
                                        aria-hidden="true"
                                      />
                                    ) : null}
                                    <span>
                                      {t(
                                        isSwitching
                                          ? 'accountSwitch.actions.switching'
                                          : 'accountSwitch.actions.switchShort',
                                      )}
                                    </span>
                                    {!isSwitching ? (
                                      <ArrowRight size={12} aria-hidden="true" />
                                    ) : null}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        </>
                      ) : (
                        <div className="fd-standby-empty">
                          <span>{t('accountSwitch.overview.noRecommendation')}</span>
                          <button
                            type="button"
                            className="fd-text-action"
                            onClick={() => onQuickAdd(platform.platform)}
                          >
                            <Plus size={12} aria-hidden="true" />
                            <span>{t('accountSwitch.actions.addAccount')}</span>
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Subtle Editorial Footer Link */}
                    <div className="fd-deck-foot">
                      <button
                        type="button"
                        className="fd-deck-manage-link"
                        onClick={() => onSelectPlatform(platform.platform)}
                      >
                        <span>
                          {t('accountSwitch.overview.manageAll', {
                            count: platform.accountCount,
                          })}
                        </span>
                        <ArrowUpRight size={13} aria-hidden="true" />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          ) : null}

          {/* 3. Subtle Bottom Shelf for Unconfigured Platforms */}
          {unconfiguredPlatforms.length > 0 ? (
            <div className="fd-shelf">
              <span className="fd-shelf-label">
                {t('accountSwitch.overview.morePlatformsTitle')}
              </span>
              <div className="fd-shelf-items">
                {unconfiguredPlatforms.map((item) => (
                  <button
                    key={item.platform}
                    type="button"
                    className="fd-shelf-pill"
                    data-platform-id={item.platform}
                    title={PLATFORM_VISUAL_META[item.platform].clientHint}
                    onClick={() => onSelectPlatform(item.platform)}
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
                    <Plus size={12} className="fd-shelf-plus" aria-hidden="true" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
