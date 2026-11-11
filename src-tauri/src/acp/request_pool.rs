//! Admission is shared with interactive ACP operations. Only separately
//! authenticated, isolated profiles can provide additional request slots.
use super::*;

const MAX_REQUESTS: usize = 4;

type Active = BTreeMap<PathBuf, Arc<AtomicBool>>;

#[derive(Default)]
pub(super) struct Pool {
    active: Mutex<Active>,
    pub root: Mutex<Option<PathBuf>>,
}

impl Pool {
    pub fn cancel(&self) {
        if let Ok(active) = self.active.lock() {
            for flag in active.values() {
                flag.store(true, Ordering::Release);
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct AccountRoute {
    pub id: String,
    pub profile: PathBuf,
}

fn routes(active: AccountRoute, root: Option<&Path>) -> Vec<AccountRoute> {
    let mut candidates = vec![active];
    if let Some((root, registry)) =
        root.and_then(|root| accounts::read(root).ok().map(|registry| (root, registry)))
    {
        for account in registry.accounts {
            if account.id != candidates[0].id {
                if let Some(profile) = accounts::pool_profile(root, &account) {
                    candidates.push(AccountRoute {
                        id: account.id,
                        profile,
                    });
                }
            }
        }
    }
    candidates
}

pub(super) enum AdmissionError {
    Busy,
    Disconnected,
    Stale,
}

fn select<'a>(
    routes: &'a [AccountRoute],
    active: &Active,
    pinned: Option<&AccountRoute>,
) -> Result<&'a AccountRoute, AdmissionError> {
    if let Some(pinned) = pinned {
        if !routes.contains(pinned) {
            return Err(AdmissionError::Stale);
        }
    }
    if active.len() >= MAX_REQUESTS {
        return Err(AdmissionError::Busy);
    }
    routes
        .iter()
        .find(|route| {
            pinned.is_none_or(|pin| *route == pin) && !active.contains_key(&route.profile)
        })
        .ok_or(AdmissionError::Busy)
}

pub(super) struct Guard<R: tauri::Runtime> {
    app: tauri::AppHandle<R>,
    pub account: AccountRoute,
    pub cancel: Arc<AtomicBool>,
}

impl<R: tauri::Runtime> Drop for Guard<R> {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        let state = self.app.state::<AcpState>();
        let Ok(mut status) = state.status.lock() else {
            return;
        };
        let Ok(mut active) = state.request_pool.active.lock() else {
            return;
        };
        active.remove(&self.account.profile);
        if active.is_empty() {
            status.busy = false;
            status.operation.clear();
        }
    }
}

pub(super) fn begin_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    pinned: Option<&AccountRoute>,
) -> Result<(Guard<R>, AcpStatus), AdmissionError> {
    let state = app.state::<AcpState>();
    let mut status = state
        .status
        .lock()
        .map_err(|_| AdmissionError::Disconnected)?;
    if !status.upstream_enabled || !status.authenticated {
        return Err(AdmissionError::Disconnected);
    }
    if status.busy && status.operation != "request" {
        return Err(AdmissionError::Busy);
    }
    let root = state
        .request_pool
        .root
        .lock()
        .map_err(|_| AdmissionError::Disconnected)?;
    let mut active = state
        .request_pool
        .active
        .lock()
        .map_err(|_| AdmissionError::Disconnected)?;
    let profile = PathBuf::from(&status.profile);
    if !profile.is_absolute() {
        return Err(AdmissionError::Disconnected);
    }
    if status.busy && active.is_empty() {
        return Err(AdmissionError::Busy);
    }
    let primary = AccountRoute {
        id: status.active_account.clone(),
        profile,
    };
    let try_other = match pinned {
        Some(pin) => pin != &primary,
        None => active.contains_key(&primary.profile) && active.len() < MAX_REQUESTS,
    };
    let candidates = routes(primary, if try_other { root.as_deref() } else { None });
    let account = select(&candidates, &active, pinned)?.clone();
    let cancel = Arc::new(AtomicBool::new(false));
    active.insert(account.profile.clone(), cancel.clone());
    status.busy = true;
    status.operation = "request".into();
    status.error = None;
    Ok((
        Guard {
            app: app.clone(),
            account,
            cancel,
        },
        status.clone(),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pool_limits_global_occupancy_and_never_reroutes_a_pinned_turn() {
        let routes = (0..MAX_REQUESTS + 2)
            .map(|id| AccountRoute {
                id: id.to_string(),
                profile: PathBuf::from(id.to_string()),
            })
            .collect::<Vec<_>>();
        let mut active = Active::new();
        for candidate in &routes[..MAX_REQUESTS] {
            assert_eq!(select(&routes, &active, None).ok(), Some(candidate));
            active.insert(candidate.profile.clone(), Arc::new(AtomicBool::new(false)));
            assert!(matches!(
                select(&routes, &active, Some(candidate)),
                Err(AdmissionError::Busy)
            ));
        }
        assert!(matches!(
            select(&routes, &active, None),
            Err(AdmissionError::Busy)
        ));
        active.remove(&routes[0].profile);
        assert!(matches!(
            select(&routes[..1], &active, Some(&routes[1])),
            Err(AdmissionError::Stale)
        ));
        assert_eq!(
            select(&routes, &active, Some(&routes[MAX_REQUESTS])).ok(),
            Some(&routes[MAX_REQUESTS])
        );
    }
}
