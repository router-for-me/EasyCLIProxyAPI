//! Multi-account request concurrency pool with priority tiers, routing
//! strategies, async slot queuing, and per-(account, model) cooldown tracking.
//! API traffic admission is decoupled from interactive UI operations while
//! still protecting accounts undergoing destructive/credential mutations.
use super::*;
use std::collections::BTreeSet;
use std::sync::atomic::{AtomicU64, AtomicUsize};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub(super) const DEFAULT_MAX_GLOBAL_CONCURRENCY: usize = 16;
pub(super) const MIN_GLOBAL_CONCURRENCY: usize = 1;
pub(super) const MAX_GLOBAL_CONCURRENCY: usize = 128;
pub(super) const DEFAULT_QUEUE_WAIT_MS: u64 = 3000;
pub(super) const MAX_QUEUE_WAIT_MS: u64 = 60_000;
pub(super) const DEFAULT_MAX_FAILOVER_ATTEMPTS: usize = 2;
pub(super) const MAX_FAILOVER_ATTEMPTS: usize = 8;
pub(super) const DEFAULT_COOLDOWN_BASE_SECS: u64 = 60;
pub(super) const MIN_COOLDOWN_BASE_SECS: u64 = 5;
pub(super) const MAX_COOLDOWN_BASE_SECS: u64 = 3600;
pub(super) const DEFAULT_COOLDOWN_MAX_SECS: u64 = 600;
pub(super) const MIN_COOLDOWN_MAX_SECS: u64 = 10;
pub(super) const MAX_COOLDOWN_MAX_SECS: u64 = 86_400;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RoutingStrategy {
    #[default]
    RoundRobin,
    LeastBusy,
    FillFirst,
    Weighted,
}

fn default_max_global_concurrency() -> usize {
    DEFAULT_MAX_GLOBAL_CONCURRENCY
}

fn default_max_live_sessions() -> usize {
    agent::DEFAULT_MAX_LIVE
}

fn default_queue_wait_ms() -> u64 {
    DEFAULT_QUEUE_WAIT_MS
}

fn default_max_failover_attempts() -> usize {
    DEFAULT_MAX_FAILOVER_ATTEMPTS
}

fn default_cooldown_base_secs() -> u64 {
    DEFAULT_COOLDOWN_BASE_SECS
}

fn default_cooldown_max_secs() -> u64 {
    DEFAULT_COOLDOWN_MAX_SECS
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct PoolSettings {
    #[serde(alias = "account_pool")]
    pub account_pool: bool,
    #[serde(alias = "routing_strategy")]
    pub routing_strategy: RoutingStrategy,
    #[serde(
        default = "default_max_global_concurrency",
        alias = "max_global_concurrency"
    )]
    pub max_global_concurrency: usize,
    #[serde(default = "default_max_live_sessions", alias = "max_live_sessions")]
    pub max_live_sessions: usize,
    #[serde(default = "default_queue_wait_ms", alias = "queue_wait_ms")]
    pub queue_wait_ms: u64,
    #[serde(
        default = "default_max_failover_attempts",
        alias = "max_failover_attempts"
    )]
    pub max_failover_attempts: usize,
    #[serde(
        default = "default_cooldown_base_secs",
        alias = "cooldown_base_secs"
    )]
    pub cooldown_base_secs: u64,
    #[serde(
        default = "default_cooldown_max_secs",
        alias = "cooldown_max_secs"
    )]
    pub cooldown_max_secs: u64,
    #[serde(alias = "prompt_profile")]
    pub prompt_profile: bridge::PromptProfile,
}

impl Default for PoolSettings {
    fn default() -> Self {
        Self {
            account_pool: false,
            routing_strategy: RoutingStrategy::RoundRobin,
            max_global_concurrency: DEFAULT_MAX_GLOBAL_CONCURRENCY,
            max_live_sessions: agent::DEFAULT_MAX_LIVE,
            queue_wait_ms: DEFAULT_QUEUE_WAIT_MS,
            max_failover_attempts: DEFAULT_MAX_FAILOVER_ATTEMPTS,
            cooldown_base_secs: DEFAULT_COOLDOWN_BASE_SECS,
            cooldown_max_secs: DEFAULT_COOLDOWN_MAX_SECS,
            prompt_profile: bridge::PromptProfile::Append,
        }
    }
}

