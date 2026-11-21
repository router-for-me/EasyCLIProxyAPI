## CPA instance selection and usage history

- Switch to a verified external CPA instance from the sidebar and keep using the same management pages. Routing, client keys and advanced settings target the selected server; a failed connection does not fall back to the built-in CPA.
- Usage collection follows the selected instance. Each external URL has its own history and pricing settings, separate from built-in usage. Rotating a management key no longer changes which history you see.

## ACP API access

- An optional native relay supports Responses continuations and client tool results on the original ACP session. It must be built and installed manually and is not included or enabled in the desktop packages. The integration has been verified on Linux x64.
- System instructions still use the CLI’s append mode by default. An opt-in profile sends them once as ordinary first-turn context instead. Account pooling is also opt-in; continuations stay with their original account.
