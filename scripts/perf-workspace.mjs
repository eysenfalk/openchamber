#!/usr/bin/env node
/**
 * Builds and serves a production-scale workspace for performance captures.
 *
 * Most performance problems in OpenChamber are threshold effects: a sidebar
 * that is fast with ten projects and slow with four hundred, a timeline that is
 * fast with fifty messages and slow with a thousand. A development machine is
 * usually below every threshold, so the profilers need a workspace that is not.
 *
 * Everything lives under one root directory with its own HOME, so the
 * workspace never reads or writes the user's real OpenCode or OpenChamber data:
 *
 *   <root>/home            isolated HOME: OpenChamber settings, OpenCode database
 *   <root>/projects        one git repository per project
 *   <root>/massive         optional: 100k files, ~1k changed files, one
 *                          20k-line rewrite, 300 untracked files
 *   <root>/workspace.json  what was built, read by the serve command
 *
 * Sessions and messages are created through the supported `openchamber
 * session` CLI against the fixture provider, so OpenCode stores them exactly as
 * it stores real ones; nothing writes OpenCode's private database schema.
 */

import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"

import { fixtureProviderConfig, startFixtureProvider } from "./perf/fixture-provider.mjs"
import { createProjectIdFromPath } from "../packages/web/server/lib/projects/project-id.js"

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CLI = join(REPO, "packages", "web", "bin", "cli.js")

const HELP = `Usage:
  bun run perf:workspace -- create [options]
  bun run perf:workspace -- serve [options]

create  Builds the workspace. Starts its own server while seeding sessions and
        stops it afterwards. Creating over an existing root replaces it.
serve   Serves an existing workspace until interrupted, with the fixture
        provider registered, for the profile:* commands to measure.

Options:
  --root <directory>          Workspace root (default: <tmp>/openchamber-perf-workspace)
  --port <port>               OpenChamber port (default: 4599)
  --provider-port <port>      Fixture provider port (default: 4601)
  --dist <directory>          UI build to serve (default: packages/web/dist)

create only:
  --projects <n>              Projects in the sidebar (default: 400)
  --sessions <n>              Sessions spread over the projects (default: 1000)
  --long-session-turns <n>    Agent turns in one long session in the first
                              project, 20 tool calls each, about 22 messages
                              per turn (default: 55, about 1.2k messages)
  --massive-repo              Also build the massive repository and add it as
                              the second project
  --concurrency <n>           Parallel session creations (default: 8)
  --help                      Show this help

Build the UI first: bun run build:ui && bun run build:web
`

const parseArgs = (argv) => {
  const options = {
    command: null,
    root: join(tmpdir(), "openchamber-perf-workspace"),
    port: 4599,
    providerPort: 4601,
    dist: join(REPO, "packages", "web", "dist"),
    projects: 400,
    sessions: 1000,
    longSessionTurns: 55,
    massiveRepo: false,
    concurrency: 8,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help" || value === "-h") { console.log(HELP); process.exit(0) }
    else if (value === "create" || value === "serve") options.command = value
    else if (value === "--root") options.root = resolve(argv[++index])
    else if (value === "--port") options.port = Number(argv[++index])
    else if (value === "--provider-port") options.providerPort = Number(argv[++index])
    else if (value === "--dist") options.dist = resolve(argv[++index])
    else if (value === "--projects") options.projects = Number(argv[++index])
    else if (value === "--sessions") options.sessions = Number(argv[++index])
    else if (value === "--long-session-turns") options.longSessionTurns = Number(argv[++index])
    else if (value === "--massive-repo") options.massiveRepo = true
    else if (value === "--concurrency") options.concurrency = Number(argv[++index])
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!options.command) throw new Error("Choose a command: create or serve (see --help)")
  for (const key of ["port", "providerPort", "projects", "sessions", "longSessionTurns", "concurrency"]) {
    if (!Number.isInteger(options[key]) || options[key] < 0) throw new Error(`--${key} must be a whole number`)
  }
  if (options.projects < 1) throw new Error("--projects must be at least 1")
  return options
}

const layout = (root) => {
  const home = join(root, "home")
  return {
    root,
    home,
    dataDir: join(home, ".config", "openchamber"),
    projects: join(root, "projects"),
    massive: join(root, "massive"),
    manifest: join(root, "workspace.json"),
  }
}

// The server and every CLI call see only the workspace: settings, the
// OpenCode database and OpenCode's config all follow HOME and the XDG
// directories, and an inherited OPENCHAMBER_ or OPENCODE_ variable could
// point back at the user's real data.
const isolatedEnv = (paths, options) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(OPENCHAMBER_|OPENCODE_|ELECTRON_|NODE_OPTIONS$)/.test(key))),
  HOME: paths.home,
  USERPROFILE: paths.home,
  XDG_CONFIG_HOME: join(paths.home, ".config"),
  XDG_DATA_HOME: join(paths.home, ".local", "share"),
  XDG_STATE_HOME: join(paths.home, ".local", "state"),
  XDG_CACHE_HOME: join(paths.home, ".cache"),
  OPENCHAMBER_DATA_DIR: paths.dataDir,
  OPENCHAMBER_DIST_DIR: options.dist,
  OPENCODE_CONFIG_CONTENT: JSON.stringify(fixtureProviderConfig(options.providerPort)),
})

