#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { parseArgs, splitRawArgumentString } from "./lib/args.mjs";
import { getCursorAvailability, getCursorLoginStatus, runCursorAgent } from "./lib/cursor.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  enrichJob,
  readStoredJob,
  resolveCancelableJob,
  resolveResultJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import { terminateProcessTree } from "./lib/process-utils.mjs";
import {
  renderSetupReport,
  renderTaskResult,
  renderReviewResult,
  renderStatusReport,
  renderJobStatusReport,
  renderCancelReport,
  renderStoredJobResult,
} from "./lib/render.mjs";
import {
  generateJobId,
  getConfig,
  listJobs,
  readJobFile,
  resolveJobFile,
  setConfig,
  deleteConfigKey,
  upsertJob,
  writeJobFile,
} from "./lib/state.mjs";
import {
  SESSION_ID_ENV,
  nowIso,
  createJobLogFile,
  createJobRecord,
  createJobProgressUpdater,
  createProgressReporter,
  runTrackedJob,
  appendLogBlock,
} from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;

// ── Helpers ──

function printUsage() {
  console.log(
    [
      "Usage:",
      "  cursor-companion setup [--json]",
      "  cursor-companion task [--background] [--write] [--model <model>] [--mode plan|ask] [prompt]",
      "  cursor-companion review [--model <model>] [focus text]",
      "  cursor-companion status [job-id] [--wait] [--timeout-ms <ms>] [--all] [--json]",
      "  cursor-companion result [job-id] [--json]",
      "  cursor-companion model [<model-id>] [--clear] [--json]",
      "  cursor-companion cancel [job-id] [--json]",
    ].join("\n")
  );
}

function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(typeof value === "string" ? value : JSON.stringify(value, null, 2));
  }
}

function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) return [];
    return splitRawArgumentString(raw);
  }
  return argv;
}

function parseCommandInput(argv, config = {}) {
  return parseArgs(normalizeArgv(argv), {
    ...config,
    aliasMap: { C: "cwd", ...(config.aliasMap ?? {}) },
  });
}

function resolveCommandCwd(options = {}) {
  return options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
}

