import { logger } from "@coder/logger"
import { ChildProcess, execFile, spawn } from "child_process"
import * as crypto from "crypto"
import { Request, Response, Router } from "express"
import { promises as fs } from "fs"
import * as http from "http"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { HttpCode, HttpError } from "../../common/http"
import { rootPath, vsRootPath } from "../constants"
import { authenticated, ensureAuthenticated, ensureOrigin, redirect, replaceTemplates } from "../http"
import { proxy as _proxy } from "../proxy"
import { wss, type WebsocketRequest } from "../wsRouter"

/**
 * SSH remote servers. Selecting a server runs code-server on that host over
 * SSH (installing it on first use) on a Unix socket, forwards the socket to a
 * local port, and proxies /remote/<id>/ to it. Alternatively a plain ssh shell
 * runs in a local pty streamed over /remote-shell/<id>.
 */

// Installed on the remote code-server from Open VSX if missing.
const REMOTE_EXTENSIONS = ["anthropic.claude-code", "openai.chatgpt"]
const READY_TIMEOUT_MS = 10 * 60 * 1000

export interface RemoteServer {
  id: string
  name: string
  host: string
  port?: number
  user?: string
  identityFile?: string
  password?: string
  folder?: string
  group?: string
  entries?: EntryPoint[]
}

/** A named folder to start in, picked when opening a server. */
export interface EntryPoint {
  name: string
  path: string
}

interface Session {
  proc: ChildProcess
  port: number
  ready: Promise<void>
  log: string[]
  /** Remote $HOME, for expanding ~ in ?folder=. */
  home?: string
}

// Always present: SSH into this machine. Account and password are asked on connect.
const DEFAULT_SERVER: RemoteServer = { id: "local", name: "This computer", host: "127.0.0.1", group: "Local" }

const sessions = new Map<string, Session>()

process.on("exit", () => sessions.forEach((s) => s.proc.kill()))

const storePath = (req: Request) => path.join(req.args["user-data-dir"], "remote-servers.json")

async function readServers(req: Request): Promise<RemoteServer[]> {
  try {
    const servers: RemoteServer[] = JSON.parse(await fs.readFile(storePath(req), "utf8"))
    return servers.some((s) => s.id === DEFAULT_SERVER.id) ? servers : [DEFAULT_SERVER, ...servers]
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return [DEFAULT_SERVER]
    }
    throw error
  }
}

async function writeServers(req: Request, servers: RemoteServer[]): Promise<void> {
  // May contain passwords.
  await fs.writeFile(storePath(req), JSON.stringify(servers, null, 2), { mode: 0o600 })
}

async function getServer(req: Request): Promise<RemoteServer> {
  const server = (await readServers(req)).find((s) => s.id === req.params.id)
  if (!server) {
    throw new HttpError("Server not found", HttpCode.NotFound)
  }
  return server
}

/** Validate user input. Host and user end up as ssh arguments. */
export function parseServer(body: any, existing?: RemoteServer): RemoteServer {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const host = str(body?.host)
  const user = str(body?.user)
  const port = body?.port ? Number(body.port) : undefined
  if (!/^[\w.:[\]-]+$/.test(host) || host.startsWith("-")) {
    throw new HttpError("Invalid host", HttpCode.BadRequest)
  }
  if (user && !/^[\w.-]+$/.test(user)) {
    throw new HttpError("Invalid user", HttpCode.BadRequest)
  }
  if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) {
    throw new HttpError("Invalid port", HttpCode.BadRequest)
  }
  // An empty password keeps the saved one unless explicitly cleared.
  const password = body?.clearPassword ? "" : str(body?.password) ? body.password : existing?.password
  return {
    id: existing?.id || crypto.randomBytes(8).toString("hex"),
    name: str(body?.name) || host,
    host,
    port,
    user: user || undefined,
    identityFile: str(body?.identityFile) || undefined,
    password: password || undefined,
    folder: str(body?.folder) || undefined,
    group: str(body?.group).slice(0, 40) || undefined,
    entries: existing?.entries,
  }
}

