export function renderSetupReport(report) {
  const lines = [];
  lines.push("# Cursor Agent Setup\n");

  const status = (available) => (available ? "OK" : "MISSING");

  lines.push(`- **cursor-agent**: ${status(report.cursor.available)} — ${report.cursor.detail}`);
  lines.push(`- **Auth**: ${status(report.auth.loggedIn)} — ${report.auth.detail}`);
  lines.push(`- **Ready**: ${report.ready ? "Yes" : "No"}`);

  if (report.nextSteps.length > 0) {
    lines.push("\n## Next Steps\n");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n") + "\n";
}

function normalizeReasoningSummary(reasoningSummary) {
  if (Array.isArray(reasoningSummary)) {
    return reasoningSummary
      .filter((entry) => typeof entry === "string" && entry.trim())
      .map((entry) => entry.trim());
  }
  if (typeof reasoningSummary === "string" && reasoningSummary.trim()) {
    return [reasoningSummary.trim()];
  }
  return [];
}

function appendReasoningSection(lines, reasoningSummary) {
  const normalized = normalizeReasoningSummary(reasoningSummary);
  if (normalized.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const item of normalized) {
    lines.push(`- ${item}`);
  }
}

export function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title ?? job.summary) {
    parts.push(job.title ?? job.summary);
  }
  return parts.join(" | ");
}

function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/cursor:status ${job.id}`];
    if (job.status === "queued" || job.status === "running") {
      actions.push(`/cursor:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.startedAt) {
    lines.push(`  Started: ${job.startedAt}`);
  }
  if (job.completedAt) {
    lines.push(`  Completed: ${job.completedAt}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if (job.errorMessage) {
    lines.push(`  Error: ${job.errorMessage}`);
  }
  if (job.waitTimedOut) {
    lines.push("  Wait: timed out before the job finished.");
  }
  if ((job.status === "queued" || job.status === "running") && options.showCancelHint) {
    lines.push(`  Cancel: /cursor:cancel ${job.id}`);
  }
  if (job.status !== "queued" && job.status !== "running" && options.showResultHint) {
    lines.push(`  Result: /cursor:result ${job.id}`);
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

export function renderTaskResult(result, options = {}) {
  const lines = [];
  const title = options.title || "Cursor Agent Task";

  lines.push(`## ${title}\n`);

  if (result.stdout) {
    lines.push(result.stdout.trimEnd());
  } else if (result.status === 0) {
    lines.push("Cursor Agent completed without any stdout output.");
  }

  if (result.status !== 0 && result.stderr) {
    lines.push("", `**Error** (exit ${result.status}):`, "", "```text");
    lines.push(result.stderr.trimEnd());
    lines.push("```");
  }

  appendReasoningSection(lines, options.reasoningSummary ?? result.reasoningSummary);

  if (options.jobId) {
    lines.push("", "---", `Job: ${options.jobId}`, `Result: /cursor:result ${options.jobId}`);
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderReviewResult(result) {
  const lines = [];
  lines.push("## Cursor Agent Review\n");

  if (result.status !== 0 && result.stderr) {
    lines.push(`**Error** (exit ${result.status}):\n`);
    lines.push("```");
    lines.push(result.stderr);
    lines.push("```\n");
  }

  if (result.stdout) {
    lines.push(result.stdout);
  }

  return lines.join("\n") + "\n";
}

export function renderStatusReport(report) {
  const lines = ["# Cursor Status", ""];

  if (report.workspaceRoot) {
    lines.push(`Workspace: ${report.workspaceRoot}`);
  }
  lines.push("");

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true,
        showCancelHint: true,
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed",
      showResultHint: true,
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed",
        showResultHint: true,
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderJobStatusReport(job) {
  const lines = ["# Cursor Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: job.status === "queued" || job.status === "running",
    showDuration: job.status !== "queued" && job.status !== "running",
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderCancelReport(job) {
  const lines = ["# Cursor Cancel", "", `Cancelled ${job.id}.`, ""];

  if (job.title ?? job.summary) {
    lines.push(`- Summary: ${job.title ?? job.summary}`);
  }
  if (job.kindLabel ?? job.kind) {
    lines.push(`- Kind: ${job.kindLabel ?? job.kind}`);
  }
  lines.push("- Check `/cursor:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}

export function renderStoredJobResult(job, storedJob) {
  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    return output;
  }

  const rawOutput =
    (typeof storedJob?.result?.stdout === "string" && storedJob.result.stdout) ||
    "";
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    return output;
  }

  const lines = [
    `# ${job.title ?? "Cursor Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
