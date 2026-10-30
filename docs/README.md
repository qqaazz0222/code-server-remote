# code-server-remote

A fork of [code-server](https://github.com/coder/code-server) that turns it into
a launcher for your SSH servers. Register servers once, then open VS Code, a
shell or a file browser on any of them from the browser — desktop, tablet or
phone.

## Features

- **Server list** at `/`: servers grouped by name, online state and latency,
  connect/disconnect per server. "This computer" (SSH to `127.0.0.1`) is always
  present. The local editor stays at `/vscode`.
- **VS Code on the remote**: on first use code-server is installed on the host
  over SSH (standalone, into `~/.local`), started on a Unix socket and proxied
  through `/remote/<id>/`. The Claude Code and ChatGPT extensions are installed
  from Open VSX if missing. The editor opens in a frame under the launcher
  header; reloading reopens it.
- **Shell**: `ssh` in a local pty streamed over a WebSocket, VS Code Dark Modern
  colors, and an on-screen keyboard (including Korean 2-set) shown by default
  on touch devices. Touch keys give short vibration feedback on supported
  browsers; the phone icon beside the keyboard toggle turns it on or off and
  remembers your choice. Shift also modifies the navigation bar: tap once for
  the next key, twice to lock. Long-press an arrow for Shift/Ctrl combinations.
- **Files**: browse from any folder with breadcrumbs and hidden-file toggle;
  preview text, images, PDF, audio and video; rendered/raw views for Markdown,
  HTML (sandboxed), JSON, YAML, CSV and TSV; upload (button or drag and drop),
  download and delete. Open the current folder in VS Code or a shell.
  `src/samples` has files to try the previews with.
- **Quick Entry Points**: named folders per server, offered when opening it.
  `~` expands on the remote.
- **Task notifications**: browser alerts when Codex CLI or Claude Code finishes
  a response, including while viewing another tab. The alert identifies the
  tool, project and host, and opens the launcher when clicked.
- **AI usage**: Claude Code and Codex limits left (5-hour, weekly) per
  account in the top bar, read on This computer. See
  [AI usage](#ai-usage).
- **Auth**: SSH keys (`identityFile`) or saved passwords (via `SSH_ASKPASS`,
  OpenSSH 8.4+). Username and password can also be typed per connection
  without saving. File browsing reuses one SSH ControlMaster for 15 minutes.

## Requirements

- Launcher host: Linux with `ssh` (OpenSSH 8.4+ for password sign-in).
- Remote hosts: `sh`, `curl` (for the first-time code-server install) and GNU
  findutils (the file browser uses `find -printf`).

## Running

```bash
npm install
npm run build:vscode
npm run build
node out/node/entry.js --bind-addr 0.0.0.0:8080
```

For development, `npm run watch` instead. Source builds use the dev logo,
release builds the regular one.

### Preserve development sessions across launcher restarts

After `npm run build`, start the launcher with `CSR_SESSION_BROKER=1` to keep
remote editors, SSH connections and shell PTYs in a separate session broker.
This mode requires an existing tmux server started outside the launcher service
(for example, open a tmux session from your login shell first). Each user data
directory gets its own broker in a
`csr-sessions-<hash>` tmux session, listening on a private Unix socket under
`<user-data-dir>/session-broker/`. Authentication and origin checks still run
in the launcher before it forwards requests to that socket. Production keeps
the existing behavior unless this environment variable is explicitly enabled.

The broker survives launcher and systemd service restarts. Open WebSockets
disconnect during restart; reconnect to the launcher to reattach to the same
terminal, with its screen and running commands preserved. Sessions created
before enabling this mode cannot be transferred into the broker. The local
editor at `/vscode` remains owned by the launcher.

The broker continues running its loaded code when the launcher is rebuilt.
To update the broker itself, finish its sessions, then stop its tmux session
and restart the launcher. Stopping the broker or rebooting the host ends its
sessions. The launcher refuses to reuse an incompatible broker protocol rather
than terminating existing sessions. Do not share a user data directory between
development and production launchers.

Run `npm run build && npm run test:session-broker` to exercise launcher shutdown
and restart with real processes and PTYs and a local SSH test fixture. It checks
continued execution during downtime, terminal PID, environment and screen
recovery, retained editor connections, HTTP/WebSocket forwarding, authentication,
origin checks, private socket permissions and explicit session termination.
It runs both tmux-owned and externally managed worker modes.

### Docker

The production image layers this fork's server and pages on the official
code-server release:

```bash
npm run build
tar -c ci/remote/Dockerfile package.json out src/browser/pages src/images |
  docker build -t code-server-remote -f ci/remote/Dockerfile -
```

The base tag in `ci/remote/Dockerfile` must match the code-server version this
fork is based on.

For sessions that survive launcher container replacement, run the broker in a
separate container, sharing the same user data mount, SSH keys, workspace mounts
and network as the launcher. The launcher uses `CSR_SESSION_BROKER=1` and
`CSR_SESSION_BROKER_EXTERNAL=1`; external mode waits for the companion and never
starts an in-container tmux worker. The companion runs:

```bash
/usr/lib/code-server/lib/node /usr/lib/code-server/out/node/sessionBrokerWorker.js \
  --user-data-dir /home/coder/.local/share/code-server
```

See [the Compose overlay](../ci/remote/compose.session-broker.yaml) for a complete
example to merge into your deployment. Keep the broker image pinned and update
only the launcher's image with `docker compose up -d --no-deps code-server`.
Replacing the broker container, `docker compose down`, or rebooting the host
ends its sessions. Updating a compatible launcher alone preserves them. The
first transition from an older launcher ends sessions owned by that launcher.

## Configuration

All upstream code-server [options](https://coder.com/docs/code-server/latest/guide)
work as before. The app name defaults to `code-server-remote` (override with
`--app-name` or `CODE_SERVER_APP_NAME`).

Servers are stored in `<user-data-dir>/remote-servers.json` (mode `0600`; may
contain passwords). Remote sockets are named per launcher instance, so a test
and a production launcher on one machine don't interfere.

**Put the launcher behind code-server's password auth (the default) or another
auth layer.** Anyone who can sign in can reach every registered server.

### CLI completion notifications

1. Open **Task notifications** (the bell in the launcher header), then enable
   notifications and allow the browser permission. HTTPS or localhost is required.
2. Copy the setup command and run it on each host where the CLIs run. Python
   3.11+ is required, and the host must be able to reach the displayed launcher
   URL. An additional proxy sign-in layer must allow the publisher endpoints
   `/agent-notifications/install.py` and `/agent-notifications/complete` through
   to code-server; those endpoints require their own bearer credential.
3. Restart Codex CLI and Claude Code. Use **Test browser alert** to check browser
   delivery; the installer also prints a command to test the whole connection.

The installer updates user-level `$CODEX_HOME/config.toml` (default
`~/.codex/config.toml`) and `$CLAUDE_CONFIG_DIR/settings.json` (default
`~/.claude/settings.json`). It preserves existing hooks, chains any previous
Codex `notify` command, and keeps original settings in adjacent
`.before-agent-notifications` files. Re-running setup does not duplicate hooks.
If Claude project or managed settings override user hooks, check `/hooks` in
the CLI and allow the installed `Stop` hook.

Only completion metadata is sent: the tool, project folder name and hostname.
Prompts and response text are excluded. Notification failures do not fail the
CLI task. Credentials are stored with mode `0600` in the launcher's
`<user-data-dir>/agent-notifications-token` and the CLI host's
`~/.local/share/code-server-remote/notifications/connection.json`. Keep the setup
command private. To rotate the credential, stop the launcher, remove its token
file, restart it and re-run setup on each CLI host.

Keep a launcher tab open. Events are checked every three seconds and the latest
100 are retained in memory to cover brief disconnects. New pages start from the
current event, and launcher restarts clear the queue. Browser suspension, device
sleep and Do Not Disturb may delay or silence alerts. This does not provide Web
Push delivery after the launcher tabs close. Disabling notifications in the
dialog affects all launcher tabs for this URL in that browser.

To uninstall, remove the installed Claude `Stop` command and restore Codex's
previous `notify` value (recorded in `connection.json` as `previous_notify`), then
remove the CLI host's `notifications` directory. The original backup files can
also restore settings if no later settings changes need to be kept.

### AI usage

The top bar shows the limits of each account listed under **AI usage** (click
the bars). An account is a folder on This computer, read over its SSH login
(save its password or key) at most once a minute:

- **Codex**: its `CODEX_HOME` (default `~/.codex`). Session logs already record
  the limits.
- **Claude Code**: its `CLAUDE_CONFIG_DIR` (default `~/.claude`). Only the
  status line receives the limits, so the status line command must save them;
  add this after it reads its input into `INPUT`:

  ```sh
  USAGE_FILE="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/usage.json"
  jq -c '{rate_limits, at: (now | floor)}' <<< "$INPUT" > "$USAGE_FILE.tmp" && mv -f "$USAGE_FILE.tmp" "$USAGE_FILE"
  ```

  The file updates only while Claude Code runs; older than an hour, the bars dim.

- **cswap** ([claude-swap](https://pypi.org/project/claude-swap/)): its
  executable (e.g. `~/.local/bin/cswap`). `cswap list --json` lists every
  Claude account it manages, each shown separately.

The top bar shows each account's session (5-hour) window; the dialog shows all
windows with their reset times. A window past its reset time shows 100% left. Accounts are kept in
`<user-data-dir>/remote-usage.json`.

## Tests

```bash
npm run test:unit
```

Remote-specific tests are in `test/unit/node/routes/remote.test.ts`.
Notification API and CLI installer tests are in
`test/unit/node/routes/agentNotifications.test.ts`.

## Upstream

Based on code-server by [Coder](https://coder.com). See the
[upstream docs](https://coder.com/docs/code-server/latest) for install, setup
and FAQ. Licensed under [MIT](../LICENSE).
