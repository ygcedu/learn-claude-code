#!/usr/bin/env node
/**
 * s09_agent_teams.js - Agent Teams
 *
 * Persistent named agents with file-based JSONL inboxes. Each teammate runs
 * its own agent loop in a separate thread. Communication via append-only inboxes.
 *
 *     Subagent (s04):  spawn -> execute -> return summary -> destroyed
 *     Teammate (s09):  spawn -> work -> idle -> work -> ... -> shutdown
 *
 *     .team/config.json                   .team/inbox/
 *     +----------------------------+      +------------------+
 *     | {"team_name": "default",   |      | alice.jsonl      |
 *     |  "members": [              |      | bob.jsonl        |
 *     |    {"name":"alice",        |      | lead.jsonl       |
 *     |     "role":"coder",        |      +------------------+
 *     |     "status":"idle"}       |
 *     |  ]}                        |      send_message("alice", "fix bug"):
 *     +----------------------------+        open("alice.jsonl", "a").write(msg)
 *
 *                                         read_inbox("alice"):
 *     spawn_teammate("alice","coder",...)   msgs = [json.loads(l) for l in ...]
 *          |                                open("alice.jsonl", "w").close()
 *          v                                return msgs  # drain
 *     Thread: alice             Thread: bob
 *     +------------------+      +------------------+
 *     | agent_loop       |      | agent_loop       |
 *     | status: working  |      | status: idle     |
 *     | ... runs tools   |      | ... waits ...    |
 *     | status -> idle   |      |                  |
 *     +------------------+      +------------------+
 *
 *     5 message types (all declared, not all handled here):
 *     +-------------------------+-----------------------------------+
 *     | message                 | Normal text message               |
 *     | broadcast               | Sent to all teammates             |
 *     | shutdown_request        | Request graceful shutdown (s10)   |
 *     | shutdown_response       | Approve/reject shutdown (s10)     |
 *     | plan_approval_response  | Approve/reject plan (s10)         |
 *     +-------------------------+-----------------------------------+
 *
 * Key insight: "Teammates that can talk to each other."
 */

import 'dotenv/config';

import { readline } from 'readline';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, isAbsolute } from 'path';
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

const TEAM_DIR = resolve(WORKDIR, '.team');
const INBOX_DIR = resolve(TEAM_DIR, 'inbox');

const SYSTEM = `You are a team lead at ${WORKDIR}. Spawn teammates and communicate via inboxes.`;

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);


function parseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

// -- MessageBus: JSONL inbox per teammate --
class MessageBus {
  constructor(inboxDir) {
    this.dir = inboxDir;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
  }

  send(sender, to, content, msgType = "message", extra = null) {
    if (!VALID_MSG_TYPES.has(msgType)) {
      return `Error: Invalid type '${msgType}'. Valid: ${Array.from(VALID_MSG_TYPES).join(', ')}`;
    }
    const msg = {
      type: msgType,
      from: sender,
      content: content,
      timestamp: Date.now() / 1000,
    };
    if (extra) {
      Object.assign(msg, extra);
    }
    const inboxPath = resolve(this.dir, `${to}.jsonl`);
    writeFileSync(inboxPath, JSON.stringify(msg) + "\n", { flag: 'a' });
    return `Sent ${msgType} to ${to}`;
  }

  readInbox(name) {
    const inboxPath = resolve(this.dir, `${name}.jsonl`);
    if (!existsSync(inboxPath)) {
      return [];
    }
    const content = readFileSync(inboxPath, 'utf-8').trim();
    const messages = [];
    if (content) {
      content.split('\n').forEach(line => {
        if (line.trim()) {
          const parsed = parseJSON(line);
          if (parsed) messages.push(parsed);
        }
      });
    }
    // Drain the inbox
    writeFileSync(inboxPath, '');
    return messages;
  }

