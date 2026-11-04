- If you have any questions or suggestions about the app, please contact us through our [QQ group](https://qm.qq.com/q/3queDaIG) or [GitHub Issues](https://github.com/router-for-me/EasyCLIProxyAPI/issues). We will respond as soon as possible.

## Added

- **Card layout switch (Quota Lookup and Authentication Files)**: Both pages now have a "Card layout" switch at the top right with three arrangements, and each page remembers its own choice.
  - **Even rows** (default): every card in a row is the same height, so the action buttons line up along the bottom.
  - **Stacked**: cards are packed into columns, so a short card no longer leaves a gap under it.
  - **Compact**: one small glance card per row for scanning many accounts. Quota Lookup shows the name, the plan and a bar per limit; Authentication Files shows the name, the status, the plan and the lowest remaining quota. The arrow button expands a card to its full size.
- The layout switch is keyboard operable, including expanding and collapsing Compact cards, and the new text is available in English, Simplified Chinese, Japanese and Traditional Chinese.

## Changed

- **Quota Lookup now defaults to Even rows**: short cards, such as a failed lookup, are stretched to the height of the cards beside them instead of sitting at the top of the row. Authentication Files looks the same as before.
