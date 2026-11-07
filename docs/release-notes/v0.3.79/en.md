This release adds a "Hide disabled" toggle to the routing view so a long credential list stops burying the tiers that actually serve traffic, removes the duplicate horizontal scrollbar above the usage table, and stops running the full packaging workflow for every external pull request.

If you hit problems, tell us on [Discord](https://discord.gg/your-discord-invite) or open an issue on [GitHub](https://github.com/router-for-me/EasyCLIProxyAPI/issues).

## Added

- **Temporarily hide disabled credentials in the routing ladder**: the Routing page now has a "Hide disabled" button in its toolbar. With it on, disabled credentials are left out of the tier cards, and a tier whose members are all disabled is collapsed out of view. Tier numbering stays continuous and dragging as well as splitting keep working. The toggle is view-only: priorities, weights and the routing plan are untouched, and the choice is remembered between sessions.

## Fixed

- **Two horizontal scrollbars on request details**: the usage table rendered a second scrollbar on top of the native one at the bottom. The top scrollbar now sizes its track to fit the table content and hides itself when nothing overflows, so the two no longer fight over the same scroll position.

## Improved

- **Pull request builds are scoped to maintainers**: the packaging workflow now only runs for pull requests authored by repository maintainers, so external contributions no longer queue a full multi-platform build and formal releases get the runners sooner.