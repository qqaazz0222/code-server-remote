import cookieParser from "cookie-parser"
import express from "express"
import { promises as fs } from "fs"
import * as http from "http"
import { DefaultedArgs, parse, setDefaults } from "./cli"
import { errorHandler, wsErrorHandler } from "./routes/errors"
import * as remote from "./routes/remote"
import { brokerHealth, brokerPaths, BROKER_PROTOCOL } from "./sessionBroker"
import { handleUpgrade, WebsocketRequest } from "./wsRouter"

async function main(): Promise<void> {
  process.umask(0o077)
  process.on("SIGTERM", () => process.exit(0))
  process.on("SIGINT", () => process.exit(0))
  process.on("SIGHUP", () => process.exit(0))
  const standalone = process.argv[2] === "--user-data-dir"
  const args: DefaultedArgs = standalone
    ? await setDefaults(parse(["--auth", "none", "--user-data-dir", process.argv[3]]))
    : JSON.parse(await fs.readFile(process.argv[2], "utf8"))
  const { socket, directory } = brokerPaths(args["user-data-dir"])
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
  if (standalone) {
    if (await brokerHealth(socket)) throw new Error("A session broker is already running for this data directory")
    await fs.rm(socket, { force: true })
  }
  const app = express()
  const ws = express()
  for (const router of [app, ws]) {
    router.disable("x-powered-by")
    router.use(cookieParser())
    router.use((req, _res, next) => {
      req.args = args
      next()
    })
  }
  app.get("/_broker/health", (_req, res) => res.json({ protocol: BROKER_PROTOCOL, pid: process.pid }))
  app.all("/remote/:id{/*path}", remote.proxy)
  app.use(express.json())
  app.use(express.urlencoded({ extended: true }))
  app.use(remote.router)
  app.use(errorHandler)
  ws.get("/remote/:id{/*path}", (req) => remote.wsProxy(req as unknown as WebsocketRequest))
  ws.get("/remote-shell/:id", (req) => remote.wsShell(req as unknown as WebsocketRequest))
  ws.use(wsErrorHandler)
  const server = http.createServer(app)
  handleUpgrade(ws, server)
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(socket, resolve)
  })
  await fs.chmod(socket, 0o600)
  await remote.startUptime({ args })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
