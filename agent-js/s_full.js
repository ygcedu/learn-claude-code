#!/usr/bin/env node
/**
 * s_full.js - Full Reference Agent
 *
 * Capstone implementation combining every mechanism from s01-s11.
 * Session s12 (task-aware worktree isolation) is taught separately.
 * NOT a teaching session -- this is the "put it all together" reference.
 *
 *     +------------------------------------------------------------------+
 *     |                        FULL AGENT                                 |
 *     |                                                                   |
 *     |  System prompt (s05 skills, task-first + optional todo nag)      |
 *     |                                                                   |
 *     |  Before each LLM call:                                            |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |  | Microcompact (s06) |  | Drain bg (s08)   |  | Check inbox  |  |
 *     |  | Auto-compact (s06) |  | notifications    |  | (s09)        |  |
 *     |  +--------------------+  +------------------+  +--------------+  |
 *     |                                                                   |
 *     |  Tool dispatch (s02 pattern):                                     |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |  | bash   | read     | write    | edit    | TodoWrite |          |
 *     |  | task   | load_sk  | compress | bg_run  | bg_check  |          |
 *     |  | t_crt  | t_get    | t_upd    | t_list  | spawn_tm  |          |
 *     |  | list_tm| send_msg | rd_inbox | bcast   | shutdown  |          |
 *     |  | plan   | idle     | claim    |         |           |          |
 *     |  +--------+----------+----------+---------+-----------+          |
 *     |                                                                   |
 *     |  Subagent (s04):  spawn -> work -> return summary                 |
 *     |  Teammate (s09):  spawn -> work -> idle -> auto-claim (s11)      |
 *     |  Shutdown (s10):  request_id handshake                            |
 *     |  Plan gate (s10): submit -> approve/reject                        |
 *     +------------------------------------------------------------------+
 *
 *     REPL commands: /compact /tasks /team /inbox
 */

import { readline } from 'readline';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
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

const client = new OpenRouter({ apiKey });

const TEAM_DIR = resolve(WORKDIR, '.team');
const INBOX_DIR = resolve(TEAM_DIR, 'inbox');
const TASKS_DIR = resolve(WORKDIR, '.tasks');
const SKILLS_DIR = resolve(WORKDIR, 'skills');
const TRANSCRIPT_DIR = resolve(WORKDIR, '.transcripts');
const TOKEN_THRESHOLD = 100000;
const POLL_INTERVAL = 5;
const IDLE_TIMEOUT = 60;

const VALID_MSG_TYPES = new Set(["message", "broadcast", "shutdown_request", "shutdown_response", "plan_approval_response"]);

function parseJSON(str) {
  try { return JSON.parse(str); } catch { return null; }
}


// === SECTION: base_tools ===
function safePath(p) {
  let path = isAbsolute(p) ? resolve(p) : resolve(WORKDIR, p);
  if (!path.startsWith(resolve(WORKDIR))) throw new Error(`Path escapes workspace: ${p}`);
  return path;
}

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some(d => command.includes(d))) return "Error: Dangerous command blocked";
  return new Promise(resolve => {
    const isWindows = process.platform === 'win32';
    const child = spawn(isWindows ? 'cmd.exe' : '/bin/sh', [isWindows ? '/c' : '-c', command], { cwd: WORKDIR, timeout: 120000 });
    let out = '', err = '';
    child.stdout?.on('data', d => out += d);
    child.stderr?.on('data', d => err += d);
    child.on('close', () => resolve((out + err).trim()[:50000] || "(no output)"));
    child.on('error', e => resolve(`Error: ${e.message}`));
    setTimeout(() => { child.kill(); resolve("Error: Timeout (120s)"); }, 120000);
  });
}

function runRead(path, limit = null) {
  try {
    const lines = readFileSync(safePath(path), 'utf-8').split('\n');
    if (limit && limit < lines.length) lines.splice(limit, 0, `... (${lines.length - limit} more)`);
    return lines.join('\n')[:50000];
  } catch (e) { return `Error: ${e.message}`; }
}

