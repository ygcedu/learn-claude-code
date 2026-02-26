#!/usr/bin/env node
/**
 * s06_context_compact.js - Compact
 *
 * Three-layer compression pipeline so the agent can work forever:
 *
 * Every turn:
 * +------------------+
 * | Tool call result |
 * +------------------+
 *         |
 *         v
 * [Layer 1: micro_compact]        (silent, every turn)
 *   Replace tool_result content older than last 3
 *   with "[Previous: used {tool_name}]"
 *         |
 *         v
 * [Check: tokens > 50000?]
 *    |               |
 *    no              yes
 *    |               |
 *    v               v
 * continue    [Layer 2: auto_compact]
 *               Save full transcript to .transcripts/
 *               Ask LLM to summarize conversation.
 *               Replace all messages with [summary].
 *                     |
 *                     v
 *             [Layer 3: compact tool]
 *               Model calls compact -> immediate summarization.
 *               Same as auto, triggered manually.
 *
 * Key insight: "The agent can forget strategically and keep working forever."
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

const client = new OpenRouter({
  apiKey: OPENROUTER_API_KEY,
  baseURL: OPENROUTER_BASE_URL,
});

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.`;

const THRESHOLD = 50000;
const TRANSCRIPT_DIR = path.join(WORKDIR, ".transcripts");
const KEEP_RECENT = 3;

function estimateTokens(messages) {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

// Layer 1: micro_compact - replace old tool results with placeholders
function microCompact(messages) {
  const toolResults = [];
  for (let msgIdx = 0; msgIdx < messages.length; msgIdx++) {
    const msg = messages[msgIdx];
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (let partIdx = 0; partIdx < msg.content.length; partIdx++) {
        const part = msg.content[partIdx];
        if (typeof part === "object" && part.type === "tool_result") {
          toolResults.push({ msgIdx, partIdx, part });
        }
      }
    }
  }
  if (toolResults.length <= KEEP_RECENT) return messages;

  const toolNameMap = {};
  for (const msg of messages) {
    if (msg.role === "assistant") {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use") {
            toolNameMap[block.id] = block.name;
          }
        }
      }
    }
  }

  const toClear = toolResults.slice(0, -KEEP_RECENT);
  for (const { part } of toClear) {
    if (typeof part.content === "string" && part.content.length > 100) {
      const toolId = part.tool_use_id || "";
      const toolName = toolNameMap[toolId] || "unknown";
      part.content = `[Previous: used ${toolName}]`;
    }
  }
  return messages;
}

// Layer 2: auto_compact - save transcript, summarize, replace messages
async function autoCompact(messages) {
  if (!fs.existsSync(TRANSCRIPT_DIR)) {
    fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  }
  const transcriptPath = path.join(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const stream = fs.createWriteStream(transcriptPath);
  for (const msg of messages) {
    stream.write(JSON.stringify(msg) + "\n");
  }
  stream.end();
  console.log(`[transcript saved: ${transcriptPath}]`);

  const conversationText = JSON.stringify(messages).substring(0, 80000);
  const response = await client.chat.send({
    chatGenerationParams: {
      model: MODEL,
      messages: [{ role: "user", content: `Summarize this conversation for continuity. Include: 1) What was accomplished, 2) Current state, 3) Key decisions made. Be concise but preserve critical details.\n\n${conversationText}` }],
      max_tokens: 2000,
    }
  });
  const summary = response.choices[0].message.content;

  return [
    { role: "user", content: `[Conversation compressed. Transcript: ${transcriptPath}]\n\n${summary}` },
    { role: "assistant", content: "Understood. I have the context from the summary. Continuing." },
  ];
}

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
  compact: () => "Manual compression requested.",
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
  { name: "compact", description: "Trigger manual conversation compression.", input_schema: { type: "object", properties: { focus: { type: "string", description: "What to preserve in the summary" } } } },
];

async function agentLoop(messages) {
  while (true) {
    microCompact(messages);
    if (estimateTokens(messages) > THRESHOLD) {
      console.log("[auto_compact triggered]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
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

    if (choice.finishReason !== "tool_calls") return;

    const results = [];
    let manualCompact = false;

    for (const toolCall of choice.message.toolCalls) {
      let output;
      if (toolCall.function.name === "compact") {
        manualCompact = true;
        output = "Compressing...";
      } else {
        const handler = TOOL_HANDLERS[toolCall.function.name];
        const args = JSON.parse(toolCall.function.arguments);
        output = handler ? await handler(args) : `Unknown tool: ${toolCall.function.name}`;
      }
      console.log(`> ${toolCall.function.name}: ${String(output).substring(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: toolCall.id, content: String(output) });
    }

    messages.push({ role: "user", content: results });

    if (manualCompact) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      messages.push(...compacted);
    }
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: "\x1b[36ms06 >> \x1b[0m" });

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