impl PoolSettings {
    pub(crate) fn validate(&self) -> Result<(), String> {
        if !(MIN_GLOBAL_CONCURRENCY..=MAX_GLOBAL_CONCURRENCY).contains(&self.max_global_concurrency)
        {
            return Err(format!(
                "ACP global max concurrency must be between {MIN_GLOBAL_CONCURRENCY} and {MAX_GLOBAL_CONCURRENCY}"
            ));
        }
        if !(agent::MIN_MAX_LIVE..=agent::MAX_MAX_LIVE).contains(&self.max_live_sessions) {
            return Err(format!(
                "ACP max live sessions must be between {} and {}",
                agent::MIN_MAX_LIVE,
                agent::MAX_MAX_LIVE
            ));
        }
        if self.queue_wait_ms > MAX_QUEUE_WAIT_MS {
            return Err(format!(
                "ACP queue wait timeout must be between 0 and {MAX_QUEUE_WAIT_MS} ms"
            ));
        }
        if self.max_failover_attempts > MAX_FAILOVER_ATTEMPTS {
            return Err(format!(
                "ACP failover attempts must be between 0 and {MAX_FAILOVER_ATTEMPTS}"
            ));
        }
        if !(MIN_COOLDOWN_BASE_SECS..=MAX_COOLDOWN_BASE_SECS).contains(&self.cooldown_base_secs) {
            return Err(format!(
                "ACP cooldown base must be between {MIN_COOLDOWN_BASE_SECS} and {MAX_COOLDOWN_BASE_SECS} seconds"
            ));
        }
        if !(MIN_COOLDOWN_MAX_SECS..=MAX_COOLDOWN_MAX_SECS).contains(&self.cooldown_max_secs)
            || self.cooldown_max_secs < self.cooldown_base_secs
        {
            return Err(format!(
                "ACP cooldown max must be between {} and {MAX_COOLDOWN_MAX_SECS} seconds",
                self.cooldown_base_secs.max(MIN_COOLDOWN_MAX_SECS)
            ));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AccountRoute {
    pub id: String,
    pub profile: PathBuf,
}

#[derive(Clone, Debug)]
pub(super) struct Candidate {
    pub route: AccountRoute,
    pub priority: u32,
    pub weight: u32,
    pub max_concurrency: usize,
    pub proxy_url: Option<String>,
    pub is_primary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CooldownSnapshot {
    pub model: Option<String>,
    pub reason: String,
    pub until_epoch_secs: u64,
    pub remaining_secs: u64,
    pub consecutive_failures: u32,
}

#[derive(Clone, Debug)]
struct CooldownEntry {
    until: Instant,
    until_epoch_secs: u64,
    consecutive_failures: u32,
    reason: String,
}

#[derive(Clone)]
struct ActiveSlot {
    slot_id: u64,
    cancel: Arc<AtomicBool>,
}

type ActiveMap = BTreeMap<String, Vec<ActiveSlot>>;

#[derive(Default)]
struct SchedulerState {
    active: ActiveMap,
    weighted_scores: BTreeMap<String, i64>,
    cooldowns: BTreeMap<(String, Option<String>), CooldownEntry>,
}

pub(super) struct Pool {
    inner: Mutex<SchedulerState>,
    pub root: Mutex<Option<PathBuf>>,
    settings: Mutex<PoolSettings>,
    rr_cursor: AtomicUsize,
    next_slot_id: AtomicU64,
    notify: Arc<tokio::sync::Notify>,
    stopped: AtomicBool,
}

impl Default for Pool {
    fn default() -> Self {
        Self {
            inner: Mutex::new(SchedulerState::default()),
            root: Mutex::new(None),
            settings: Mutex::new(PoolSettings::default()),
            rr_cursor: AtomicUsize::new(0),
            next_slot_id: AtomicU64::new(1),
            notify: Arc::new(tokio::sync::Notify::new()),
            stopped: AtomicBool::new(false),
        }
    }
}

impl Pool {
    pub fn settings(&self) -> PoolSettings {
        self.settings
            .lock()
            .map(|s| s.clone())
            .unwrap_or_default()
    }

    pub fn set_settings(&self, settings: PoolSettings) {
        if let Ok(mut guard) = self.settings.lock() {
            *guard = settings;
        }
        self.notify.notify_waiters();
    }

    pub fn wake_waiters(&self) {
        self.notify.notify_waiters();
    }

    pub fn mark_running(&self) {
        self.stopped.store(false, Ordering::Release);
    }

    pub fn cancel(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(inner) = self.inner.lock() {
            for slots in inner.active.values() {
                for slot in slots {
                    slot.cancel.store(true, Ordering::Release);
                }
            }
        }
        self.notify.notify_waiters();
    }

    pub fn active_count(&self) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.active.values().map(Vec::len).sum())
            .unwrap_or(0)
    }

    pub fn active_for(&self, account_id: &str) -> usize {
        self.inner
            .lock()
            .map(|inner| inner.active.get(account_id).map_or(0, Vec::len))
            .unwrap_or(0)
    }

    pub fn active_counts_by_account(&self) -> BTreeMap<String, usize> {
        let mut counts = BTreeMap::new();
        if let Ok(inner) = self.inner.lock() {
            for (account_id, slots) in &inner.active {
                if !slots.is_empty() {
                    counts.insert(account_id.clone(), slots.len());
                }
            }
        }
        counts
    }

    pub fn record_failure(
        &self,
        account_id: &str,
        model: Option<&str>,
        kind: rpc::Rejection,
    ) {
        let settings = self.settings();
        let (base_secs, reason) = match kind {
            rpc::Rejection::Quota => (settings.cooldown_base_secs, "rate_limited"),
            rpc::Rejection::Overloaded => ((settings.cooldown_base_secs / 2).max(5), "overloaded"),
            rpc::Rejection::Timeout => ((settings.cooldown_base_secs / 2).max(5), "timeout"),
            rpc::Rejection::Authentication | rpc::Rejection::Permission => {
                (settings.cooldown_max_secs, "auth_required")
            }
            rpc::Rejection::Unknown => ((settings.cooldown_base_secs / 4).max(5), "upstream_error"),
            rpc::Rejection::InvalidRequest => return,
        };
        let key = (
            account_id.to_string(),
            match kind {
                rpc::Rejection::Authentication | rpc::Rejection::Permission => None,
                _ => model.map(str::to_owned),
            },
        );
        let now = Instant::now();
        let now_epoch = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if let Ok(mut inner) = self.inner.lock() {
            let failures = inner
                .cooldowns
                .get(&key)
                .map(|entry| entry.consecutive_failures.saturating_add(1))
                .unwrap_or(1);
            let exp = 1_u64.checked_shl(failures.saturating_sub(1).min(10)).unwrap_or(u64::MAX);
            let duration_secs = base_secs
                .saturating_mul(exp)
                .min(settings.cooldown_max_secs)
                .max(1);
            inner.cooldowns.insert(
                key,
                CooldownEntry {
                    until: now + Duration::from_secs(duration_secs),
                    until_epoch_secs: now_epoch.saturating_add(duration_secs),
                    consecutive_failures: failures,
                    reason: reason.to_string(),
                },
            );
        }
        self.notify.notify_waiters();
    }

    pub fn record_spawn_failure(&self, account_id: &str) {
        self.record_failure(account_id, None, rpc::Rejection::Unknown);
    }

    pub fn record_success(&self, account_id: &str, model: Option<&str>) {
        if let Ok(mut inner) = self.inner.lock() {
            if let Some(model) = model {
                inner
                    .cooldowns
                    .remove(&(account_id.to_string(), Some(model.to_string())));
            }
            inner.cooldowns.remove(&(account_id.to_string(), None));
        }
    }

    pub fn reset_cooldown(&self, account_id: Option<&str>) {
        if let Ok(mut inner) = self.inner.lock() {
            match account_id {
                Some(target) => inner.cooldowns.retain(|(id, _), _| id != target),
                None => inner.cooldowns.clear(),
            }
        }
        self.notify.notify_waiters();
    }

    pub fn remove_account(&self, account_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.cooldowns.retain(|(id, _), _| id != account_id);
            inner.weighted_scores.remove(account_id);
        }
    }

    pub fn cooldowns_by_account(&self) -> BTreeMap<String, Vec<CooldownSnapshot>> {
        let mut result: BTreeMap<String, Vec<CooldownSnapshot>> = BTreeMap::new();
        let now = Instant::now();
        if let Ok(mut inner) = self.inner.lock() {
            inner.cooldowns.retain(|_, entry| entry.until > now);
            for ((account_id, model), entry) in &inner.cooldowns {
                let remaining_secs = entry
                    .until
                    .saturating_duration_since(now)
                    .as_secs()
                    .max(1);
                result
                    .entry(account_id.clone())
                    .or_default()
                    .push(CooldownSnapshot {
                        model: model.clone(),
                        reason: entry.reason.clone(),
                        until_epoch_secs: entry.until_epoch_secs,
                        remaining_secs,
                        consecutive_failures: entry.consecutive_failures,
                    });
            }
        }
        result
    }
}

fn is_cooled_down(
    cooldowns: &BTreeMap<(String, Option<String>), CooldownEntry>,
    account_id: &str,
    model: Option<&str>,
    now: Instant,
) -> bool {
    if cooldowns
        .get(&(account_id.to_string(), None))
        .is_some_and(|entry| entry.until > now)
    {
        return true;
    }
    if let Some(model) = model {
        if cooldowns
            .get(&(account_id.to_string(), Some(model.to_string())))
            .is_some_and(|entry| entry.until > now)
        {
            return true;
        }
    }
    false
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum AdmissionError {
    Busy,
    Disconnected,
    Stale,
    NoHealthyAccount(String),
    Cancelled,
}

fn build_candidates(
    status: &AcpStatus,
    primary: AccountRoute,
    root: Option<&Path>,
) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let Some(root_path) = root else {
        if !status.authenticated {
            return candidates;
        }
        let meta = status
            .accounts
            .iter()
            .find(|account| account.id == primary.id);
        if meta.is_some_and(|account| !account.enabled) {
            return candidates;
        }
        candidates.push(Candidate {
            route: primary,
            priority: meta.map_or(0, |a| a.priority),
            weight: meta.map_or(1, |a| a.weight.max(1)),
            max_concurrency: meta.map_or(1, |a| a.max_concurrency.max(1) as usize),
            proxy_url: meta.and_then(|a| a.proxy_url.clone()),
            is_primary: true,
        });
        return candidates;
    };

    let registry = accounts::read(root_path).ok();
    if let Some(registry) = registry {
        let mut included_primary = false;
        for account in registry.accounts {
            let is_primary = account.id == primary.id;
            if !account.enabled {
                continue;
            }
            let route_path = if is_primary {
                if status.authenticated {
                    Some(primary.profile.clone())
                } else {
                    accounts::route_profile(root_path, &account)
                }
            } else {
                accounts::route_profile(root_path, &account)
            };
            if let Some(profile) = route_path {
                if is_primary {
                    included_primary = true;
                }
                candidates.push(Candidate {
                    route: AccountRoute {
                        id: account.id,
                        profile,
                    },
                    priority: account.priority,
                    weight: account.weight.max(1),
                    max_concurrency: account.max_concurrency.max(1) as usize,
                    proxy_url: account.proxy_url,
                    is_primary,
                });
            }
        }
        if !included_primary && status.authenticated {
            // Only fall back to primary when it wasn't explicitly disabled in registry.
            let explicitly_disabled = status
                .accounts
                .iter()
                .any(|a| a.id == primary.id && !a.enabled);
            if !explicitly_disabled {
                candidates.insert(
                    0,
                    Candidate {
                        route: primary,
                        priority: 0,
                        weight: 1,
                        max_concurrency: 1,
                        proxy_url: None,
                        is_primary: true,
                    },
                );
            }
        }
    } else if status.authenticated {
        candidates.push(Candidate {
            route: primary,
            priority: 0,
            weight: 1,
            max_concurrency: 1,
            proxy_url: None,
            is_primary: true,
        });
    }
    candidates
}

#[allow(clippy::too_many_arguments)]
fn select<'a>(
    candidates: &'a [Candidate],
    inner: &mut SchedulerState,
    settings: &PoolSettings,
    rr_cursor: &AtomicUsize,
    pinned: Option<&AccountRoute>,
    model: Option<&str>,
    excluded: &BTreeSet<String>,
    operating: &BTreeSet<String>,
    runtime: &BTreeMap<String, AccountRuntime>,
    now: Instant,
) -> Result<&'a Candidate, AdmissionError> {
    inner.cooldowns.retain(|_, entry| entry.until > now);
    let total_active: usize = inner.active.values().map(Vec::len).sum();

    if let Some(pin) = pinned {
        let candidate = candidates
            .iter()
            .find(|c| c.route == *pin)
            .ok_or(AdmissionError::Stale)?;
        if operating.contains(&pin.id) {
            return Err(AdmissionError::Busy);
        }
        let account_active = inner.active.get(&pin.id).map_or(0, Vec::len);
        if total_active >= settings.max_global_concurrency
            || account_active >= candidate.max_concurrency
        {
            return Err(AdmissionError::Busy);
        }
        return Ok(candidate);
    }

    // Filter out structurally ineligible, auth-failed, model-incompatible, or cooled-down accounts.
    let mut healthy = Vec::new();
    let mut saw_cooled_down = false;
    let mut saw_auth_required = false;
    for candidate in candidates {
        let id = &candidate.route.id;
        if excluded.contains(id) {
            continue;
        }
        if operating.contains(id) {
            continue;
        }
        if let Some(rt) = runtime.get(id) {
            if rt.auth_state == AccountAuthState::AuthRequired {
                saw_auth_required = true;
                continue;
            }
            if let Some(requested_model) = model {
                if !rt.models.is_empty() && !model_supported(&rt.models, requested_model) {
                    continue;
                }
            }
        }
        if is_cooled_down(&inner.cooldowns, id, model, now) {
            saw_cooled_down = true;
            continue;
        }
        healthy.push(candidate);
    }

    if healthy.is_empty() {
        if saw_cooled_down {
            return Err(AdmissionError::NoHealthyAccount(
                "All eligible ACP accounts are currently cooling down".into(),
            ));
        }
        if saw_auth_required {
            return Err(AdmissionError::NoHealthyAccount(
                "All eligible ACP accounts require re-authentication".into(),
            ));
        }
        if !excluded.is_empty() {
            return Err(AdmissionError::NoHealthyAccount(
                "No additional healthy ACP accounts remain for failover".into(),
            ));
        }
        return Err(AdmissionError::Disconnected);
    }

    if total_active >= settings.max_global_concurrency {
        return Err(AdmissionError::Busy);
    }

    let available: Vec<&Candidate> = healthy
        .into_iter()
        .filter(|candidate| {
            inner
                .active
                .get(&candidate.route.id)
                .map_or(0, Vec::len)
                < candidate.max_concurrency
        })
        .collect();

    if available.is_empty() {
        return Err(AdmissionError::Busy);
    }

    // Choose from the highest priority tier (lowest priority integer) that has free capacity.
    let min_priority = available.iter().map(|c| c.priority).min().unwrap_or(0);
    let tier: Vec<&Candidate> = available
        .into_iter()
        .filter(|c| c.priority == min_priority)
        .collect();

    match settings.routing_strategy {
        RoutingStrategy::FillFirst => Ok(tier
            .iter()
            .copied()
            .find(|c| c.is_primary)
            .unwrap_or(tier[0])),
        RoutingStrategy::RoundRobin => {
            let idx = rr_cursor.fetch_add(1, Ordering::Relaxed) % tier.len();
            Ok(tier[idx])
        }
        RoutingStrategy::LeastBusy => {
            let start = rr_cursor.fetch_add(1, Ordering::Relaxed) % tier.len();
            let mut best = tier[start];
            let score = |c: &Candidate| -> (usize, usize) {
                let active = inner.active.get(&c.route.id).map_or(0, Vec::len);
                let ratio = active.saturating_mul(10_000) / c.max_concurrency.max(1);
                (ratio, active)
            };
            let mut best_score = score(best);
            for offset in 1..tier.len() {
                let candidate = tier[(start + offset) % tier.len()];
                let candidate_score = score(candidate);
                if candidate_score < best_score {
                    best = candidate;
                    best_score = candidate_score;
                }
            }
            Ok(best)
        }
        RoutingStrategy::Weighted => {
            let total_weight: i64 = tier.iter().map(|c| i64::from(c.weight.max(1))).sum();
            let mut best_idx = 0_usize;
            let mut best_score = i64::MIN;
            for (idx, candidate) in tier.iter().enumerate() {
                let entry = inner
                    .weighted_scores
                    .entry(candidate.route.id.clone())
                    .or_insert(0);
                *entry += i64::from(candidate.weight.max(1));
                if *entry > best_score {
                    best_score = *entry;
                    best_idx = idx;
                }
            }
            let chosen = tier[best_idx];
            if let Some(score) = inner.weighted_scores.get_mut(&chosen.route.id) {
                *score -= total_weight;
            }
            Ok(chosen)
        }
    }
}

