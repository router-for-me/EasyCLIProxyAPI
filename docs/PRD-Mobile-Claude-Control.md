# Tim's AI Hub: Mobile Claude Control

**Status:** Draft for product review, not approved for implementation  
**Owner:** Tim McClain  
**Date:** October 2, 2026  
**Platform:** Personal EasyCLIProxyAPI fork, Windows host, mobile web app first  
**Working name:** Tim's AI Hub Remote

## 1. Product summary

Control coding work from a phone while keeping EasyCLI's model routing and account selection on the home computer. Open a project, read Claude's latest response, send instructions or a screenshot, approve a pending action, and see when work finishes.

The first priority is the user's EXISTING Claude Desktop Code conversations. Support for these is an unresolved compatibility requirement, not a promised feature. Before building the full interface, prove that an existing gateway conversation can be identified, read, and sent a prompt reliably.

If that proof fails, the alternative is an interface that manages its own Claude Code sessions through the CLI or Agent SDK. That is a different experience and requires a product decision. Do not silently substitute new sessions for existing Desktop conversations.

This PRD authorizes no implementation, deployment, account purchases, or migration. It defines the proposal for review.

## 2. Problem and intended outcome

Tim works across several projects in Claude Desktop using EasyCLI. Automatic account selection is useful, but Anthropic's built-in Remote Control excludes sessions using a non-Anthropic API host or gateway. A normal subscription login alone does not remove that restriction. [Anthropic Remote Control requirements](https://code.claude.com/docs/en/remote-control#requirements)

The desired outcome is a personal remote interface that preserves the working setup and reduces the need to return to the computer. It must make the active project, conversation, pending action, and connection state obvious. It must never claim a command was delivered or completed without evidence.

## 3. Goals and non-goals

### Goals

- Read and steer ongoing work from a phone without changing the model gateway.
- Preserve existing conversations, project files, permissions, skills, and hooks where the selected integration supports them.
- Make tasks needing attention easier to find than tasks still running.
- Support secure access outside the home Wi-Fi network.
- Recover cleanly from phone disconnection, computer sleep, and app restarts.
- Keep credentials and execution on the computer; use the phone as a controller.

### Not in the first release

- Reimplementing the entire Claude Desktop application.
- Unlocking Anthropic's native Remote Control for proxy sessions.
- Automatic migration or merging of Desktop, web, CLI, and gateway histories.
- Restoring access to Claude-hosted Docs or Artifacts merely through EasyCLI.
- Public account sharing, subscription resale, or multi-user administration.
- Raw remote terminal access, unrestricted computer control, or automatic permission bypass.
- Native iOS/Android apps, multiple execution computers, or Codex/Gemini-specific agent runtimes.

## 4. Known facts, hypotheses, and dependencies

| Item | Current evidence | Product implication |
|---|---|---|
| EasyCLI application | Existing personal fork uses React/TypeScript and Tauri; local gateway is on port 8317 | Add a Remote area and a separate host service; do not replace account management |
| Programmatic Claude Code | Official CLI/SDK supports programmatic execution, streamed output, and session continuation | Supported basis for sessions owned by our app; not proof of Desktop session interoperability |
| Desktop deep links | Official links can open sessions and prefill a prompt for review and sending | Useful navigation, not an unattended bidirectional control API |
| Existing Desktop control | No general supported read/send API established in this investigation | Requires a compatibility spike; do not advertise it as working |
| Local reader experiment | Earlier local CLI tests successfully used the existing EasyCLI connection | Narrow inference proof only; does not validate mobile access, permissions, or Desktop synchronization |
| Host availability | Work executes on the user's computer | Closing the phone is fine; a sleeping or powered-off host cannot continue work |

