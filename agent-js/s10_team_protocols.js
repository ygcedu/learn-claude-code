#!/usr/bin/env node
/**
 * s10_team_protocols.js - Team Protocols
 *
 * Shutdown protocol and plan approval protocol, both using the same
 * request_id correlation pattern. Builds on s09's team messaging.
 *
 *     Shutdown FSM: pending -> approved | rejected
 *
 *     Lead                              Teammate
 *     +---------------------+          +---------------------+
 *     | shutdown_request     |          |                     |
 *     | {                    | -------> | receives request    |
 *     |   request_id: abc    |          | decides: approve?   |
 *     | }                    |          |                     |
 *     +---------------------+          +---------------------+
 *                                              |
 *     +---------------------+          +-------v-------------+
 *     | shutdown_response    | <------- | shutdown_response   |
 *     | {                    |          | {                   |
 *     |   request_id: abc    |          |   request_id: abc   |
 *     |   approve: true      |          |   approve: true     |
 *     | }                    |          | }                   |
 *     +---------------------+          +---------------------+
 *             |
 *             v
 *     status -> "shutdown", thread stops
 *
 *     Plan approval FSM: pending -> approved | rejected
 *
 *     Teammate                          Lead
 *     +---------------------+          +---------------------+
 *     | plan_approval        |          |                     |
 *     | submit: {plan:"..."}| -------> | reviews plan text   |
 *     +---------------------+          | approve/reject?     |
 *                                      +---------------------+
 *                                              |
 *     +---------------------+          +-------v-------------+
 *     | plan_approval_resp   | <------- | plan_approval       |
 *     | {approve: true}      |          | review: {req_id,    |
 *     +---------------------+          |   approve: true}     |
 *                                      +---------------------+
 *
 *     Trackers: {request_id: {"target|from": name, "status": "pending|..."}}
 *
 * Key insight: "Same request_id correlation pattern, two domains."
 */

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

const TEAM_DIR = resolve(WORKDIR, '.team');
const INBOX_DIR = resolve(TEAM_DIR, 'inbox');

const SYSTEM = `You are a team lead at ${WORKDIR}. Manage teammates with shutdown and plan approval protocols.`;

const VALID_MSG_TYPES = new Set([
  "message",
  "broadcast",
  "shutdown_request",
  "shutdown_response",
  "plan_approval_response",
]);

// -- Request trackers: correlate by request_id --
const shutdownRequests = new Map();
const planRequests = new Map();
let trackerLock = false;

function acquireLock() {
  while (trackerLock) {}
  trackerLock = true;
}

function releaseLock() {
  trackerLock = false;
}

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


// -- TeammateManager with shutdown + plan approval --
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
    setTimeout(() => thread.work(), 0);
    return `Spawned '${name}' (role: ${role})`;
  }

  async _teammateLoop(name, role, prompt) {
    const sysPrompt = (
      `You are '${name}', role: ${role}, at ${WORKDIR}. `
      `Submit plans via plan_approval before major work. `
      `Respond to shutdown_request with shutdown_response.`
    );
    const messages = [{ role: "user", content: prompt }];
    const tools = this._teammateTools();
    let shouldExit = false;

    for (let i = 0; i < 50; i++) {
      const inbox = BUS.readInbox(name);
      for (const msg of inbox) {
        messages.push({ role: "user", content: JSON.stringify(msg) });
      }
      if (shouldExit) break;

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

        if (toolCall.function.name === "shutdown_response" && args.approve) {
          shouldExit = true;
        }
      }
      messages.push({ role: "user", content: results });
    }

    const member = this._findMember(name);
    if (member) {
      member.status = shouldExit ? "shutdown" : "idle";
      this._saveConfig();
    }
  }

  _exec(sender, toolName, args) {
    if (toolName === "bash") return _runBash(args.command);
    if (toolName === "read_file") return _runRead(args.path);
    if (toolName === "write_file") return _runWrite(args.path, args.content);
    if (toolName === "edit_file") return _runEdit(args.path, args.old_text, args.new_text);
    if (toolName === "send_message") return BUS.send(sender, args.to, args.content, args.msg_type || "message");
    if (toolName === "read_inbox") return JSON.stringify(BUS.readInbox(sender), null, 2);

    if (toolName === "shutdown_response") {
      const reqId = args.request_id;
      const approve = args.approve;
      acquireLock();
      if (shutdownRequests.has(reqId)) {
        shutdownRequests.get(reqId).status = approve ? "approved" : "rejected";
      }
      releaseLock();
      BUS.send(
        sender, "lead", args.reason || "",
        "shutdown_response", { request_id: reqId, approve: approve },
      );
      return `Shutdown ${approve ? 'approved' : 'rejected'}`;
    }

    if (toolName === "plan_approval") {
      const planText = args.plan || "";
      const reqId = crypto.randomBytes(4).toString('hex');
      acquireLock();
      planRequests.set(reqId, { from: sender, plan: planText, status: "pending" });
      releaseLock();
      BUS.send(
        sender, "lead", planText, "plan_approval_response",
        { request_id: reqId, plan: planText },
      );
      return `Plan submitted (request_id=${reqId}). Waiting for lead approval.`;
    }

    return `Unknown tool: ${toolName}`;
  }

  _teammateTools() {
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
      { name: "shutdown_response", description: "Respond to a shutdown request. Approve to shut down, reject to keep working.",
        input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, reason: { type: "string" } }, required: ["request_id", "approve"] }},
      { name: "plan_approval", description: "Submit a plan for lead approval. Provide plan text.",
        input_schema: { type: "object", properties: { plan: { type: "string" } }, required: ["plan"] }},
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