  broadcast(sender, content, teammates) {
    let count = 0;
    for (const name of teammates) {
      if (name !== sender) {
        this.send(sender, name, content, "broadcast");
        count++;
      }
    }
    return `Broadcast to ${count} teammates`;
  }
}

const BUS = new MessageBus(INBOX_DIR);


// -- TeammateManager: persistent named agents with config.json --
class TeammateManager {
  constructor(teamDir) {
    this.dir = teamDir;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    this.configPath = resolve(this.dir, 'config.json');
    this.config = this._loadConfig();
    this.threads = new Map();
    this.client = new OpenRouter({ apiKey });
  }

  _loadConfig() {
    if (existsSync(this.configPath)) {
      const content = readFileSync(this.configPath, 'utf-8');
      return parseJSON(content) || { team_name: "default", members: [] };
    }
    return { team_name: "default", members: [] };
  }

  _saveConfig() {
    writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
  }

  _findMember(name) {
    for (const m of this.config.members) {
      if (m.name === name) return m;
    }
    return null;
  }

  spawn(name, role, prompt) {
    const member = this._findMember(name);
    if (member) {
      if (member.status !== "idle" && member.status !== "shutdown") {
        return `Error: '${name}' is currently ${member.status}`;
      }
      member.status = "working";
      member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this._saveConfig();

    const thread = {
      running: true,
      work: () => this._teammateLoop(name, role, prompt)
    };
    this.threads.set(name, thread);

    // Run in background
    setTimeout(() => thread.work(), 0);
    return `Spawned '${name}' (role: ${role})`;
  }

  async _teammateLoop(name, role, prompt) {
    const sysPrompt = (
      `You are '${name}', role: ${role}, at ${WORKDIR}. `
      `Use send_message to communicate. Complete your task.`
    );
    const messages = [{ role: "user", content: prompt }];
    const tools = this._teammateTools();

    for (let i = 0; i < 50; i++) {
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }

      try {
        var response = await this.client.chat.completions.create({
          model: model,
          messages: [
            { role: "system", content: sysPrompt },
            ...messages
          ],
          tools: toOpenAITools(tools),
          max_tokens: 8000,
        });
      } catch (e) {
        break;
      }

      const message = response.choices[0].message;
      messages.push({ role: "assistant", content: message.content });

      if (!message.toolCalls || message.toolCalls.length === 0) {
        break;
      }

      const results = [];
      for (const toolCall of message.toolCalls) {
        const args = parseJSON(toolCall.function.arguments) || {};
        const output = this._exec(name, toolCall.function.name, args);
        console.log(`  [${name}] ${toolCall.function.name}: ${String(output).substring(0, 120)}`);
        results.push({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: String(output),
        });
      }
      messages.push({ role: "user", content: results });
    }

    const member = this._findMember(name);
    if (member && member.status !== "shutdown") {
      member.status = "idle";
      this._saveConfig();
    }
  }

  _exec(sender, toolName, args) {
    // These base tools are unchanged from s02
    if (toolName === "bash") return _runBash(args.command);
    if (toolName === "read_file") return _runRead(args.path);
    if (toolName === "write_file") return _runWrite(args.path, args.content);
    if (toolName === "edit_file") return _runEdit(args.path, args.old_text, args.new_text);
    if (toolName === "send_message") return BUS.send(sender, args.to, args.content, args.msg_type || "message");
    if (toolName === "read_inbox") return JSON.stringify(BUS.readInbox(sender), null, 2);
    return `Unknown tool: ${toolName}`;
  }

