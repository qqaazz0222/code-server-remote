import { execFile } from "child_process"
import express from "express"
import { promises as fs } from "fs"
import * as os from "os"
import * as path from "path"
import { promisify } from "util"
import { AuthType } from "../../../../src/node/cli"
import { rootPath } from "../../../../src/node/constants"
import { agentNotifications } from "../../../../src/node/routes/agentNotifications"
import { errorHandler } from "../../../../src/node/routes/errors"
import { HttpServer } from "../../../utils/httpserver"

describe("agent completion notifications", () => {
  let server: HttpServer
  let dir: string
  let token: string
  let endpoint: string
  const prefix = "/prefix/agent-notifications"
  const post = (body: unknown, credential = token) =>
    server.fetch(prefix + "/complete", {
      method: "POST",
      headers: { Authorization: `Bearer ${credential}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  const feed = async (cursor?: { epoch: string; cursor: number }) =>
    (await server.fetch(prefix + "/events", {}, cursor && { epoch: cursor.epoch, after: String(cursor.cursor) })).json()

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-notify-"))
    server = new HttpServer()
    const app = express()
    app.use(express.json())
    app.use((req, _res, next) => {
      req.args = {
        auth: req.headers["x-test-login"] ? AuthType.Password : AuthType.None,
        "user-data-dir": dir,
        "trusted-origins": [],
      } as any
      req.cookies = {}
      next()
    })
    app.use(prefix, agentNotifications())
    app.use(errorHandler)
    await server.listen(app)
    endpoint = `http://127.0.0.1:${server.port()}${prefix}`
    token = (await (await server.fetch(prefix + "/setup", { method: "POST" })).json()).token
  })
  afterEach(async () => {
    await server.dispose()
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("requires login for setup and feed, and a separate publisher credential", async () => {
    for (const [route, method] of [
      ["/setup", "POST"],
      ["/events", "GET"],
    ]) {
      expect((await server.fetch(prefix + route, { method, headers: { "x-test-login": "required" } })).status).toBe(401)
    }
    expect(
      (await server.fetch(prefix + "/setup", { method: "POST", headers: { Origin: "https://evil.example" } })).status,
    ).toBe(403)
    expect((await post({ tool: "codex", cwd: "/tmp/project", host: "worker" }, "bad")).status).toBe(401)
    expect((await server.fetch(prefix + "/install.py")).status).toBe(401)
    expect((await fs.stat(path.join(dir, "agent-notifications-token"))).mode & 0o777).toBe(0o600)
    expect((await server.fetch(prefix + "/events")).headers.get("cache-control")).toBe("no-store")
  })

  it("replays missed events, avoids stale alerts on a new page, and excludes response text", async () => {
    const initial = await feed()
    expect(
      (await post({ tool: "codex", cwd: "/private/project", host: "worker", message: "private output" })).status,
    ).toBe(202)
    expect((await post({ tool: "claude", cwd: "C:\\work\\other", host: "worker\n" })).status).toBe(202)
    const next = await feed(initial)
    expect(next.events).toHaveLength(2)
    expect(next.events[0]).toMatchObject({ tool: "codex", project: "project", host: "worker" })
    expect(next.events[1]).toMatchObject({ tool: "claude", project: "other", host: "worker" })
    expect(JSON.stringify(next)).not.toMatch(/private/)
    expect((await feed()).events).toEqual([])
    expect((await feed(next)).events).toEqual([])
    expect((await feed({ epoch: "old-process", cursor: 0 })).events).toEqual([])
    expect((await post({ tool: "other", cwd: "x", host: "y" })).status).toBe(400)
    expect((await post({ tool: "codex", cwd: {}, host: "y" })).status).toBe(400)
  })

  it("bounds the replay queue and limits publisher traffic", async () => {
    const initial = await feed()
    for (let i = 0; i < 120; i++) {
      expect((await post({ tool: "codex", cwd: "/tmp/project", host: "worker" })).status).toBe(202)
    }
    expect((await feed(initial)).events).toHaveLength(100)
    expect((await post({ tool: "codex", cwd: "/tmp/project", host: "worker" })).status).toBe(429)
  })

  it("installs idempotently, preserves existing hooks, and delivers both CLI payloads", async () => {
    const codexDir = path.join(dir, "codex")
    const claudeDir = path.join(dir, "claude")
    await fs.mkdir(codexDir)
    await fs.mkdir(claudeDir)
    const chained = path.join(dir, "chained.json")
    const oldHelper = path.join(dir, "previous.py")
    await fs.writeFile(
      oldHelper,
      `import pathlib, sys\npathlib.Path(${JSON.stringify(chained)}).write_text(sys.argv[1])\n`,
    )
    const original = `# Preserve this comment\nnotify = [\n "python3",\n ${JSON.stringify(oldHelper)},\n]\n[model_providers.custom]\nname = "Keep me"\n`
    await fs.writeFile(path.join(codexDir, "config.toml"), original)
    await fs.writeFile(
      path.join(claudeDir, "settings.json"),
      JSON.stringify({ theme: "dark", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] } }),
    )
    const response = await server.fetch(prefix + "/install.py", { headers: { Authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    const source = await response.text()
    const env = { ...process.env, HOME: dir, CODEX_HOME: codexDir, CLAUDE_CONFIG_DIR: claudeDir }
    for (let i = 0; i < 2; i++) await promisify(execFile)("python3", ["-c", source, endpoint], { env })
    const settings = JSON.parse(await fs.readFile(path.join(claudeDir, "settings.json"), "utf8"))
    expect(settings.theme).toBe("dark")
    expect(settings.hooks.Stop).toHaveLength(2)
    expect(settings.hooks.Stop[0].hooks[0].command).toBe("echo existing")
    expect(await fs.readFile(path.join(codexDir, "config.toml.before-agent-notifications"), "utf8")).toBe(original)
    const helper = path.join(dir, ".local/share/code-server-remote/notifications/notify.py")
    const initial = await feed()
    const payload = JSON.stringify({ type: "agent-turn-complete", cwd: "/work/codex-project" })
    await promisify(execFile)("python3", [helper, "codex", payload], { env })
    expect(await fs.readFile(chained, "utf8")).toBe(payload)
    await new Promise<void>((resolve, reject) => {
      const child = execFile("python3", [helper, "claude"], { env }, (error) => (error ? reject(error) : resolve()))
      child.stdin!.end(JSON.stringify({ hook_event_name: "Stop", cwd: "/work/claude-project" }))
    })
    await promisify(execFile)("python3", [helper, "codex", JSON.stringify({ type: "approval-requested" })], { env })
    const events = (await feed(initial)).events
    expect(events.map((e: any) => e.project)).toEqual(["codex-project", "claude-project"])
    const connection = path.join(path.dirname(helper), "connection.json")
    expect((await fs.stat(connection)).mode & 0o777).toBe(0o600)
    await fs.writeFile(connection, JSON.stringify({ endpoint: "http://127.0.0.1:1", token }))
    await promisify(execFile)("python3", [helper, "codex", payload], { env })
    await expect(promisify(execFile)("python3", [helper, "--test"], { env })).rejects.toThrow()
  })

  it("does not change settings when a CLI config is malformed", async () => {
    const source = (await fs.readFile(path.join(rootPath, "src/browser/pages/agent-notify.py"), "utf8")).replace(
      "TOKEN = None",
      `TOKEN = ${JSON.stringify(token)}`,
    )
    await fs.mkdir(path.join(dir, "codex"))
    await fs.mkdir(path.join(dir, "claude"))
    const original = 'model = "keep"\n'
    await fs.writeFile(path.join(dir, "codex/config.toml"), original)
    await fs.writeFile(path.join(dir, "claude/settings.json"), "{invalid")
    await expect(
      promisify(execFile)("python3", ["-c", source, endpoint], {
        env: {
          ...process.env,
          HOME: dir,
          CODEX_HOME: path.join(dir, "codex"),
          CLAUDE_CONFIG_DIR: path.join(dir, "claude"),
        },
      }),
    ).rejects.toThrow()
    expect(await fs.readFile(path.join(dir, "codex/config.toml"), "utf8")).toBe(original)
    await expect(
      fs.stat(path.join(dir, ".local/share/code-server-remote/notifications/connection.json")),
    ).rejects.toThrow()
  })
})
