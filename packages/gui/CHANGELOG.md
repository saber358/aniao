# Changelog

## [Unreleased]

### Added

- Added anonymous feedback with optional images, explicit submission, bounded requests and preserved input after failures or closing the dialog; no account or token is required.
- Added a plugin manager for Pi packages: installed package list, curated community catalog, npm/Git/local installation and removal through the Pi package manager, plus built-in capability overview.
- Added a native goal dashboard above the composer for `pi-goal-x`: live status, task progress, current task, completion contract, usage, pause reason, expandable task tree, and pause/resume/delete controls routed through the plugin commands.
- Added inline subagent status rows with a live per-agent work step line and kept the main turn in a waiting state until active Pi subagent runs settle.
- Added subagent detail tabs with a read-only conversation transcript, work facts and output files, and made the right-side start page a regular reusable tab with multiple tabs per tool type.
- Let users scroll away from the live subagent panel while it is waiting, and simplified the waiting label.
- Added a `/` composer menu for files, plan mode, model selection, loaded skills and extension commands, with filtering and keyboard navigation.
- Added file and folder navigation to the `@` composer menu, including folder icons, Tab-to-enter and arrow-key selection.
- File and folder references now render as blue composer chips instead of raw `@"path"` text, and are expanded back into prompt paths when sending.
- Added new-file cards after completed turns, before the edited-files summary, with side-panel previews for text, Office documents, images and PDFs.
- Website links and generated HTML files now open in the side browser instead of the system browser.
- Enabled the SDK PowerShell tool in Windows sessions, so shell commands no longer depend on WSL bash being able to access Windows paths.
- Added a completed-task edited-files card with per-file addition/deletion counts, single-file and collapsible multi-file layouts.
- Added per-model custom-provider configuration with a model list and editor for context window, max output tokens, text/image inputs, structured output, mid-conversation system messages and selectable reasoning levels.
- Added low, medium, high, xhigh and max reasoning levels to the bundled `aniao` model.
- Merged model selection and thinking strength into one right-aligned composer picker with provider/model panels and an inline reasoning slider.
- Added a context-usage ring beside the composer model picker, with token totals and percentage in its tooltip.
- Added MCP server settings for the user-level `mcp.json`, including add, enable/disable and delete controls; SDK sessions now load the built-in MCP, codemode and tool-search extensions.
- Added a Skills settings view with search, scope grouping, load diagnostics and a shortcut to the user skill directory.
- Added an isolated native browser in the right workspace panel with HTTP/HTTPS and localhost navigation, history, reload/stop, title/loading/error states, explicit system-browser fallback, modal-aware layout and complete view cleanup.
- Added the Electron and Vue desktop workspace with project selection, new sessions, streaming messages, reasoning, tool results, model selection, thinking levels, API key settings, and light/dark themes.
- Added a validated AgentPort protocol, independent SDK utility process, pure session projection, reload recovery, JSONL resume, and host failure recovery.
- Added architecture checks, separate Node/Vue/test type checks, focused offline tests, and an Electron smoke workflow using a local model fixture.
- Added project session history with search, switching, native renaming, pinning, and archiving through validated desktop ports.
- Added isolated, revision-checked session drafts and atomic workspace persistence, including unsent session recovery after reloads and application restarts.
- Added SDK follow-up and steering queues with reload visibility, bounded write-ahead persistence, and manual recovery after application exits or host failures.
- Added stop behavior that withdraws pending SDK messages before cancellation, plus save-before-clear recovery into the session draft.
- Added message and code copying through a bounded, write-only desktop clipboard port, with confirmation, retry, and preserved Markdown or parsed code whitespace.
- Added native session branching from eligible user messages, with stable entry identities, source navigation, independent drafts, restart recovery, and save-before-switch failure handling.
- Added a session-bound project file selection port with native dialogs, canonical path validation, bounded relative paths, and protection against escaping links and stale results.
- Added a composer action that inserts quoted project file references into the latest session draft, preserves existing whitespace, rejects oversized merges, and restores references after session switches, reloads, and application restarts.
- Added bounded PNG selection, session-scoped atomic image storage, revision-checked draft references, model capability checks, SDK image input, and on-demand history preview transport.
- Added reusable draft and history image previews with enlargement, retry, removal, restart recovery, save-before-send behavior, and conservative draft retention after interrupted image runs.
- Added a bounded, session-bound image content import port that shares native selection decoding, atomic storage, and model capability checks.
- Added composer PNG paste and drop support with bounded file reads, drop feedback, focus recovery, batch rejection, preserved text input, and shared draft persistence.
- Added bounded project file search and selection validation ports with nested project ignore rules, cancellation, explicit incomplete results, and real path revalidation.
- Added a reusable project file search dialog with debounced queries, keyboard selection, failure retry, native selection fallback, and the same persistent draft reference path as native file selection.
- Added bounded caret reference parsing and stale-draft rejection for replacing an inline file reference through the existing validated draft path.
- Added inline file completion in the existing composer with overridable selection keys, caret restoration, composition and held-key protection, stale result cleanup, and separate browser contract type checks.
- Added JPEG selection, paste and drop with bounded frame validation before native decoding, canonical PNG persistence, and the existing draft recovery and SDK image transport.
- Added image follow-up and steering queues with immutable attachment references, FIFO projection, write-ahead recovery, active-run imports, and bounded save-before-clear draft restoration.
- Added bounded, correlated OAuth and extension dialogs with timeout, cancellation, reload visibility, stale reply rejection, and host shutdown cleanup.
- Added OAuth provider selection, device codes, browser links, manual authorization input, cancellation, logout, and token persistence through the existing Pi authentication registry and storage.
- Added portable extension selectors, confirmations, inputs, editors, notifications, statuses, and text widgets, with explicit terminal capability limits and cancellable session transition hooks.
- Added explicit virtual module loading for the bundled SDK host and real Electron coverage for extension startup prompts, session transitions, and offline OAuth persistence.
- Added multi-workspace navigation: remembered projects appear in the sidebar with their recent sessions, and switching a project or a historical session keeps drafts and the active workspace index intact.
- Added per-workspace rename, remove, and new-session actions. Renamed workspaces persist in desktop metadata; removing a workspace only drops it (and its session index) from the sidebar, not from disk.
- Added Windows NSIS packaging with electron-builder, a packaged SDK resource directory for themes, and automatic `PI_PACKAGE_DIR` resolution for installed builds.
- Added an engineering view with Git branch/status inspection, staged and unstaged file versions, Monaco side-by-side diffs, guarded stage/unstage/discard actions, line-comment feedback that can be sent to the agent, and an independent PTY terminal powered by xterm.js.
- Added Git worktree management: create an independent branch directory from an explicit starting point, list current worktrees, open one as a workspace session, and remove clean worktrees without deleting the branch.
- Added a collapsible right workspace panel with a start page, tabbed terminal, workspace-file browser, and browser links, plus a draggable boundary, maximize/collapse controls, and `Ctrl+P`, `Ctrl+\``, and `Ctrl+T` shortcuts.
- Added a read-only resource inspector page opened from the sidebar: extensions, skills, prompt templates, registered commands, and load diagnostics come from the host session snapshot, with bounded lists and source/scope/path details.
- Added a plan contract: plan mode restricts active tools to read/search operations, asks for an editable plan, and only restores the full tool set after explicit approval; rejection, abort, and completion states are projected into the session snapshot.
- Added background parallel tasks: each job runs in its own agent process, up to two run at once, excess jobs queue, records persist across restarts as interrupted rather than auto-replaying, and completed jobs can open their native session.
- Added a local automation page with interval schedules, pause/resume, catch-up or skip policy, persisted next-run and run records, failure results, system notifications, and restart/sleep behavior without automatic replay.
- Added an immediate top-of-turn running status before the first assistant chunk; the bottom elapsed-time line is shown only until final answer text starts, then hidden.
- Added a reasoning capability option for custom Providers; reasoning models expose thinking-level selection, and the bundled default Provider enables it.
- Added internal-beta in-app updates through a generic HTTP update feed: startup and periodic version checks, user-initiated downloads, shared status/progress, and restart-to-install. This channel is unsigned and unencrypted by design; it is not suitable for public distribution.
- Seeded a default custom Provider, model and credential for fresh installations and merged it into existing configurations without overriding existing providers or defaults; a marker prevents deleted defaults from returning.
- Added delete controls for all configured Providers. Custom Provider deletion removes its `models.json` entry and local credential; built-in Provider deletion removes only the local credential and can be reconfigured later.
- Added a running spinner to the left of the active session title; it appears while the session run phase is not idle and disappears when the run ends.
- Added a live thinking excerpt after the `正在分析请求` label; it follows the latest reasoning tail, updates while the model is thinking, and each process state now has its own icon.
- Added a two-level model picker in the composer: the trigger shows only the current model name, then lists configured providers and only their authenticated models.
- Added a five-section settings panel opened from the sidebar footer: account/authentication overview, theme and general preferences, provider/model management, loaded plugin resources, and current Agent configuration. The model section lists configured providers with edit actions, adds built-in or custom API providers, supports Base URL, API type, model IDs and API keys, and opens `models.json` for advanced provider definitions.
- Added atomic, session-scoped plan recovery with explicitly saved edits, original tool restoration, and interrupted states that require review before reapproval.
- Added an offline Electron workflow runner for development and packaged builds, including previous-build data recovery, Git revision protection, worktree opening, plan restart/approval, isolated background writes, provider/schedule failures, real PTY round trips, and reported child-process cleanup.
- Added a minimal Aniao startup window with light/dark themes, reduced-motion support, an isolated preload, real workbench readiness handoff, bounded exit timing, and safe cancellation during initialization.
- Added a compact blue circular download button immediately left of the sidebar Settings gear, with a white arrow and live progress ring, plus a Help menu that opens a centered version dialog with current/latest versions and explicit check, download, retry, and install actions.