/** Validate entry points; the path ends up quoted in a remote shell command. */
export function parseEntries(body: any): EntryPoint[] {
  if (!Array.isArray(body?.entries) || body.entries.length > 50) {
    throw new HttpError("Invalid entry points", HttpCode.BadRequest)
  }
  return body.entries.map((e: any) => {
    const name = typeof e?.name === "string" ? e.name.trim() : ""
    const path = typeof e?.path === "string" ? e.path.trim() : ""
    if (!name || name.length > 40 || !path || path.length > 1024 || /[\0\n\r]/.test(path)) {
      throw new HttpError("Invalid entry point", HttpCode.BadRequest)
    }
    return { name, path }
  })
}

/** Shell script run on the remote via `sh -s`. */
export function remoteScript(socket: string): string {
  const exts = REMOTE_EXTENSIONS.join(" ")
  return `
CS="$(command -v code-server || echo "$HOME/.local/bin/code-server")"
if [ ! -x "$CS" ]; then
  echo "Installing code-server..."
  curl -fsSL https://code-server.dev/install.sh | sh -s -- --method=standalone
fi
EXTS="$("$CS" --list-extensions 2>/dev/null)"
for ext in ${exts}; do
  echo "$EXTS" | grep -qix "$ext" || "$CS" --install-extension "$ext" || echo "Failed to install $ext"
done
SETTINGS="\${XDG_DATA_HOME:-$HOME/.local/share}/code-server/User/settings.json"
if [ ! -e "$SETTINGS" ]; then
  mkdir -p "$(dirname "$SETTINGS")"
  echo '{ "workbench.colorTheme": "Default Dark Modern" }' > "$SETTINGS"
fi
echo "CS_REMOTE_HOME=$HOME"
rm -f '${socket}'
exec "$CS" --auth none --socket '${socket}' --socket-mode 600 --disable-update-check
`
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = net.createServer()
    srv.on("error", reject)
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port
      srv.close(() => resolve(port))
    })
  })

const healthy = (port: number) =>
  new Promise<boolean>((resolve) => {
    http
      .get({ host: "127.0.0.1", port, path: "/healthz", timeout: 2000 }, (res) => {
        res.resume()
        resolve(res.statusCode === 200)
      })
      .on("error", () => resolve(false))
      .on("timeout", function (this: http.ClientRequest) {
        this.destroy()
      })
  })

async function askpassPath(req: Request): Promise<string> {
  const p = path.join(req.args["user-data-dir"], "ssh-askpass.sh")
  await fs.writeFile(p, `#!/bin/sh\nprintf '%s\\n' "$CS_REMOTE_SSH_PASSWORD"\n`, { mode: 0o700 })
  return p
}

/** ssh arguments and environment shared by code-server and shell connections. */
async function sshCommand(
  req: Request,
  server: RemoteServer,
  extra: string[],
  command?: string,
): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const args = [
    ...extra,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    `BatchMode=${server.password ? "no" : "yes"}`,
  ]
  if (server.port) {
    args.push("-p", String(server.port))
  }
  if (server.identityFile) {
    args.push("-i", server.identityFile.replace(/^~(?=$|\/)/, process.env.HOME || "~"))
  }
  args.push("--", server.user ? `${server.user}@${server.host}` : server.host)
  if (command) {
    args.push(command)
  }

  const env: NodeJS.ProcessEnv = { ...process.env }
  if (server.password) {
    // ponytail: password via SSH_ASKPASS (OpenSSH 8.4+); keys are preferred.
    Object.assign(env, {
      SSH_ASKPASS: await askpassPath(req),
      SSH_ASKPASS_REQUIRE: "force",
      DISPLAY: env.DISPLAY || ":0",
      CS_REMOTE_SSH_PASSWORD: server.password,
    })
  }
  return { args, env }
}

/** Milliseconds to open a TCP connection, or undefined if it fails. */
export const probe = (host: string, port: number, timeout = 3000) =>
  new Promise<number | undefined>((resolve) => {
    const start = Date.now()
    const sock = net.connect({ host, port, timeout })
    sock.once("connect", () => {
      sock.destroy()
      resolve(Date.now() - start)
    })
    sock.once("timeout", () => {
      sock.destroy()
      resolve(undefined)
    })
    sock.once("error", () => resolve(undefined))
  })

