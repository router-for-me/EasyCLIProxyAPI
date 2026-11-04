# Model fallback in agent mappings

Requires a CLIProxyAPI build implementing `routing.model-fallback` and strong
configuration ETags in the v8 management API. The installed application is not
changed by building this source tree or running its browser preview.

## Agent Configuration

Open **Agent Configuration**, select a local client, then open **Model mappings**
(or its default model picker). Each supported picker offers **Model fallbacks**.

1. Select the primary model.
2. Open **Model fallbacks** and add the alternate models.
3. Use the up/down buttons to order the alternatives. Models may use different
   providers. Remove an alternative with the delete button.
4. Click **Use this chain**. This prepares an isolated core route, enables the
   global fallback feature, and selects the route in the client configuration
   draft. It does not yet change the local client's files.
5. Apply the client configuration using its existing configuration action.

Claude Code has independent Sonnet, Opus, Fable, and Haiku chains. Claude Desktop
has a chain for each configured model entry. Other clients use the same editor
for their configured default model. This applies to requests sent through CPA;
clients using a native provider connection bypass the proxy and its fallback.

## Conditions and maximum hops

The **Routing → Model fallback** panel manages the global eligibility conditions,
maximum hops, and explicit model chains. These remain authoritative for agent
mappings. Saving a mapping preserves the existing conditions and maximum hops.
If its chain needs more hops, increase **Maximum hops** in Routing first.
An explicit empty conditions list matches no failures.

The core finishes its existing credential retries before trying an alternate
model. HTTP 400/401/403/404/413/422 do not trigger fallback. A stream never changes
model after client output starts. Requests with chains defer pre-first-token
heartbeats until bootstrap completes.

## Isolation and persistence

An agent mapping uses an immutable `claude-cpa-fallback-...` alias. Its fingerprint
includes the client, slot, primary model, and ordered alternatives. Changing one
mapping creates a new alias instead of changing a route still used by another
client or by an already-running process. Alias ownership and the public primary
model are recorded in the existing model `display-name` field.

The native command reads the current v8 YAML with its strong ETag and writes the
alias entries and fallback chain in one conditional `PUT /config.yaml` using
`If-Match`. A stale draft is rejected without overwriting the newer configuration.
The generated alias keeps matching explicit credential sources and OAuth aliases,
including upstream-model pools. Unrelated credentials, payload rules, aliases,
and policy fields are preserved.

Removing all alternatives selects the public primary again without changing the
core configuration. Old immutable aliases remain so previously applied client
configurations continue to work. They are not automatically garbage-collected.
Global Routing-panel saves use a preflight stale-draft check; its existing frontend
transport does not expose ETag headers, so those saves are not atomic with an
external editor.

## Scope and limitations

- The core disables model fallback for Home dispatch and forced-provider routes.
- API-key sources must have explicit matching model entries. The app refuses to
  infer a provider or replace an implicit model catalog to create a scoped alias.
  OAuth sources can use model definitions provided by the core.
- Thinking, context-window support, tool support, and native continuation IDs may
  differ between models. Selecting a fallback does not make those capabilities
  interchangeable. Unsupported requests fail normally.
- Core and desktop app are separate builds. Replacing only `cli-proxy-api` enables
  YAML/API configuration but does not add new controls to an older installed UI.

## Development verification

```bash
bun run check
bun test tests/agentModelFallback.test.ts tests/modelFallback.test.tsx tests/routingPage.test.tsx
bun run build
cargo test --manifest-path src-tauri/Cargo.toml --locked agents::model_fallback::tests
```

Browser regression (with a development server on port 5174):

```bash
AGENT_UI_BASE_URL=http://127.0.0.1:5174 node tests/agent-model-fallback-ui.cjs
```

Set `PLAYWRIGHT_MODULE` if Playwright is installed outside this project.
The browser preview uses demo state, never installed credentials or client files.
