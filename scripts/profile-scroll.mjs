#!/usr/bin/env node
/**
 * Scroll smoothness capture for OpenChamber.
 *
 * Scrolls one surface with real wheel input and reports what a user sees: how
 * many frames the display got, how many it missed, and the longest stall. The
 * frame budget is the display's own refresh interval, measured before the
 * scroll starts, so the same command judges a 60 Hz and a 144 Hz screen
 * against what each can show.
 *
 * Surfaces:
 * - `chat`: the session timeline, scrolled up into history by default;
 * - `sidebar`: the session sidebar, scrolled down;
 * - `diff`: the stacked changes diff, opened through `?tab=diff`, scrolled down.
 *
 * Alongside the frames it records Long Animation Frame attribution (which
 * script owned each slow frame, and how much of it was forced layout), the
 * timeline trace, a CPU profile, and the requests and storage writes the app
 * made during the scroll: background work competes for the same frames.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

import { CdpClient, createPageTarget, evaluateValue, launchChrome, reservePort, resolveChrome, wait } from "./perf/cdp.mjs"
import { summarizeCpuProfile } from "./perf/cpu-profile.mjs"
import { percentile, round, summarizeLongTasks, summarizeTraceEvents } from "./perf/metrics.mjs"
import { expandProjects } from "./perf/scenario.mjs"

const HELP = `Usage: bun run profile:scroll -- --surface <chat|sidebar|diff> [options]

Measures how smoothly one surface scrolls under real wheel input.

Options:
  --url <url>                OpenChamber URL (default: http://localhost:3000)
  --surface <name>           chat, sidebar or diff (required)
  --session <id>             Session to open (chat needs one)
  --expand-projects          Expand every sidebar project before measuring
  --direction <dir>          up, down or bounce (default: up for chat, down otherwise)
  --duration <seconds>       Length of the scroll (default: 8)
  --wheel-delta <px>         Pixels per wheel event (default: 120)
  --wheel-interval <ms>      Time between wheel events (default: 16)
  --settle <seconds>         Wait after load before measuring (default: 20)
  --output <directory>       Artifact directory (default: artifacts/scroll-profile-<time>)
  --baseline <directory>     Compare against a previous run's scroll-summary.json
  --budget-slow-frames <pct> Fail when more than this share of frames missed
                             the display's refresh
  --budget-longest-frame <ms> Fail when the longest frame exceeds this
  --save-trace               Also write the raw timeline trace
  --label <text>             Human label stored in the summary
  --chrome <path>            Chrome/Chromium executable
  --headless                 Run without a visible browser. Headless Chrome
                             draws at its own fixed rate, so frame figures
                             describe the page, not the display.
  --help                     Show this help

Needs a running OpenChamber server; see scripts/perf/DOCUMENTATION.md.
`

const SURFACES = new Set(["chat", "sidebar", "diff"])

const parseArgs = (argv) => {
  const options = {
    url: "http://localhost:3000",
    surface: null,
    session: null,
    expandProjects: false,
    direction: null,
    duration: 8,
    wheelDelta: 120,
    wheelInterval: 16,
    settle: 20,
    output: null,
    baseline: null,
    budgetSlowFrames: null,
    budgetLongestFrame: null,
    saveTrace: false,
    label: null,
    chrome: null,
    headless: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === "--help" || value === "-h") { console.log(HELP); process.exit(0) }
    else if (value === "--url") options.url = argv[++index]
    else if (value === "--surface") options.surface = argv[++index]
    else if (value === "--session") options.session = argv[++index]
    else if (value === "--expand-projects") options.expandProjects = true
    else if (value === "--direction") options.direction = argv[++index]
    else if (value === "--duration") options.duration = Number(argv[++index])
    else if (value === "--wheel-delta") options.wheelDelta = Number(argv[++index])
    else if (value === "--wheel-interval") options.wheelInterval = Number(argv[++index])
    else if (value === "--settle") options.settle = Number(argv[++index])
    else if (value === "--output") options.output = argv[++index]
    else if (value === "--baseline") options.baseline = argv[++index]
    else if (value === "--budget-slow-frames") options.budgetSlowFrames = Number(argv[++index])
    else if (value === "--budget-longest-frame") options.budgetLongestFrame = Number(argv[++index])
    else if (value === "--save-trace") options.saveTrace = true
    else if (value === "--label") options.label = argv[++index]
    else if (value === "--chrome") options.chrome = argv[++index]
    else if (value === "--headless") options.headless = true
    else throw new Error(`Unknown option: ${value}`)
  }
  if (!SURFACES.has(options.surface)) throw new Error("--surface must be chat, sidebar or diff")
  if (options.surface === "chat" && !options.session) throw new Error("--surface chat needs --session <id>")
  options.direction = options.direction ?? (options.surface === "chat" ? "up" : "down")
  if (!["up", "down", "bounce"].includes(options.direction)) throw new Error("--direction must be up, down or bounce")
  for (const key of ["duration", "wheelDelta", "wheelInterval", "settle"]) {
    if (!Number.isFinite(options[key]) || options[key] <= 0) throw new Error(`--${key} must be a positive number`)
  }
  return options
}

// Installed before any application code runs. Frames, long animation frames,
// requests and storage writes are only collected while `running` is set, so
// startup work never leaks into the measured window.
const PAGE_PROBE = `(() => {
  const state = { running: false, frames: [], loaf: [], requests: {}, storage: {} }
  const tick = (time) => { if (state.running) state.frames.push(time); requestAnimationFrame(tick) }
  requestAnimationFrame(tick)
  try {
    new PerformanceObserver((list) => {
      if (!state.running) return
      for (const entry of list.getEntries()) {
        state.loaf.push({
          duration: entry.duration,
          blocking: entry.blockingDuration,
          scripts: entry.scripts.map((script) => ({
            duration: script.duration,
            forcedLayout: script.forcedStyleAndLayoutDuration,
            invoker: script.invoker,
            source: (script.sourceURL || "").split("/").pop() + ":" + (script.sourceFunctionName || "(anonymous)"),
          })),
        })
      }
    }).observe({ type: "long-animation-frame", buffered: false })
  } catch {}
  const originalFetch = window.fetch
  window.fetch = function (input, init) {
    if (state.running) {
      try {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url, location.href)
        const key = url.pathname.replace(/ses_[A-Za-z0-9]+/g, ":session")
        state.requests[key] = (state.requests[key] || 0) + 1
      } catch {}
    }
    return originalFetch.apply(this, arguments)
  }
  const originalSetItem = Storage.prototype.setItem
  Storage.prototype.setItem = function (key, value) {
    if (!state.running) return originalSetItem.call(this, key, value)
    const startedAt = performance.now()
    const result = originalSetItem.call(this, key, value)
    const entry = state.storage[key] || (state.storage[key] = { writes: 0, bytes: 0, ms: 0 })
    entry.writes += 1
    entry.bytes += String(value).length
    entry.ms += performance.now() - startedAt
    return result
  }
  globalThis.__openchamberScrollProbe = state
})()`

// Resolves the element that actually scrolls for a surface and marks it, so
// later reads find the same element. The anchors are the attributes the
// application itself uses to find these containers.
const buildScrollerLookup = (surface) => `(() => {
  const scrolls = (element) => {
    const style = getComputedStyle(element)
    return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
  }
  const ancestorScroller = (element) => {
    for (let current = element; current; current = current.parentElement) if (scrolls(current)) return current
    return null
  }
  const surface = ${JSON.stringify(surface)}
  let scroller = null
  if (surface === "chat") scroller = ancestorScroller(document.querySelector('[data-scrollbar="chat"]'))
    ?? [...document.querySelectorAll('[data-scrollbar="chat"] *')].find(scrolls) ?? null
  if (surface === "sidebar") scroller = ancestorScroller(document.querySelector("[data-session-row]"))
  if (surface === "diff") scroller = [...document.querySelectorAll("[data-diff-virtual-root]")].find(scrolls) ?? null
  if (!scroller) return null
  scroller.setAttribute("data-scroll-profile-target", "")
  const rect = scroller.getBoundingClientRect()
  const x = Math.round(rect.left + rect.width / 2)
  const y = Math.round(rect.top + Math.min(rect.height / 2, 300))
  const hit = document.elementFromPoint(x, y)
  return {
    x, y,
    hitInside: Boolean(hit && scroller.contains(hit)),
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
  }
})()`

const summarizeFrames = (frames, idleMs) => {
  const startIndex = frames.findIndex((time) => time - frames[0] >= idleMs)
  const idleIntervals = []
  const intervals = []
  for (let index = 1; index < frames.length; index += 1) {
    const interval = frames[index] - frames[index - 1]
    if (startIndex === -1 || index <= startIndex) idleIntervals.push(interval)
    else intervals.push(interval)
  }
  // The median idle interval is the display's refresh interval. A frame that
  // took longer than one and a half of those missed at least one refresh.
  const refreshMs = percentile(idleIntervals, 0.5)
  const share = (threshold) => intervals.length === 0 ? 0 : round((100 * intervals.filter((interval) => interval > threshold).length) / intervals.length, 1)
  const elapsed = intervals.reduce((total, interval) => total + interval, 0)
  return {
    refreshMs,
    refreshHz: refreshMs > 0 ? round(1000 / refreshMs, 0) : null,
    frames: intervals.length,
    fps: elapsed > 0 ? round((1000 * intervals.length) / elapsed, 1) : 0,
    p50: percentile(intervals, 0.5),
    p95: percentile(intervals, 0.95),
    p99: percentile(intervals, 0.99),
    longest: round(intervals.reduce((max, interval) => Math.max(max, interval), 0)),
    slowFramePercent: share(refreshMs * 1.5),
    over33msPercent: share(34),
  }
}

const summarizeLongAnimationFrames = (entries) => {
  const byScript = new Map()
  for (const entry of entries) {
    for (const script of entry.scripts) {
      const key = `${script.invoker} | ${script.source}`
      const total = byScript.get(key) ?? { script: key, count: 0, durationMs: 0, forcedLayoutMs: 0 }
      total.count += 1
      total.durationMs += script.duration
      total.forcedLayoutMs += script.forcedLayout
      byScript.set(key, total)
    }
  }
  return {
    count: entries.length,
    totalMs: round(entries.reduce((total, entry) => total + entry.duration, 0)),
    longestMs: round(entries.reduce((max, entry) => Math.max(max, entry.duration), 0)),
    topScripts: [...byScript.values()]
      .sort((left, right) => right.durationMs - left.durationMs)
      .slice(0, 12)
      .map((total) => ({ ...total, durationMs: round(total.durationMs), forcedLayoutMs: round(total.forcedLayoutMs) })),
  }
}

const COMPARED_METRICS = [
  ["frames.fps", "fps"],
  ["frames.slowFramePercent", "slow frames %"],
  ["frames.p95", "frame p95 (ms)"],
  ["frames.longest", "longest frame (ms)"],
  ["longAnimationFrames.totalMs", "long animation frames (ms)"],
  ["domNodes.after", "DOM nodes"],
]

const readPath = (object, path) => path.split(".").reduce((value, key) => value?.[key], object)

const printComparison = (current, baseline) => {
  const rows = []
  for (const [path, label] of COMPARED_METRICS) {
    const now = readPath(current, path)
    const then = readPath(baseline, path)
    if (!Number.isFinite(now) || !Number.isFinite(then)) continue
    rows.push({ metric: label, baseline: then, current: now, delta: round(now - then) })
  }
  console.table(rows)
}

const main = async () => {
  const options = parseArgs(process.argv.slice(2))
  const output = resolve(options.output ?? join("artifacts", `scroll-profile-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  await mkdir(output, { recursive: true })
  const baseline = options.baseline
    ? JSON.parse(await readFile(join(resolve(options.baseline), "scroll-summary.json"), "utf8"))
    : null
  // One browser profile per surface: the app persists open panels, so a diff
  // run would otherwise leave a 40k-node diff mounted under the next sidebar run.
  const profileDir = join(homedir(), ".cache", `openchamber-perf-scroll-profile-${options.surface}`)
  const chrome = resolveChrome(options.chrome)
  const port = await reservePort()
  const chromeProcess = launchChrome({ chrome, profileDir, port, headless: options.headless, extraArgs: ["--window-size=1600,1000"] })
  let client
  try {
    const target = await createPageTarget(port)
    client = new CdpClient(target.webSocketDebuggerUrl)
    await client.connect()
    await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("Profiler.enable")])
    await client.send("Network.setBypassServiceWorker", { bypass: true }).catch(() => {})
    // A fixed viewport keeps the wheel target where it was resolved even when
    // a window manager resizes the browser window.
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false })
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_PROBE })
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("openchamber_stream_perf", "1") } catch {}` })

    const url = new URL(options.url)
    if (options.session) url.searchParams.set("session", options.session)
    if (options.surface === "diff") url.searchParams.set("tab", "diff")
    let loaded = client.once("Page.loadEventFired", 60_000)
    await client.send("Page.navigate", { url: url.toString() })
    await loaded
    if (options.expandProjects) {
      await expandProjects(client)
      loaded = client.once("Page.loadEventFired", 60_000)
      await client.send("Page.reload")
      await loaded
    }
    console.log(`Loaded ${url}; settling for ${options.settle}s.`)
    await wait(options.settle * 1000)

    const scroller = await evaluateValue(client, buildScrollerLookup(options.surface))
    if (!scroller) throw new Error(`No scrollable ${options.surface} surface on the page; the scenario never ran.`)
    if (!scroller.hitInside) throw new Error(`The wheel target (${scroller.x}, ${scroller.y}) is covered by another element; the scroll would not reach the ${options.surface}.`)
    // A hidden window or a display that is off draws no frames, and wheel input
    // then waits for a frame that never comes: fail instead of hanging.
    const liveFrames = await evaluateValue(client, `new Promise((resolveFrames) => {
      let frames = 0
      let running = true
      const tick = () => { if (!running) return; frames += 1; requestAnimationFrame(tick) }
      requestAnimationFrame(tick)
      setTimeout(() => { running = false; resolveFrames(frames) }, 1000)
    })`)
    if (Number(liveFrames) < 20) throw new Error(`The page drew ${liveFrames} frames in one second: the window is hidden or the display is off, so frame figures would be meaningless.`)
    if (options.surface === "chat") {
      const messages = await evaluateValue(client, `document.querySelectorAll("[data-message-id]").length`)
      if (!messages) throw new Error("The timeline rendered no messages; the chat scenario never ran.")
    }
    console.log(`Scrolling ${options.surface} ${options.direction} for ${options.duration}s (content ${scroller.scrollHeight}px, viewport ${scroller.clientHeight}px).`)

    const domBefore = await evaluateValue(client, `document.getElementsByTagName("*").length`)
    const traceEvents = []
    client.on("Tracing.dataCollected", ({ value }) => { for (const event of value ?? []) traceEvents.push(event) })
    await client.send("Tracing.start", {
      transferMode: "ReportEvents",
      // `RunTask` only exists under the disabled-by-default timeline category.
      categories: ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.frame", "blink.user_timing"].join(","),
    })
    await evaluateValue(client, `window.__openchamberStreamPerformance?.reset?.()`)
    await client.send("Profiler.setSamplingInterval", { interval: 250 })
    await client.send("Profiler.start")
    await evaluateValue(client, `globalThis.__openchamberScrollProbe.running = true`)

    // A quiet second first: its frame intervals are the display's refresh.
    const idleMs = 1500
    await wait(idleMs)
    const startedAt = Date.now()
    let direction = options.direction === "down" ? 1 : -1
    let wheelEvents = 0
    while (Date.now() - startedAt < options.duration * 1000) {
      if (options.direction === "bounce" && wheelEvents > 0 && wheelEvents % 40 === 0) direction = -direction
      await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: scroller.x, y: scroller.y, deltaX: 0, deltaY: direction * options.wheelDelta })
      wheelEvents += 1
      await wait(options.wheelInterval)
    }
    await wait(500)
    await evaluateValue(client, `globalThis.__openchamberScrollProbe.running = false`)
    const { profile } = await client.send("Profiler.stop")
    const tracingComplete = client.once("Tracing.tracingComplete", 120_000)
    await client.send("Tracing.end")
    await tracingComplete

    const probe = await evaluateValue(client, `JSON.parse(JSON.stringify(globalThis.__openchamberScrollProbe))`)
    const scrollTopAfter = await evaluateValue(client, `document.querySelector("[data-scroll-profile-target]")?.scrollTop ?? null`)
    const domAfter = await evaluateValue(client, `document.getElementsByTagName("*").length`)
    const counters = await evaluateValue(client, `(window.__openchamberStreamPerformance?.getSnapshot?.().entries ?? []).map((entry) => [entry.metric, entry.count])`)

    const frames = summarizeFrames(probe.frames, idleMs)
    if (frames.frames === 0) throw new Error("The page produced no frames while scrolling; the renderer was throttled or hidden.")
    if (frames.refreshMs > 20) console.warn(`Warning: the idle frame interval was ${frames.refreshMs}ms; the renderer may be throttled or the display runs below 50 Hz.`)
    if (scrollTopAfter === null) throw new Error("The scroll target left the page during the capture.")
    const scrolledPx = Math.abs(scrollTopAfter - scroller.scrollTop)
    if (scrolledPx === 0) throw new Error("The surface did not move; the wheel events never scrolled it.")

    const summary = {
      recordedAt: new Date().toISOString(),
      label: options.label,
      url: url.toString(),
      surface: options.surface,
      direction: options.direction,
      headless: options.headless,
      wheelEvents,
      scrolledPx,
      frames,
      longAnimationFrames: summarizeLongAnimationFrames(probe.loaf),
      domNodes: { before: domBefore, after: domAfter },
      requests: Object.entries(probe.requests).sort((left, right) => right[1] - left[1]).slice(0, 20),
      storageWrites: Object.entries(probe.storage)
        .sort((left, right) => right[1].ms - left[1].ms)
        .slice(0, 10)
        .map(([key, entry]) => ({ key, writes: entry.writes, bytes: entry.bytes, ms: round(entry.ms) })),
      longTasks: summarizeLongTasks(traceEvents, 16),
      trace: summarizeTraceEvents(traceEvents, 15),
      cpuProfile: summarizeCpuProfile(profile, 25),
      renderCounters: Object.fromEntries((counters ?? []).filter(([metric]) => metric.endsWith(".render") || metric.includes("rebuilt"))),
    }
    await writeFile(join(output, "scroll-summary.json"), JSON.stringify(summary, null, 2))
    await writeFile(join(output, "cpu-profile.cpuprofile"), JSON.stringify(profile))
    if (options.saveTrace) await writeFile(join(output, "trace.json"), JSON.stringify({ traceEvents }))

    console.log("")
    console.log(`Display refresh   ${frames.refreshMs}ms (~${frames.refreshHz} Hz)${options.headless ? ", headless" : ""}`)
    console.log(`Frames            ${frames.frames} at ${frames.fps} fps; p50 ${frames.p50}ms, p95 ${frames.p95}ms, p99 ${frames.p99}ms, longest ${frames.longest}ms`)
    console.log(`Missed refresh    ${frames.slowFramePercent}% of frames (${frames.over33msPercent}% longer than 33ms)`)
    console.log(`Long anim. frames ${summary.longAnimationFrames.count}, ${summary.longAnimationFrames.totalMs}ms in total, longest ${summary.longAnimationFrames.longestMs}ms`)
    console.log(`Scrolled          ${scrolledPx}px with ${wheelEvents} wheel events; DOM ${domBefore} → ${domAfter} nodes`)
    for (const script of summary.longAnimationFrames.topScripts.slice(0, 6)) {
      console.log(`  ${String(script.durationMs).padStart(8)}ms ${String(script.count).padStart(4)}x  forced layout ${script.forcedLayoutMs}ms  ${script.script}`)
    }
    const requestTotal = summary.requests.reduce((total, [, count]) => total + count, 0)
    if (requestTotal > 0) console.log(`Background requests during the scroll: ${requestTotal} (${summary.requests.slice(0, 4).map(([path, count]) => `${path} ${count}`).join(", ")})`)
    for (const write of summary.storageWrites.slice(0, 3)) console.log(`Storage writes: ${write.key} ${write.writes}x, ${write.bytes} bytes, ${write.ms}ms`)
    if (baseline) printComparison(summary, baseline)
    console.log(`Artifacts written to ${output}`)

    const failures = []
    if (options.budgetSlowFrames !== null && frames.slowFramePercent > options.budgetSlowFrames) failures.push(`${frames.slowFramePercent}% slow frames exceeds ${options.budgetSlowFrames}%`)
    if (options.budgetLongestFrame !== null && frames.longest > options.budgetLongestFrame) failures.push(`longest frame ${frames.longest}ms exceeds ${options.budgetLongestFrame}ms`)
    if (failures.length > 0) {
      console.error(`Budget exceeded: ${failures.join("; ")}`)
      process.exitCode = 1
    }
  } finally {
    client?.close()
    chromeProcess.kill()
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