/**
 * Whether the server's SSH port answers. The host may be an ssh config alias,
 * so let ssh resolve it; hosts behind a jump host can't be checked directly.
 */
async function status(server: RemoteServer): Promise<{ online: boolean | null; ms?: number }> {
  const args = ["-G", ...(server.port ? ["-p", String(server.port)] : []), "--", server.host]
  const { stdout } = await promisify(execFile)("ssh", args).catch(() => ({ stdout: "" }))
  const conf = new Map(stdout.split("\n").map((l) => [l.split(" ")[0], l.slice(l.indexOf(" ") + 1)]))
  if ([conf.get("proxyjump"), conf.get("proxycommand")].some((v) => v && v !== "none")) {
    return { online: null }
  }
  const ms = await probe(conf.get("hostname") || server.host, Number(conf.get("port")) || server.port || 22)
  return { online: ms !== undefined, ms }
}

/** Quote a remote path for sh; a leading ~ stays outside the quotes so it expands. */
export function quotePath(p: string): string {
  const [, home, rest] = /^(~(?:\/|$))?([\s\S]*)$/.exec(p)!
  return `${home ? '"$HOME"/' : ""}'${rest.replace(/'/g, "'\\''")}'`
}

/** Login shell on the remote, starting in the given folder if set. */
export function shellCommand(folder?: string): string | undefined {
  // A missing folder prints an error and the shell opens in $HOME instead of exiting.
  return folder && `cd ${quotePath(folder)}; exec "$SHELL" -l`
}

/** Credentials typed on the launcher apply to this connection only (not saved). */
function withCredentials(saved: RemoteServer, body: any): RemoteServer {
  const user = typeof body?.user === "string" ? body.user.trim() : ""
  if (user && !/^[\w.-]+$/.test(user)) {
    throw new HttpError("Invalid user", HttpCode.BadRequest)
  }
  const password = typeof body?.password === "string" ? body.password : ""
  return { ...saved, user: user || saved.user, password: password || saved.password }
}

/**
 * Per launcher instance, so two launchers (e.g. test and production) on one
 * host don't replace each other's remote sockets.
 */
const instanceId = (req: Request) =>
  crypto.createHash("sha1").update(req.args["user-data-dir"]).digest("hex").slice(0, 8)

async function connect(req: Request, server: RemoteServer): Promise<Session> {
  const existing = sessions.get(server.id)
  if (existing) {
    return existing
  }

  const port = await freePort()
  // Hex only, so safe unescaped.
  const socket = `/tmp/code-server-remote-${instanceId(req)}-${server.id}.sock`
  const { args, env } = await sshCommand(
    req,
    server,
    ["-T", "-o", "ExitOnForwardFailure=yes", "-L", `127.0.0.1:${port}:${socket}`],
    "sh -s",
  )

  logger.info(`Connecting to remote server ${server.name} (${server.host})`)
  const proc = spawn("ssh", args, { env, stdio: ["pipe", "pipe", "pipe"] })
  proc.stdin!.end(remoteScript(socket))

  const log: string[] = []
  let home: string | undefined
  const onData = (data: Buffer) => {
    for (const line of data.toString().split(/\r?\n|\r/)) {
      if (line.startsWith("CS_REMOTE_HOME=")) home = line.slice("CS_REMOTE_HOME=".length)
      else if (line) log.push(line)
    }
    log.splice(0, Math.max(0, log.length - 50))
  }
  proc.stdout!.on("data", onData)
  proc.stderr!.on("data", onData)

  let exited = false
  proc.on("error", (error) => onData(Buffer.from(error.message)))
  proc.on("close", (code) => {
    exited = true
    logger.info(`Remote server ${server.name} disconnected (exit ${code})`)
    if (sessions.get(server.id)?.proc === proc) {
      sessions.delete(server.id)
    }
  })

  const ready = (async () => {
    const deadline = Date.now() + READY_TIMEOUT_MS
    while (!(await healthy(port))) {
      if (exited) {
        throw new Error(log.slice(-15).join("\n") || "ssh exited")
      }
      if (Date.now() > deadline) {
        proc.kill()
        throw new Error("Timed out waiting for remote code-server\n" + log.slice(-15).join("\n"))
      }
      await new Promise((r) => setTimeout(r, 1000))
    }
  })()

  const session: Session = {
    proc,
    port,
    ready,
    log,
    get home() {
      return home
    },
  }
  sessions.set(server.id, session)
  return session
}

