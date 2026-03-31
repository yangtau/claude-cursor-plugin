#!/usr/bin/env node

/**
 * Session lifecycle hook for Cursor Companion.
 * - SessionStart: generates and exports CURSOR_COMPANION_SESSION_ID
 * - SessionEnd: cleans up session jobs and terminates running processes
 */

import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";

import { terminateProcessTree } from "./lib/process-utils.mjs";
import { loadState, resolveStateFile, saveState } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const SESSION_ID_ENV = "CURSOR_COMPANION_SESSION_ID";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    if (!raw) {
      return {};
    }
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

function cleanupSessionJobs(cwd, sessionId) {
  if (!cwd || !sessionId) {
    return;
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const stateFile = resolveStateFile(workspaceRoot);
  if (!fs.existsSync(stateFile)) {
    return;
  }

  const state = loadState(workspaceRoot);
  const removedJobs = state.jobs.filter((job) => job.sessionId === sessionId);
  if (removedJobs.length === 0) {
    return;
  }

  for (const job of removedJobs) {
    const stillRunning = job.status === "queued" || job.status === "running";
    if (!stillRunning) {
      continue;
    }
    try {
      terminateProcessTree(job.pid ?? Number.NaN);
    } catch {
      // Ignore teardown failures during session shutdown.
    }
  }

  saveState(workspaceRoot, {
    ...state,
    jobs: state.jobs.filter((job) => job.sessionId !== sessionId)
  });
}

function handleSessionStart(input) {
  const sessionId = input.session_id ?? crypto.randomUUID();
  appendEnvVar(SESSION_ID_ENV, sessionId);
  appendEnvVar(PLUGIN_DATA_ENV, process.env[PLUGIN_DATA_ENV]);
}

function handleSessionEnd(input) {
  const cwd = input.cwd || process.cwd();
  cleanupSessionJobs(cwd, input.session_id || process.env[SESSION_ID_ENV]);
}

const input = readHookInput();
const eventName = process.argv[2] ?? input.hook_event_name ?? "";

switch (eventName) {
  case "SessionStart":
    handleSessionStart(input);
    break;
  case "SessionEnd":
    handleSessionEnd(input);
    break;
  default:
    process.stderr.write(`Unknown lifecycle event: ${eventName}\n`);
    process.exitCode = 1;
}
