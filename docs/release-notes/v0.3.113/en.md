If you have any questions or suggestions about the software, please reach us through the [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues) and we will get back to you as soon as possible.

## Added

- **ACP accounts can be managed**: saved accounts show a label and can be removed locally, signed out on their own or authorized again from a compact account manager, so signing one client in again no longer disturbs the others.
- **Removed accounts keep their history**: removing a saved account detaches its data instead of destroying it, and the removed data stays isolated from the accounts that remain.

## Improved

- **Account changes no longer leave a half-finished state**: an authorization attempt that is never completed is rolled back, and an account transition either completes fully or leaves the previous state untouched.

## Fixed

- **Account switching could leave a stale sign-in behind**: transitions are now fail-closed, so an authorization that fails or is cancelled no longer changes the API intent that was active before it.