function disconnect(id: string): void {
  sessions.get(id)?.proc.kill()
  sessions.delete(id)
}

/** Launcher page and server CRUD API. */
export const router = Router()

router.get("/", async (req, res, next) => {
  // Keep old links to the local editor working.
  if (req.query.folder || req.query.workspace || req.query.ew) {
    return next()
  }
  if (!(await authenticated(req))) {
    return redirect(req, res, "login", {})
  }
  const content = await fs.readFile(path.join(rootPath, "src/browser/pages/remote.html"), "utf8")
  res.send(replaceTemplates(req, content))
})

router.use("/remote-servers", ensureAuthenticated)

router.get("/remote-servers", async (req, res) => {
  const servers = await readServers(req)
  res.json(servers.map(({ password, ...s }) => ({ ...s, hasPassword: !!password, connected: sessions.has(s.id) })))
})

router.get("/remote-servers/status", async (req, res) => {
  const servers = await readServers(req)
  const results = await Promise.all(servers.map(status))
  res.json(Object.fromEntries(servers.map((s, i) => [s.id, results[i]])))
})

router.post("/remote-servers", async (req, res) => {
  const servers = await readServers(req)
  const server = parseServer(req.body)
  await writeServers(req, [...servers, server])
  res.json({ id: server.id })
})

router.put("/remote-servers/:id", async (req, res) => {
  const servers = await readServers(req)
  const server = parseServer(req.body, await getServer(req))
  disconnect(server.id)
  await writeServers(
    req,
    servers.map((s) => (s.id === server.id ? server : s)),
  )
  res.json({ id: server.id })
})

router.put("/remote-servers/:id/entries", async (req, res) => {
  const entries = parseEntries(req.body)
  const server = await getServer(req)
  await writeServers(
    req,
    (await readServers(req)).map((s) => (s.id === server.id ? { ...s, entries } : s)),
  )
  res.json({ entries })
})

router.delete("/remote-servers/:id", async (req, res) => {
  if (req.params.id === DEFAULT_SERVER.id) {
    throw new HttpError("The default server cannot be deleted", HttpCode.BadRequest)
  }
  disconnect(req.params.id)
  await writeServers(
    req,
    (await readServers(req)).filter((s) => s.id !== req.params.id),
  )
  res.json({})
})

router.post("/remote-servers/:id/connect", async (req, res) => {
  const server = withCredentials(await getServer(req), req.body)
  try {
    await (
      await connect(req, server)
    ).ready
  } catch (error: any) {
    disconnect(server.id)
    throw new HttpError(error.message, HttpCode.ServerError)
  }
  res.json({})
})

/** Stats about this machine for the dashboard widgets. */
const cpuTimes = () =>
  os
    .cpus()
    .reduce(
      (acc, { times: t }) => ({ idle: acc.idle + t.idle, total: acc.total + t.user + t.nice + t.sys + t.idle + t.irq }),
      { idle: 0, total: 0 },
    )
let lastCpu = cpuTimes()
// Container bridges and veths clutter the IP list.
const VIRTUAL_IF = /^(docker|br-|veth|virbr)/