### Changed

- Completed turns now collapse into a “已工作” header; expanding it reveals assistant text, reasoning and tool results in message order.
- Running turns show a “工作中” row immediately after the user message, with a live pulsing reasoning preview and a divider; completed reasoning rows show their duration.
- Tool rows use per-tool icons and include the command, path, query or skill name inline.
- Moved the engineering view into a right-side Changes tab with responsive file/diff layouts, preserving review feedback, Git operations, worktrees and terminal access; replaced the top Edit view with native editing actions, focus restoration, shortcut hints and Settings.
- Switched the desktop kernel from workspace Pi 0.80.6 sources to the pinned official Pi 1.4.0 SDK packages, migrated model/auth operations to ModelRuntime and CredentialStore, and retained official extension virtual modules and lazy runtime assets.
- Reworked the desktop shell to the DeepSeek Harness visual language: neutral palette, compact sidebar and composer, lighter message surfaces, and a single accent send action. Removed the native application menu and raised the host startup timeout to 60 seconds for cold Windows starts.
- Changed the conversation header to a DSH-style title row with settings and theme actions, plus a tab strip. The conversation is now a rounded white panel over the neutral shell, and composer focus keeps its border while deepening the shadow.
- Running turns now show one live operation row (analyzing, running a command, or calling a tool) plus a live elapsed-time line; process rows are collapsed by default and expand on click. Completed turns fold into an expandable summary with duration and action categories, separated from the answer by a divider. Clicking the completed row toggles the action-summary line; clicking that line reveals up to 12 step rows with scrolling, each rendered as an icon, label, and truncated detail.
- Renamed the desktop display to Aniao Harness and restyled the sidebar header with a centered new-session action and offline navigation icons.
- Background and scheduled jobs now create independent worktrees from the source repository HEAD, persist their actual execution directory and branch, and retain the worktree for review without importing source changes.
- Background job and schedule records now use atomic storage, preserve corrupt files, and wait for active host cleanup during shutdown.
- Application updates now require an explicit download click from the sidebar, General Settings, or Help; automatic checks only fetch metadata, and all three entry points share progress and retry state.

