// Drives a headless Chromium browser over the DevTools protocol (CDP), no dependencies:
// navigate, evaluate script, screenshot, and collect console/exception noise as it happens.
// Used by tests/viewer.smoke.js.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BROWSER_PATHS = [
  process.env.TASK_FLOW_BROWSER,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean);

export function findBrowser() {
  return BROWSER_PATHS.find((candidate) => existsSync(candidate)) ?? null;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForTarget(port, attempts = 80, intervalMs = 150) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(intervalMs);
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page) return page;
    } catch {
      // the DevTools endpoint is not listening yet
    }
  }
  return null;
}

// A tiny JSON-RPC layer over the CDP WebSocket: send() waits for the reply with a matching id,
// once() waits for the next unsolicited event of a given method, and every message not claimed
// by either is scanned for console/exception noise.
function makeRpc(socket, problems) {
  let nextId = 1;
  const pending = new Map();
  const waiters = [];

  function noteProblem(message) {
    if (message.method === "Runtime.exceptionThrown") {
      const details = message.params.exceptionDetails;
      problems.push(`exception: ${details.exception?.description ?? details.text}`);
    } else if (message.method === "Runtime.consoleAPICalled" && ["error", "warning"].includes(message.params.type)) {
      const text = message.params.args.map((arg) => arg.value ?? arg.description).join(" ");
      problems.push(`console.${message.params.type}: ${text}`);
    } else if (message.method === "Log.entryAdded" && message.params.entry.level === "error") {
      problems.push(`log: ${message.params.entry.text} ${message.params.entry.url ?? ""}`.trim());
    }
  }

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    noteProblem(message);
    for (const waiter of waiters.slice()) {
      if (waiter.method !== message.method) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message.params);
    }
  });

  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    once(method, timeoutMs = 15000) {
      return new Promise((resolve, reject) => {
        const waiter = { method, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index < 0) return;
          waiters.splice(index, 1);
          reject(new Error(`timed out: ${method}`));
        }, timeoutMs);
      });
    },
  };
}

export async function openBrowser(options = {}) {
  const { width = 1400, height = 1000, port = 9300 + Math.floor(Math.random() * 500) } = options;
  const binary = findBrowser();
  if (!binary) throw new Error("no Chromium browser found (set TASK_FLOW_BROWSER to point to one)");

  const profileDir = mkdtempSync(path.join(os.tmpdir(), "task-flow-browser-"));
  const child = spawn(binary, [
    "--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars",
    `--window-size=${width},${height}`, "about:blank",
  ], { stdio: "ignore" });

  const target = await waitForTarget(port);
  if (!target) {
    child.kill();
    throw new Error("the browser does not answer on the DevTools port");
  }

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const problems = [];
  const rpc = makeRpc(socket, problems);

  await rpc.send("Page.enable");
  await rpc.send("Runtime.enable");
  await rpc.send("Log.enable");

  let viewport = { width, height };
  const applyViewport = (w, h) => rpc.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 700 });
  await applyViewport(width, height);

  return {
    problems,
    async resize(w, h = viewport.height) {
      viewport = { width: w, height: h };
      await applyViewport(w, h);
    },
    async goto(url, settleMs = 600) {
      const loaded = rpc.once("Page.loadEventFired");
      await rpc.send("Page.navigate", { url });
      await loaded;
      await wait(settleMs);
    },
    async eval(expression) {
      const result = await rpc.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
      return result.result.value;
    },
    async screenshot(file, options = {}) {
      const { fullPage = true } = options;
      let clip;
      if (fullPage) {
        const metrics = await rpc.send("Page.getLayoutMetrics");
        const content = metrics.cssContentSize ?? metrics.contentSize;
        clip = { x: 0, y: 0, width: viewport.width, height: Math.ceil(Math.min(content.height, 12000)), scale: 1 };
      }
      const shot = await rpc.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: fullPage, ...(clip ? { clip } : {}) });
      await writeFile(file, Buffer.from(shot.data, "base64"));
      return file;
    },
    async close() {
      try {
        socket.close();
      } catch {
        // already closed
      }
      child.kill();
      await wait(300);
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // the browser still holds the folder: it will go away with the temp directory
      }
    },
  };
}