fn model_supported(models: &[AcpModel], target: &str) -> bool {
    let bare = target.strip_prefix("acp/").unwrap_or(target);
    models.iter().any(|model| {
        model.id == bare || model.reasoning_variants.values().any(|variant| variant == bare)
    })
}

pub(super) struct Guard<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
    slot_id: u64,
    pub account: AccountRoute,
    pub proxy_url: Option<String>,
    pub cancel: Arc<AtomicBool>,
}

impl<R: tauri::Runtime> Drop for Guard<R> {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        let state = self.app.state::<AcpState>();
        if let Ok(mut inner) = state.request_pool.inner.lock() {
            if let Some(slots) = inner.active.get_mut(&self.account.id) {
                slots.retain(|slot| slot.slot_id != self.slot_id);
                if slots.is_empty() {
                    inner.active.remove(&self.account.id);
                }
            }
        }
        state.request_pool.notify.notify_waiters();
    }
}

fn try_begin_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pinned: Option<&AccountRoute>,
    model: Option<&str>,
    excluded: &BTreeSet<String>,
) -> Result<(Guard<R>, AcpStatus), AdmissionError> {
    let state = app.state::<AcpState>();
    if state.request_pool.stopped.load(Ordering::Acquire) {
        return Err(AdmissionError::Cancelled);
    }
    let status = state
        .status
        .lock()
        .map_err(|_| AdmissionError::Disconnected)?
        .clone();
    let root = state
        .request_pool
        .root
        .lock()
        .map_err(|_| AdmissionError::Disconnected)?
        .clone();
    if !status.upstream_enabled {
        return Err(AdmissionError::Disconnected);
    }
    if root.is_none() && !status.authenticated {
        return Err(AdmissionError::Disconnected);
    }
    let profile = PathBuf::from(&status.profile);
    if !profile.is_absolute() && root.is_none() {
        return Err(AdmissionError::Disconnected);
    }
    let primary = AccountRoute {
        id: status.active_account.clone(),
        profile,
    };
    let candidates = build_candidates(&status, primary, root.as_deref());
    if candidates.is_empty() {
        return Err(if pinned.is_some() {
            AdmissionError::Stale
        } else {
            AdmissionError::Disconnected
        });
    }
    let settings = state.request_pool.settings();
    let operating = state
        .operating_accounts
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();
    let runtime = state
        .account_runtime
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default();

    let mut inner = state
        .request_pool
        .inner
        .lock()
        .map_err(|_| AdmissionError::Disconnected)?;
    let chosen = select(
        &candidates,
        &mut inner,
        &settings,
        &state.request_pool.rr_cursor,
        pinned,
        model,
        excluded,
        &operating,
        &runtime,
        Instant::now(),
    )?
    .clone();
    let cancel = Arc::new(AtomicBool::new(false));
    let slot_id = state
        .request_pool
        .next_slot_id
        .fetch_add(1, Ordering::Relaxed);
    inner
        .active
        .entry(chosen.route.id.clone())
        .or_default()
        .push(ActiveSlot {
            slot_id,
            cancel: cancel.clone(),
        });
    Ok((
        Guard {
            app: app.clone(),
            slot_id,
            account: chosen.route,
            proxy_url: chosen.proxy_url,
            cancel,
        },
        status,
    ))
}

