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
  on touch devices.
- **Files**: browse from any folder with breadcrumbs and hidden-file toggle;
  preview text, images, PDF, audio and video; rendered/raw views for Markdown,
  HTML (sandboxed), JSON, YAML, CSV and TSV; upload (button or drag and drop),
  download and delete. Open the current folder in VS Code or a shell.
  `src/samples` has files to try the previews with.
- **Quick Entry Points**: named folders per server, offered when opening it.
  `~` expands on the remote.
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

### Docker

The production image layers this fork's server and pages on the official
code-server release:

```bash
npm run build
tar -c ci/remote/Dockerfile out src/browser/pages src/images |
  docker build -t code-server-remote -f ci/remote/Dockerfile -
```

The base tag in `ci/remote/Dockerfile` must match the code-server version this
fork is based on.

## Configuration

All upstream code-server [options](https://coder.com/docs/code-server/latest/guide)
work as before. The app name defaults to `code-server-remote` (override with
`--app-name` or `CODE_SERVER_APP_NAME`).

Servers are stored in `<user-data-dir>/remote-servers.json` (mode `0600`; may
contain passwords). Remote sockets are named per launcher instance, so a test
and a production launcher on one machine don't interfere.

**Put the launcher behind code-server's password auth (the default) or another
auth layer.** Anyone who can sign in can reach every registered server.

## Tests

```bash
npm run test:unit
```

Remote-specific tests are in `test/unit/node/routes/remote.test.ts`.

## Upstream

Based on code-server by [Coder](https://coder.com). See the
[upstream docs](https://coder.com/docs/code-server/latest) for install, setup
and FAQ. Licensed under [MIT](../LICENSE).
