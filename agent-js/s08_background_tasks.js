#!/usr/bin/env node
/**
 * s08_background_tasks.js - Background Tasks
 *
 * Run commands in background threads. A notification queue is drained
 * before each LLM call to deliver results.
 *
 *     Main thread                Background thread
 *     +-----------------+        +-----------------+
 *     | agent loop      |        | task executes   |
 *     | ...             |        | ...             |
 *     | [LLM call] <---+------- | enqueue(result) |
 *     |  ^drain queue   |        +-----------------+
 *     +-----------------+
 *
 *     Timeline:
 *     Agent ----[spawn A]----[spawn B]----[other work]----
 *                  |              |
 *                  v              v
 *               [A runs]      [B runs]        (parallel)
 *                  |              |
 *                  +-- notification queue --> [results injected]
 *
 * Key insight: "Fire and forget -- the agent doesn't block while the command runs."
 */

import 'dotenv/config';

import { readline } from 'readline';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, isAbsolute } from 'path';
import crypto from 'crypto';
import { OpenRouter } from "@openrouter/sdk";

const WORKDIR = process.cwd();

// Load environment
import { readFileSync as readEnvFile } from 'fs';
const dotenvPath = resolve(WORKDIR, '.env');
if (existsSync(dotenvPath)) {
  const envContent = readEnvFile(dotenvPath, 'utf-8');
  envContent.split('\n').forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  });
}

const apiKey = process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY;
const model = process.env.MODEL_ID || "anthropic/claude-3.5-sonnet";

const client = new OpenRouter({
  apiKey: apiKey,
});

const SYSTEM = `You are a coding agent at ${WORKDIR}. Use background_run for long-running commands.`;

// -- BackgroundManager: threaded execution + notification queue --
class BackgroundManager {
  constructor() {
    this.tasks = new Map(); // task_id -> {status, result, command}
    this._notificationQueue = []; // completed task results
    this._lock = false;
  }

  _acquireLock() {
    while (this._lock) {
      // Simple spinlock
    }
    this._lock = true;
  }

  _releaseLock() {
    this._lock = false;
  }

  run(command) {
    // Start a background thread, return task_id immediately.
    const taskId = crypto.randomBytes(4).toString('hex');
    this.tasks.set(taskId, { status: "running", result: null, command: command });

    // Run in background using setTimeout 0
    setTimeout(() => this._execute(taskId, command), 0);
    return `Background task ${taskId} started: ${command.substring(0, 80)}`;
  }

  _execute(taskId, command) {
    // Thread target: run subprocess, capture output, push to queue.
    try {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellFlag = isWindows ? '/c' : '-c';

      const child = spawn(shell, [shellFlag, command], {
        cwd: WORKDIR,
        timeout: 300000 // 300s timeout
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        const output = (stdout + stderr).trim().substring(0, 50000);
        const status = code === 0 ? "completed" : "error";
        const task = this.tasks.get(taskId);
        if (task) {
          task.status = status;
          task.result = output || "(no output)";
        }

        this._acquireLock();
        this._notificationQueue.push({
          task_id: taskId,
          status: status,
          command: command.substring(0, 80),
          result: (output || "(no output)").substring(0, 500),
        });
        this._releaseLock();
      });

      child.on('error', (err) => {
        const task = this.tasks.get(taskId);
        if (task) {
          task.status = "error";
          task.result = `Error: ${err.message}`;
        }

        this._acquireLock();
        this._notificationQueue.push({
          task_id: taskId,
          status: "error",
          command: command.substring(0, 80),
          result: `Error: ${err.message}`.substring(0, 500),
        });
        this._releaseLock();
      });

      // Set timeout
      setTimeout(() => {
        if (this.tasks.get(taskId)?.status === "running") {
          const task = this.tasks.get(taskId);
          task.status = "timeout";
          task.result = "Error: Timeout (300s)";

          this._acquireLock();
          this._notificationQueue.push({
            task_id: taskId,
            status: "timeout",
            command: command.substring(0, 80),
            result: "Error: Timeout (300s)".substring(0, 500),
          });
          this._releaseLock();

          child.kill();
        }
      }, 300000);

    } catch (e) {
      const task = this.tasks.get(taskId);
      if (task) {
        task.status = "error";
        task.result = `Error: ${e.message}`;
      }

      this._acquireLock();
      this._notificationQueue.push({
        task_id: taskId,
        status: "error",
        command: command.substring(0, 80),
        result: `Error: ${e.message}`.substring(0, 500),
      });
      this._releaseLock();
    }
  }

  check(taskId = null) {
    // Check status of one task or list all.
    if (taskId) {
      const t = this.tasks.get(taskId);
      if (!t) {
        return `Error: Unknown task ${taskId}`;
      }
      return `[${t.status}] ${t.command.substring(0, 60)}\n${t.result || '(running)'}`;
    }

    const lines = [];
    for (const [tid, t] of this.tasks) {
      lines.push(`${tid}: [${t.status}] ${t.command.substring(0, 60)}`);
    }
    return lines.length > 0 ? lines.join('\n') : "No background tasks.";
  }