router.get("/system-info", ensureAuthenticated, async (_req, res) => {
  const cpu = cpuTimes()
  const elapsed = cpu.total - lastCpu.total
  const usage = elapsed > 0 ? 1 - (cpu.idle - lastCpu.idle) / elapsed : 0
  lastCpu = cpu
  // MemAvailable counts reclaimable cache as free, unlike os.freemem().
  const meminfo = await fs.readFile("/proc/meminfo", "utf8").catch(() => "")
  const available = Number(/MemAvailable:\s+(\d+)/.exec(meminfo)?.[1]) * 1024 || os.freemem()
  const disk = await fs.statfs(os.homedir()).catch(() => undefined)
  // Byte counters since boot of the default-route interface (tunnels like
  // tailscale ride on it, so summing interfaces would double count).
  const route = await fs.readFile("/proc/net/route", "utf8").catch(() => "")
  const iface = route
    .split("\n")
    .find((l) => l.split("\t")[1] === "00000000")
    ?.split("\t")[0]
  const dev = (await fs.readFile("/proc/net/dev", "utf8").catch(() => ""))
    .split("\n")
    .map((line) => line.trim().split(/[:\s]+/))
    .find(([name]) => name === iface)
  const network = dev && { name: iface, rx: Number(dev[1]), tx: Number(dev[9]) }
  res.json({
    hostname: os.hostname(),
    // IPv4 addresses, minus container bridges.
    addresses: Object.entries(os.networkInterfaces()).flatMap(([name, addrs]) =>
      VIRTUAL_IF.test(name)
        ? []
        : (addrs || []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, address: a.address })),
    ),
    uptime: os.uptime(),
    cpu: { usage, cores: os.cpus().length, model: os.cpus()[0]?.model },
    memory: { total: os.totalmem(), used: os.totalmem() - available },
    network,
    disk: disk && { total: disk.blocks * disk.bsize, used: (disk.blocks - disk.bavail) * disk.bsize },
  })
})

router.get("/remote-servers/:id/log", (req, res) => {
  res.json({ log: sessions.get(req.params.id)?.log || [] })
})

router.post("/remote-servers/:id/disconnect", async (req, res) => {
  disconnect(req.params.id)
  res.json({})
})

/**
 * File browser over ssh. `open` logs in once and leaves a multiplexed master
 * connection behind; listing and reading reuse it, so they need no credentials
 * (servers with a saved password or key also work without it).
 */
const filesArgs = (req: Request, server: RemoteServer, master: boolean) => [
  "-T",
  "-o",
  `ControlPath=/tmp/cs-files-${instanceId(req)}-${server.id}`,
  "-o",
  master ? "ControlMaster=auto" : "ControlMaster=no",
  "-o",
  "ControlPersist=15m",
]

/** Path query parameter; relative paths are relative to the remote home. */
function filesPath(q: unknown): string {
  const p = typeof q === "string" && q ? q : "~"
  if (p.length > 4096 || /[\0\n\r]/.test(p)) {
    throw new HttpError("Invalid path", HttpCode.BadRequest)
  }
  return p
}

// Exit codes from the remote commands below; 255 is ssh itself failing.
const NOT_FOUND = 3
const EXISTS = 4
const PROTECTED = 5
const filesError = (code: number | null, stderr: string): HttpError =>
  code === 255
    ? new HttpError("Not signed in to this server", HttpCode.Unauthorized)
    : code === NOT_FOUND
      ? new HttpError("Not found or no permission", HttpCode.NotFound)
      : code === EXISTS
        ? new HttpError("A file with that name already exists", HttpCode.Conflict)
        : code === PROTECTED
          ? new HttpError("Refusing to delete / or the home folder", HttpCode.Forbidden)
          : new HttpError(stderr.trim().split("\n").pop() || `Failed (exit ${code})`, HttpCode.ServerError)

async function filesRun(req: Request, server: RemoteServer, command: string) {
  const { args, env } = await sshCommand(req, server, filesArgs(req, server, false), command)
  const proc = spawn("ssh", args, { env, stdio: ["ignore", "pipe", "pipe"] })
  const stdout: Buffer[] = []
  let stderr = ""
  proc.stdout!.on("data", (d: Buffer) => stdout.push(d))
  proc.stderr!.on("data", (d) => (stderr += d))
  const code = await new Promise<number | null>((resolve) => {
    proc.on("error", () => resolve(255))
    proc.on("close", resolve)
  })
  if (code !== 0) throw filesError(code, stderr)
  return Buffer.concat(stdout).toString("utf8")
}