function runWrite(path, content) {
  try {
    const fp = safePath(path);
    const dir = fp.substring(0, fp.lastIndexOf('/'));
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(fp, content);
    return `Wrote ${content.length} bytes to ${path}`;
  } catch (e) { return `Error: ${e.message}`; }
}

function runEdit(path, oldText, newText) {
  try {
    const fp = safePath(path);
    const c = readFileSync(fp, 'utf-8');
    if (!c.includes(oldText)) return `Error: Text not found in ${path}`;
    writeFileSync(fp, c.replace(oldText, newText, 1));
    return `Edited ${path}`;
  } catch (e) { return `Error: ${e.message}`; }
}


// === SECTION: todos (s03) ===
class TodoManager {
  constructor() { this.items = []; }
  update(items) {
    const validated = [], ip = 0;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const content = String(item.content || "").trim();
      const status = String(item.status || "pending").toLowerCase();
      const af = String(item.activeForm || "").trim();
      if (!content) throw new Error(`Item ${i}: content required`);
      if (!["pending", "in_progress", "completed"].includes(status)) throw new Error(`Item ${i}: invalid status '${status}'`);
      if (!af) throw new Error(`Item ${i}: activeForm required`);
      if (status === "in_progress") ip++;
      validated.push({ content, status, activeForm: af });
    }
    if (validated.length > 20) throw new Error("Max 20 todos");
    if (ip > 1) throw new Error("Only one in_progress allowed");
    this.items = validated;
    return this.render();
  }
  render() {
    if (!this.items.length) return "No todos.";
    const lines = this.items.map(t => {
      const m = { completed: "[x]", in_progress: "[>]", pending: "[ ]" }[t.status] || "[?]";
      const suffix = t.status === "in_progress" ? ` <- ${t.activeForm}` : "";
      return `${m} ${t.content}${suffix}`;
    });
    const done = this.items.filter(t => t.status === "completed").length;
    lines.push(`\n(${done}/${this.items.length} completed)`);
    return lines.join('\n');
  }
  hasOpenItems() { return this.items.some(t => t.status !== "completed"); }
}


