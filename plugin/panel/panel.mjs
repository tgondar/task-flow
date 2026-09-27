#!/usr/bin/env node
// Starts the task-flow panel, or finds the one already running.
//
//   node plugin/panel/panel.mjs [--port <n>] [--open] [--quiet]
//
// install.ps1 registers this to run when the user logs on to Windows, so the
// panel is simply there. Run by hand, it prints the address (and opens it with
// --open). A second start does not start a second server: the running one is
// found through <home>/panel/server.json and reused, but only once it has
// answered like a task-flow panel on that port - a registry that points at some
// other program, or at a process that is gone, is ignored.
//
// task-flow works the same with the panel stopped or never installed; the panel
// only reads what task-flow leaves for it and writes answers task-flow takes in
// when it chooses to (see server.mjs).

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { DEFAULT_PORT, startPanel } from "./server.mjs";

const require = createRequire(import.meta.url);
const { homePath } = require("../scripts/config.js");

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, open: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--open") out.open = true;
    else if (argv[i] === "--quiet") out.quiet = true;
    else if (argv[i] === "--port") {
      const value = Number(argv[i + 1]);
      if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error("--port takes a port number");
      out.port = value;
      i += 1;
    } else throw new Error(`unknown option ${JSON.stringify(argv[i]).slice(0, 40)}`);
  }
  return out;
}

/** The panel already running, if there is one that answers like a panel. */
async function running() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(homePath(["panel", "server.json"]), "utf8"));
  } catch {
    return null;
  }
  if (!info || !Number.isInteger(info.port) || !Number.isInteger(info.pid)) return null;
  try {
    process.kill(info.pid, 0);
  } catch {
    return null;
  }
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/projects`, { signal: AbortSignal.timeout(1500) });
    const body = await response.json();
    if (response.ok && Array.isArray(body.projects)) return `http://127.0.0.1:${info.port}/`;
  } catch {
    /* not answering, or not a panel */
  }
  return null;
}

function openInBrowser(url) {
  const [command, args] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(command, args, { stdio: "ignore", detached: true }).unref();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const existing = await running();
  if (existing) {
    if (!options.quiet) console.log(`task-flow panel already running: ${existing}`);
    if (options.open) openInBrowser(existing);
    return;
  }
  const panel = await startPanel({ port: options.port, quiet: options.quiet });
  if (options.open) openInBrowser(panel.url);
  const stop = () => panel.close().then(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => {
  console.error(`task-flow panel: ${error.message}`);
  process.exit(1);
});
