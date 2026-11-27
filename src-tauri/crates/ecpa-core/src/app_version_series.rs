//! Application update identity, independent of the package's runtime version.
use chrono::{DateTime, NaiveDate, Utc};
use semver::Version;
use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum AppVersionSeries {
    Stable,
    Preview,
}

impl AppVersionSeries {
    pub(crate) fn for_channel(channel: &str) -> Self {
        if channel == "preview" || channel.starts_with("preview-") {
            Self::Preview
        } else {
            Self::Stable
        }
    }

    pub(crate) fn accepts(self, version: &str) -> bool {
        match self {
            Self::Stable => stable_version(version).is_some(),
            Self::Preview => preview_coordinate(version).is_some(),
        }
    }

    pub(crate) fn newer(self, current: &str, candidate: &str) -> bool {
        match self {
            Self::Stable => stable_version(current)
                .zip(stable_version(candidate))
                .is_some_and(|(current, candidate)| candidate.cmp_precedence(&current).is_gt()),
            Self::Preview => preview_coordinate(current)
                .zip(preview_coordinate(candidate))
                .is_some_and(|(current, candidate)| candidate > current),
        }
    }
}

fn parse_version(version: &str) -> Option<Version> {
    Version::parse(version.trim().trim_start_matches('v')).ok()
}

fn stable_version(version: &str) -> Option<Version> {
    parse_version(version).filter(|version| version.pre.is_empty())
}

pub(crate) fn preview_stamp(stamp: &str) -> Option<DateTime<Utc>> {
    let (date, time) = stamp.split_once('-')?;
    if date.len() != 8
        || time.len() != 4
        || !date.bytes().chain(time.bytes()).all(|b| b.is_ascii_digit())
    {
        return None;
    }
    let date = NaiveDate::parse_from_str(date, "%Y%m%d").ok()?;
    Some(
        date.and_hms_opt(time[..2].parse().ok()?, time[2..].parse().ok()?, 0)?
            .and_utc(),
    )
}

/// An older named pin can still identify a preview package exactly even if it
/// predates comparable timestamped preview identifiers.
pub(crate) fn is_preview_package(version: &str) -> bool {
    parse_version(version).is_some_and(|version| {
        let suffix = version.pre.as_str();
        suffix == "preview" || suffix.starts_with("preview.")
    })
}

pub(crate) fn preview_version_stamp(version: &str) -> Option<DateTime<Utc>> {
    let version = parse_version(version)?;
    preview_stamp(version.pre.as_str().strip_prefix("preview.")?)
}

fn preview_coordinate(value: &str) -> Option<DateTime<Utc>> {
    preview_stamp(value).or_else(|| preview_version_stamp(value))
}

pub(crate) fn preview_display_coordinate(version: &str) -> Option<String> {
    preview_coordinate(version).map(|stamp| stamp.format("%Y%m%d-%H%M").to_string())
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppVersionBaselines {
    pub(crate) installed_series: Option<AppVersionSeries>,
    pub(crate) stable: Option<String>,
    pub(crate) preview: Option<String>,
}

impl AppVersionBaselines {
    pub(crate) fn from_local(
        release_family: Option<&str>,
        stable: Option<&str>,
        preview: Option<&str>,
        package_version: &str,
        legacy_portable_version: Option<&str>,
    ) -> Self {
        let stable_identity =
            |value: &str| stable_version(value).map(|_| super::normalize_version(value));
        if let Some(family) = release_family {
            let stable = stable.and_then(stable_identity);
            let preview = preview.and_then(preview_display_coordinate);
            // A counterpart coordinate never makes this executable that package family.
            let installed_series = match family {
                "stable"
                    if stable.as_deref() == stable_identity(package_version).as_deref()
                        && stable.is_some() =>
                {
                    Some(AppVersionSeries::Stable)
                }
                "preview"
                    if preview.as_deref()
                        == preview_display_coordinate(package_version).as_deref()
                        && preview.is_some()
                        && is_preview_package(package_version) =>
                {
                    Some(AppVersionSeries::Preview)
                }
                _ => None,
            };
            return Self {
                stable,
                preview,
                installed_series,
            };
        }
        // Historical preview packages encoded their coordinate in the executable.
        // A legacy stable package needs a matching local portable marker as well.
        let stable = legacy_portable_version
            .filter(|value| {
                parse_version(value)
                    .zip(parse_version(package_version))
                    .is_some_and(|(a, b)| a == b)
            })
            .and_then(stable_identity);
        let preview = preview_version_stamp(package_version)
            .map(|stamp| stamp.format("%Y%m%d-%H%M").to_string());
        let installed_series = if stable.is_some() {
            Some(AppVersionSeries::Stable)
        } else if is_preview_package(package_version) {
            Some(AppVersionSeries::Preview)
        } else {
            None
        };
        Self {
            stable,
            preview,
            installed_series,
        }
    }

    pub(crate) fn installed_baseline(&self, series: AppVersionSeries) -> Option<&str> {
        self.installed_series
            .filter(|family| *family == series)
            .and_then(|_| self.get(series))
    }

    pub(crate) fn get(&self, series: AppVersionSeries) -> Option<&str> {
        match series {
            AppVersionSeries::Stable => self.stable.as_deref(),
            AppVersionSeries::Preview => self.preview.as_deref(),
        }
    }
}