Documentation: [programmatic Claude Code](https://code.claude.com/docs/en/headless), [Desktop deep links](https://support.claude.com/en/articles/14729294-open-claude-desktop-with-a-link). Pin and test the actual installed versions before implementation decisions; support can change.

## 5. Integration decision and feasibility gate

### Option A: Control existing Desktop conversations

First investigate supported host integration and session mechanisms. Cross-session messaging or deep links may help, but neither should be assumed to provide transcript access, user-level prompt submission, or permission approval.

If no suitable interface exists, test an explicitly labeled experimental desktop-automation adapter. It must select a conversation by stable identity and verify that identity before every send. Screen coordinates or window titles alone are insufficient. UI automation may require an unlocked desktop and may fail when a window is hidden or minimized; characterize these conditions rather than promising unattended support.

Do not patch Claude's binaries, edit its live transcript database to inject messages, extract login tokens, or depend on undocumented private network endpoints for the MVP.

### Option B: Sessions managed by Tim's AI Hub

Run Claude Code through a supported CLI/SDK adapter. Our host service owns process lifecycle, transcripts, queued instructions, and permission responses. Route inference through the existing EasyCLI gateway.

Use normal project configuration or explicitly reproduce the required context. Do not use a minimal execution mode that silently drops CLAUDE.md, Jev hooks, MCP servers, or skills. Display unsupported Desktop-only capabilities before a session starts. Existing Desktop histories remain separate unless a tested, user-approved import is developed.

### Gate A acceptance

Use a disposable project and conversation, with no real destructive actions:

1. Identify two different existing gateway Code sessions and read their latest responses.
2. Send a unique harmless prompt to the chosen session; verify it appears exactly once in that session and observe the reply.
3. Repeat 20 sends while switching windows, changing the selected chat, and reconnecting. Require zero wrong-session sends and zero duplicate accepted prompts.
4. Test running, idle, waiting-for-permission, hidden/minimized, locked desktop, and restarted-app states. Record supported and unsupported cases.
5. Prove that sending from the phone does not create a parallel process that also writes to the same conversation.

Any wrong-session delivery fails the gate. If only visible/unlocked UI control works, present that limitation for review. If Option A fails, stop that path and request a decision on Option B rather than migrating automatically.

## 6. MVP user experience

### Desktop setup

In EasyCLI, open **Remote**. See host status, connection health, selected integration mode, paired phones, and a local **Disable remote access** action. Pair a phone through a short-lived QR invitation confirmed on the computer. Register permitted project folders. Show a capability check for each project before enabling remote tasks.

### Phone home

Use three simple views: **Needs attention**, **Running**, and **Recent**. Each task shows project, conversation title, last meaningful activity, and state. Keep a persistent connection indicator. Searching or filtering must not hide pending approvals.

### Conversation

Show a readable transcript with a sticky composer, screenshot attachment, and a clear current project/session header. Collapse routine tool activity; allow details to expand. Keep model/provider information secondary. Long code blocks and diffs must scroll without breaking the phone layout.

While a task runs, the default action is **Queue instruction**. Offer **Interrupt and send** only where the adapter has verified support. Show **Draft**, **Queued**, **Accepted**, and **Failed** distinctly. Do not label a queued message as delivered.

### Approvals and completion

An approval card explains the exact action, affected path or service, and requesting session. Approve once or reject. Closing the card, losing connection, or letting it expire never approves it. Completion shows what changed, what was tested, and any remaining blockers, rather than merely a green success badge.

Use modern restrained styling consistent with the existing app, large touch targets, clear text labels, accessible contrast, and light/dark modes. Design for 360-pixel-wide screens and one-handed use. Avoid dense desktop tables on the phone.

## 7. Functional requirements

| ID | Priority | Requirement and acceptance condition |
|---|---|---|
| FR-01 | P0 | Pair and revoke a phone. A revoked device immediately loses read and command access. |
| FR-02 | P0 | List only accessible projects/sessions, with stable identifiers and integration mode. No title-only targeting. |
| FR-03 | P0 | Stream transcript/status updates with a reconnect cursor. Reconnection restores missing events without duplicating messages. |
| FR-04 | P0 | Submit instructions with a client-generated request ID and durable acknowledgement. Repeated submission of the same ID must not launch another turn. |
| FR-05 | P0 | Provide a real permission-response path. Keep host approval rules; never replace a missing approval mechanism with auto-approval. |
| FR-06 | P0 | Preserve project context and declare capability gaps. Test one representative hook, skill, and MCP tool used by each pilot project. |
| FR-07 | P0 | Stop or interrupt supported work. Distinguish a stop request from confirmed process/tool termination; expose partial results. |
| FR-08 | P0 | Enforce one active session owner. Detect conflict with local interaction or another worker before sending/writing. |
| FR-09 | P1 | Attach PNG/JPEG screenshots up to 10 MB with a preview, upload acknowledgement, and explicit rejection of unsupported input. |
| FR-10 | P1 | Notify on completed, failed, or approval-needed tasks. In-app alerts are baseline; background push requires a separate platform feasibility test. |
| FR-11 | P1 | Display routing/account information only where EasyCLI provides evidence. Label unknown usage and API-price estimates accurately. |
| FR-12 | P1 | Export transcript and a project handoff; archive a task without deleting project work. |

P0 is required for a usable pilot. Unsupported P1 features remain visibly unavailable, not simulated.

## 8. Proposed architecture

```text
Phone browser / installed PWA
          |
          | Authenticated HTTPS over a private connection
          v
Tim's AI Hub host service on Windows
  - device pairing and authorization
  - project/session registry
  - command queue and permission broker
  - event log and transcript store
          |
          +--> A: validated Claude Desktop adapter
          |       OR
          +--> B: managed Claude Code CLI/SDK sessions
                          |
                          v
                 EasyCLI local gateway
                          |
                          v
                  Configured providers
```

The Tauri application manages setup and shows the same task state; its development server is not the remote service. Keep the host service independent of the dashboard window so closing that window need not terminate tasks. Make exit behavior explicit and verify it before relying on unattended operation.

Prefer an encrypted private network for the pilot, such as a verified Tailscale HTTPS configuration, rather than router port forwarding. Application authentication remains required. Do not expose the EasyCLI management API or provider keys to the phone. Phone commands address projects, sessions, messages, and approvals, not arbitrary shell strings.

Persist devices, projects, sessions, commands, approval requests, and ordered events in a local database. Keep an adapter-specific session reference separate from our own ID. Account switching changes inference routing, not the project or conversation identity. A single approved workspace owner is responsible for execution.

## 9. Reliability, permissions, and privacy

- **Lost acknowledgement:** look up the request ID before retrying. If Desktop accepted a prompt but confirmation is ambiguous, show delivery unknown and reconcile; never blindly resend.
- **Dropped connection:** work can continue on the host. The phone reconnects and catches up; it does not start replacement work.
- **Computer sleep/offline:** show host unavailable and last-seen time. Preserve drafts. Do not promise queued commands will execute until the host accepts them.
- **Proxy outage or exhausted accounts:** display the actual block. Resume only where safe; never replay completed shell actions just because inference was retried.
- **Approval race:** tie approval to the exact session, tool call, arguments digest, and expiry. Reject stale, duplicate, or mismatched responses.
- **Restart:** recover persisted state and reconcile live processes. Mark uncertain work interrupted; do not automatically repeat deployments, writes, or purchases.
- **Credentials:** keep provider credentials on the host. Use expiring pairing invitations and revocable device credentials stored securely. Exclude secrets from logs, URLs, exports, and notification text.
- **Browser security:** validate origins and authenticated event connections; reject forged requests and unauthorized project/session IDs. Uploaded filenames must not control filesystem paths.
- **Private content:** store transcripts locally by default. No public sharing or cloud transcript relay in the MVP. Notification previews default to project/status only. Document any push provider's data flow before enabling it.
- **Permissions:** preserve approval policies and project rules. Remote approval cannot override a policy denial. Pairing the phone does not grant blanket approval for future actions.

These are controls for an application that can execute real project actions, not optional hardening after release.

## 10. Delivery milestones and release checks

| Milestone | Deliverable | Exit condition |
|---|---|---|
| M0: Compatibility | Option A experiment and recorded support matrix; Option B evaluation if needed | Demonstrated read/send/response cycle; explicit selection of integration mode |
| M1: Host and pairing | Host service, device pairing/revocation, project/session registry | An authorized phone can read a disposable session; unpaired/revoked devices cannot |
| M2: Safe interaction | Send/queue, stream replies, approvals, interrupt, durable recovery | Reconnect, duplicate-send, stale-approval, and concurrent-owner tests pass |
| M3: Mobile pilot | PWA, screenshots, task inbox, in-app alerts | Verified on Tim's actual phone and normal off-home connection; capability gaps shown |
| M4: Hardened release | Upgrade/rollback, export, diagnostics, optional background notifications | Five real low-risk tasks completed remotely with evidence and no wrong-session actions |

Proposed performance targets, not current measurements: task list usable within two seconds on the pilot connection; accepted-message acknowledgement within one second while connected; live output shown within two seconds of host receipt. Measure app transport separately from model response time.

Required failure tests: host restart during a turn, phone disconnect after send, repeated send, wrong-session attempt, stale approval, revoked phone, locked desktop, EasyCLI outage, all accounts unavailable, and concurrent local activity. Require zero lost acknowledged commands and zero unauthorized or duplicate dispatches in the bounded test suite. Ambiguous downstream delivery must remain visible rather than counted as success.

Use disposable repositories for destructive-action tests. Do not use CrestBid production or the novel manuscript as the acceptance sandbox. No launch claim until the integrated candidate passes; a working mockup or inference call is insufficient.

## 11. Review decisions

| Decision | Proposed default |
|---|---|
| Must existing Desktop conversations be controllable in v1? | Yes for the first experiment; if unsupported, review Option B explicitly |
| First client | Mobile web/PWA, not native app |
| First host | This Windows computer, single user |
| Remote network | Private encrypted connection plus application authentication |
| Project concurrency | One active writer per workspace; isolated worktrees only where verified |
| Initial model coverage | One proven Claude route first; expand after tool/approval compatibility tests |
| Notifications | In-app first; background push after testing on the actual phone |
| Access to original claude.ai artifacts | Separate investigation, not promised by this product |

Phone platform/version, desired lock-screen behavior, and whether a separate session UI is acceptable remain open. No delivery date or cost estimate is committed until M0 establishes which integration is viable.

## 12. Definition of done for this PRD

The proposal distinguishes tested capabilities from assumptions, preserves existing Desktop work, defines an explicit compatibility gate, and provides requirements that can be demonstrated on the user's phone. Review should select the integration path and first-release scope before engineering begins.
