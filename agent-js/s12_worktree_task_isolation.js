#!/usr/bin/env node
/**
 * s12_worktree_task_isolation.js - Worktree + Task Isolation
 *
 * Directory-level isolation for parallel task execution.
 * Tasks are the control plane and worktrees are the execution plane.
 *
 *     .tasks/task_12.json
 *       {
 *         "id": 12,
 *         "subject": "Implement auth refactor",
 *         "status": "in_progress",
 *         "worktree": "auth-refactor"
 *       }
 *
 *     .worktrees/index.json
 *       {
 *         "worktrees": [
 *           {
 *             "name": "auth-refactor",
 *             "path": ".../.worktrees/auth-refactor",
 *             "branch": "wt/auth-refactor",
 *             "task_id": 12,
 *             "status": "active"
 *           }
 *         ]
 *       }
 *
 * Key insight: "Isolate by directory, coordinate by task ID."
 */

import { readline } from 'readline';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
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


function detectRepoRoot(cwd) {
  // Return git repo root if cwd is inside a repo, else None.
  return new Promise((resolve) => {
    const child = spawn('git', ['rev-parse', '--show-toplevel'], {
      cwd: cwd,
      timeout: 10000
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const root = stdout.trim();
      if (root && existsSync(root)) {
        resolve(root);
      } else {
        resolve(null);
      }
    });

    child.on('error', () => resolve(null));

    setTimeout(() => {
      child.kill();
      resolve(null);
    }, 10000);
  });
}

// Use sync version for initialization
function detectRepoRootSync(cwd) {
  try {
    const result = require('child_process').execSync('git rev-parse --show-toplevel', {
      cwd: cwd,
      timeout: 10000,
      encoding: 'utf-8'
    });
    const root = result.trim();
    if (root && existsSync(root)) {
      return root;
    }
    return null;
  } catch (e) {
    return null;
  }
}

const REPO_ROOT = detectRepoRootSync(WORKDIR) || WORKDIR;

const SYSTEM = (
  `You are a coding agent at ${WORKDIR}. `
  "Use task + worktree tools for multi-task work. "
  "For parallel or risky changes: create tasks, allocate worktree lanes, "
  "run commands in those lanes, then choose keep/remove for closeout. "
  "Use worktree_events when you need lifecycle visibility."
);


function parseJSON(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}


// -- EventBus: append-only lifecycle events for observability --
class EventBus {
  constructor(eventLogPath) {
    this.path = eventLogPath;
    const dir = this.path.substring(0, this.path.lastIndexOf('/') || this.path.lastIndexOf('\\'));
    if (dir && !existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    if (!existsSync(this.path)) {
      writeFileSync(this.path, '');
    }
  }

  emit(event, task = null, worktree = null, error = null) {
    const payload = {
      event: event,
      ts: Date.now() / 1000,
      task: task || {},
      worktree: worktree || {},
    };
    if (error) {
      payload.error = error;
    }
    writeFileSync(this.path, JSON.stringify(payload) + "\n", { flag: 'a' });
  }

  listRecent(limit = 20) {
    const n = Math.max(1, Math.min(parseInt(limit) || 20, 200));
    const content = readFileSync(this.path, 'utf-8');
    const lines = content.split('\n').filter(l => l.trim());
    const recent = lines.slice(-n);
    const items = [];
    for (const line of recent) {
      const parsed = parseJSON(line);
      if (parsed) {
        items.push(parsed);
      } else {
        items.push({ event: "parse_error", raw: line });
      }
    }
    return JSON.stringify(items, null, 2);
  }
}


// -- TaskManager: persistent task board with optional worktree binding --
class TaskManager {
  constructor(tasksDir) {
    this.dir = tasksDir;
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    this._nextId = this._maxId() + 1;
  }

  _maxId() {
    const ids = [];
    try {
      const files = readdirSync(this.dir);
      for (const f of files) {
        if (f.startsWith('task_') && f.endsWith('.json')) {
          const match = f.match(/task_(\d+)\.json/);
          if (match) {
            ids.push(parseInt(match[1]));
          }
        }
      }
    } catch (e) {}
    return ids.length > 0 ? Math.max(...ids) : 0;
  }

  _path(taskId) {
    return resolve(this.dir, `task_${taskId}.json`);
  }

  _load(taskId) {
    const path = this._path(taskId);
    if (!existsSync(path)) {
      throw new Error(`Task ${taskId} not found`);
    }
    return parseJSON(readFileSync(path, 'utf-8'));
  }

  _save(task) {
    writeFileSync(this._path(task.id), JSON.stringify(task, null, 2));
  }