  _teammateTools() {
    // These base tools are unchanged from s02
    return [
      { name: "bash", description: "Run a shell command.",
        input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }},
      { name: "read_file", description: "Read file contents.",
        input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }},
      { name: "write_file", description: "Write content to file.",
        input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }},
      { name: "edit_file", description: "Replace exact text in file.",
        input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] }},
      { name: "send_message", description: "Send message to a teammate.",
        input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) } }, required: ["to", "content"] }},
      { name: "read_inbox", description: "Read and drain your inbox.",
        input_schema: { type: "object", properties: {}}},
    ];
  }

  listAll() {
    if (!this.config.members || this.config.members.length === 0) {
      return "No teammates.";
    }
    const lines = [`Team: ${this.config.team_name}`];
    for (const m of this.config.members) {
      lines.push(`  ${m.name} (${m.role}): ${m.status}`);
    }
    return lines.join('\n');
  }

  memberNames() {
    return this.config.members.map(m => m.name);
  }
}

const TEAM = new TeammateManager(TEAM_DIR);


// -- Base tool implementations (these base tools are unchanged from s02) --
function safePath(p) {
  let path;
  if (isAbsolute(p)) {
    path = resolve(p);
  } else {
    path = resolve(WORKDIR, p);
  }

  const workdirResolved = resolve(WORKDIR);
  if (!path.startsWith(workdirResolved)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return path;
}

function _runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot"];
  if (dangerous.some(d => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  return new Promise((resolve) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : '/bin/sh';
    const shellFlag = isWindows ? '/c' : '-c';

    const child = spawn(shell, [shellFlag, command], {
      cwd: WORKDIR,
      timeout: 120000
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });

    child.on('close', () => {
      const out = (stdout + stderr).trim();
      resolve(out ? out.substring(0, 50000) : "(no output)");
    });

    child.on('error', (err) => { resolve(`Error: ${err.message}`); });

    setTimeout(() => {
      if (!child.killed) { child.kill(); resolve("Error: Timeout (120s)"); }
    }, 120000);
  });
}

function _runRead(path, limit = null) {
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

function _runWrite(path, content) {
  try {
    const fp = safePath(path);
    const dir = fp.substring(0, fp.lastIndexOf('/') || fp.lastIndexOf('\\'));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes`;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

function _runEdit(path, oldText, newText) {
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


// -- Lead tool dispatch (9 tools) --
const TOOL_HANDLERS = {
  bash: async (params) => await _runBash(params.command),
  read_file: (params) => _runRead(params.path, params.limit),
  write_file: (params) => _runWrite(params.path, params.content),
  edit_file: (params) => _runEdit(params.path, params.old_text, params.new_text),
  spawn_teammate: (params) => TEAM.spawn(params.name, params.role, params.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: (params) => BUS.send("lead", params.to, params.content, params.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: (params) => BUS.broadcast("lead", params.content, TEAM.memberNames()),
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
  { name: "bash", description: "Run a shell command.",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }},
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] }},
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }},
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] }},
  { name: "spawn_teammate", description: "Spawn a persistent teammate that runs in its own thread.",
    input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] }},
  { name: "list_teammates", description: "List all teammates with name, role, status.",
    input_schema: { type: "object", properties: {}}},
  { name: "send_message", description: "Send a message to a teammate's inbox.",
    input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) } }, required: ["to", "content"] }},
  { name: "read_inbox", description: "Read and drain the lead's inbox.",
    input_schema: { type: "object", properties: {}}},
  { name: "broadcast", description: "Send a message to all teammates.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }},
];


async function agentLoop(messages) {
  while (true) {
    const inbox = BUS.readInbox("lead");
    if (inbox && inbox.length > 0) {
      messages.push({
        role: "user",
        content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>`,
      });
      messages.push({
        role: "assistant",
        content: "Noted inbox messages.",
      });
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
        const args = parseJSON(toolCall.function.arguments) || {};
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
    rl.question('\x1b[36ms09 >> \x1b[0m', async (query) => {
      const q = query.trim();
      if (q.toLowerCase() in ('q', 'exit', '')) {
        rl.close();
        return;
      }
      if (q === '/team') {
        console.log(TEAM.listAll());
        ask();
        return;
      }
      if (q === '/inbox') {
        console.log(JSON.stringify(BUS.readInbox("lead"), null, 2));
        ask();
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
