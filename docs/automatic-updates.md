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
