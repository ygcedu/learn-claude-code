#!/usr/bin/env node
/**
 * s02_tool_use.js - Tools
 *
 * The agent loop from s01 didn't change. We just added tools to the array
 * and a dispatch map to route calls.
 *
 * Key insight: "The loop didn't change at all. I just added tools."
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
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

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
      lines.push(`... (${lines.length - limit} more lines)`);
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
    return `Wrote ${content.length} bytes to ${pathStr}`;
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

// The dispatch map: {tool_name: handler}
const TOOL_HANDLERS = {
  bash: async (kw) => await runBash(kw.command),
  read_file: (kw) => runRead(kw.path, kw.limit),
  write_file: (kw) => runWrite(kw.path, kw.content),
  edit_file: (kw) => runEdit(kw.path, kw.old_text, kw.new_text),
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

    if (choice.finishReason !== "tool_calls") {
      return;
    }

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

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "\x1b[36ms02 >> \x1b[0m"
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
