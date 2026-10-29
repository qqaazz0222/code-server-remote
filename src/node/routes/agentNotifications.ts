import * as crypto from "crypto"
import { Router } from "express"
import { promises as fs } from "fs"
import * as path from "path"
import { rootPath } from "../constants"
import { ensureAuthenticated, ensureOrigin } from "../http"

/** Per launcher instance. Publishers get a separate credential, never the login password. */
export function agentNotifications() {
  const router = Router()
  const epoch = crypto.randomBytes(8).toString("hex")
  const events: { id: number; tool: string; project: string; host: string; time: number }[] = []
  let sequence = 0
  let windowStart = 0
  let published = 0
  let tokenPromise: Promise<string> | undefined
  const token = (dir: string) =>
    (tokenPromise ||= (async () => {
      const file = path.join(dir, "agent-notifications-token")
      await fs.writeFile(file, crypto.randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }).catch((error) => {
        if (error.code !== "EEXIST") throw error
      })
      const value = (await fs.readFile(file, "utf8")).trim()
      if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("Invalid agent notification credential")
      return value
    })())

  router.use((_req, res, next) => {
    res.set("Cache-Control", "no-store")
    next()
  })
  router.post("/setup", ensureAuthenticated, ensureOrigin, async (req, res) => {
    res.json({ token: await token(req.args["user-data-dir"]) })
  })
  // Polling also works behind proxies that buffer streaming responses. A cursor
  // replays short disconnects; a fresh page starts at the current sequence.
  router.get("/events", ensureAuthenticated, (req, res) => {
    const after = Number(req.query.after)
    const replay = req.query.epoch === epoch && Number.isSafeInteger(after) && after >= 0
    res.json({ epoch, cursor: sequence, events: replay ? events.filter((e) => e.id > after) : [] })
  })
  router.use(async (req, res, next) => {
    const expected = await token(req.args["user-data-dir"])
    const actual = req.headers.authorization?.replace(/^Bearer /, "") || ""
    if (!/^[a-f0-9]{64}$/.test(actual) || !crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected))) {
      return res.sendStatus(401)
    }
    return next()
  })
  router.get("/install.py", async (_req, res) => {
    const source = await fs.readFile(path.join(rootPath, "src/browser/pages/agent-notify.py"), "utf8")
    const secret = await tokenPromise!
    res.type("text/plain").send(source.replace("TOKEN = None", `TOKEN = ${JSON.stringify(secret)}`))
  })
  router.post("/complete", (req, res) => {
    const { tool, cwd, host } = req.body || {}
    if (
      !["codex", "claude"].includes(tool) ||
      typeof cwd !== "string" ||
      cwd.length > 4096 ||
      typeof host !== "string" ||
      host.length > 255
    ) {
      return res.status(400).json({ error: "Invalid completion event" })
    }
    if (Date.now() - windowStart >= 60_000) {
      windowStart = Date.now()
      published = 0
    }
    if (++published > 120) return res.sendStatus(429)
    const clean = (s: string) =>
      [...s]
        .filter((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)
        .join("")
        .slice(0, 255)
    events.push({
      id: ++sequence,
      tool,
      project: clean(path.posix.basename(cwd.replace(/\\/g, "/")) || cwd || "Project"),
      host: clean(host),
      time: Date.now(),
    })
    if (events.length > 100) events.shift()
    return res.sendStatus(202)
  })
  return router
}