// === SECTION: subagent (s04) ===
async function runSubagent(prompt, agentType = "Explore") {
  const subTools = [
    { name: "bash", description: "Run command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }},
    { name: "read_file", description: "Read file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }},
  ];
  if (agentType !== "Explore") {
    subTools.push(
      { name: "write_file", description: "Write file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }},
      { name: "edit_file", description: "Edit file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] }},
    );
  }
  const subHandlers = {
    bash: p => runBash(p.command),
    read_file: p => runRead(p.path),
    write_file: p => runWrite(p.path, p.content),
    edit_file: p => runEdit(p.path, p.old_text, p.new_text),
  };
  const subMsgs = [{ role: "user", content: prompt }];
  let resp = null;
  for (let i = 0; i < 30; i++) {
    resp = await client.chat.send({ model, messages: subMsgs, tools: toOpenAITools(subTools), max_tokens: 8000 });
    subMsgs.push({ role: "assistant", content: resp.choices[0].message.content });
    if (!resp.choices[0].message.toolCalls || resp.choices[0].message.toolCalls.length === 0) break;
    const results = [];
    for (const tc of resp.choices[0].message.toolCalls) {
      const h = subHandlers[tc.function.name] || (() => "Unknown tool");
      const args = parseJSON(tc.function.arguments) || {};
      results.push({ type: "tool_result", tool_use_id: tc.id, content: String(h(args))[:50000] });
    }
    subMsgs.push({ role: "user", content: results });
  }
  if (resp) {
    const content = resp.choices[0].message.content;
    if (Array.isArray(content)) return content.filter(c => c.text).map(c => c.text).join("") || "(no summary)";
    return content || "(no summary)";
  }
  return "(subagent failed)";
}


// === SECTION: skills (s05) ===
class SkillLoader {
  constructor(skillsDir) {
    this.skills = {};
    if (existsSync(skillsDir)) {
      const files = readdirSync(skillsDir).filter(f => f.endsWith('.md'));
      for (const f of files) {
        const text = readFileSync(resolve(skillsDir, f), 'utf-8');
        const match = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        let meta = {}, body = text;
        if (match) {
          match[1].split('\n').forEach(line => {
            if (line.includes(':')) {
              const [k, v] = line.split(':', 1);
              meta[k.trim()] = v.trim();
            }
          });
          body = match[2].trim();
        }
        this.skills[f.replace('.md', '')] = { meta, body };
      }
    }
  }
  descriptions() {
    if (!Object.keys(this.skills).length) return "(no skills)";
    return Object.entries(this.skills).map(([n, s]) => `  - ${n}: ${s.meta.description || '-'}`).join('\n');
  }
  load(name) {
    const s = this.skills[name];
    if (!s) return `Error: Unknown skill '${name}'. Available: ${Object.keys(this.skills).join(', ')}`;
    return `<skill name="${name}">\n${s.body}\n</skill>`;
  }
}


// === SECTION: compression (s06) ===
function estimateTokens(messages) {
  return JSON.stringify(messages).length / 4;
}

function microcompact(messages) {
  const indices = [];
  messages.forEach((msg, i) => {
    if (msg.role === "user" && Array.isArray(msg.content)) {
      msg.content.forEach(part => {
        if (part && part.type === "tool_result") indices.push(part);
      });
    }
  });
  if (indices.length <= 3) return;
  indices.slice(0, -3).forEach(part => {
    if (typeof part.content === "string" && part.content.length > 100) part.content = "[cleared]";
  });
}

async function autoCompact(messages) {
  if (!existsSync(TRANSCRIPT_DIR)) mkdirSync(TRANSCRIPT_DIR, { recursive: true });
  const path = resolve(TRANSCRIPT_DIR, `transcript_${Date.now()}.jsonl`);
  const f = writeFileSync(path, '');
  messages.forEach(msg => {
    writeFileSync(path, JSON.stringify(msg) + "\n", { flag: 'a' });
  });
  const convText = JSON.stringify(messages).slice(0, 80000);
  const resp = await client.chat.send({
    model,
    messages: [{ role: "user", content: `Summarize for continuity:\n${convText}` }],
    max_tokens: 2000,
  });
  const summary = resp.choices[0].message.content;
  return [
    { role: "user", content: `[Compressed. Transcript: ${path}]\n${summary}` },
    { role: "assistant", content: "Understood. Continuing with summary context." },
  ];
}


// === SECTION: file_tasks (s07) ===
class TaskManager {
  constructor() {
    if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
  }
  _nextId() {
    const files = readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json'));
    const ids = files.map(f => parseInt(f.match(/task_(\d+)/)?.[1] || "0"));
    return Math.max(0, ...ids) + 1;
  }
  _load(tid) {
    const p = resolve(TASKS_DIR, `task_${tid}.json`);
    if (!existsSync(p)) throw new Error(`Task ${tid} not found`);
    return parseJSON(readFileSync(p, 'utf-8'));
  }
  _save(task) {
    writeFileSync(resolve(TASKS_DIR, `task_${task.id}.json`), JSON.stringify(task, null, 2));
  }
  create(subject, description = "") {
    const task = { id: this._nextId(), subject, description, status: "pending", owner: null, blockedBy: [], blocks: [] };
    this._save(task);
    return JSON.stringify(task, null, 2);
  }
  get(tid) { return JSON.stringify(this._load(tid), null, 2); }
  update(tid, status = null, addBlockedBy = null, addBlocks = null) {
    const task = this._load(tid);
    if (status) {
      task.status = status;
      if (status === "completed") {
        readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json')).forEach(f => {
          const t = parseJSON(readFileSync(resolve(TASKS_DIR, f), 'utf-8'));
          if (t.blockedBy?.includes(tid)) {
            t.blockedBy = t.blockedBy.filter(id => id !== tid);
            this._save(t);
          }
        });
      }
      if (status === "deleted") {
        const p = resolve(TASKS_DIR, `task_${tid}.json`);
        if (existsSync(p)) require('fs').unlinkSync(p);
        return `Task ${tid} deleted`;
      }
    }
    if (addBlockedBy) task.blockedBy = [...new Set([...(task.blockedBy || []), ...addBlockedBy])];
    if (addBlocks) task.blocks = [...new Set([...(task.blocks || []), ...addBlocks])];
    this._save(task);
    return JSON.stringify(task, null, 2);
  }
  listAll() {
    const files = readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json')).sort();
    if (!files.length) return "No tasks.";
    return files.map(f => {
      const t = parseJSON(readFileSync(resolve(TASKS_DIR, f), 'utf-8'));
      const m = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
      const owner = t.owner ? ` @${t.owner}` : "";
      const blocked = t.blockedBy?.length ? ` (blocked by: ${t.blockedBy})` : "";
      return `${m} #${t.id}: ${t.subject}${owner}${blocked}`;
    }).join('\n');
  }
  claim(tid, owner) {
    const task = this._load(tid);
    task.owner = owner;
    task.status = "in_progress";
    this._save(task);
    return `Claimed task #${tid} for ${owner}`;
  }
}


// === SECTION: background (s08) ===
class BackgroundManager {
  constructor() {
    this.tasks = {};
    this.notifications = [];
  }
  run(command, timeout = 120) {
    const tid = crypto.randomBytes(4).toString('hex');
    this.tasks[tid] = { status: "running", command, result: null };
    setTimeout(() => this._exec(tid, command, timeout), 0);
    return `Background task ${tid} started: ${command.slice(0, 80)}`;
  }
  _exec(tid, command, timeout) {
    try {
      const isWindows = process.platform === 'win32';
      const child = spawn(isWindows ? 'cmd.exe' : '/bin/sh', [isWindows ? '/c' : '-c', command], { cwd: WORKDIR, timeout });
      let out = '', err = '';
      child.stdout?.on('data', d => out += d);
      child.stderr?.on('data', d => err += d);
      child.on('close', () => {
        const output = (out + err).trim().slice(0, 50000);
        this.tasks[tid] = { status: "completed", result: output || "(no output)" };
        this.notifications.push({ task_id: tid, status: "completed", result: (output || "(no output)").slice(0, 500) });
      });
      child.on('error', e => {
        this.tasks[tid] = { status: "error", result: e.message };
        this.notifications.push({ task_id: tid, status: "error", result: e.message.slice(0, 500) });
      });
      setTimeout(() => { child.kill(); }, timeout * 1000);
    } catch (e) {
      this.tasks[tid] = { status: "error", result: e.message };
      this.notifications.push({ task_id: tid, status: "error", result: e.message.slice(0, 500) });
    }
  }
  check(tid = null) {
    if (tid) {
      const t = this.tasks[tid];
      return t ? `[${t.status}] ${t.result || '(running)'}` : `Unknown: ${tid}`;
    }
    const lines = Object.entries(this.tasks).map(([k, v]) => `${k}: [${v.status}] ${v.command.slice(0, 60)}`);
    return lines.length ? lines.join('\n') : "No bg tasks.";
  }
  drain() {
    const notifs = [...this.notifications];
    this.notifications = [];
    return notifs;
  }
}


// === SECTION: messaging (s09) ===
class MessageBus {
  constructor() {
    if (!existsSync(INBOX_DIR)) mkdirSync(INBOX_DIR, { recursive: true });
  }
  send(sender, to, content, msgType = "message", extra = null) {
    const msg = { type: msgType, from: sender, content, timestamp: Date.now() / 1000 };
    if (extra) Object.assign(msg, extra);
    writeFileSync(resolve(INBOX_DIR, `${to}.jsonl`), JSON.stringify(msg) + "\n", { flag: 'a' });
    return `Sent ${msgType} to ${to}`;
  }
  readInbox(name) {
    const path = resolve(INBOX_DIR, `${name}.jsonl`);
    if (!existsSync(path)) return [];
    const msgs = readFileSync(path, 'utf-8').trim().split('\n').filter(l => l).map(l => parseJSON(l)).filter(Boolean);
    writeFileSync(path, '');
    return msgs;
  }
  broadcast(sender, content, names) {
    let count = 0;
    names.forEach(n => { if (n !== sender) { this.send(sender, n, content, "broadcast"); count++; } });
    return `Broadcast to ${count} teammates`;
  }
}


// === SECTION: shutdown + plan tracking (s10) ===
const shutdownRequests = new Map();
const planRequests = new Map();


// === SECTION: team (s09/s11) ===
class TeammateManager {
  constructor(bus, taskMgr) {
    if (!existsSync(TEAM_DIR)) mkdirSync(TEAM_DIR, { recursive: true });
    this.bus = bus;
    this.taskMgr = taskMgr;
    this.configPath = resolve(TEAM_DIR, 'config.json');
    this.config = this._load();
  }
  _load() {
    return existsSync(this.configPath) ? parseJSON(readFileSync(this.configPath, 'utf-8')) : { team_name: "default", members: [] };
  }
  _save() { writeFileSync(this.configPath, JSON.stringify(this.config, null, 2)); }
  _find(name) { return this.config.members.find(m => m.name === name) || null; }
  spawn(name, role, prompt) {
    const member = this._find(name);
    if (member) {
      if (!["idle", "shutdown"].includes(member.status)) return `Error: '${name}' is currently ${member.status}`;
      member.status = "working"; member.role = role;
    } else {
      this.config.members.push({ name, role, status: "working" });
    }
    this._save();
    setTimeout(() => this._loop(name, role, prompt), 0);
    return `Spawned '${name}' (role: ${role})`;
  }
  _setStatus(name, status) { const m = this._find(name); if (m) { m.status = status; this._save(); } }
  async _loop(name, role, prompt) {
    const teamName = this.config.team_name;
    const sysPrompt = `You are '${name}', role: ${role}, team: ${teamName}, at ${WORKDIR}. Use idle when done with current work. You may auto-claim tasks.`;
    const messages = [{ role: "user", content: prompt }];
    const tools = [
      { name: "bash", description: "Run command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }},
      { name: "read_file", description: "Read file.", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }},
      { name: "write_file", description: "Write file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }},
      { name: "edit_file", description: "Edit file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] }},
      { name: "send_message", description: "Send message.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" } }, required: ["to", "content"] }},
      { name: "idle", description: "Signal no more work.", input_schema: { type: "object", properties: {}}},
      { name: "claim_task", description: "Claim task by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] }},
    ];
    while (true) {
      for (let i = 0; i < 50; i++) {
        const inbox = this.bus.readInbox(name);
        inbox.forEach(msg => {
          if (msg.type === "shutdown_request") { this._setStatus(name, "shutdown"); return; }
          messages.push({ role: "user", content: JSON.stringify(msg) });
        });
        try {
          var resp = await client.chat.send({ model, messages: [{ role: "system", content: sysPrompt }, ...messages], tools, max_tokens: 8000 });
        } catch { this._setStatus(name, "shutdown"); return; }
        const msg = resp.choices[0].message;
        messages.push({ role: "assistant", content: msg.content });
        if (!msg.toolCalls || !msg.toolCalls?.length) break;
        const results = [];
        let idleRequested = false;
        for (const tc of msg.toolCalls) {
          const args = parseJSON(tc.function.arguments) || {};
          let output;
          if (tc.function.name === "idle") { idleRequested = true; output = "Entering idle phase."; }
          else if (tc.function.name === "claim_task") output = this.taskMgr.claim(args.task_id, name);
          else if (tc.function.name === "send_message") output = this.bus.send(name, args.to, args.content);
          else if (tc.function.name === "bash") output = await runBash(args.command);
          else if (tc.function.name === "read_file") output = runRead(args.path);
          else if (tc.function.name === "write_file") output = runWrite(args.path, args.content);
          else if (tc.function.name === "edit_file") output = runEdit(args.path, args.old_text, args.new_text);
          else output = `Unknown: ${tc.function.name}`;
          console.log(`  [${name}] ${tc.function.name}: ${String(output).slice(0, 120)}`);
          results.push({ type: "tool_result", tool_use_id: tc.id, content: String(output) });
        }
        messages.push({ role: "user", content: results });
        if (idleRequested) break;
      }
      this._setStatus(name, "idle");
      let resume = false;
      for (let i = 0; i < IDLE_TIMEOUT / Math.max(POLL_INTERVAL, 1); i++) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL * 1000));
        const inbox = this.bus.readInbox(name);
        if (inbox.length) {
          inbox.forEach(msg => {
            if (msg.type === "shutdown_request") { this._setStatus(name, "shutdown"); return; }
            messages.push({ role: "user", content: JSON.stringify(msg) });
          });
          resume = true; break;
        }
        const files = readdirSync(TASKS_DIR).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        const unclaimed = files.map(f => parseJSON(readFileSync(resolve(TASKS_DIR, f), 'utf-8'))).filter(t => t.status === "pending" && !t.owner && !t.blockedBy?.length);
        if (unclaimed.length) {
          const task = unclaimed[0];
          this.taskMgr.claim(task.id, name);
          if (messages.length <= 3) {
            messages.unshift({ role: "user", content: `<identity>You are '${name}', role: ${role}, team: ${teamName}.</identity>` });
            messages.splice(1, 0, { role: "assistant", content: `I am ${name}. Continuing.` });
          }
          messages.push({ role: "user", content: `<auto-claimed>Task #${task.id}: ${task.subject}\n${task.description || ''}</auto-claimed>` });
          messages.push({ role: "assistant", content: `Claimed task #${task.id}. Working on it.` });
          resume = true; break;
        }
      }
      if (!resume) { this._setStatus(name, "shutdown"); return; }
      this._setStatus(name, "working");
    }
  }
  listAll() {
    if (!this.config.members.length) return "No teammates.";
    return [`Team: ${this.config.team_name}`, ...this.config.members.map(m => `  ${m.name} (${m.role}): ${m.status}`)].join('\n');
  }
  memberNames() { return this.config.members.map(m => m.name); }
}


