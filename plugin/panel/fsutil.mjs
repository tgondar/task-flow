// Small file helpers shared by the server and the CLI.
import { existsSync } from "node:fs";
import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

// Two-step write: a truncated file never replaces the good one.
export async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, "utf8");
  await rename(temp, file);
}

export async function writeJson(file, data) {
  await writeAtomic(file, JSON.stringify(data, null, 2) + "\n");
}

export async function readJson(file, fallback) {
  if (!existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw httpError(404, `file not found: ${file}`);
  }
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw httpError(400, `unreadable JSON in ${file}: ${error.message}`);
  }
}

export function isInside(base, target) {
  const relative = path.relative(base, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function safeJoin(base, relative) {
  const target = path.resolve(base, relative);
  return isInside(base, target) ? target : null;
}

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function toPosix(file) {
  return file.split(path.sep).join("/");
}
