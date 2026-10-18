import { execFileSync } from "child_process"
import * as fs from "fs"
import * as net from "net"
import * as os from "os"
import * as path from "path"
import { parseServer, probe, shellCommand } from "../../../../src/node/routes/remote"
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
    expect(list[0]).toMatchObject({ id: "local", name: "This computer", host: "127.0.0.1" })
    expect(list[1]).toEqual({ id, name: "box", host: "box.local", hasPassword: true, connected: false })

    resp = await json("PUT", `/remote-servers/${id}`, { name: "box2", host: "box.local", user: "me" })
    expect(resp.status).toBe(200)
    resp = await json("GET", "/remote-servers")
    expect((await resp.json())[1]).toMatchObject({ name: "box2", user: "me", hasPassword: true })

    resp = await json("GET", "/remote-servers/status")
    const status = await resp.json()
    expect(Object.keys(status)).toEqual(["local", id])
    expect(typeof status[id].online).toBe("boolean")

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
