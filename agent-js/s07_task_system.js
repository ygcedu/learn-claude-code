#!/usr/bin/env node
/**
 * s07_task_system.js - Tasks
 *
 * Tasks persist as JSON files in .tasks/ so they survive context compression.
 * Each task has a dependency graph (blockedBy/blocks).
 *
 * Key insight: "State that survives compression -- because it's outside the conversation."
 */

import 'dotenv/config';

import { OpenRouter } from "@openrouter/sdk";
import { spawn } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  envContent.split("\n").forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] = match[2].trim();
  });
}

const MODEL = process.env.MODEL_ID || "anthropic/claude-3.5-sonnet";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

const client = new OpenRouter({ apiKey: OPENROUTER_API_KEY, baseURL: OPENROUTER_BASE_URL });
const WORKDIR = process.cwd();
const TASKS_DIR = path.join(WORKDIR, ".tasks");
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use task tools to plan and track work.`;

class TaskManager {
  constructor(tasksDir) {
    this.dir = tasksDir;
    if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
    this._nextId = this._maxId() + 1;
  }
  _maxId() {
    const files = fs.readdirSync(this.dir).filter(f => f.startsWith("task_") && f.endsWith(".json"));
    const ids = files.map(f => parseInt(f.split("_")[1].split(".")[0], 10));
    return ids.length ? Math.max(...ids) : 0;
  }
  _load(taskId) {
    const p = path.join(this.dir, `task_${taskId}.json`);
    if (!fs.existsSync(p)) throw new Error(`Task ${taskId} not found`);
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  }
  _save(task) {
    fs.writeFileSync(path.join(this.dir, `task_${task.id}.json`), JSON.stringify(task, null, 2));
  }
  create(subject, description = "") {
    const task = { id: this._nextId++, subject, description, status: "pending", blockedBy: [], blocks: [], owner: "" };
    this._save(task);
    return JSON.stringify(task, null, 2);
  }
  get(taskId) { return JSON.stringify(this._load(taskId), null, 2); }
  update(taskId, status = null, addBlockedBy = null, addBlocks = null) {
    const task = this._load(taskId);
    if (status) {
      task.status = status;
      if (status === "completed") {
        const files = fs.readdirSync(this.dir).filter(f => f.startsWith("task_") && f.endsWith(".json"));
        for (const f of files) {
          const t = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8"));
          if (t.blockedBy && t.blockedBy.includes(taskId)) {
            t.blockedBy = t.blockedBy.filter(id => id !== taskId);
            this._save(t);
          }
        }
      }
    }
    if (addBlockedBy) task.blockedBy = [...new Set([...task.blockedBy, ...addBlockedBy])];
    if (addBlocks) task.blocks = [...new Set([...task.blocks, ...addBlocks])];
    this._save(task);
    return JSON.stringify(task, null, 2);
  }
  listAll() {
    const files = fs.readdirSync(this.dir).filter(f => f.startsWith("task_") && f.endsWith(".json")).sort();
    if (!files.length) return "No tasks.";
    const markers = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };
    const lines = files.map(f => {
      const t = JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8"));
      return `${markers[t.status] || "[?]"} #${t.id}: ${t.subject}`;
    });
    return lines.join("\n");
  }
  claim(taskId, owner) {
    const task = this._load(taskId);
    task.owner = owner;
    task.status = "in_progress";
    this._save(task);
    return `Claimed task #${taskId} for ${owner}`;
  }
}

const TASK_MGR = new TaskManager(TASKS_DIR);

function safePath(p) {
  const absPath = path.resolve(WORKDIR, p);
  if (!absPath.startsWith(WORKDIR)) throw new Error(`Path escapes workspace: ${p}`);
  return absPath;
}

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some(d => command.includes(d))) return "Error: Dangerous command blocked";
  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: true, cwd: WORKDIR });
    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());
    child.on("close", () => resolve((stdout + stderr).trim().substring(0, 50000) || "(no output)"));
    child.on("error", err => resolve(`Error: ${err.message}`));
    setTimeout(() => { child.kill(); resolve("Error: Timeout (120s)"); }, 120000);
  });
}

function runRead(pathStr, limit = null) {
  try {
    const content = fs.readFileSync(pathStr, "utf-8");
    const lines = content.split("\n");
    if (limit && limit < lines.length) lines.length = limit, lines.push(`... (${lines.length - limit} more)`);
    return lines.join("\n").substring(0, 50000);
  } catch (e) { return `Error: ${e.message}`; }
}

function runWrite(pathStr, content) {
  try {
    const fp = safePath(pathStr);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes`;
  } catch (e) { return `Error: ${e.message}`; }
}

function runEdit(pathStr, oldText, newText) {
  try {
    const fp = safePath(pathStr);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) return `Error: Text not found in ${pathStr}`;
    fs.writeFileSync(fp, content.replace(oldText, newText, 1), "utf-8");
    return `Edited ${pathStr}`;
  } catch (e) { return `Error: ${e.message}`; }
}

const TOOL_HANDLERS = {
  bash: async (kw) => await runBash(kw.command),
  read_file: (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  task_create: (kw) => TASK_MGR.create(kw.subject, kw.description || ""),
  task_get: (kw) => TASK_MGR.get(kw.task_id),
  task_update: (kw) => TASK_MGR.update(kw.task_id, kw.status, kw.add_blocked_by, kw.add_blocks),
  task_list: () => TASK_MGR.listAll(),
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
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } },
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] } },
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } },
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] } },
  { name: "task_create", description: "Create a persistent file task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] } },
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] } },
  { name: "task_update", description: "Update task status or dependencies.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, add_blocked_by: { type: "array", items: { type: "integer" } }, add_blocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] } },
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {} } },
];

async function agentLoop(messages) {
  while (true) {
    const response = await client.chat.send({
      chatGenerationParams: {
        model: MODEL,
        messages: [{ role: "system", content: SYSTEM }, ...messages],
        tools: toOpenAITools(TOOLS),
        max_tokens: 8000,
      }
    });
    const choice = response.choices[0];
    messages.push({ role: "assistant", content: [choice.message] });
    if (choice.finishReason !== "tool_calls") return;
    const results = [];
    for (const toolCall of choice.message.toolCalls) {
      const handler = TOOL_HANDLERS[toolCall.function.name];
      const args = JSON.parse(toolCall.function.arguments);
      const output = handler ? await handler(args) : `Unknown tool: ${toolCall.function.name}`;
      console.log(`> ${toolCall.function.name}: ${String(output).substring(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: toolCall.id, content: String(output) });
    }
    messages.push({ role: "user", content: results });
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms07 >> \x1b[0m" });

async function main() {
  const history = [];
  rl.on("line", async (query) => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "exit" || trimmed === "") { rl.close(); return; }
    history.push({ role: "user", content: query });
    await agentLoop(history);
    console.log();
    rl.prompt();
  });
  rl.on("close", () => process.exit(0));
  rl.prompt();
}

main().catch(console.error);
