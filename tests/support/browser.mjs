// Drives a headless browser (Edge or Chrome) over the DevTools protocol, with no dependencies:
// script evaluation, screenshots, console errors collected. From FluidPlan (engine/lib/browser.mjs,
// see plugin/panel/NOTICE.md); used by the panel smoke test only.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CANDIDATES = [
  process.env.TASK_FLOW_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

export function findBrowser() {
  return CANDIDATES.find((file) => existsSync(file)) ?? null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openBrowser({ width = 1400, height = 1000, port = 9300 + Math.floor(Math.random() * 500) } = {}) {
  const binary = findBrowser();
  if (!binary) throw new Error("no Chromium browser found (set TASK_FLOW_BROWSER to point to one)");
  const profile = mkdtempSync(path.join(os.tmpdir(), "task-flow-browser-"));
  const child = spawn(binary, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
    `--window-size=${width},${height}`, "about:blank",
  ], { stdio: "ignore" });

  let target = null;
  for (let i = 0; i < 80 && !target; i += 1) {
    await sleep(150);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      target = list.find((t) => t.type === "page");
    } catch {
      /* not ready yet */
    }
  }
  if (!target) {
    child.kill();
    throw new Error("the browser does not answer on the DevTools port");
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const waiters = [];
  const problems = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    if (message.method === "Runtime.exceptionThrown") {
      const d = message.params.exceptionDetails;
      problems.push(`exception: ${d.exception?.description ?? d.text}`);
    } else if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
      problems.push(`console.${message.params.type}: ${message.params.args.map((a) => a.value ?? a.description).join(" ")}`);
    } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      problems.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ""}`.trim());
    }
    for (const waiter of [...waiters]) {
      if (waiter.method === message.method) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message.params);
      }
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const once = (method, timeout = 15000) => new Promise((resolve, reject) => {
    const waiter = { method, resolve };
    waiters.push(waiter);
    setTimeout(() => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) {
        waiters.splice(index, 1);
        reject(new Error(`timed out: ${method}`));
      }
    }, timeout);
  });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");
  let size = { width, height };
  const setSize = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  await setSize(width, height);

  return {
    problems,
    async resize(w, h = size.height) {
      size = { width: w, height: h };
      await setSize(w, h);
    },
    async goto(url, settleMs = 600) {
      const loaded = once("Page.loadEventFired");
      await send("Page.navigate", { url });
      await loaded;
      await sleep(settleMs);
    },
    async eval(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async screenshot(file, { fullPage = true } = {}) {
      let clip;
      if (fullPage) {
        const metrics = await send("Page.getLayoutMetrics");
        const content = metrics.cssContentSize ?? metrics.contentSize;
        clip = { x: 0, y: 0, width: size.width, height: Math.ceil(Math.min(content.height, 12000)), scale: 1 };
      }
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
      await writeFile(file, Buffer.from(shot.data, "base64"));
      return file;
    },
    async close() {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      child.kill();
      await sleep(300);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {
        /* the browser still holds the folder: it will go away with the temp directory */
      }
    },
  };
}
