# Automatic updates

In **Version Management → Automatic updates**, enable the feature, select **Application**,
**Core**, or both, and save. It is off by default.

The application checks for new versions while running and downloads them using the
selected source. Verified downloads are kept across restarts and installed on the
next launch, before local services start. Changing the source, channel, or proxy
invalidates the download. Closing the application cancels unfinished downloads.

Only newer versions are installed. Core updates run first. Manual and automatic
updates cannot run at the same time. Application updates preserve the running core
on Windows and macOS. If installation fails or rolls back, use **Clear failures
and retry** before attempting the same version again.

### Desktop application version references

Every official stable or timestamped preview build carries two local version
coordinates. For the running package's own release family, its coordinate is
its installed version: final SemVer for Stable, or the release's UTC
`YYYYMMDD-HHMM` preview build number. Preview comparisons ignore the numeric
SemVer prefix required by packaging. The other coordinate is a **local
reference**, shared by all packages built from the same source and read from
`app-version-anchors.json` at build time. It is not a second installed package,
and it does not claim to be the latest release.

Maintainers can deliberately advance either anchor to a verified published
release independently when updating the comparison reference for future
builds. The initial anchors refer to GitHub releases `v0.3.112` and
`preview-20261109-1316`. An anchor lives with the source so historical rebuilds
use the same counterpart; the build and the running app never look up a remote
latest release to populate that field. Pull-request, Miaomiao and unpublished
builds are not treated as official installed families. Older packages without
embedded metadata fall back to a recognizable local package identity; otherwise
the reference is shown as unknown.

Clicking the desktop logo switches the series used for the Version Management
page's Current version and Latest version fields. Current version shows the
selected series' local coordinate. Clicking the logo does not change either
coordinate, the installed package or the configured background-update channel.
The background updater can download and install only a strictly newer build
for the running package's own family. A release from the other family can only
be installed through an explicit manual action.