  drainNotifications() {
    // Return and clear all pending completion notifications.
    this._acquireLock();
    const notifs = [...this._notificationQueue];
    this._notificationQueue = [];
    this._releaseLock();
    return notifs;
  }
}

const BG = new BackgroundManager();


// -- Tool implementations --
function safePath(p) {
  let path;
  if (isAbsolute(p)) {
    path = resolve(p);
  } else {
    path = resolve(WORKDIR, p);
  }

  // Check if path is within WORKDIR
  const workdirResolved = resolve(WORKDIR);
  if (!path.startsWith(workdirResolved)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return path;
}

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some(d => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellFlag = isWindows ? '/c' : '-c';

    const child = spawn(shell, [shellFlag, command], {
      cwd: WORKDIR,
      timeout: 120000 // 120s timeout
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', () => {
      const out = (stdout + stderr).trim();
      resolve(out ? out.substring(0, 50000) : "(no output)");
    });

    child.on('error', (err) => {
      resolve(`Error: ${err.message}`);
    });

    setTimeout(() => {
      if (!child.killed) {
        child.kill();
        resolve("Error: Timeout (120s)");
      }
    }, 120000);
  });
}

function runRead(path, limit = null) {
  try {
    const content = readFileSync(safePath(path), 'utf-8');
    let lines = content.split('\n');
    if (limit && limit < lines.length) {
      lines = lines.slice(0, limit).concat([`... (${lines.length - limit} more)`]);
    }
    return lines.join('\n').substring(0, 50000);
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function runWrite(path, content) {
  try {
    const fp = safePath(path);
    const dir = fp.substring(0, fp.lastIndexOf('/') || fp.lastIndexOf('\\'));
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function runEdit(path, oldText, newText) {
  try {
    const fp = safePath(path);
    const content = readFileSync(fp, 'utf-8');
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${path}`;
    }
    const newContent = content.replace(oldText, newText, 1);
    writeFileSync(fp, newContent);
    return `Edited ${path}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

const TOOL_HANDLERS = {
  bash: async (params) => await runBash(params.command),
  read_file: (params) => runRead(params.path, params.limit),
  write_file: (params) => runWrite(params.path, params.content),
  edit_file: (params) => runEdit(params.path, params.old_text, params.new_text),
  background_run: (params) => BG.run(params.command),
  check_background: (params) => BG.check(params.task_id),
};

// Convert Anthropic-style tools to OpenAI-style for OpenRouter SDK
function toOpenAITools(tools) {
  return tools.map(t => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema || t.parameters || { type: "object", properties: {} }
    }
  }));
}
const TOOLS = [
  {
    name: "bash",
    description: "Run a shell command (blocking).",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"]
    }
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, limit: { type: "integer" } },
      required: ["path"]
    }
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } },
      required: ["path", "old_text", "new_text"]
    }
  },
  {
    name: "background_run",
    description: "Run command in background thread. Returns task_id immediately.",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"]
    }
  },
  {
    name: "check_background",
    description: "Check background task status. Omit task_id to list all.",
    input_schema: {
      type: "object",
      properties: { task_id: { type: "string" } }
    }
  },
];


async function agentLoop(messages) {
  while (true) {
    // Drain background notifications and inject as system message before LLM call
    const notifs = BG.drainNotifications();
    if (notifs.length > 0 && messages.length > 0) {
      const notifText = notifs
        .map(n => `[bg:${n.task_id}] ${n.status}: ${n.result}`)
        .join('\n');
      messages.push({ role: "user", content: `<background-results>\n${notifText}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }

    const response = await client.chat.send({
      chatGenerationParams: {
        model: model,
        messages: [
          { role: "system", content: SYSTEM },
          ...messages
        ],
        tools: toOpenAITools(TOOLS),
        max_tokens: 8000,
      }
    });

    const message = response.choices[0].message;
    messages.push({ role: "assistant", content: message.content });

    if (!message.toolCalls || message.toolCalls.length === 0) {
      return;
    }

    const results = [];
    for (const toolCall of message.toolCalls) {
      const handler = TOOL_HANDLERS[toolCall.function.name];
      let output;
      try {
        const args = JSON.parse(toolCall.function.arguments);
        output = handler ? await handler(args) : `Unknown tool: ${toolCall.function.name}`;
      } catch (e) {
        output = `Error: ${e.message}`;
      }
      console.log(`> ${toolCall.function.name}: ${String(output).substring(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: toolCall.id, content: String(output) });
    }
    messages.push({ role: "user", content: results });
  }
}


async function main() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const history = [];

  const ask = () => {
    rl.question('\x1b[36ms08 >> \x1b[0m', async (query) => {
      if (query.trim().toLowerCase() in ('q', 'exit', '')) {
        rl.close();
        return;
      }
      history.push({ role: "user", content: query });
      await agentLoop(history);
      console.log();
      ask();
    });
  };

  ask();
}

main();