// -- Base tool implementations --
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

    const child = spawn(shell, [shellFlag, command], { cwd: WORKDIR, timeout: 120000 });
    let stdout = '', stderr = '';

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


// -- Lead-specific protocol handlers --
function handleShutdownRequest(teammate) {
  const reqId = crypto.randomBytes(4).toString('hex');
  acquireLock();
  shutdownRequests.set(reqId, { target: teammate, status: "pending" });
  releaseLock();

  BUS.send(
    "lead", teammate, "Please shut down gracefully.",
    "shutdown_request", { request_id: reqId },
  );
  return `Shutdown request ${reqId} sent to '${teammate}' (status: pending)`;
}

function handlePlanReview(requestId, approve, feedback = "") {
  acquireLock();
  const req = planRequests.get(requestId);
  releaseLock();

  if (!req) {
    return `Error: Unknown plan request_id '${requestId}'`;
  }

  acquireLock();
  req.status = approve ? "approved" : "rejected";
  releaseLock();

  BUS.send(
    "lead", req.from, feedback, "plan_approval_response",
    { request_id: requestId, approve: approve, feedback: feedback },
  );
  return `Plan ${req.status} for '${req.from}'`;
}

function checkShutdownStatus(requestId) {
  acquireLock();
  const result = shutdownRequests.get(requestId) || { error: "not found" };
  releaseLock();
  return JSON.stringify(result);
}


// -- Lead tool dispatch (12 tools) --
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
  shutdown_request: (params) => handleShutdownRequest(params.teammate),
  shutdown_response: (params) => checkShutdownStatus(params.request_id || ""),
  plan_approval: (params) => handlePlanReview(params.request_id, params.approve, params.feedback || ""),
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
  { name: "spawn_teammate", description: "Spawn a persistent teammate.",
    input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] }},
  { name: "list_teammates", description: "List all teammates.",
    input_schema: { type: "object", properties: {}}},
  { name: "send_message", description: "Send a message to a teammate.",
    input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) } }, required: ["to", "content"] }},
  { name: "read_inbox", description: "Read and drain the lead's inbox.",
    input_schema: { type: "object", properties: {}}},
  { name: "broadcast", description: "Send a message to all teammates.",
    input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }},
  { name: "shutdown_request", description: "Request a teammate to shut down gracefully. Returns a request_id for tracking.",
    input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] }},
  { name: "shutdown_response", description: "Check the status of a shutdown request by request_id.",
    input_schema: { type: "object", properties: { request_id: { type: "string" } }, required: ["request_id"] }},
  { name: "plan_approval", description: "Approve or reject a teammate's plan. Provide request_id + approve + optional feedback.",
    input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] }},
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
    rl.question('\x1b[36ms10 >> \x1b[0m', async (query) => {
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