pub(super) async fn acquire_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pinned: Option<&AccountRoute>,
    model: Option<&str>,
    excluded: &BTreeSet<String>,
) -> Result<(Guard<R>, AcpStatus), AdmissionError> {
    let wait_ms = app.state::<AcpState>().request_pool.settings().queue_wait_ms;
    let deadline = (wait_ms > 0).then(|| Instant::now() + Duration::from_millis(wait_ms));
    let notify = app.state::<AcpState>().request_pool.notify.clone();
    loop {
        // Register notified future before attempting acquisition so no wakeup is lost.
        let notified = notify.notified();
        match try_begin_request(app, pinned, model, excluded) {
            Ok(admitted) => return Ok(admitted),
            Err(AdmissionError::Busy) => {
                let Some(deadline) = deadline else {
                    return Err(AdmissionError::Busy);
                };
                let now = Instant::now();
                if now >= deadline {
                    return Err(AdmissionError::Busy);
                }
                let remaining = deadline.saturating_duration_since(now);
                let _ = tokio::time::timeout(remaining, notified).await;
            }
            Err(other) => return Err(other),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(id: &str, priority: u32, weight: u32, max_concurrency: usize, is_primary: bool) -> Candidate {
        Candidate {
            route: AccountRoute {
                id: id.into(),
                profile: PathBuf::from(id),
            },
            priority,
            weight,
            max_concurrency,
            proxy_url: None,
            is_primary,
        }
    }

    #[test]
    fn pool_limits_global_occupancy_and_never_reroutes_a_pinned_turn() {
        let mut settings = PoolSettings::default();
        settings.max_global_concurrency = 4;
        settings.routing_strategy = RoutingStrategy::FillFirst;
        let candidates = (0..6)
            .map(|id| candidate(&id.to_string(), 0, 1, 1, id == 0))
            .collect::<Vec<_>>();
        let mut inner = SchedulerState::default();
        let rr = AtomicUsize::new(0);
        let empty_set = BTreeSet::new();
        let empty_rt = BTreeMap::new();
        let now = Instant::now();

        for (idx, c) in candidates[..4].iter().enumerate() {
            let chosen = select(
                &candidates,
                &mut inner,
                &settings,
                &rr,
                None,
                None,
                &empty_set,
                &empty_set,
                &empty_rt,
                now,
            )
            .unwrap();
            assert_eq!(chosen.route, c.route);
            inner.active.entry(c.route.id.clone()).or_default().push(ActiveSlot {
                slot_id: idx as u64,
                cancel: Arc::new(AtomicBool::new(false)),
            });
            assert_eq!(
                select(
                    &candidates,
                    &mut inner,
                    &settings,
                    &rr,
                    Some(&c.route),
                    None,
                    &empty_set,
                    &empty_set,
                    &empty_rt,
                    now,
                )
                .unwrap_err(),
                AdmissionError::Busy
            );
        }
        assert_eq!(
            select(
                &candidates,
                &mut inner,
                &settings,
                &rr,
                None,
                None,
                &empty_set,
                &empty_set,
                &empty_rt,
                now,
            )
            .unwrap_err(),
            AdmissionError::Busy
        );
        inner.active.remove(&candidates[0].route.id);
        assert_eq!(
            select(
                &candidates[..1],
                &mut inner,
                &settings,
                &rr,
                Some(&candidates[1].route),
                None,
                &empty_set,
                &empty_set,
                &empty_rt,
                now,
            )
            .unwrap_err(),
            AdmissionError::Stale
        );
        assert_eq!(
            select(
                &candidates,
                &mut inner,
                &settings,
                &rr,
                Some(&candidates[4].route),
                None,
                &empty_set,
                &empty_set,
                &empty_rt,
                now,
            )
            .unwrap()
            .route,
            candidates[4].route
        );
    }

    #[test]
    fn routing_strategies_priority_tiers_and_per_model_cooldowns_work() {
        let empty_set = BTreeSet::new();
        let empty_rt = BTreeMap::new();
        let now = Instant::now();
        let rr = AtomicUsize::new(0);

        // Round-robin within priority 0, spilling to priority 1 when tier 0 is saturated.
        let candidates = vec![
            candidate("a", 0, 1, 2, true),
            candidate("b", 0, 1, 2, false),
            candidate("backup", 1, 1, 2, false),
        ];
        let mut settings = PoolSettings::default();
        settings.routing_strategy = RoutingStrategy::RoundRobin;
        let mut inner = SchedulerState::default();
        let first = select(&candidates, &mut inner, &settings, &rr, None, Some("m1"), &empty_set, &empty_set, &empty_rt, now).unwrap().route.id.clone();
        let second = select(&candidates, &mut inner, &settings, &rr, None, Some("m1"), &empty_set, &empty_set, &empty_rt, now).unwrap().route.id.clone();
        assert_ne!(first, second);
        assert!(first == "a" || first == "b");
        assert!(second == "a" || second == "b");

        // Cool down both tier-0 accounts for m1 -> must spill to backup for m1, but still use tier 0 for m2!
        for id in ["a", "b"] {
            inner.cooldowns.insert(
                (id.into(), Some("m1".into())),
                CooldownEntry {
                    until: now + Duration::from_secs(60),
                    until_epoch_secs: 9999999999,
                    consecutive_failures: 1,
                    reason: "rate_limited".into(),
                },
            );
        }
        assert_eq!(
            select(&candidates, &mut inner, &settings, &rr, None, Some("m1"), &empty_set, &empty_set, &empty_rt, now).unwrap().route.id,
            "backup"
        );
        let for_m2 = select(&candidates, &mut inner, &settings, &rr, None, Some("m2"), &empty_set, &empty_set, &empty_rt, now).unwrap().route.id.clone();
        assert!(for_m2 == "a" || for_m2 == "b");

        // Weighted routing distributes proportionally (weight 3 vs 1 -> 3:1 over 4 picks).
        inner.cooldowns.clear();
        settings.routing_strategy = RoutingStrategy::Weighted;
        let weighted = vec![
            candidate("heavy", 0, 3, 4, true),
            candidate("light", 0, 1, 4, false),
        ];
        let mut heavy_count = 0;
        let mut light_count = 0;
        for _ in 0..8 {
            let id = select(&weighted, &mut inner, &settings, &rr, None, None, &empty_set, &empty_set, &empty_rt, now).unwrap().route.id.clone();
            if id == "heavy" { heavy_count += 1; } else { light_count += 1; }
        }
        assert_eq!(heavy_count, 6);
        assert_eq!(light_count, 2);

        // LeastBusy picks lowest utilization ratio.
        settings.routing_strategy = RoutingStrategy::LeastBusy;
        inner.active.insert("heavy".into(), vec![ActiveSlot { slot_id: 1, cancel: Arc::new(AtomicBool::new(false)) }]);
        assert_eq!(
            select(&weighted, &mut inner, &settings, &rr, None, None, &empty_set, &empty_set, &empty_rt, now).unwrap().route.id,
            "light"
        );
    }

    #[test]
    fn cooldown_exponential_backoff_and_reset_work() {
        let pool = Pool::default();
        let mut settings = PoolSettings::default();
        settings.cooldown_base_secs = 30;
        settings.cooldown_max_secs = 100;
        pool.set_settings(settings);

        pool.record_failure("acc1", Some("m1"), rpc::Rejection::Quota);
        let snap1 = pool.cooldowns_by_account();
        assert_eq!(snap1["acc1"].len(), 1);
        assert_eq!(snap1["acc1"][0].consecutive_failures, 1);
        assert!(snap1["acc1"][0].remaining_secs <= 30 && snap1["acc1"][0].remaining_secs >= 29);

        pool.record_failure("acc1", Some("m1"), rpc::Rejection::Quota);
        let snap2 = pool.cooldowns_by_account();
        assert_eq!(snap2["acc1"][0].consecutive_failures, 2);
        assert!(snap2["acc1"][0].remaining_secs <= 60 && snap2["acc1"][0].remaining_secs >= 59);

        pool.record_failure("acc1", Some("m1"), rpc::Rejection::Quota);
        let snap3 = pool.cooldowns_by_account();
        assert_eq!(snap3["acc1"][0].consecutive_failures, 3);
        assert!(snap3["acc1"][0].remaining_secs <= 100 && snap3["acc1"][0].remaining_secs >= 99);

        pool.record_success("acc1", Some("m1"));
        assert!(pool.cooldowns_by_account().is_empty());

        pool.record_failure("acc1", Some("m1"), rpc::Rejection::Quota);
        pool.record_failure("acc2", Some("m1"), rpc::Rejection::Quota);
        pool.reset_cooldown(Some("acc1"));
        let snap4 = pool.cooldowns_by_account();
        assert!(!snap4.contains_key("acc1"));
        assert!(snap4.contains_key("acc2"));
        pool.reset_cooldown(None);
        assert!(pool.cooldowns_by_account().is_empty());
    }
}
