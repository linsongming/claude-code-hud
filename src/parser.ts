import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

export interface CostSummary {
  inputCost: number;
  outputCost: number;
  cacheWriteCost: number;
  cacheReadCost: number;
  totalCost: number;
  savedByCacheUSD: number;
}

export interface CacheStats {
  totalInputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  hitRate: number;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  model?: string;
  cost?: number;
}

export interface ToolStats {
  counts: Record<string, number>; // tool name → call count
  webSearches: number;
  webFetches: number;
}

export interface SessionBloat {
  rounds: number;
  // min cost per future round = all cached tokens × cache-read rate
  minCostPerRound: number;
}

export interface DailySpend {
  date: string;   // YYYY-MM-DD
  cost: number;
}

export interface SessionStats {
  sessionId: string;
  sessionFile: string;
  sessionTitle: string;
  usage: TokenUsage;
  cost: CostSummary;
  cache: CacheStats;
  tools: ToolStats;
  bloat: SessionBloat;
  todos: TodoItem[];
  model: string;
  lastUpdated: Date;
  contextLimit: number;
  contextLimitSource: 'auto' | 'config';
  pricing: {
    inputPer1M: number;
    outputPer1M: number;
    cacheWritePer1M: number;
    cacheReadPer1M: number;
  };
}

// Known Claude model context limits (tokens)
// Opus 4.x → 1M context (confirmed in Claude Code model selector)
// Sonnet / Haiku → 200K
const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-4-8':   1_000_000,
  'claude-opus-4-6':   1_000_000,
  'claude-opus-4':     1_000_000,
  'claude-sonnet-4-6':   200_000,
  'claude-sonnet-4-5':   200_000,
  'claude-sonnet-4':     200_000,
  'claude-haiku-4-5':    200_000,
  'claude-haiku-4':      200_000,
  'claude-opus-3':       200_000,
  'claude-sonnet-3-7':   200_000,
  'claude-sonnet-3-5':   200_000,
  'claude-haiku-3-5':    200_000,
  'claude-fable-5':    1_000_000,
};

export function modelContextLimit(model: string): number {
  // Strip region prefix e.g. us.anthropic.claude-sonnet-4-6
  const clean = model.replace(/^[a-z]{2}\.anthropic\./, '').replace(/-\d{8}$/, '');
  return MODEL_CONTEXT_LIMITS[clean] ?? 200_000;
}

interface CostConfig {
  inputCostPer1M: number;
  outputCostPer1M: number;
  cacheWriteCostPer1M: number;
  cacheReadCostPer1M: number;
  contextLimit?: number; // undefined = auto-detect from model
}

function calcCost(tokens: number, ratePerMillion: number): number {
  return (tokens / 1_000_000) * ratePerMillion;
}

