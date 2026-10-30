import { execFile } from "child_process"
import { createHash } from "crypto"
import { Request, Response } from "express"
import { promises as fs } from "fs"
import * as http from "http"
import * as path from "path"
import { promisify } from "util"
import { AuthType, DefaultedArgs } from "./cli"
import { ensureAuthenticated, ensureOrigin } from "./http"
import { proxy } from "./proxy"
import { WebsocketRequest } from "./wsRouter"

// AI usage and rebuilding hold no sessions: the launcher serves them, so they work without restarting the broker.
export const brokerRoutes = /^\/remote(?:\/|-(?:servers(?!\/(?:usage|rebuild)(?:\/|$))|shells|shell)(?:\/|$))/
export const BROKER_PROTOCOL = 1

export const brokerPaths = (dataDir: string) => {
  const directory = path.join(path.resolve(dataDir), "session-broker")
  return {
    directory,
    socket: path.join(directory, "broker.sock"),
    config: path.join(directory, "args.json"),
    session: `csr-sessions-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}`,
  }
}

export function brokerHealth(socket: string): Promise<{ protocol: number; pid: number } | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.get({ socketPath: socket, path: "/_broker/health", timeout: 1000 }, (res) => {
      let body = ""
      res.on("data", (chunk) => (body += chunk))
      res.on("end", () => {
        try {
          const health = JSON.parse(body)
          if (res.statusCode !== 200 || health.protocol !== BROKER_PROTOCOL || !Number.isInteger(health.pid)) {
            throw new Error("Incompatible session broker; keep it running until its sessions have ended")
          }
          resolve(health)
        } catch (error) {
          reject(error)
        }
      })
      res.on("error", reject)
    })
    req.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve(undefined)
      else reject(error)
    })
    req.on("timeout", () => req.destroy(new Error("Session broker health check timed out")))
  })
}

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`

/** tmux owns the worker, so systemd stopping the launcher's cgroup cannot kill its sessions. */
export async function ensureSessionBroker(args: DefaultedArgs): Promise<string> {
  const locations = brokerPaths(args["user-data-dir"])
  if (Buffer.byteLength(locations.socket) > 100) throw new Error("Session broker socket path is too long")
  await fs.mkdir(locations.directory, { recursive: true, mode: 0o700 })
  await fs.chmod(locations.directory, 0o700)
  if (await brokerHealth(locations.socket)) return locations.socket

  // A companion container owns production sessions. Never replace its socket
  // or attempt to start a worker inside the launcher container.
  if (process.env.CSR_SESSION_BROKER_EXTERNAL === "1") {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (await brokerHealth(locations.socket)) return locations.socket
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    throw new Error("External session broker is unavailable; start the session-broker service first")
  }

  const lock = path.join(locations.directory, "starting")
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(lock)
    } catch (error: any) {
      if (error.code !== "EEXIST") throw error
      if (await brokerHealth(locations.socket)) return locations.socket
      const locked = await fs.stat(lock).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error
        return undefined
      })
      if (locked && Date.now() - locked.mtimeMs > 30000) await fs.rmdir(lock).catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 100))
      continue
    }
    try {
      if (await brokerHealth(locations.socket)) return locations.socket
      // Only remove a stale socket after taking the startup lock and checking health.
      await fs.rm(locations.socket, { force: true })
      // Authentication stays in the launcher. Never persist its password in worker configuration.
      const config = { ...args, auth: AuthType.None, password: undefined, "hashed-password": undefined }
      await fs.writeFile(locations.config, JSON.stringify(config), { mode: 0o600 })
      const command = [process.execPath, path.join(__dirname, "sessionBrokerWorker.js"), locations.config]
        .map(quote)
        .join(" ")
      await promisify(execFile)("tmux", [
        // Do not start a tmux server inside the launcher service cgroup.
        "-N",
        "new-session",
        "-d",
        "-s",
        locations.session,
        "-c",
        process.cwd(),
        "-e",
        `PATH=${process.env.PATH || ""}`,
        "-e",
        `SSH_AUTH_SOCK=${process.env.SSH_AUTH_SOCK || ""}`,
        `exec ${command}`,
      ])
      while (Date.now() < deadline) {
        if (await brokerHealth(locations.socket)) return locations.socket
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      throw new Error(`Session broker failed to start; inspect tmux session ${locations.session}`)
    } finally {
      await fs.rmdir(lock)
    }
  }
  throw new Error("Timed out waiting for session broker startup lock")
}

export async function brokerHttp(socket: string, req: Request, res: Response): Promise<void> {
  await ensureAuthenticated(req)
  if (req.method !== "GET" && req.method !== "HEAD") ensureOrigin(req)
  proxy.web(req, res, {
    target: { socketPath: socket, host: "localhost", port: 0, path: req.originalUrl },
    ignorePath: true,
  })
}

export async function brokerWebsocket(socket: string, req: WebsocketRequest): Promise<void> {
  await ensureAuthenticated(req)
  ensureOrigin(req)
  proxy.ws(req, req.ws, req.head, {
    target: { socketPath: socket, host: "localhost", port: 0, path: req.originalUrl },
    ignorePath: true,
  })
  req.ws.resume()
}