  create(subject, description = "") {
    const task = {
      id: this._nextId,
      subject: subject,
      description: description,
      status: "pending",
      owner: "",
      worktree: "",
      blockedBy: [],
      created_at: Date.now() / 1000,
      updated_at: Date.now() / 1000,
    };
    this._save(task);
    this._nextId++;
    return JSON.stringify(task, null, 2);
  }

  get(taskId) {
    return JSON.stringify(this._load(taskId), null, 2);
  }

  exists(taskId) {
    return existsSync(this._path(taskId));
  }

  update(taskId, status = null, owner = null) {
    const task = this._load(taskId);
    if (status) {
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`Invalid status: ${status}`);
      }
      task.status = status;
    }
    if (owner !== undefined) {
      task.owner = owner;
    }
    task.updated_at = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  bindWorktree(taskId, worktreeName, owner = "") {
    const task = this._load(taskId);
    task.worktree = worktreeName;
    if (owner) {
      task.owner = owner;
    }
    if (task.status === "pending") {
      task.status = "in_progress";
    }
    task.updated_at = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  unbindWorktree(taskId) {
    const task = this._load(taskId);
    task.worktree = "";
    task.updated_at = Date.now() / 1000;
    this._save(task);
    return JSON.stringify(task, null, 2);
  }

  listAll() {
    const tasks = [];
    try {
      const files = readdirSync(this.dir);
      for (const f of files) {
        if (f.startsWith('task_') && f.endsWith('.json')) {
          const parsed = parseJSON(readFileSync(resolve(this.dir, f), 'utf-8'));
          if (parsed) tasks.push(parsed);
        }
      }
    } catch (e) {}

    if (tasks.length === 0) {
      return "No tasks.";
    }

    tasks.sort((a, b) => a.id - b.id);
    const lines = [];
    for (const t of tasks) {
      const marker = { pending: "[ ]", in_progress: "[>]", completed: "[x]" }[t.status] || "[?]";
      const owner = t.owner ? ` owner=${t.owner}` : "";
      const wt = t.worktree ? ` wt=${t.worktree}` : "";
      lines.push(`${marker} #${t.id}: ${t.subject}${owner}${wt}`);
    }
    return lines.join('\n');
  }
}


const TASKS = new TaskManager(resolve(REPO_ROOT, '.tasks'));
const EVENTS = new EventBus(resolve(REPO_ROOT, '.worktrees/events.jsonl'));


// -- WorktreeManager: create/list/run/remove git worktrees + lifecycle index --
class WorktreeManager {
  constructor(repoRoot, tasks, events) {
    this.repoRoot = repoRoot;
    this.tasks = tasks;
    this.events = events;
    this.dir = resolve(repoRoot, '.worktrees');
    if (!existsSync(this.dir)) {
      mkdirSync(this.dir, { recursive: true });
    }
    this.indexPath = resolve(this.dir, 'index.json');
    if (!existsSync(this.indexPath)) {
      writeFileSync(this.indexPath, JSON.stringify({ worktrees: [] }, null, 2));
    }
    this.gitAvailable = this._isGitRepo();
  }