/** Remote command printing the folder's absolute path, then its entries. */
export const listCommand = (p: string) =>
  `cd ${quotePath(p)} || exit ${NOT_FOUND}; pwd; find . -mindepth 1 -maxdepth 1 -printf '%Y\\t%y\\t%s\\t%T@\\t%f\\0' 2>/dev/null; exit 0`

/** Remote command printing a file, or its first `max` bytes. */
export const readCommand = (p: string, max = 0) =>
  `[ -f ${quotePath(p)} ] || exit ${NOT_FOUND}; ${max > 0 ? `head -c ${max}` : "cat"} -- ${quotePath(p)}`

/**
 * Remote command writing stdin to a file. It goes to a temporary name first so
 * an interrupted upload never leaves a half-written file in place.
 */
export const writeCommand = (p: string, overwrite = false) => {
  const tmp = quotePath(p + ".cs-upload")
  return (
    `[ -d "$(dirname -- ${quotePath(p)})" ] || exit ${NOT_FOUND}; ` +
    (overwrite ? "" : `[ -e ${quotePath(p)} ] && exit ${EXISTS}; `) +
    `cat > ${tmp} && mv -f -- ${tmp} ${quotePath(p)} || { rm -f -- ${tmp}; exit 1; }`
  )
}

/** Remote command deleting a file or a whole folder, but never / or $HOME. */
export const removeCommand = (p: string) => {
  const q = quotePath(p)
  return (
    `{ [ -e ${q} ] || [ -L ${q} ]; } || exit ${NOT_FOUND}; r="$(realpath -- ${q})"; ` +
    `{ [ "$r" = / ] || [ "$r" = "$(realpath -- "$HOME")" ]; } && exit ${PROTECTED}; rm -rf -- ${q}`
  )
}

export interface FileEntry {
  name: string
  dir: boolean
  link: boolean
  size: number
  mtime: number
}

/** Parse `pwd` then NUL-terminated `find -printf '%Y\t%y\t%s\t%T@\t%f\0'` lines. */
export function parseListing(out: string): { path: string; entries: FileEntry[] } {
  const nl = out.indexOf("\n")
  const entries = out
    .slice(nl + 1)
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [type, own, size, mtime, ...name] = line.split("\t")
      return {
        name: name.join("\t"),
        dir: type === "d",
        link: own === "l",
        size: Number(size),
        mtime: Math.round(Number(mtime) * 1000),
      }
    })
  return { path: out.slice(0, nl), entries }
}

router.post("/remote-servers/:id/files/open", async (req, res) => {
  const server = withCredentials(await getServer(req), req.body)
  const { args, env } = await sshCommand(req, server, filesArgs(req, server, true), "true")
  // The master stays in the background holding ssh's fds, so wait for exit, not close.
  const proc = spawn("ssh", args, { env, stdio: ["ignore", "ignore", "pipe"] })
  let stderr = ""
  proc.stderr!.on("data", (d) => (stderr += d))
  const code = await new Promise<number | null>((resolve) => {
    proc.on("error", () => resolve(255))
    proc.on("exit", resolve)
  })
  if (code !== 0) {
    throw new HttpError(stderr.trim().split("\n").pop() || "ssh failed", HttpCode.ServerError)
  }
  res.json({})
})

router.get("/remote-servers/:id/files", async (req, res) => {
  const out = await filesRun(req, await getServer(req), listCommand(filesPath(req.query.path)))
  res.json(parseListing(out))
})

// Previewable in the browser; everything else is sent as plain text.
const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
}