function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shorten(text, limit = 96) {
  const normalized = String(text ?? "")
    .trim()
    .replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 3)}...`;
}

function ensureCursorReady() {
  const cursor = getCursorAvailability();
  if (!cursor.available) {
    throw new Error("cursor-agent is not installed. Install it from cursor.com or your package manager.");
  }
  const auth = getCursorLoginStatus();
  if (!auth.loggedIn) {
    throw new Error("cursor-agent is not authenticated. Run `!cursor-agent login` to log in.");
  }
}

function getDefaultModelForWorkspace(workspaceRoot) {
  const v = getConfig(workspaceRoot).defaultModel;
  if (v == null || String(v).trim() === "") return undefined;
  return String(v).trim();
}

async function listCursorModels() {
  const { execFileSync } = await import("node:child_process");
  let raw = "";
  try {
    raw = execFileSync("cursor-agent", ["--list-models"], {
      encoding: "utf8",
      timeout: 30000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Failed to list models. Is cursor-agent installed and authenticated?");
  }
  const clean = raw.replace(/\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?\x07/g, "").trim();
  const models = [];
  for (const line of clean.split("\n")) {
    const match = line.match(/^(\S+)\s+-\s+(.+?)(?:\s+\((default|current)\))?$/);
    if (match) {
      models.push({
        id: match[1],
        name: match[2].trim(),
        ...(match[3] ? { tag: match[3] } : {}),
      });
    }
  }
  return models;
}

async function waitForSingleJobSnapshot(cwd, reference, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let snapshot = buildSingleJobSnapshot(cwd, reference);

  while ((snapshot.job.status === "queued" || snapshot.job.status === "running") && Date.now() < deadline) {
    await sleep(Math.min(DEFAULT_STATUS_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    snapshot = buildSingleJobSnapshot(cwd, reference);
  }

  const waitTimedOut = snapshot.job.status === "queued" || snapshot.job.status === "running";
  return {
    ...snapshot,
    waitTimedOut,
    timeoutMs,
    job: {
      ...snapshot.job,
      waitTimedOut,
    },
  };
}

// ── Setup ──

function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  const cursor = getCursorAvailability();
  const auth = getCursorLoginStatus();

  const nextSteps = [];
  if (!cursor.available) {
    nextSteps.push("Install cursor-agent from cursor.com or via your package manager.");
  }
  if (cursor.available && !auth.loggedIn) {
    nextSteps.push("Run `!cursor-agent login` to authenticate.");
  }

  const report = {
    ready: cursor.available && auth.loggedIn,
    cursor,
    auth,
    nextSteps,
  };

  outputResult(options.json ? report : renderSetupReport(report), options.json);
}

// ── Task ──

async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "mode", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "background", "wait"],
    aliasMap: { m: "model" },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  ensureCursorReady();

  const effectiveModel = options.model ?? getDefaultModelForWorkspace(workspaceRoot) ?? undefined;

  // Read prompt
  let prompt;
  if (options["prompt-file"]) {
    prompt = fs.readFileSync(path.resolve(cwd, options["prompt-file"]), "utf8");
  } else {
    prompt = positionals.join(" ");
  }
  if (!prompt) {
    throw new Error("Provide a prompt for the task.");
  }

  const jobId = generateJobId("task");
  const jobRecord = createJobRecord({
    id: jobId,
    kind: "task",
    jobClass: "task",
    status: "queued",
    summary: shorten(prompt),
    write: Boolean(options.write),
  });

  if (options.background) {
    // Background execution: spawn detached worker
    upsertJob(workspaceRoot, jobRecord);

    const scriptPath = path.join(ROOT_DIR, "scripts", "cursor-companion.mjs");
    const child = spawn(
      process.execPath,
      [scriptPath, "task-worker", "--cwd", cwd, "--job-id", jobId],
      {
        cwd,
        env: process.env,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }
    );
    child.unref();

    upsertJob(workspaceRoot, { id: jobId, pid: child.pid });
    writeJobFile(workspaceRoot, jobId, {
      ...jobRecord,
      pid: child.pid,
      prompt,
      model: effectiveModel,
      mode: options.mode ?? undefined,
      write: Boolean(options.write),
    });

    const payload = { jobId, status: "queued", summary: jobRecord.summary };
    outputResult(
      options.json ? payload : `Cursor Agent task started in the background as ${jobId}. Check /cursor:status ${jobId} for progress.\n`,
      options.json
    );
    return;
  }

  // Foreground execution via tracked job
  const logFile = createJobLogFile(workspaceRoot, jobId, "Cursor Agent task");
  const progressUpdater = createJobProgressUpdater(workspaceRoot, jobId);
  const progressReporter = createProgressReporter({
    stderr: true,
    logFile,
    onEvent: progressUpdater,
  });

  const job = {
    ...jobRecord,
    workspaceRoot,
    logFile,
  };

  const execution = await runTrackedJob(job, async () => {
    progressReporter?.({ message: `Running task: ${shorten(prompt, 60)}`, phase: "running" });

    const result = await runCursorAgent({
      prompt,
      workspace: workspaceRoot,
      model: effectiveModel,
      mode: options.mode ?? undefined,
      write: Boolean(options.write),
      outputFormat: "text",
      onData: (text) => process.stderr.write(text),
    });

    const rendered = renderTaskResult(result, { title: "Cursor Agent Task", jobId });
    return {
      exitStatus: result.status,
      payload: { stdout: result.stdout, stderr: result.stderr, prompt },
      rendered,
      summary: shorten(prompt),
    };
  }, { logFile });

  outputResult(
    options.json
      ? { id: jobId, status: execution.exitStatus === 0 ? "completed" : "failed", result: execution.payload }
      : execution.rendered,
    options.json
  );

  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

// ── Task Worker (background execution) ──

async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id"],
  });

  if (!options["job-id"]) {
    throw new Error("Missing required --job-id for task-worker.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  const jobFile = resolveJobFile(workspaceRoot, options["job-id"]);
  const stored = readJobFile(jobFile);
  if (!stored) {
    throw new Error(`No stored job found for ${options["job-id"]}.`);
  }

  const logFile = createJobLogFile(workspaceRoot, stored.id, "Cursor Agent background task");
  const progressUpdater = createJobProgressUpdater(workspaceRoot, stored.id);
  const progressReporter = createProgressReporter({
    logFile,
    onEvent: progressUpdater,
  });

  const job = {
    ...stored,
    workspaceRoot,
    logFile,
  };

  await runTrackedJob(job, async () => {
    progressReporter?.({ message: "Running background task", phase: "running" });

    const result = await runCursorAgent({
      prompt: stored.prompt,
      workspace: workspaceRoot,
      model: stored.model ?? undefined,
      mode: stored.mode ?? undefined,
      write: Boolean(stored.write),
      outputFormat: "text",
    });

    const rendered = renderTaskResult(result, { title: "Cursor Agent Task", jobId: stored.id });
    return {
      exitStatus: result.status,
      payload: { stdout: result.stdout, stderr: result.stderr },
      rendered,
      summary: stored.summary,
    };
  }, { logFile });
}

// ── Review ──

async function handleReview(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "cwd"],
    booleanOptions: ["json", "background", "wait"],
    aliasMap: { m: "model" },
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  ensureCursorReady();

  const effectiveModel = options.model ?? getDefaultModelForWorkspace(workspaceRoot) ?? undefined;

  // Build review prompt from git diff
  let diffContext = "";
  try {
    const { execFileSync } = await import("node:child_process");
    diffContext = execFileSync("git", ["diff", "--cached", "--stat"], {
      cwd: workspaceRoot,
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    if (!diffContext) {
      diffContext = execFileSync("git", ["diff", "--stat"], {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
    }
    if (!diffContext) {
      diffContext = execFileSync("git", ["diff", "HEAD~1", "--stat"], {
        cwd: workspaceRoot,
        encoding: "utf8",
        timeout: 10000,
      }).trim();
    }
  } catch {
    // no git context available
  }

  const focusText = positionals.join(" ").trim();
  const reviewPrompt = [
    "Review the current code changes in this repository.",
    "Focus on: bugs, logic errors, security vulnerabilities, code quality issues, and potential improvements.",
    diffContext ? `\nChanged files:\n${diffContext}` : "",
    focusText ? `\nSpecific focus: ${focusText}` : "",
    "\nProvide a structured review with severity levels (critical/high/medium/low) for each finding.",
  ]
    .filter(Boolean)
    .join("\n");

  const jobId = generateJobId("review");
  const jobRecord = createJobRecord({
    id: jobId,
    kind: "review",
    jobClass: "review",
    status: "queued",
    summary: focusText ? shorten(`Review: ${focusText}`) : "Code review",
  });

  const logFile = createJobLogFile(workspaceRoot, jobId, "Cursor Agent review");
  const progressUpdater = createJobProgressUpdater(workspaceRoot, jobId);
  const progressReporter = createProgressReporter({
    stderr: true,
    logFile,
    onEvent: progressUpdater,
  });

  const job = {
    ...jobRecord,
    workspaceRoot,
    logFile,
  };

  const execution = await runTrackedJob(job, async () => {
    progressReporter?.({ message: "Running review", phase: "reviewing" });

    const result = await runCursorAgent({
      prompt: reviewPrompt,
      workspace: workspaceRoot,
      model: effectiveModel,
      mode: "ask",
      write: false,
      outputFormat: "text",
      onData: (text) => process.stderr.write(text),
    });

    const rendered = renderReviewResult(result);
    return {
      exitStatus: result.status,
      payload: { stdout: result.stdout, stderr: result.stderr },
      rendered,
      summary: focusText ? shorten(`Review: ${focusText}`) : "Code review",
    };
  }, { logFile });

  outputResult(
    options.json
      ? { id: jobId, status: execution.exitStatus === 0 ? "completed" : "failed", result: execution.payload }
      : execution.rendered,
    options.json
  );

  if (execution.exitStatus !== 0) {
    process.exitCode = execution.exitStatus;
  }
}

// ── Status ──

async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms"],
    booleanOptions: ["json", "all", "wait"],
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";

  if (reference) {
    const snapshot = options.wait
      ? await waitForSingleJobSnapshot(cwd, reference, {
          timeoutMs: options["timeout-ms"],
        })
      : buildSingleJobSnapshot(cwd, reference);
    outputResult(options.json ? snapshot : renderJobStatusReport(snapshot.job), options.json);
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  const report = buildStatusSnapshot(cwd, { all: options.all });
  outputResult(options.json ? report : renderStatusReport(report), options.json);
}

// ── Result ──

function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  const { workspaceRoot, job } = resolveResultJob(cwd, reference);
  const stored = readStoredJob(workspaceRoot, job.id);
  outputResult(options.json ? { job, stored } : renderStoredJobResult(job, stored), options.json);
}

// ── Model (list + workspace default) ──

async function handleModel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "clear"],
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);

  if (options.clear) {
    deleteConfigKey(workspaceRoot, "defaultModel");
    const payload = { defaultModel: null, cleared: true };
    const text =
      "Cleared the workspace default model. Cursor Agent will use its own default until you set one with `/cursor:model <model-id>`.\n";
    outputResult(options.json ? payload : text, options.json);
    return;
  }

  const modelId = positionals.join(" ").trim();

  if (!modelId) {
    const models = await listCursorModels();
    const defaultModel = getDefaultModelForWorkspace(workspaceRoot);

    if (options.json) {
      outputResult({ models, defaultModel: defaultModel ?? null }, true);
      return;
    }

    const lines = ["## Available Cursor Agent Models\n"];
    for (const m of models) {
      const tag = m.tag ? ` (${m.tag})` : "";
      const wsTag = defaultModel === m.id ? " (workspace default)" : "";
      lines.push(`- **${m.id}** — ${m.name}${tag}${wsTag}`);
    }
    lines.push("\n---");
    if (defaultModel) {
      lines.push(
        `Workspace default: **${defaultModel}** (used when \`--model\` is omitted on \`/cursor:task\` and \`/cursor:review\`).`
      );
    } else {
      lines.push(
        "No workspace default set. Run `/cursor:model <model-id>` to choose one, or pass `--model` on each run."
      );
    }
    lines.push("\nOverride for a single run:");
    lines.push("  `/cursor:task --model grok-4-20 \"your prompt\"`");
    outputResult(lines.join("\n") + "\n", false);
    return;
  }

  ensureCursorReady();
  const models = await listCursorModels();
  const found = models.find((m) => m.id === modelId);
  if (!found) {
    throw new Error(
      `Unknown model id: ${modelId}. Run /cursor:model with no arguments to see available models.`
    );
  }

  setConfig(workspaceRoot, "defaultModel", modelId);
  const payload = { defaultModel: modelId, model: found };
  const text = [
    `Set **${modelId}** (${found.name}) as the default model for this workspace.`,
    "",
    "Future `/cursor:task` and `/cursor:review` runs use this model when `--model` is not specified.",
    "",
  ].join("\n");
  outputResult(options.json ? payload : text + "\n", options.json);
}

// ── Cancel ──

function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"],
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";

  const { workspaceRoot, job } = resolveCancelableJob(cwd, reference);

  // Kill the process
  if (job.pid) {
    terminateProcessTree(job.pid);
  }

  const cancelledJob = {
    ...enrichJob(job),
    status: "cancelled",
    phase: "cancelled",
    completedAt: nowIso(),
    errorMessage: "Cancelled by user.",
  };
  upsertJob(workspaceRoot, cancelledJob);
  writeJobFile(workspaceRoot, job.id, {
    ...(readStoredJob(workspaceRoot, job.id) ?? {}),
    ...cancelledJob,
  });

  outputResult(
    options.json ? { jobId: job.id, status: "cancelled" } : renderCancelReport(cancelledJob),
    options.json
  );
}

// ── Main ──

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      handleSetup(argv);
      break;
    case "task":
      await handleTask(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "model":
      await handleModel(argv);
      break;
    case "cancel":
      handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