const git = (cwd, args) => execFileSync("git", ["-c", "user.email=perf@openchamber.invalid", "-c", "user.name=perf", ...args], { cwd, stdio: "ignore" })

const createRepository = (directory, files) => {
  for (const [path, text] of files) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), text)
  }
  git(directory, ["init", "-q"])
  git(directory, ["add", "-A"])
  git(directory, ["commit", "-qm", "fixture"])
}

const lines = (count, line) => Array.from({ length: count }, (_, index) => line(index)).join("\n") + "\n"

/**
 * 100 modules × 10 folders × 100 files, then a working tree that changes
 * about 1k of them (1.5k writes, some to the same file), rewrites every other line of one 20k-line file and adds
 * 300 untracked files: the scale at which the changes view, the diff and the
 * file tree stop being small.
 */
const createMassiveRepository = (directory) => {
  const files = []
  for (let module = 0; module < 100; module += 1) {
    for (let folder = 0; folder < 10; folder += 1) {
      for (let file = 0; file < 100; file += 1) {
        files.push([`src/mod${module}/sub${folder}/file${file}.ts`, lines(20, (line) => `export const v${file}_${line} = ${module * 1000 + folder * 100 + file + line}`)])
      }
    }
  }
  const huge = (changed) => lines(20_000, (line) => `export function fn${line}(x: number): number { return ${changed && line % 2 ? "-" : ""}x * ${line} }`)
  files.push(["src/huge.ts", huge(false)])
  createRepository(directory, files)

  for (let change = 0; change < 1500; change += 1) {
    const path = join(directory, "src", `mod${change % 100}`, `sub${Math.floor(change / 100) % 10}`, `file${(change * 7) % 100}.ts`)
    writeFileSync(path, lines(30, (line) => `export const changed${change}_${line} = ${change + line}`))
  }
  writeFileSync(join(directory, "src", "huge.ts"), huge(true))
  mkdirSync(join(directory, "untracked"), { recursive: true })
  for (let file = 0; file < 300; file += 1) writeFileSync(join(directory, "untracked", `new${file}.ts`), `export const n${file} = ${file}\n`)
}

const writeSettings = (paths, projectPaths) => {
  const now = Date.now()
  const projects = projectPaths.map((path, index) => ({
    id: createProjectIdFromPath(path),
    path,
    label: path.split("/").pop(),
    addedAt: now - index * 1000,
    lastOpenedAt: now - index * 1000,
  }))
  mkdirSync(paths.dataDir, { recursive: true })
  writeFileSync(join(paths.dataDir, "settings.json"), JSON.stringify({
    projects,
    activeProjectId: projects[0].id,
    lastDirectory: projectPaths[0],
    homeDirectory: paths.home,
    reportUsage: false,
  }, null, 2))
}

const runSessionCli = (paths, options, args, { timeoutMs = 600_000 } = {}) => new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [CLI, "session", ...args, "--port", String(options.port), "--json"], {
    env: isolatedEnv(paths, options),
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`session ${args[0]} timed out`)) }, timeoutMs)
  child.stdout.on("data", (chunk) => { stdout += chunk })
  child.stderr.on("data", (chunk) => { stderr += chunk })
  child.on("error", (error) => { clearTimeout(timer); reject(error) })
  child.on("close", (code) => {
    clearTimeout(timer)
    if (code !== 0) { reject(new Error(`session ${args[0]} exited with ${code}: ${(stderr || stdout).trim().slice(0, 400)}`)); return }
    try { resolvePromise(JSON.parse(stdout)) } catch { reject(new Error(`session ${args[0]} returned unparseable output: ${stdout.slice(0, 400)}`)) }
  })
})

const startServer = async (paths, options) => {
  const provider = await startFixtureProvider(options.providerPort)
  const server = spawn(process.execPath, [CLI, "serve", "--port", String(options.port), "--foreground"], {
    cwd: paths.root,
    env: isolatedEnv(paths, options),
    stdio: ["ignore", "ignore", "inherit"],
  })
  const stop = async () => {
    provider.close()
    if (server.exitCode !== null) return
    const exited = new Promise((resolveExit) => server.once("exit", resolveExit))
    server.kill("SIGTERM")
    await Promise.race([exited, new Promise((resolveWait) => setTimeout(resolveWait, 10_000))])
  }
  // Ready means the CLI can reach OpenCode through the server, not merely that
  // the port answers.
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      provider.close()
      throw new Error(`The OpenChamber server exited with ${server.exitCode} before it was ready.`)
    }
    const ready = await runSessionCli(paths, options, ["list", "--limit", "1"], { timeoutMs: 15_000 }).then(() => true, () => false)
    if (ready) return { stop }
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000))
  }
  await stop()
  throw new Error("The OpenChamber server did not become ready within 120s.")
}