export function parseSessionFile(filePath: string, config: CostConfig): SessionStats | null {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  const lines = content.trim().split('\n');
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  };

  let model = 'unknown';
  let sessionId = '';
  let sessionTitle = '';
  const todos: TodoItem[] = [];
  const todoMap = new Map<string, TodoItem>();
  const messageCosts: Array<{ cost: number; model: string }> = [];
  const toolCounts: Record<string, number> = {};
  let webSearches = 0;
  let webFetches = 0;
  let rounds = 0; // count assistant messages with real tokens = conversation rounds

  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!sessionId && entry.sessionId) {
      sessionId = entry.sessionId as string;
    }

    // Extract first user message as session title
    if (!sessionTitle && entry.type === 'user') {
      const msg = entry.message as Record<string, unknown> | undefined;
      const content = msg?.content;
      if (typeof content === 'string') {
        sessionTitle = content;
      } else if (Array.isArray(content)) {
        for (const c of content) {
          if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text') {
            sessionTitle = (c as Record<string, unknown>).text as string || '';
            break;
          }
        }
      }
    }

    if (entry.type !== 'assistant') continue;
    const msg = entry.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    if (msg.model && msg.model !== '<synthetic>') {
      model = msg.model as string;
    }

    const u = msg.usage as Record<string, unknown> | undefined;
    if (u) {
      const msgInputTokens = (u.input_tokens as number || 0);
      const msgOutputTokens = (u.output_tokens as number || 0);
      const msgCacheCreate = (u.cache_creation_input_tokens as number || 0);
      const msgCacheRead = (u.cache_read_input_tokens as number || 0);

      usage.inputTokens += msgInputTokens;
      usage.outputTokens += msgOutputTokens;
      usage.cacheCreationTokens += msgCacheCreate;
      usage.cacheReadTokens += msgCacheRead;

      // web search/fetch from server_tool_use
      const stu = u.server_tool_use as Record<string, number> | undefined;
      if (stu) {
        webSearches += stu.web_search_requests || 0;
        webFetches += stu.web_fetch_requests || 0;
      }

      const msgCost =
        calcCost(msgInputTokens, config.inputCostPer1M) +
        calcCost(msgOutputTokens, config.outputCostPer1M) +
        calcCost(msgCacheCreate, config.cacheWriteCostPer1M) +
        calcCost(msgCacheRead, config.cacheReadCostPer1M);

      messageCosts.push({ cost: msgCost, model: msg.model as string || model });

      if (msgInputTokens > 0 || msgOutputTokens > 0) {
        rounds++;
      }
    }

    // Parse tool calls — count each named tool
    const content = msg.content as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === 'tool_use' && typeof item.name === 'string') {
          const name = item.name as string;
          toolCounts[name] = (toolCounts[name] || 0) + 1;

          // Also parse TodoWrite
          if (name === 'TodoWrite') {
            const input = item.input as Record<string, unknown> | undefined;
            const todosArr = input?.todos as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(todosArr)) {
              for (const t of todosArr) {
                const key = t.content as string || t.activeForm as string || '';
                const existing = todoMap.get(key);
                const todoItem: TodoItem = {
                  content: key,
                  status: (t.status as TodoItem['status']) || 'pending',
                  model: msg.model as string || model,
                };
                if (!existing || existing.status !== 'completed') {
                  todoMap.set(key, todoItem);
                }
              }
            }
          }
        }
      }
    }
  }

  // Build todos array preserving latest state
  for (const [, todo] of todoMap) {
    todos.push(todo);
  }

  const inputCost = calcCost(usage.inputTokens, config.inputCostPer1M);
  const outputCost = calcCost(usage.outputTokens, config.outputCostPer1M);
  const cacheWriteCost = calcCost(usage.cacheCreationTokens, config.cacheWriteCostPer1M);
  const cacheReadCost = calcCost(usage.cacheReadTokens, config.cacheReadCostPer1M);

  // What input cost would have been without cache reads
  const savedByCacheUSD = calcCost(usage.cacheReadTokens, config.inputCostPer1M - config.cacheReadCostPer1M);

  const totalInputForCache = usage.inputTokens + usage.cacheReadTokens;
  const hitRate = totalInputForCache > 0 ? usage.cacheReadTokens / totalInputForCache : 0;

  // Snowball effect: each new round must read all cached tokens at cache-read rate
  // minCostPerRound = cached context tokens × cache-read rate per token
  const cachedTokens = usage.cacheCreationTokens + usage.cacheReadTokens;
  const minCostPerRound = calcCost(cachedTokens, config.cacheReadCostPer1M);

  return {
    sessionId,
    sessionFile: filePath,
    sessionTitle: sessionTitle.trim() || 'Untitled Session',
    usage,
    cost: {
      inputCost,
      outputCost,
      cacheWriteCost,
      cacheReadCost,
      totalCost: inputCost + outputCost + cacheWriteCost + cacheReadCost,
      savedByCacheUSD,
    },
    cache: {
      totalInputTokens: totalInputForCache,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
      hitRate,
    },
    tools: {
      counts: toolCounts,
      webSearches,
      webFetches,
    },
    bloat: {
      rounds,
      minCostPerRound,
    },
    todos,
    model,
    pricing: {
      inputPer1M: config.inputCostPer1M,
      outputPer1M: config.outputCostPer1M,
      cacheWritePer1M: config.cacheWriteCostPer1M,
      cacheReadPer1M: config.cacheReadCostPer1M,
    },
    lastUpdated: new Date(),
    contextLimit: config.contextLimit ?? modelContextLimit(model),
    contextLimitSource: config.contextLimit != null ? 'config' : 'auto',
  };
}