// === SECTION: global_instances ===
const TODO = new TodoManager();
const SKILLS = new SkillLoader(SKILLS_DIR);
const TASK_MGR = new TaskManager();
const BG = new BackgroundManager();
const BUS = new MessageBus();
const TEAM = new TeammateManager(BUS, TASK_MGR);


// === SECTION: system_prompt ===
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks.
Prefer task_create/task_update/task_list for multi-step work. Use TodoWrite for short checklists.
Use task for subagent delegation. Use load_skill for specialized knowledge.
Skills: ${SKILLS.descriptions()}`;


// === SECTION: shutdown_protocol (s10) ===
function handleShutdownRequest(teammate) {
  const reqId = crypto.randomBytes(4).toString('hex');
  shutdownRequests.set(reqId, { target: teammate, status: "pending" });
  BUS.send("lead", teammate, "Please shut down.", "shutdown_request", { request_id: reqId });
  return `Shutdown request ${reqId} sent to '${teammate}'`;
}


// === SECTION: plan_approval (s10) ===
function handlePlanReview(requestId, approve, feedback = "") {
  const req = planRequests.get(requestId);
  if (!req) return `Error: Unknown plan request_id '${requestId}'`;
  req.status = approve ? "approved" : "rejected";
  BUS.send("lead", req.from, feedback, "plan_approval_response", { request_id: requestId, approve, feedback });
  return `Plan ${req.status} for '${req.from}'`;
}


// === SECTION: tool_dispatch (s02) ===
const TOOL_HANDLERS = {
  bash: p => runBash(p.command),
  read_file: p => runRead(p.path, p.limit),
  write_file: p => runWrite(p.path, p.content),
  edit_file: p => runEdit(p.path, p.old_text, p.new_text),
  TodoWrite: p => TODO.update(p.items),
  task: p => runSubagent(p.prompt, p.agent_type || "Explore"),
  load_skill: p => SKILLS.load(p.name),
  compress: () => "Compressing...",
  background_run: p => BG.run(p.command, p.timeout || 120),
  check_background: p => BG.check(p.task_id),
  task_create: p => TASK_MGR.create(p.subject, p.description || ""),
  task_get: p => TASK_MGR.get(p.task_id),
  task_update: p => TASK_MGR.update(p.task_id, p.status, p.add_blocked_by, p.add_blocks),
  task_list: () => TASK_MGR.listAll(),
  spawn_teammate: p => TEAM.spawn(p.name, p.role, p.prompt),
  list_teammates: () => TEAM.listAll(),
  send_message: p => BUS.send("lead", p.to, p.content, p.msg_type || "message"),
  read_inbox: () => JSON.stringify(BUS.readInbox("lead"), null, 2),
  broadcast: p => BUS.broadcast("lead", p.content, TEAM.memberNames()),
  shutdown_request: p => handleShutdownRequest(p.teammate),
  plan_approval: p => handlePlanReview(p.request_id, p.approve, p.feedback || ""),
  idle: () => "Lead does not idle.",
  claim_task: p => TASK_MGR.claim(p.task_id, "lead"),
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
  { name: "bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }},
  { name: "read_file", description: "Read file contents.", input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] }},
  { name: "write_file", description: "Write content to file.", input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }},
  { name: "edit_file", description: "Replace exact text in file.", input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] }},
  { name: "TodoWrite", description: "Update task tracking list.", input_schema: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { content: { type: "string" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, activeForm: { type: "string" } }, required: ["content", "status", "activeForm"] } } }, required: ["items"] }},
  { name: "task", description: "Spawn a subagent for isolated exploration or work.", input_schema: { type: "object", properties: { prompt: { type: "string" }, agent_type: { type: "string", enum: ["Explore", "general-purpose"] } }, required: ["prompt"] }},
  { name: "load_skill", description: "Load specialized knowledge by name.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }},
  { name: "compress", description: "Manually compress conversation context.", input_schema: { type: "object", properties: {}}},
  { name: "background_run", description: "Run command in background thread.", input_schema: { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer" } }, required: ["command"] }},
  { name: "check_background", description: "Check background task status.", input_schema: { type: "object", properties: { task_id: { type: "string" } }}},
  { name: "task_create", description: "Create a persistent file task.", input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] }},
  { name: "task_get", description: "Get task details by ID.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] }},
  { name: "task_update", description: "Update task status or dependencies.", input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] }, add_blocked_by: { type: "array", items: { type: "integer" } }, add_blocks: { type: "array", items: { type: "integer" } } }, required: ["task_id"] }},
  { name: "task_list", description: "List all tasks.", input_schema: { type: "object", properties: {}}},
  { name: "spawn_teammate", description: "Spawn a persistent autonomous teammate.", input_schema: { type: "object", properties: { name: { type: "string" }, role: { type: "string" }, prompt: { type: "string" } }, required: ["name", "role", "prompt"] }},
  { name: "list_teammates", description: "List all teammates.", input_schema: { type: "object", properties: {}}},
  { name: "send_message", description: "Send a message to a teammate.", input_schema: { type: "object", properties: { to: { type: "string" }, content: { type: "string" }, msg_type: { type: "string", enum: Array.from(VALID_MSG_TYPES) } }, required: ["to", "content"] }},
  { name: "read_inbox", description: "Read and drain the lead's inbox.", input_schema: { type: "object", properties: {}}},
  { name: "broadcast", description: "Send message to all teammates.", input_schema: { type: "object", properties: { content: { type: "string" } }, required: ["content"] }},
  { name: "shutdown_request", description: "Request a teammate to shut down.", input_schema: { type: "object", properties: { teammate: { type: "string" } }, required: ["teammate"] }},
  { name: "plan_approval", description: "Approve or reject a teammate's plan.", input_schema: { type: "object", properties: { request_id: { type: "string" }, approve: { type: "boolean" }, feedback: { type: "string" } }, required: ["request_id", "approve"] }},
  { name: "idle", description: "Enter idle state.", input_schema: { type: "object", properties: {}}},
  { name: "claim_task", description: "Claim a task from the board.", input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] }},
];


// === SECTION: agent_loop ===
async function agentLoop(messages) {
  let roundsWithoutTodo = 0;
  while (true) {
    microcompact(messages);
    if (estimateTokens(messages) > TOKEN_THRESHOLD) {
      console.log("[auto-compact triggered]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      compacted.forEach(m => messages.push(m));
    }
    const notifs = BG.drain();
    if (notifs.length) {
      const txt = notifs.map(n => `[bg:${n.task_id}] ${n.status}: ${n.result}`).join('\n');
      messages.push({ role: "user", content: `<background-results>\n${txt}\n</background-results>` });
      messages.push({ role: "assistant", content: "Noted background results." });
    }
    const inbox = BUS.readInbox("lead");
    if (inbox.length) {
      messages.push({ role: "user", content: `<inbox>${JSON.stringify(inbox, null, 2)}</inbox>` });
      messages.push({ role: "assistant", content: "Noted inbox messages." });
    }
    const response = await client.chat.send({
      model, messages: [{ role: "system", content: SYSTEM }, ...messages], tools: toOpenAITools(TOOLS), max_tokens: 8000,
    });
    const msg = response.choices[0].message;
    messages.push({ role: "assistant", content: msg.content });
    if (!msg.toolCalls || !msg.toolCalls.length) return;
    const results = [];
    let usedTodo = false;
    let manualCompress = false;
    for (const tc of msg.toolCalls) {
      if (tc.function.name === "compress") manualCompress = true;
      const handler = TOOL_HANDLERS[tc.function.name];
      let output;
      try {
        const args = parseJSON(tc.function.arguments) || {};
        output = handler ? await handler(args) : `Unknown tool: ${tc.function.name}`;
      } catch (e) { output = `Error: ${e.message}`; }
      console.log(`> ${tc.function.name}: ${String(output).slice(0, 200)}`);
      results.push({ type: "tool_result", tool_use_id: tc.id, content: String(output) });
      if (tc.function.name === "TodoWrite") usedTodo = true;
    }
    roundsWithoutTodo = usedTodo ? 0 : roundsWithoutTodo + 1;
    if (TODO.hasOpenItems() && roundsWithoutTodo >= 3) {
      results.unshift({ type: "text", text: "<reminder>Update your todos.</reminder>" });
    }
    messages.push({ role: "user", content: results });
    if (manualCompress) {
      console.log("[manual compact]");
      const compacted = await autoCompact(messages);
      messages.length = 0;
      compacted.forEach(m => messages.push(m));
    }
  }
}


// === SECTION: repl ===
async function main() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const history = [];
  const ask = () => {
    rl.question('\x1b[36ms_full >> \x1b[0m', async (query) => {
      const q = query.trim().toLowerCase();
      if (q in ('q', 'exit', '')) { rl.close(); return; }
      if (q === '/compact') { console.log("[manual compact via /compact]"); if (history.length) { const compacted = await autoCompact(history); history.length = 0; compacted.forEach(m => history.push(m)); } ask(); return; }
      if (q === '/tasks') { console.log(TASK_MGR.listAll()); ask(); return; }
      if (q === '/team') { console.log(TEAM.listAll()); ask(); return; }
      if (q === '/inbox') { console.log(JSON.stringify(BUS.readInbox("lead"), null, 2)); ask(); return; }
      history.push({ role: "user", content: query });
      await agentLoop(history);
      console.log();
      ask();
    });
  };
  ask();
}

main();