router.get("/remote-servers/:id/files/raw", async (req, res) => {
  const p = filesPath(req.query.path)
  const max = Math.max(0, Math.floor(Number(req.query.max)) || 0)
  const server = await getServer(req)
  const { args, env } = await sshCommand(req, server, filesArgs(req, server, false), readCommand(p, max))
  const proc = spawn("ssh", args, { env, stdio: ["ignore", "pipe", "pipe"] })
  req.on("close", () => proc.kill())
  const name = path.posix.basename(p)
  const headers = {
    "Content-Type": req.query.download
      ? "application/octet-stream"
      : MEDIA_TYPES[path.extname(name).slice(1).toLowerCase()] || "text/plain; charset=utf-8",
    // Remote content must never run as part of this origin. PDFs are exempt:
    // browsers won't show them in a sandbox, and their viewers don't run
    // with this origin's privileges.
    "X-Content-Type-Options": "nosniff",
    ...(!/\.pdf$/i.test(name) && { "Content-Security-Policy": "sandbox" }),
    // Inline still names it, for viewer titles and saving from them.
    "Content-Disposition": `${req.query.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(name)}`,
  }
  // Headers wait for the first byte so a failure can still be an error status.
  let started = false
  let stderr = ""
  proc.stderr!.on("data", (d) => (stderr += d))
  proc.stdout!.once("data", (chunk) => {
    started = true
    res.writeHead(200, headers)
    res.write(chunk)
    proc.stdout!.pipe(res)
  })
  const finish = (code: number | null) => {
    // A spawn error can be followed by close; only the first answer counts.
    if (started || res.headersSent) {
      return
    }
    if (code === 0) {
      res.writeHead(200, headers).end()
    } else {
      const error = filesError(code, stderr)
      res.status(error.statusCode).json({ error: error.message })
    }
  }
  proc.on("error", () => finish(255))
  proc.on("close", finish)
})

router.put("/remote-servers/:id/files/raw", async (req, res) => {
  const p = filesPath(req.query.path)
  if (["", ".", "..", "~"].includes(path.posix.basename(p))) {
    throw new HttpError("Invalid file name", HttpCode.BadRequest)
  }
  const server = await getServer(req)
  const { args, env } = await sshCommand(
    req,
    server,
    filesArgs(req, server, false),
    writeCommand(p, req.query.overwrite === "1"),
  )
  // The request body streams straight into the remote file.
  const proc = spawn("ssh", args, { env, stdio: ["pipe", "ignore", "pipe"] })
  proc.stdin!.on("error", () => {}) // ssh may exit (e.g. file exists) before reading it all.
  req.pipe(proc.stdin!)
  req.on("close", () => !req.complete && proc.kill())
  let stderr = ""
  proc.stderr!.on("data", (d) => (stderr += d))
  const code = await new Promise<number | null>((resolve) => {
    proc.on("error", () => resolve(255))
    proc.on("close", resolve)
  })
  if (code !== 0) throw filesError(code, stderr)
  res.json({})
})

router.delete("/remote-servers/:id/files", async (req, res) => {
  await filesRun(req, await getServer(req), removeCommand(filesPath(req.query.path)))
  res.json({})
})

/** Proxy /remote/<id>/* to the forwarded remote code-server. */
const target = (req: Request, session: Session): string => {
  const base = `/remote/${req.params.id}`
  ;(req as any).base = base // Used to rewrite redirects.
  const url = req.originalUrl.slice(req.originalUrl.indexOf(base) + base.length)
  return `http://127.0.0.1:${session.port}${url || "/"}`
}

export async function proxy(req: Request, res: Response): Promise<void> {
  const [pathname, query] = req.originalUrl.split("?")
  if (!(await authenticated(req))) {
    if (!req.params.path) {
      return redirect(req, res, "login", { to: pathname })
    }
    throw new HttpError("Unauthorized", HttpCode.Unauthorized)
  }
  const session = sessions.get(req.params.id as string)
  if (!session) {
    // Not connected (yet); the launcher connects and comes back.
    return redirect(req, res, "/", { connect: req.params.id })
  }
  // The remote code-server doesn't expand ~ in ?folder=.
  const folder = req.query.folder
  if (!req.params.path && typeof folder === "string" && /^~(\/|$)/.test(folder) && session.home) {
    const params = new URLSearchParams(query)
    params.set("folder", session.home + folder.slice(1))
    return res.redirect(`${pathname.endsWith("/") ? "./" : req.params.id + "/"}?${params}`)
  }
  // Relative URLs only work with the trailing slash.
  if (!req.params.path && !pathname.endsWith("/")) {
    return res.redirect(`${req.params.id}/${query ? "?" + query : ""}`)
  }
  if (!req.params.path && req.method === "GET") {
    return proxyEditorPage(req, res, session)
  }
  _proxy.web(req, res, { ignorePath: true, target: target(req, session) })
}