export interface SessionSummary {
  filePath: string;
  sessionId: string;
  title: string;
  mtime: number; // ms timestamp
}

export function listSessions(workspacePath: string, limit = 8): SessionSummary[] {
  const projectDir = resolveProjectDir(workspacePath);
  if (!projectDir) return [];

  return fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const fp = path.join(projectDir, f);
      const mtime = fs.statSync(fp).mtime.getTime();
      return { filePath: fp, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map(({ filePath, mtime }) => {
      const title = readFirstUserMessage(filePath);
      const sessionId = path.basename(filePath, '.jsonl');
      return { filePath, sessionId, title, mtime };
    });
}

function readFirstUserMessage(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.type !== 'user') continue;
        const msg = d.message as Record<string, unknown> | undefined;
        const c = msg?.content;
        if (typeof c === 'string' && c.trim()) return c.trim();
        if (Array.isArray(c)) {
          for (const item of c) {
            if (item?.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
              return item.text.trim();
            }
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return 'Untitled Session';
}

function resolveProjectDir(workspacePath: string): string | null {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return null;
  const allProjects = fs.readdirSync(claudeDir);
  const encoded = workspacePath.replace(/[/_]/g, '-');
  const exactMatch = allProjects.find(p => p === encoded);
  if (exactMatch) return path.join(claudeDir, exactMatch);
  const suffixMatch = allProjects
    .filter(p => encoded.endsWith(p) || p.endsWith(encoded))
    .sort((a, b) => b.length - a.length)[0];
  return suffixMatch ? path.join(claudeDir, suffixMatch) : null;
}

// Calculate daily spend across all sessions for this project (last N days)
export function calcDailySpend(workspacePath: string, config: CostConfig, days = 7): DailySpend[] {
  const dir = resolveProjectDir(workspacePath);
  if (!dir) return [];

  const cutoff = Date.now() - days * 86400_000;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => path.join(dir, f))
    .filter(fp => fs.statSync(fp).mtime.getTime() >= cutoff);

  const byDay: Record<string, number> = {};

  for (const fp of files) {
    let content: string;
    try { content = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        if (d.type !== 'assistant') continue;
        const msg = d.message as Record<string, unknown> | undefined;
        const u = msg?.usage as Record<string, number> | undefined;
        if (!u) continue;
        const ts: string = d.timestamp as string;
        if (!ts) continue;
        const day = ts.slice(0, 10); // YYYY-MM-DD
        const cost =
          calcCost(u.input_tokens || 0, config.inputCostPer1M) +
          calcCost(u.output_tokens || 0, config.outputCostPer1M) +
          calcCost(u.cache_creation_input_tokens || 0, config.cacheWriteCostPer1M) +
          calcCost(u.cache_read_input_tokens || 0, config.cacheReadCostPer1M);
        byDay[day] = (byDay[day] || 0) + cost;
      } catch { /* skip */ }
    }
  }

  return Object.entries(byDay)
    .map(([date, cost]) => ({ date, cost }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function findActiveSession(workspacePath: string): string | null {
  const dir = resolveProjectDir(workspacePath);
  if (!dir) return null;
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({ fp: path.join(dir, f), mtime: fs.statSync(path.join(dir, f)).mtime.getTime() }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length > 0 ? files[0].fp : null;
}

export function getProjectDir(workspacePath: string): string | null {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(claudeDir)) return null;

  const normalized = workspacePath.replace(/\//g, '-').replace(/^-/, '');
  const allProjects = fs.readdirSync(claudeDir);

  // Exact match or suffix match
  for (const p of allProjects) {
    const pNorm = p.replace(/^-/, '');
    if (pNorm === normalized || normalized.endsWith(pNorm) || pNorm.endsWith(normalized)) {
      return path.join(claudeDir, p);
    }
  }
  return null;
}
