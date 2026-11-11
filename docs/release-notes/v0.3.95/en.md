## Added

- **Tag filtering is now a single row plus a floating multi-select panel**: on both the ECPA featured page and the plugin store page the tag filter takes one line, and any remaining tags move behind a chevron at the end of the row. Opening it shows a panel above the cards where several tags can be checked at once (the results are the union of the selected tags), and the plugin grid below never gets pushed down. The panel opens upward when space is short, scrolls internally when there are many tags, and never cuts off its last row of options.

## Improved

- **The featured plugin grid now appears in one pass**: the featured page waits for both the registry and the plugin store list before rendering its cards, and shows a single centred loading placeholder in the meantime, so the grid no longer draws skeletons that fill in later.
- **Card height no longer changes with the loading state**: the install button keeps a fixed-width slot, so switching between Install, Installing and Update does not resize the card, and the inline "loading the plugin list" strip is gone.
- **The plugin store page now matches the featured page**: store cards use the same structure (icon, name and ID, version badge in the top right, description, author and licence, tags, then a divider and the action row), with the same Copy plugin ID, Open link and primary action on the right. The store toolbar is now a single row of search, development guide and refresh, only one button more than the featured page; the wrap-prone status dropdown, check updates and local install controls were removed from it.
- **The plugins-disabled notice is a short toolbar pill**: instead of a full-width banner breaking up the page, a global disable now shows as a compact note in the toolbar with the full sentence in its tooltip.

## Fixed

- **Reverse proxy settings were lost after a restart**: the settings were only written into the kernel configuration, which is regenerated on every kernel start and could overwrite them. They are now stored in the GUI configuration, and saving also updates the in-memory state so an unrelated configuration save cannot serialize them away.
- **Reverse proxy settings were lost while migrating between the kernel and GUI configurations**: the migration now updates the file and the in-memory state in the same step, removes the kernel copy only after both writes succeed, and keeps the original values for a retry when a write fails.
- **Stale reverse proxy start errors**: a successful start now clears an earlier bind or restore error, so a running listener is never shown next to an old failure.