  _isGitRepo() {
    try {
      require('child_process').execSync('git rev-parse --is-inside-work-tree', {
        cwd: this.repoRoot,
        timeout: 10000,
        encoding: 'utf-8'
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  _runGit(args) {
    if (!this.gitAvailable) {
      throw new Error("Not in a git repository. worktree tools require git.");
    }

    return new Promise((resolve, reject) => {
      const child = spawn('git', args, {
        cwd: this.repoRoot,
        timeout: 120000
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => { stdout += data.toString(); });
      child.stderr?.on('data', (data) => { stderr += data.toString(); });

      child.on('close', (code) => {
        if (code !== 0) {
          const msg = (stdout + stderr).trim();
          reject(new Error(msg || `git ${args.join(' ')} failed`));
          return;
        }
        resolve((stdout + stderr).trim() || "(no output)");
      });

      child.on('error', (err) => reject(err));

      setTimeout(() => {
        child.kill();
        reject(new Error("Timeout"));
      }, 120000);
    });
  }

  _loadIndex() {
    return parseJSON(readFileSync(this.indexPath, 'utf-8'));
  }

  _saveIndex(data) {
    writeFileSync(this.indexPath, JSON.stringify(data, null, 2));
  }

  _find(name) {
    const idx = this._loadIndex();
    for (const wt of idx.worktrees || []) {
      if (wt.name === name) return wt;
    }
    return null;
  }

  _validateName(name) {
    if (!/^[A-Za-z0-9._-]{1,40}$/.test(name || "")) {
      throw new Error("Invalid worktree name. Use 1-40 chars: letters, numbers, ., _, -");
    }
  }

  async create(name, taskId = null, baseRef = "HEAD") {
    this._validateName(name);
    if (this._find(name)) {
      throw new Error(`Worktree '${name}' already exists in index`);
    }
    if (taskId !== null && !this.tasks.exists(taskId)) {
      throw new Error(`Task ${taskId} not found`);
    }

    const path = resolve(this.dir, name);
    const branch = `wt/${name}`;

    this.events.emit(
      "worktree.create.before",
      taskId !== null ? { id: taskId } : {},
      { name, base_ref: baseRef },
    );

    try {
      await this._runGit(['worktree', 'add', '-b', branch, path, baseRef]);

      const entry = {
        name: name,
        path: path,
        branch: branch,
        task_id: taskId,
        status: "active",
        created_at: Date.now() / 1000,
      };

      const idx = this._loadIndex();
      idx.worktrees.push(entry);
      this._saveIndex(idx);

      if (taskId !== null) {
        this.tasks.bindWorktree(taskId, name);
      }

      this.events.emit(
        "worktree.create.after",
        taskId !== null ? { id: taskId } : {},
        {
          name,
          path,
          branch,
          status: "active",
        },
      );
      return JSON.stringify(entry, null, 2);
    } catch (e) {
      this.events.emit(
        "worktree.create.failed",
        taskId !== null ? { id: taskId } : {},
        { name, base_ref: baseRef },
        e.message,
      );
      throw e;
    }
  }

  listAll() {
    const idx = this._loadIndex();
    const wts = idx.worktrees || [];
    if (wts.length === 0) {
      return "No worktrees in index.";
    }
    const lines = [];
    for (const wt of wts) {
      const suffix = wt.task_id ? ` task=${wt.task_id}` : "";
      lines.push(
        `[${wt.status || 'unknown'}] ${wt.name} -> ${wt.path} (${wt.branch || '-'})${suffix}`
      );
    }
    return lines.join('\n');
  }

  async status(name) {
    const wt = this._find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    const path = wt.path;
    if (!existsSync(path)) {
      return `Error: Worktree path missing: ${path}`;
    }

    return new Promise((resolve) => {
      const child = spawn('git', ['status', '--short', '--branch'], {
        cwd: path,
        timeout: 60000
      });

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => { stdout += data.toString(); });
      child.stderr?.on('data', (data) => { stderr += data.toString(); });

      child.on('close', () => {
        const text = (stdout + stderr).trim();
        resolve(text || "Clean worktree");
      });

      child.on('error', () => resolve("Error checking status"));

      setTimeout(() => {
        child.kill();
        resolve("Timeout");
      }, 60000);
    });
  }

  async run(name, command) {
    const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
    if (dangerous.some(d => command.includes(d))) {
      return "Error: Dangerous command blocked";
    }

    const wt = this._find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }
    const path = wt.path;
    if (!existsSync(path)) {
      return `Error: Worktree path missing: ${path}`;
    }

    return new Promise((resolve) => {
      const isWindows = process.platform === 'win32';
      const shell = isWindows ? 'cmd.exe' : '/bin/sh';
      const shellFlag = isWindows ? '/c' : '-c';

      const child = spawn(shell, [shellFlag, command], {
        cwd: path,
        timeout: 300000
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
        child.kill();
        resolve("Error: Timeout (300s)");
      }, 300000);
    });
  }

  async remove(name, force = false, completeTask = false) {
    const wt = this._find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    this.events.emit(
      "worktree.remove.before",
      wt.task_id !== null && wt.task_id !== undefined ? { id: wt.task_id } : {},
      { name, path: wt.path },
    );

    try {
      const args = ['worktree', 'remove'];
      if (force) args.push('--force');
      args.push(wt.path);
      await this._runGit(args);

      if (completeTask && wt.task_id !== null && wt.task_id !== undefined) {
        const taskId = wt.task_id;
        const before = parseJSON(this.tasks.get(taskId));
        this.tasks.update(taskId, "completed");
        this.tasks.unbindWorktree(taskId);
        this.events.emit(
          "task.completed",
          {
            id: taskId,
            subject: before?.subject || "",
            status: "completed",
          },
          { name },
        );
      }

      const idx = this._loadIndex();
      for (const item of idx.worktrees || []) {
        if (item.name === name) {
          item.status = "removed";
          item.removed_at = Date.now() / 1000;
        }
      }
      this._saveIndex(idx);

      this.events.emit(
        "worktree.remove.after",
        wt.task_id !== null && wt.task_id !== undefined ? { id: wt.task_id } : {},
        { name, path: wt.path, status: "removed" },
      );
      return `Removed worktree '${name}'`;
    } catch (e) {
      this.events.emit(
        "worktree.remove.failed",
        wt.task_id !== null && wt.task_id !== undefined ? { id: wt.task_id } : {},
        { name, path: wt.path },
        e.message,
      );
      throw e;
    }
  }

  keep(name) {
    const wt = this._find(name);
    if (!wt) {
      return `Error: Unknown worktree '${name}'`;
    }

    const idx = this._loadIndex();
    let kept = null;
    for (const item of idx.worktrees || []) {
      if (item.name === name) {
        item.status = "kept";
        item.kept_at = Date.now() / 1000;
        kept = item;
      }
    }
    this._saveIndex(idx);

    this.events.emit(
      "worktree.keep",
      wt.task_id !== null && wt.task_id !== undefined ? { id: wt.task_id } : {},
      {
        name,
        path: wt.path,
        status: "kept",
      },
    );
    return kept ? JSON.stringify(kept, null, 2) : `Error: Unknown worktree '${name}'`;
  }
}


const WORKTREES = new WorktreeManager(REPO_ROOT, TASKS, EVENTS);


// -- Base tools --
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

function runBash(command) {
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
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
    if (dir && !existsSync(dir)) {
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
  task_create: (params) => TASKS.create(params.subject, params.description || ""),
  task_list: () => TASKS.listAll(),
  task_get: (params) => TASKS.get(params.task_id),
  task_update: (params) => TASKS.update(params.task_id, params.status, params.owner),
  task_bind_worktree: (params) => TASKS.bindWorktree(params.task_id, params.worktree, params.owner || ""),
  worktree_create: async (params) => await WORKTREES.create(params.name, params.task_id, params.base_ref || "HEAD"),
  worktree_list: () => WORKTREES.listAll(),
  worktree_status: async (params) => await WORKTREES.status(params.name),
  worktree_run: async (params) => await WORKTREES.run(params.name, params.command),
  worktree_keep: (params) => WORKTREES.keep(params.name),
  worktree_remove: async (params) => await WORKTREES.remove(params.name, params.force || false, params.complete_task || false),
  worktree_events: (params) => EVENTS.listRecent(params.limit || 20),
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
  { name: "bash", description: "Run a shell command in the current workspace (blocking).",
    input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] }},
  { name: "read_file", description: "Read file contents.",
    input_schema: { type: "object", properties: { path: { type: "string" }, limit: { type: "integer" } }, required: ["path"] }},
  { name: "write_file", description: "Write content to file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }},
  { name: "edit_file", description: "Replace exact text in file.",
    input_schema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, required: ["path", "old_text", "new_text"] }},
  { name: "task_create", description: "Create a new task on the shared task board.",
    input_schema: { type: "object", properties: { subject: { type: "string" }, description: { type: "string" } }, required: ["subject"] }},
  { name: "task_list", description: "List all tasks with status, owner, and worktree binding.",
    input_schema: { type: "object", properties: {}}},
  { name: "task_get", description: "Get task details by ID.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" } }, required: ["task_id"] }},
  { name: "task_update", description: "Update task status or owner.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" }, status: { type: "string", enum: ["pending", "in_progress", "completed"] }, owner: { type: "string" } }, required: ["task_id"] }},
  { name: "task_bind_worktree", description: "Bind a task to a worktree name.",
    input_schema: { type: "object", properties: { task_id: { type: "integer" }, worktree: { type: "string" }, owner: { type: "string" } }, required: ["task_id", "worktree"] }},
  { name: "worktree_create", description: "Create a git worktree and optionally bind it to a task.",
    input_schema: { type: "object", properties: { name: { type: "string" }, task_id: { type: "integer" }, base_ref: { type: "string" } }, required: ["name"] }},
  { name: "worktree_list", description: "List worktrees tracked in .worktrees/index.json.",
    input_schema: { type: "object", properties: {}}},
  { name: "worktree_status", description: "Show git status for one worktree.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }},
  { name: "worktree_run", description: "Run a shell command in a named worktree directory.",
    input_schema: { type: "object", properties: { name: { type: "string" }, command: { type: "string" } }, required: ["name", "command"] }},
  { name: "worktree_remove", description: "Remove a worktree and optionally mark its bound task completed.",
    input_schema: { type: "object", properties: { name: { type: "string" }, force: { type: "boolean" }, complete_task: { type: "boolean" } }, required: ["name"] }},
  { name: "worktree_keep", description: "Mark a worktree as kept in lifecycle state without removing it.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }},
  { name: "worktree_events", description: "List recent worktree/task lifecycle events from .worktrees/events.jsonl.",
    input_schema: { type: "object", properties: { limit: { type: "integer" } }}},
];


async function agentLoop(messages) {
  while (true) {
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
  console.log(`Repo root for s12: ${REPO_ROOT}`);
  if (!WORKTREES.gitAvailable) {
    console.log("Note: Not in a git repo. worktree_* tools will return errors.");
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const history = [];

  const ask = () => {
    rl.question('\x1b[36ms12 >> \x1b[0m', async (query) => {
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
