#!/usr/bin/env node
/**
 * s05_skill_loading.js - Skills
 *
 * Two-layer skill injection that avoids bloating the system prompt:
 *
 * Layer 1 (cheap): skill names in system prompt (~100 tokens/skill)
 * Layer 2 (on demand): full skill body in tool_result
 *
 * Key insight: "Don't put everything in the system prompt. Load on demand."
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
const SKILLS_DIR = path.join(WORKDIR, ".skills");

// SkillLoader: parse .skills/*.md files with YAML frontmatter
class SkillLoader {
  constructor(skillsDir) {
    this.skillsDir = skillsDir;
    this.skills = {};
    this._loadAll();
  }

  _loadAll() {
    if (!fs.existsSync(this.skillsDir)) {
      return;
    }
    const files = fs.readdirSync(this.skillsDir).filter(f => f.endsWith(".md")).sort();
    for (const f of files) {
      const name = path.basename(f, ".md");
      const text = fs.readFileSync(path.join(this.skillsDir, f), "utf-8");
      const [meta, body] = this._parseFrontmatter(text);
      this.skills[name] = { meta, body, path: f };
    }
  }

  _parseFrontmatter(text) {
    const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)/);
    if (!match) {
      return [{}, text];
    }
    const meta = {};
    for (const line of match[1].trim().split("\n")) {
      if (line.includes(":")) {
        const [key, val] = line.split(":", 1);
        meta[key.trim()] = val.trim();
      }
    }
    return [meta, match[2].trim()];
  }

  getDescriptions() {
    if (!Object.keys(this.skills).length) {
      return "(no skills available)";
    }
    const lines = [];
    for (const [name, skill] of Object.entries(this.skills)) {
      const desc = skill.meta.description || "No description";
      const tags = skill.meta.tags || "";
      let line = `  - ${name}: ${desc}`;
      if (tags) {
        line += ` [${tags}]`;
      }
      lines.push(line);
    }
    return lines.join("\n");
  }

  getContent(name) {
    const skill = this.skills[name];
    if (!skill) {
      return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(", ")}`;
    }
    return `<skill name="${name}">\n${skill.body}\n</skill>`;
  }
}

const SKILL_LOADER = new SkillLoader(SKILLS_DIR);

// Layer 1: skill metadata injected into system prompt
const SYSTEM = `You are a coding agent at ${WORKDIR}.
Use load_skill to access specialized knowledge before tackling unfamiliar topics.

Skills available:
${SKILL_LOADER.getDescriptions()}`;

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
  load_skill: (kw) => SKILL_LOADER.getContent(kw.name),
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
  { name: "load_skill", description: "Load specialized knowledge by name.", input_schema: { type: "object", properties: { name: { type: "string", description: "Skill name to load" } }, required: ["name"] } },
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
      let output;
      try {
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

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "\x1b[36ms05 >> \x1b[0m"
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