### Fixed

- Mutate queued messages by stable identity without replaying the live queue; reject consumed targets and late input callbacks, preserve write-ahead order, and keep edited attachments consistent with recovery.
- Restore the idle queue's recover-to-draft and clear controls, and retain edited text until the host confirms the change.
- Apply MCP saves, enable/disable and removal to the current idle session through serialized atomic writes and resource reload, with rollback on reload failure and guards for active tasks, interactions and pending plans.
- Only show the goal dashboard when the current session has a `pi-goal-focus` entry for that goal, so goals do not leak into unrelated sessions in the same project.
- Normalize renderer commands before crossing the contextBridge, so Vue reactive proxies no longer cause `An object could not be cloned` when saving custom API providers.
- Settle waiting runs when the main prompt finishes and poll subagent activity while waiting, so completed workflows cannot leave the UI stuck in settling.
- Resolve workflow child run IDs from session tool results when opening a subagent transcript, so child tabs show records instead of an empty state.
- Tie the message streaming caret to actual assistant text updates instead of the whole run, so it stops blinking while tools, subagents, or compaction are still running.
- Treat `setToolsExpanded` as a saved extension UI state, ignore terminal-only widget factories and terminal input listeners silently, preventing subagent extensions from emitting unsupported-capability warnings.
- Guard browser-view disposal when the main window is already destroyed, preventing the `Object has been destroyed` main-process error during application exit.
- Aligned the composer file and command popups to the input width and placed them above the input, and let arrow keys navigate their candidates before the prompt consumes the key.
- Aligned API picker labels with the model list and delayed provider-flyout dismissal when the pointer crosses into the menu.
- Retry loading the workbench once when the first renderer load stalls, preventing the startup page from timing out with an empty window.
- Preserve opened side tools when returning to the start page, keep native browser views clear of dialogs and resize gestures, and restore the original page when a link triggers a download.
- Prevented clipped message snapshots from being offered as complete message or code copies, and added a visible truncation notice.
- Kept the custom Provider add button clickable and replaced silent disabled validation with field-specific errors.
- Reject stale Git mutations even when file contents change without a status change; include index objects and worktree contents in the diff revision, and allow staging untracked files.
- Bind line comments to the focused diff side, line, scope, and revision, then revalidate before adding feedback to the draft.
- Open newly created worktrees as independent workspace sessions after verifying repository membership, and avoid a second new-session action after a failed open.
- Keep cancelled background jobs in the concurrency limit until their host has closed, and report model errors or incomplete results as failures.
- Preserve interrupted plans on abort or model failure, reapply read-only tools after extension initialization, and exempt plan approval from the ordinary query timeout.
- Preserve active schedule runs while pruning history and finish all shutdown cleanup even when an individual persistence operation fails.
- Close active background hosts even when shutdown storage is unwritable, and preserve corrupt job/schedule records when closing after failed initialization.
- Handle update download rejections so failures remain retryable, prevent duplicate downloads, and keep application settings and Help accessible without an active project or connected host.
