#!/usr/bin/env node
/**
 * s01_agent_loop.js - The Agent Loop
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while stop_reason == "tool_use":
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 *
 * Key insight: Feed tool results back to the model until it decides to stop.
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

const WORKDIR = process.cwd();
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use bash to solve tasks. Act, don't explain.`;

const TOOLS = [{
  name: "bash",
  description: "Run a shell command.",
  input_schema: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
}];

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

// The core pattern: a while loop that calls tools until the model stops
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

    // If the model didn't call a tool, we're done
    if (choice.finishReason !== "tool_calls") {
      return;
    }

    // Execute each tool call, collect results
    const results = [];
    for (const toolCall of choice.message.toolCalls) {
      console.log(`\x1b[33m$ ${toolCall.function.arguments}\x1b[0m`);
      const args = JSON.parse(toolCall.function.arguments);
      const output = await runBash(args.command);
      console.log(output.substring(0, 200));
      results.push({
        type: "tool_result",
        tool_use_id: toolCall.id,
        content: output
      });
    }
    messages.push({ role: "user", content: results });
  }
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "\x1b[36ms01 >> \x1b[0m"
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

    const lastMsg = history[history.length - 1];
    if (Array.isArray(lastMsg.content)) {
      for (const block of lastMsg.content) {
        if (block.content) {
          console.log(block.content);
        }
      }
    }
    console.log();
    rl.prompt();
  });

  rl.on("close", () => {
    process.exit(0);
  });

  rl.prompt();
}

main().catch(console.error);
