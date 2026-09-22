## Improved

- Refined the agent management workbench layout. The client list and configuration panel now keep clearer proportions on desktop, tabs stay pinned above independently scrollable content, and narrow windows continue to use natural page scrolling.
- Improved client-list scrolling and text layout so long names, versions, and status details remain readable across window sizes.
- Made the Token trend X axis respond more smoothly to window width. Tick density now increases or decreases progressively as the window is resized, avoiding labels that stay too sparse or suddenly become crowded.
- Updated the bundled core to 7.3.12.

## Fixed

- Fixed CPA integration being unavailable when a supported client had a valid configuration file but no detected executable. Models and CPA settings can now be edited whenever the configuration exists, consistently covering WorkBuddy, Pi, and all other supported clients. Launch and restart actions remain disabled until the client is detected.
