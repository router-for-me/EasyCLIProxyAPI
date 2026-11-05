- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Added

- **Preview Channel and Build Comparison**: The Versions page now has a hidden preview channel switch — tap the app logo five times in a row to toggle between stable and preview. Switching re-checks for updates on the newly selected channel immediately. For preview builds, the page leads with build time and shows both the currently installed build time and the latest build time, so you can tell at a glance whether an update is worth taking. Preview builds also carry a timestamp in their version string, which keeps successive preview releases distinguishable.
- **In-App Updates for Preview Builds**: Preview builds no longer depend on a local marker file and can update themselves through the in-app updater. Reinstalling a preview build while one is already installed is now allowed, so you no longer have to download the package by hand each time.

## Fixed

- **OpenCode Image Paste and Attachments**: Generated custom provider models in the OpenCode configuration now declare `attachment` and `modalities` metadata. Multimodal models advertise `text`, `image`, and `pdf` input, and image generation models additionally advertise `image` output. Previously, without these declarations, OpenCode treated custom provider models as text-only and blocked clipboard image pastes and PDF attachments before the request ever reached the proxy (#567).
- **Preview Update Channel**: Fixed preview builds fetching the stable latest release metadata from the GitCode source, fixed preview update manifests referencing non-versioned asset filenames and failing validation, and taught the updater backend to resolve preview channel tags correctly.
- **Bundled Core Version Management**: A manually installed core version is no longer overwritten by the bundled build on a cold restart. A new bundled core sync script verifies and synchronizes the bundled core version (currently 8.0.52) before the release build, so the bundled core no longer drifts behind upstream.