/** Back to the launcher, top right of the editor. Styles only: the page's CSP blocks inline scripts. */
const HOME_BUTTON =
  '<a href="../../" title="Back to servers" aria-label="Back to servers" style="position:fixed;top:0;right:0;z-index:100000;' +
  "width:35px;height:35px;display:flex;align-items:center;justify-content:center;color:#ccc;background:#1f1f1f;" +
  'text-decoration:none;font:18px/1 sans-serif">&#x2715;</a>'

/** The editor page itself, with HOME_BUTTON added. */
function proxyEditorPage(req: Request, res: Response, session: Session): void {
  // Uncompressed so the button can be added; no cookies, like the shared proxy.
  const { cookie, ...headers } = req.headers
  http
    .get(target(req, session), { headers: { ...headers, "accept-encoding": "identity" } }, (pres) => {
      const out = pres.headers
      if (out.location?.startsWith("/")) {
        out.location = (req as any).base + out.location
      }
      if (pres.statusCode !== 200 || !out["content-type"]?.includes("text/html")) {
        res.writeHead(pres.statusCode || HttpCode.ServerError, out)
        pres.pipe(res)
        return
      }
      const chunks: Buffer[] = []
      pres.on("data", (c) => chunks.push(c))
      pres.on("end", () => {
        delete out["content-length"]
        res.writeHead(200, out)
        res.end(
          Buffer.concat(chunks)
            .toString()
            .replace("</body>", HOME_BUTTON + "</body>"),
        )
      })
    })
    .on("error", (error) => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(HttpCode.ServerError)
      res.end(error.message)
    })
}

export async function wsProxy(req: WebsocketRequest): Promise<void> {
  ensureOrigin(req)
  await ensureAuthenticated(req)
  const session = sessions.get(req.params.id as string)
  if (!session) {
    throw new HttpError("Not connected", HttpCode.NotFound)
  }
  _proxy.ws(req, req.ws, req.head, { ignorePath: true, target: target(req, session) })
}

// node-pty ships with VS Code; only the bits used here are typed.
interface Pty {
  onData(cb: (data: string) => void): void
  onExit(cb: (e: { exitCode: number }) => void): void
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}

/**
 * Interactive ssh shell. The first message carries credentials and terminal
 * size, then each message is {d: input} or {cols, rows}; output is sent raw.
 */
export async function wsShell(req: WebsocketRequest): Promise<void> {
  ensureOrigin(req)
  await ensureAuthenticated(req)
  const saved = await getServer(req)
  wss.handleUpgrade(req, req.ws, req.head, (ws) => {
    let pty: Pty | undefined
    let started = false
    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString())
        if (started) {
          // Input sent before the pty exists is dropped.
          return typeof msg.d === "string" ? pty?.write(msg.d) : pty?.resize(msg.cols, msg.rows)
        }
        started = true
        const server = withCredentials(saved, msg)
        const folder = typeof msg.folder === "string" && msg.folder.trim() ? msg.folder.trim() : server.folder
        const { args, env } = await sshCommand(req, server, ["-t"], shellCommand(folder))
        const { spawn } = require(path.join(vsRootPath, "node_modules/node-pty"))
        logger.info(`Opening shell on remote server ${server.name} (${server.host})`)
        pty = spawn("ssh", args, { name: "xterm-256color", cols: msg.cols || 80, rows: msg.rows || 24, env }) as Pty
        if (ws.readyState !== ws.OPEN) {
          return pty.kill()
        }
        pty.onData((data) => ws.send(data))
        pty.onExit(({ exitCode }) => ws.close(1000, `ssh exited with code ${exitCode}`))
      } catch (error: any) {
        ws.close(1011, String(error.message).slice(0, 120))
      }
    })
    ws.on("close", () => pty?.kill())
    req.ws.resume()
  })
}
