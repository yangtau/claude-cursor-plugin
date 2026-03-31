---
description: Execute a Claude Code plan using Cursor Agent
argument-hint: '[--write] [--model <model>] [plan-file-path]'
allowed-tools: Read, Glob, Bash(node:*), Bash(mktemp:*), Write, AskUserQuestion
---

Execute a plan file using Cursor Agent.

Raw slash-command arguments:
`$ARGUMENTS`

Plan resolution:
1. If a file path is provided in the arguments, use that file as the plan.
2. Otherwise, scan `~/.claude/plans/` for `.md` files and pick the most recently modified one.
3. If no plan file is found, tell the user: "No plan found. Provide a plan file path or create a plan first with `/plan`."

Execution steps:
1. Read the resolved plan file using the `Read` tool.
2. Create a temporary prompt file by writing to `/tmp/cursor-plan-<timestamp>.md` with the following content:

```
You are executing a pre-made implementation plan. Follow it step by step.
Do NOT skip steps. Do NOT deviate from the plan unless something is clearly wrong.
After completing all steps, summarize what was done.

## Plan

<full plan content here>
```

3. Determine execution mode:
   - If `--wait` is in the arguments, run in foreground.
   - If `--background` is in the arguments, run in background.
   - Otherwise, use `AskUserQuestion` with:
     - `Run in background (Recommended)` — plans are typically multi-step and long
     - `Wait for results`

4. Run the task:

Foreground:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task --write --prompt-file /tmp/cursor-plan-<timestamp>.md
```

Background:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/cursor-companion.mjs" task --background --write --prompt-file /tmp/cursor-plan-<timestamp>.md
```

- Add `--model <model>` if the user specified one.
- Always add `--write` by default since plans typically require file modifications. Only omit `--write` if the user explicitly passes `--no-write`.
- Return the command stdout verbatim.
