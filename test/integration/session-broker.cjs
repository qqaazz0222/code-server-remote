// Run against a source build: npm run build && npm run test:session-broker
// Real launcher/worker processes and PTYs; a local SSH fixture needs no server credentials.
const assert = require("node:assert/strict")
const { spawn, execFileSync } = require("node:child_process")
const fs = require("node:fs/promises")
const http = require("node:http")
const os = require("node:os")
const path = require("node:path")
const { once } = require("node:events")
const WebSocket = require("ws")
const { brokerPaths, brokerHealth, ensureSessionBroker } = require("../../out/node/sessionBroker")

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(fn, description) {
  for (let i = 0; i < 150; i++) {
    const result = await fn()
    if (result) return result
    await wait(100)
  }
  throw new Error(`Timed out: ${description}`)
}

async function main() {
  const external = process.argv.includes("--external")
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "csr-broker-test-"))
  const locations = brokerPaths(dir)
  const isolated = brokerPaths(path.join(dir, "isolated"))
  const launcherSocket = path.join(dir, "launcher.sock")
  const sockets = new Set()
  let launcher
  let worker
  let logs = ""
  let cookie = ""
  const request = (url, method = "GET", body, extra = {}) =>
    new Promise((resolve, reject) => {
      const data = body === undefined ? undefined : JSON.stringify(body)
      const req = http.request(
        {
          socketPath: launcherSocket,
          path: url,
          method,
          headers: {
            host: "localhost",
            cookie,
            ...(data && { "content-type": "application/json", "content-length": Buffer.byteLength(data) }),
            ...extra,
          },
        },
        (res) => {
          let text = ""
          res.on("data", (chunk) => (text += chunk))
          res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }))
        },
      )
      req.on("error", reject)
      req.setTimeout(10000, () => req.destroy(new Error(`Request timed out: ${url}`)))
      req.end(data)
    })
  async function start() {
    launcher = spawn(
      process.execPath,
      [
        "out/node/entry.js",
        "--auth",
        "password",
        "--socket",
        launcherSocket,
        "--user-data-dir",
        dir,
        "--session-socket",
        path.join(dir, "editor.sock"),
        "--config",
        path.join(dir, "config.yaml"),
      ],
      {
        cwd: path.resolve(__dirname, "../.."),
        detached: true,
        env: {
          ...process.env,
          CSR_SESSION_BROKER: "1",
          CSR_SESSION_BROKER_EXTERNAL: external ? "1" : "0",
          PASSWORD: "broker-test-password",
          PATH: `${dir}:${process.env.PATH}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    launcher.stdout.on("data", (data) => (logs += data))
    launcher.stderr.on("data", (data) => (logs += data))
    await until(async () => {
      if (launcher.exitCode !== null) throw new Error(logs)
      return request("/healthz")
        .then((r) => r.status === 200)
        .catch(() => false)
    }, "launcher ready")
  }
  async function stop() {
    if (!launcher || launcher.exitCode !== null) return
    const exited = once(launcher, "exit")
    process.kill(-launcher.pid, "SIGTERM")
    await exited
    launcher = undefined
  }
  async function connectShell(attach = false) {
    const ws = new WebSocket(`ws+unix://${launcherSocket}:/remote-shell/local`, {
      headers: { host: "localhost", cookie },
    })
    sockets.add(ws)
    ws.output = ""
    ws.on("message", (data) => (ws.output += data.toString()))
    await once(ws, "open")
    ws.send(JSON.stringify({ id: "persistent-test", attach, cols: 100, rows: 30 }))
    await until(() => ws.output.length > 0, "shell attached")
    return ws
  }
  try {
    await fs.writeFile(
      path.join(dir, "ssh"),
      `#!/bin/sh
case " $* " in *" -t "*) exec /bin/bash --noprofile --norc -i ;; esac
exec '${process.execPath}' '${path.join(dir, "editor.cjs")}' "$@"
`,
      { mode: 0o700 },
    )
    await fs.writeFile(
      path.join(dir, "editor.cjs"),
      `
const http = require('http');
const WS = require(${JSON.stringify(require.resolve("ws"))});
const mapping = process.argv[process.argv.indexOf('-L') + 1];
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({pid:process.pid, url:req.url})); });
const wss = new WS.Server({server}); wss.on('connection', ws => ws.on('message', data => ws.send(data.toString())));
process.stdin.resume(); server.listen(mapping.split(':')[0]); console.log('CS_REMOTE_HOME=/tmp');
`,
    )
    if (external) {
      worker = spawn(process.execPath, ["out/node/sessionBrokerWorker.js", "--user-data-dir", dir], {
        cwd: path.resolve(__dirname, "../.."),
        detached: true,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      })
      worker.stdout.on("data", (data) => (logs += data))
      worker.stderr.on("data", (data) => (logs += data))
      await until(async () => {
        if (worker.exitCode !== null) throw new Error(logs)
        return brokerHealth(locations.socket)
      }, "external worker ready")
    }
    await start()
    assert.equal((await request("/remote-shells")).status, 401)
    assert.equal((await request("/remote-servers/local/connect", "POST", {})).status, 401)
    const login = await request("/login", "POST", { password: "broker-test-password" })
    assert.equal(login.status, 302)
    cookie = login.headers["set-cookie"].map((value) => value.split(";")[0]).join("; ")
    assert.equal(
      (await request("/remote-servers/local/connect", "POST", {}, { origin: "https://evil.invalid" })).status,
      403,
    )
    const deniedWs = new WebSocket(`ws+unix://${launcherSocket}:/remote-shell/local`, {
      headers: { host: "localhost" },
    })
    sockets.add(deniedWs)
    await new Promise((resolve, reject) => {
      deniedWs.once("unexpected-response", (_req, res) => {
        assert.equal(res.statusCode, 401)
        res.resume()
        resolve()
      })
      deniedWs.once("open", () => reject(new Error("Unauthenticated websocket accepted")))
      deniedWs.once("error", reject)
    })
    assert.equal((await request("/remote-servers/local/connect", "POST", {})).status, 200)
    const editorBefore = JSON.parse((await request("/remote/local/probe?check=1")).text)
    assert.equal(editorBefore.url, "/probe?check=1")
    const brokerBefore = await brokerHealth(locations.socket)
    const isolatedArgs = { auth: "none", "user-data-dir": path.join(dir, "isolated") }
    const concurrent = await Promise.all([ensureSessionBroker(isolatedArgs), ensureSessionBroker(isolatedArgs)])
    assert.equal(concurrent[0], concurrent[1])
    assert.notEqual(concurrent[0], locations.socket)
    assert.notEqual((await brokerHealth(concurrent[0])).pid, brokerBefore.pid)
    assert.equal((await fs.stat(locations.socket)).mode & 0o777, 0o600)
    assert.equal((await fs.stat(locations.directory)).mode & 0o777, 0o700)
    if (!external) assert.ok(!(await fs.readFile(locations.config, "utf8")).includes("broker-test-password"))
    const ws = await connectShell()
    ws.send(JSON.stringify({ d: "export CSR_TEST_MARKER=kept; printf 'SHELL_PID=%s\\n' $$\r" }))
    await until(() => /SHELL_PID=\d+/.test(ws.output), "initial shell PID")
    const shellPid = /SHELL_PID=(\d+)/.exec(ws.output)[1]
    ws.send(JSON.stringify({ d: `sleep 2; printf 'FINISHED_WHILE_DOWN\\n' > '${dir}/finished'\r` }))
    const shellsBefore = JSON.parse((await request("/remote-shells")).text)
    assert.equal(shellsBefore.length, 1)
    await stop()
    // The background worker and terminal must run even with no launcher at all.
    await until(
      () => fs.readFile(path.join(dir, "finished"), "utf8").catch(() => false),
      "work continues during downtime",
    )
    process.kill(Number(shellPid), 0)
    assert.deepEqual(await brokerHealth(locations.socket), brokerBefore)
    await start()
    const shellsAfter = JSON.parse((await request("/remote-shells")).text)
    assert.equal(shellsAfter[0].id, shellsBefore[0].id)
    assert.equal(shellsAfter[0].started, shellsBefore[0].started)
    assert.equal(JSON.parse((await request("/remote-servers")).text)[0].connected, true)
    const editorAfter = JSON.parse((await request("/remote/local/probe?check=1")).text)
    assert.deepEqual(editorAfter, editorBefore)
    console.log(
      `Mode=${external ? "external" : "tmux"}. Preserved PIDs: broker=${brokerBefore.pid}, editor=${editorBefore.pid}, shell=${shellPid}`,
    )
    const attached = await connectShell(true)
    await until(() => attached.output.includes(`SHELL_PID=${shellPid}`), "terminal screen replay")
    attached.output = ""
    attached.send(JSON.stringify({ d: "printf 'REATTACHED=%s:%s\\n' $$ \"$CSR_TEST_MARKER\"\r" }))
    await until(() => attached.output.includes(`REATTACHED=${shellPid}:kept`), "same live shell and environment")
    const editorWs = new WebSocket(`ws+unix://${launcherSocket}:/remote/local/echo`, {
      headers: { host: "localhost", cookie },
    })
    sockets.add(editorWs)
    await once(editorWs, "open")
    const echoed = once(editorWs, "message")
    editorWs.send("editor websocket after restart")
    assert.equal((await echoed)[0].toString(), "editor websocket after restart")
    assert.equal((await request("/remote-shells/persistent-test", "DELETE")).status, 200)
    await until(async () => JSON.parse((await request("/remote-shells")).text).length === 0, "explicit shell shutdown")
    assert.equal((await request("/remote-servers/local/disconnect", "POST", {})).status, 200)
    console.log(
      "PASS: authentication, origin checks, private socket, launcher process restart, same broker/editor/shell PIDs, work during downtime, screen replay, environment, HTTP and WebSocket forwarding, explicit shutdown",
    )
  } finally {
    for (const ws of sockets) ws.terminate()
    await stop()
    if (worker && worker.exitCode === null) {
      const exited = once(worker, "exit")
      worker.kill("SIGTERM")
      await exited
    }
    for (const session of [locations.session, isolated.session]) {
      try {
        execFileSync("tmux", ["kill-session", "-t", session], { stdio: "ignore" })
      } catch {}
    }
    await fs.rm(dir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
