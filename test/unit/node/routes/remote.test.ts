import { execFileSync } from "child_process"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import {
  listCommand,
  packCommand,
  parseEntries,
  parseListing,
  parseServer,
  parseCswap,
  parseUsage,
  parseUsageAccounts,
  probe,
  readCommand,
  removeCommand,
  shellCommand,
  sizeCommand,
  startUptime,
  unpackCommand,
  uptimeSummary,
  usageCommand,
  writeCommand,
} from "../../../../src/node/routes/remote"
import { brokerRoutes } from "../../../../src/node/sessionBroker"
import * as httpserver from "../../../utils/httpserver"
import * as integration from "../../../utils/integration"

describe("remote servers", () => {
  let codeServer: httpserver.HttpServer | undefined

  afterEach(async () => {
    await codeServer?.dispose()
    codeServer = undefined
  })

  it("should validate input", () => {
    expect(() => parseServer({ host: "-oProxyCommand=x" })).toThrow("Invalid host")
    expect(() => parseServer({ host: "a", user: "a b" })).toThrow("Invalid user")
    expect(() => parseServer({ host: "a", port: "99999" })).toThrow("Invalid port")
    const s = parseServer({ host: "example.com", port: "2222", password: "pw" })
    expect(s).toMatchObject({ name: "example.com", host: "example.com", port: 2222, password: "pw" })
    expect(parseServer({ host: "x" }, s).password).toBe("pw")
    expect(parseServer({ host: "x", clearPassword: true }, s).password).toBeUndefined()
    expect(parseServer({ host: "x", group: " Lab " }).group).toBe("Lab")
    expect(parseServer({ host: "x", group: "" }).group).toBeUndefined()
    // Edits from the server form keep the entry points.
    expect(parseServer({ host: "x" }, { ...s, entries: [{ name: "a", path: "/a" }] }).entries).toHaveLength(1)
  })

  it("should validate entry points", () => {
    expect(parseEntries({ entries: [{ name: " src ", path: " ~/src " }] })).toEqual([{ name: "src", path: "~/src" }])
    expect(() => parseEntries({})).toThrow("Invalid entry points")
    expect(() => parseEntries({ entries: [{ name: "", path: "/a" }] })).toThrow("Invalid entry point")
    expect(() => parseEntries({ entries: [{ name: "a", path: "/a\nrm -rf ~" }] })).toThrow("Invalid entry point")
  })

  it("should log uptime per hour", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uptime-"))
    const listener = net.createServer().listen(0, "127.0.0.1")
    await new Promise((r) => listener.once("listening", r))
    const closed = net.createServer().listen(0, "127.0.0.1")
    await new Promise((r) => closed.once("listening", r))
    const closedPort = (closed.address() as net.AddressInfo).port
    await new Promise((r) => closed.close(r))
    const servers = [
      { id: "up", name: "up", host: "127.0.0.1", port: (listener.address() as net.AddressInfo).port },
      { id: "down", name: "down", host: "127.0.0.1", port: closedPort },
    ]
    fs.writeFileSync(path.join(dir, "remote-servers.json"), JSON.stringify(servers))
    const args = { args: { "user-data-dir": dir } } as any
    await startUptime(args)
    listener.close()
    expect(uptimeSummary("up")).toMatchObject({ day: 1, month: 1 })
    expect(uptimeSummary("down").day).toBe(0)
    expect(
      uptimeSummary("up")
        .hours.slice(0, 23)
        .every((h) => h === null),
    ).toBe(true)
    // An hour later the bar moves left; unknown servers have no data.
    expect(uptimeSummary("up", Date.now() + 60 * 60 * 1000).hours[22]).toBe(1)
    expect(uptimeSummary("nope").month).toBeNull()
    // Kept across restarts, with the response time of online checks.
    const log = JSON.parse(fs.readFileSync(path.join(dir, "remote-uptime.json"), "utf8"))
    expect(Object.values(log.up)[0]).toEqual([1, 1, expect.any(Number)])
    expect(Object.values(log.down)[0]).toEqual([0, 1, 0])
  })

  it("should quote the shell folder", () => {
    expect(shellCommand()).toBeUndefined()
    const folder = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "shell-")), "it's $(x)")
    fs.mkdirSync(folder)
    // Swap the login shell for pwd to see where it lands.
    const out = execFileSync("sh", ["-c", shellCommand(folder)!.replace('exec "$SHELL" -l', "pwd")], {
      encoding: "utf8",
    })
    expect(out.trim()).toBe(folder)
    // ~ expands on the remote; the rest stays quoted.
    const home = path.dirname(folder)
    const run = (f: string) =>
      execFileSync("sh", ["-c", shellCommand(f)!.replace('exec "$SHELL" -l', "pwd")], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      }).trim()
    expect(run("~")).toBe(home)
    expect(run("~/it's $(x)")).toBe(folder)
  })

  it("should list and read remote files", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "files-"))
    const dir = path.join(home, "it's $(x)")
    fs.mkdirSync(path.join(dir, "sub"), { recursive: true })
    fs.writeFileSync(path.join(dir, "a\tb.txt"), "hello")
    fs.writeFileSync(path.join(dir, ".hidden"), "")
    fs.symlinkSync("sub", path.join(dir, "link"))
    const sh = (cmd: string) =>
      execFileSync("sh", ["-c", cmd], { encoding: "utf8", env: { ...process.env, HOME: home } })

    const { path: cwd, entries } = parseListing(sh(listCommand("~/it's $(x)")))
    expect(cwd).toBe(fs.realpathSync(dir))
    const byName = Object.fromEntries(entries.map((e) => [e.name, e]))
    expect(Object.keys(byName).sort()).toEqual([".hidden", "a\tb.txt", "link", "sub"])
    expect(byName["a\tb.txt"]).toMatchObject({ dir: false, link: false, size: 5 })
    expect(byName.sub).toMatchObject({ dir: true, link: false })
    expect(byName.link).toMatchObject({ dir: true, link: true })
    expect(byName.sub.mtime).toBeGreaterThan(Date.now() - 60_000)

    expect(sh(readCommand(path.join(dir, "a\tb.txt")))).toBe("hello")
    expect(sh(readCommand(path.join(dir, "a\tb.txt"), 2))).toBe("he")
    // Missing paths and folders exit 3, which the routes report as 404.
    expect(() => sh(listCommand("~/missing"))).toThrow(expect.objectContaining({ status: 3 }))
    expect(() => sh(readCommand(path.join(dir, "sub")))).toThrow(expect.objectContaining({ status: 3 }))
  })

  it("should read AI usage of each account", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "usage-"))
    const now = Math.floor(Date.now() / 1000)
    fs.mkdirSync(path.join(home, ".claude"))
    fs.writeFileSync(
      path.join(home, ".claude/usage.json"),
      JSON.stringify({
        rate_limits: {
          five_hour: { used_percentage: 22, resets_at: now + 3600 },
          seven_day: { used_percentage: 40, resets_at: now - 60 },
        },
        at: now,
      }),
    )
    const day = path.join(home, "it's codex/sessions/2026/10/29")
    fs.mkdirSync(day, { recursive: true })
    const limits = (used: number) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        payload: {
          type: "token_count",
          rate_limits: { primary: { used_percent: used, window_minutes: 10080, resets_at: now + 60 }, secondary: null },
        },
      })
    fs.writeFileSync(
      path.join(day, "rollout-1.jsonl"),
      [limits(10), '{"rate_limits":null}', limits(16), "{}"].join("\n"),
    )
    const accounts = [
      { id: "a", tool: "claude" as const, name: "Claude", dir: "~/.claude" },
      { id: "b", tool: "codex" as const, name: "Codex", dir: "~/it's codex" },
      { id: "c", tool: "claude" as const, name: "Missing", dir: "~/nowhere" },
    ]
    const out = execFileSync("sh", ["-c", usageCommand(accounts)], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    }).split("\0")

    expect(parseUsage("claude", out[0])).toEqual({
      windows: [
        { label: "5h", used: 22, resetsAt: (now + 3600) * 1000 },
        // Past its reset: nothing used since.
        { label: "7d", used: 0, resetsAt: (now - 60) * 1000 },
      ],
      at: now * 1000,
    })
    // The last line with limits.
    expect(parseUsage("codex", out[1])?.windows).toEqual([{ label: "7d", used: 16, resetsAt: (now + 60) * 1000 }])
    expect(parseUsage("claude", out[2])).toBeUndefined()

    expect(parseUsageAccounts([{ tool: "codex", name: " Work ", dir: "~/.codex-work" }])[0]).toMatchObject({
      tool: "codex",
      name: "Work",
      dir: "~/.codex-work",
      id: expect.stringMatching(/^[0-9a-f]{16}$/),
    })
    // Served by the launcher, not an older session broker.
    expect(
      ["/remote-servers/usage", "/remote-servers/usage/accounts", "/remote-servers/rebuild"].some((p) =>
        brokerRoutes.test(p),
      ),
    ).toBe(false)
    expect(brokerRoutes.test("/remote-servers/x/files")).toBe(true)
    expect(() => parseUsageAccounts([{ tool: "gpt", name: "x", dir: "~" }])).toThrow()
    expect(() => parseUsageAccounts([{ tool: "claude", name: "x", dir: "a\nb" }])).toThrow()

    // cswap: one entry per account it manages, under the cswap entry's id.
    const swap = { id: "s", tool: "cswap" as const, name: "Swap", dir: "~/.local/bin/cswap" }
    const listed = JSON.stringify({
      accounts: [
        {
          number: 1,
          email: "a@x",
          active: false,
          usage: { fiveHour: { pct: 0 }, sevenDay: { pct: 30, resetsAt: "2026-11-06T07:00:00+00:00" } },
          usageFetchedAt: "2026-10-30T09:37:16Z",
        },
        { number: 2, email: "b@x", alias: "work", active: true, usage: { fiveHour: { pct: 4 } } },
      ],
    })
    const [one, two] = parseCswap(swap, listed, Date.parse("2026-10-30T10:00:00Z"))
    expect(one).toMatchObject({ id: "s", name: "a@x", dir: "cswap #1", configured: swap })
    expect(one.windows).toEqual([
      { label: "5h", used: 0, resetsAt: undefined },
      { label: "7d", used: 30, resetsAt: Date.parse("2026-11-06T07:00:00Z") },
    ])
    expect(one.at).toBe(Date.parse("2026-10-30T09:37:16Z"))
    expect(two).toMatchObject({ name: "work", dir: "cswap #2 · active" })
    // Unreadable: the entry stays, to be removable.
    expect(parseCswap(swap, "")).toEqual([{ ...swap, windows: [] }])
    expect(usageCommand([swap])).toBe(`{ "$HOME"/'.local/bin/cswap' list --json 2>/dev/null; }; printf '\\0'`)
  })

  it("should write and delete remote files", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "files-"))
    const sh = (cmd: string, input?: string) =>
      execFileSync("sh", ["-c", cmd], { encoding: "utf8", input, env: { ...process.env, HOME: home } })
    const status = (cmd: string) => {
      try {
        sh(cmd)
        return 0
      } catch (error: any) {
        return error.status
      }
    }

    sh(writeCommand("~/it's.txt"), "one")
    expect(fs.readFileSync(path.join(home, "it's.txt"), "utf8")).toBe("one")
    // Existing files need overwrite; nothing temporary is left behind.
    expect(status(writeCommand("~/it's.txt"))).toBe(4)
    sh(writeCommand("~/it's.txt", true), "two")
    expect(fs.readFileSync(path.join(home, "it's.txt"), "utf8")).toBe("two")
    expect(fs.readdirSync(home)).toEqual(["it's.txt"])
    expect(status(writeCommand("~/missing/a.txt"))).toBe(3)

    fs.mkdirSync(path.join(home, "dir/sub"), { recursive: true })
    sh(removeCommand("~/dir"))
    sh(removeCommand("~/it's.txt"))
    expect(fs.readdirSync(home)).toEqual([])
    expect(status(removeCommand("~/gone"))).toBe(3)
    // Never / or the home folder, however it's spelled.
    expect(status(removeCommand("~"))).toBe(5)
    expect(status(removeCommand(home + "/."))).toBe(5)
    // Checked with rm swapped for echo, so a broken guard can't wipe anything.
    expect(status(removeCommand("/").replace("rm -rf", "echo rm -rf"))).toBe(5)
    expect(fs.existsSync(home)).toBe(true)
  })

  it("should copy files and folders through a tar stream", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "files-"))
    const sh = (cmd: string, input?: Buffer) =>
      execFileSync("sh", ["-c", cmd], { input, env: { ...process.env, HOME: home } })
    const status = (cmd: string, input?: Buffer) => {
      try {
        sh(cmd, input)
        return 0
      } catch (error: any) {
        return error.status
      }
    }
    fs.mkdirSync(path.join(home, "src/it's/sub"), { recursive: true })
    fs.writeFileSync(path.join(home, "src/it's/sub/a.txt"), "one")
    fs.mkdirSync(path.join(home, "dest"))

    sh(unpackCommand("~/dest", "it's"), sh(packCommand("~/src/it's")))
    expect(fs.readFileSync(path.join(home, "dest/it's/sub/a.txt"), "utf8")).toBe("one")
    // Existing names need overwrite; missing sources and folders exit 3.
    const file = sh(packCommand("~/src/it's/sub/a.txt"))
    sh(unpackCommand("~/dest", "a.txt"), file)
    expect(status(unpackCommand("~/dest", "a.txt"), file)).toBe(4)
    fs.writeFileSync(path.join(home, "src/it's/sub/a.txt"), "two")
    sh(unpackCommand("~/dest", "a.txt", true), sh(packCommand("~/src/it's/sub/a.txt")))
    expect(fs.readFileSync(path.join(home, "dest/a.txt"), "utf8")).toBe("two")
    expect(status(packCommand("~/gone"))).toBe(3)
    expect(status(unpackCommand("~/gone", "a.txt"), file)).toBe(3)
    // Sizes: exact for files, from du (1K blocks) for folders.
    expect(sh(sizeCommand("~/dest/a.txt")).toString().trim()).toBe("3")
    expect(Number(sh(sizeCommand("~/dest/it's")))).toBeGreaterThan(0)
    expect(status(sizeCommand("~/gone"))).toBe(3)
  })

  it("should probe TCP ports", async () => {
    const srv = net.createServer().listen(0, "127.0.0.1")
    await new Promise((r) => srv.once("listening", r))
    const port = (srv.address() as net.AddressInfo).port
    expect(await probe("127.0.0.1", port)).toBeGreaterThanOrEqual(0)
    await new Promise((r) => srv.close(r))
    expect(await probe("127.0.0.1", port)).toBeUndefined()
  })

  it("should list, add, edit and delete servers", async () => {
    codeServer = await integration.setup(["--auth=none"], "")
    const json = (method: string, p: string, body?: object) =>
      codeServer!.fetch(p, {
        method,
        body: body && JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      })

    // identity: node-fetch v2 chokes on gzip under Node 24.
    const root = await codeServer.fetch("/", { headers: { "Accept-Encoding": "identity" } })
    expect(root.status).toBe(200)
    expect(await root.text()).toContain("remote-servers")

    let resp = await json("POST", "/remote-servers", { name: "box", host: "box.local", password: "secret" })
    expect(resp.status).toBe(200)
    const { id } = await resp.json()

    resp = await json("GET", "/remote-servers")
    const list = await resp.json()
    expect(list[0]).toMatchObject({ id: "local", name: "This computer", host: "127.0.0.1", group: "Local" })
    expect(list[1]).toEqual({ id, name: "box", host: "box.local", hasPassword: true, connected: false })

    resp = await json("PUT", `/remote-servers/${id}`, { name: "box2", host: "box.local", user: "me" })
    expect(resp.status).toBe(200)
    resp = await json("GET", "/remote-servers")
    expect((await resp.json())[1]).toMatchObject({ name: "box2", user: "me", hasPassword: true })

    resp = await json("PUT", `/remote-servers/${id}/entries`, { entries: [{ name: "src", path: "~/src" }] })
    expect(resp.status).toBe(200)
    resp = await json("PUT", `/remote-servers/${id}/entries`, { entries: [{ name: "", path: "x" }] })
    expect(resp.status).toBe(400)
    resp = await json("PUT", `/remote-servers/${id}`, { name: "box2", host: "box.local", user: "me" })
    resp = await json("GET", "/remote-servers")
    expect((await resp.json())[1].entries).toEqual([{ name: "src", path: "~/src" }])

    resp = await json("GET", "/remote-servers/status")
    const status = await resp.json()
    expect(Object.keys(status)).toEqual(["local", id])
    expect(typeof status[id].online).toBe("boolean")

    // Paths are validated before anything runs over ssh.
    resp = await codeServer.fetch(`/remote-servers/${id}/files`, undefined, { path: "/a\nb" })
    expect(resp.status).toBe(400)

    resp = await json("GET", `/remote-servers/${id}/log`)
    expect(await resp.json()).toEqual({ log: [] })

    resp = await json("GET", "/system-info")
    const info = await resp.json()
    expect(info.cpu.usage).toBeGreaterThanOrEqual(0)
    expect(info.memory.used).toBeLessThanOrEqual(info.memory.total)
    expect(Array.isArray(info.addresses)).toBe(true)

    resp = await json("POST", "/remote-servers", { host: "-bad" })
    expect(resp.status).toBe(400)

    // Not connected: proxy sends you back to the launcher to connect.
    resp = await codeServer.fetch(`/remote/${id}/`, { redirect: "manual" })
    expect(resp.status).toBe(302)
    expect(resp.headers.get("location")).toContain(`connect=${id}`)

    resp = await json("DELETE", `/remote-servers/${id}`)
    expect(resp.status).toBe(200)
    resp = await json("DELETE", "/remote-servers/local")
    expect(resp.status).toBe(400)
    resp = await json("GET", "/remote-servers")
    expect((await resp.json()).map((s: any) => s.id)).toEqual(["local"])
  })
})
