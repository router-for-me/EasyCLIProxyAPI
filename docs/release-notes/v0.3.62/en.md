- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Added

- Credential Custom Tags & Batch Group Management: Added custom tag support (`tags`) for OAuth and credential accounts, with tag badges on credential cards and tag-based filtering in the account list; the batch operations dialog now supports selecting an entire group by tag to enable, disable, refresh, or delete credentials in one click ([#546](https://github.com/router-for-me/EasyCLIProxyAPI/issues/546)).

## Fixed

- Anime Theme Dropdown Misalignment & Layout Shifts: Fixed an issue where `backdrop-filter` under the Anime Light / image-backdrop theme created containing blocks that offset `AgentModelPicker` dropdowns towards the bottom-right of the screen; added containing-block `offsetParent` coordinate compensation and cleaned up abnormal margins on secondary tabs and page headings ([#543](https://github.com/router-for-me/EasyCLIProxyAPI/pull/543)).
