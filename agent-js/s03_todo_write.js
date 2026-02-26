#!/usr/bin/env node
/**
 * s03_todo_write.js - TodoWrite
 *
 * The model tracks its own progress via a TodoManager. A nag reminder
 * forces it to keep updating when it forgets.
 *
 * Key insight: "The agent can track its own progress -- and I can see it."
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

// Load .env
const envPath = path.join(__dirname, "..", ".env");
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf-8");
  envContent.split("\n").forEach(line => {
    const match = line.match(/^([^=]+)=(.*)$/);
    if (match) {
      process.env[match[1].trim()] = match[2].trim();
    }
  });
}

const MODEL = process.env.MODEL_ID || "anthropic/claude-3.5-sonnet";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || "https://openrouter.ai/api/v1";

const client = new OpenRouter({
  apiKey: OPENROUTER_API_KEY,
  baseURL: OPENROUTER_BASE_URL,
});

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use the todo tool to plan multi-step tasks. Mark in_progress before starting, completed when done.
Prefer tools over prose.`;

// TodoManager: structured state the LLM writes to
class TodoManager {
  constructor() {
    this.items = [];
  }

  update(items) {
    if (items.length > 20) {
      throw new Error("Max 20 todos allowed");
    }

    const validated = [];
    let inProgressCount = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const text = String(item.text || item.content || "").trim();
      const status = String(item.status || "pending").toLowerCase();
      const itemId = String(item.id || String(i + 1));

      if (!text) {
        throw new Error(`Item ${itemId}: text required`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Item ${itemId}: invalid status '${status}'`);
      }
      if (status === "in_progress") {
        inProgressCount++;
      }
      validated.push({ id: itemId, text, status });
    }

    if (inProgressCount > 1) {
      throw new Error("Only one task can be in_progress at a time");
    }

    this.items = validated;
    return this.render();
  }

  render() {
    if (!this.items.length) return "No todos.";

    const lines = [];
    const markers = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };

    for (const item of this.items) {
      const marker = markers[item.status] || "[?]";
      lines.push(`${marker} #${item.id}: ${item.text}`);
    }

    const done = this.items.filter(t => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);

    return lines.join("\n");
  }
}

const TODO = new TodoManager();

function safePath(p) {
  const absPath = path.resolve(WORKDIR, p);
  if (!absPath.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return absPath;
}

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some(d => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  return new Promise((resolve) => {
    const child = spawn(command, [], { shell: true, cwd: WORKDIR });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (data) => { stdout += data.toString(); });
    child.stderr.on("data", (data) => { stderr += data.toString(); });

    child.on("close", () => {
      const out = (stdout + stderr).trim();
      resolve(out ? out.substring(0, 50000) : "(no output)");
    });

    child.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });

    setTimeout(() => {
      child.kill();
      resolve("Error: Timeout (120s)");
    }, 120000);
  });
}

function runRead(pathStr, limit = null) {
  try {
    const content = fs.readFileSync(pathStr, "utf-8");
    const lines = content.split("\n");
    if (limit && limit < lines.length) {
      lines.length = limit;
      lines.push(`... (${lines.length - limit} more)`);
    }
    return lines.join("\n").substring(0, 50000);
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function runWrite(pathStr, content) {
  try {
    const fp = safePath(pathStr);
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, content, "utf-8");
    return `Wrote ${content.length} bytes`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function runEdit(pathStr, oldText, newText) {
  try {
    const fp = safePath(pathStr);
    const content = fs.readFileSync(fp, "utf-8");
    if (!content.includes(oldText)) {
      return `Error: Text not found in ${pathStr}`;
    }
    fs.writeFileSync(fp, content.replace(oldText, newText, 1), "utf-8");
    return `Edited ${pathStr}`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

const TOOL_HANDLERS = {
  bash: async (kw) => await runBash(kw.command),
  read_file: (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
  todo: (kw) => TODO.update(kw.items),
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
  { name: "todo", description: "Update task list. Track progress on multi-step tasks.", input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { id: { type: "string" }, text: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] } }, required: ["id", "text", "status"] } } }, required: ["items"] } },
];

// Agent loop with nag reminder injection
async function agentLoop(messages) {
  let roundsSinceTodo = 0;

  while (true) {
    // Nag reminder: if 3+ rounds without a todo update, inject reminder
    if (roundsSinceTodo >= 3 && messages.length) {
      const last = messages[messages.length - 1];
      if (last.role === "user" && Array.isArray(last.content)) {
        last.content.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
      }
    }

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

    if (choice.finishReason !== "tool_calls") {
      return;
    }

    const results = [];
    let usedTodo = false;

    for (const toolCall of choice.message.toolCalls) {
      const handler = TOOL_HANDLERS[toolCall.function.name];
      const args = JSON.parse(toolCall.function.arguments);
      let output;
      try {
        output = handler ? await handler(args) : `Unknown tool: ${toolCall.function.name}`;
      } catch (e) {
        output = `Error: ${e.message}`;
      }
      console.log(`> ${toolCall.function.name}: ${String(output).substring(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: toolCall.id, content: String(output) });

      if (toolCall.function.name === "todo") {
        usedTodo = true;
      }
    }

    roundsSinceTodo = usedTodo ? 0 : roundsSinceTodo + 1;
    messages.push({ role: "user", content: results });
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "\x1b[36ms03 >> \x1b[0m"
});

async function main() {
  const history = [];

  rl.on("line", async (query) => {
    const trimmed = query.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "exit" || trimmed === "") {
      rl.close();
      return;
    }

    history.push({ role: "user", content: query });
    await agentLoop(history);
    console.log();
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });

  rl.prompt();
}

main().catch(console.error);