// A realistic sidebar is uneven: a few projects hold most sessions and the
// long tail holds one or two. Project i gets a share proportional to 1/(i+1).
const distributeSessions = (sessionCount, projectCount) => {
  const weights = Array.from({ length: projectCount }, (_, index) => 1 / (index + 1))
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const counts = weights.map((weight) => Math.floor((weight / total) * sessionCount))
  let remaining = sessionCount - counts.reduce((sum, count) => sum + count, 0)
  for (let index = counts.length - 1; remaining > 0; remaining -= 1) {
    counts[index] += 1
    index = index === 0 ? counts.length - 1 : index - 1
  }
  return counts
}

const runPool = async (tasks, concurrency, onProgress) => {
  let next = 0
  let done = 0
  const failures = []
  const worker = async () => {
    while (next < tasks.length) {
      const task = tasks[next]
      next += 1
      try { await task() } catch (error) { failures.push(error) }
      done += 1
      onProgress(done)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return failures
}

const seedLongSession = async (paths, options, directory) => {
  const { sessionId } = await runSessionCli(paths, options, ["create", "--dir", directory, "--title", "Fixture long session"])
  for (let turn = 1; turn <= options.longSessionTurns; turn += 1) {
    await runSessionCli(paths, options, [
      "send", "--dir", directory, "--session", sessionId,
      "--prompt", `Turn ${turn}: walk through the files again.`,
      "--model", "perf/agent-20tools-6000cps",
      "--wait", "--timeout", "600",
    ])
    if (turn % 5 === 0 || turn === options.longSessionTurns) console.log(`Long session: ${turn}/${options.longSessionTurns} turns`)
  }
  // Each turn is one user message and 21 assistant messages (20 tool steps and
  // the answer).
  return { id: sessionId, directory, turns: options.longSessionTurns, messages: options.longSessionTurns * 22 }
}

const create = async (options) => {
  const paths = layout(options.root)
  rmSync(options.root, { recursive: true, force: true })
  mkdirSync(paths.home, { recursive: true })

  const projectPaths = []
  for (let index = 0; index < options.projects; index += 1) {
    const directory = join(paths.projects, `project-${String(index).padStart(3, "0")}`)
    createRepository(directory, [["README.md", `# Project ${index}\n`]])
    projectPaths.push(directory)
  }
  console.log(`Created ${projectPaths.length} project repositories.`)
  if (options.massiveRepo) {
    createMassiveRepository(paths.massive)
    projectPaths.splice(1, 0, paths.massive)
    console.log(`Created the massive repository at ${paths.massive}.`)
  }
  writeSettings(paths, projectPaths)

  const manifest = {
    createdAt: new Date().toISOString(),
    projects: projectPaths.length,
    sessions: 0,
    longSession: null,
    massiveRepo: options.massiveRepo ? paths.massive : null,
  }
  const server = await startServer(paths, options)
  try {
    const counts = distributeSessions(options.sessions, projectPaths.length)
    const tasks = projectPaths.flatMap((directory, projectIndex) => Array.from({ length: counts[projectIndex] }, (_, sessionIndex) => () =>
      runSessionCli(paths, options, ["create", "--dir", directory, "--title", `Fixture session ${projectIndex}.${sessionIndex}`])))
    const failures = await runPool(tasks, options.concurrency, (done) => {
      if (done % 100 === 0 || done === tasks.length) console.log(`Sessions: ${done}/${tasks.length}`)
    })
    if (failures.length > 0) throw new Error(`${failures.length} session creations failed; first: ${failures[0].message}`)
    manifest.sessions = tasks.length

    if (options.longSessionTurns > 0) {
      manifest.longSession = await seedLongSession(paths, options, projectPaths[0])
      manifest.sessions += 1
    }
  } finally {
    await server.stop()
  }
  writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2))
  console.log(JSON.stringify(manifest, null, 2))
  console.log(`\nServe it with: bun run perf:workspace -- serve --root ${options.root}`)
}

const serve = async (options) => {
  const paths = layout(options.root)
  if (!existsSync(paths.manifest)) throw new Error(`No workspace at ${options.root}; run create first.`)
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"))
  const server = await startServer(paths, options)
  console.log(`Serving ${manifest.projects} projects and ${manifest.sessions} sessions on http://127.0.0.1:${options.port}`)
  if (manifest.longSession) console.log(`Long session: ${manifest.longSession.id} (${manifest.longSession.messages} messages) in ${manifest.longSession.directory}`)
  if (manifest.massiveRepo) console.log(`Massive repository: ${manifest.massiveRepo}`)
  console.log("Press Ctrl-C to stop.")
  await new Promise((resolveSignal) => {
    process.once("SIGINT", resolveSignal)
    process.once("SIGTERM", resolveSignal)
  })
  await server.stop()
}

const options = parseArgs(process.argv.slice(2))
const run = options.command === "create" ? create : serve
run(options).catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
