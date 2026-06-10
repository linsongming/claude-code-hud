import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { HudViewProvider } from './hudView';
import { parseSessionFile, findActiveSession, listSessions, calcDailySpend, SessionStats, DailySpend } from './parser';

let refreshTimer: NodeJS.Timeout | undefined;
let fileWatcher: fs.FSWatcher | undefined;
let statusBarItem: vscode.StatusBarItem;

// null = auto-follow latest session; string = pinned session file path
let pinnedSessionFile: string | null = null;
let previewMode = false;

const CONFIG_PATH = path.join(os.homedir(), '.claude', 'claude-code-hud.json');

export interface HudConfig {
  refreshInterval: number;
  inputCostPer1M: number;
  outputCostPer1M: number;
  cacheWriteCostPer1M: number;
  cacheReadCostPer1M: number;
  contextLimit?: number;
  dailyCostWarning?: number;  // USD, yellow warning threshold
  dailyCostLimit?: number;    // USD, red alert threshold
}

const DEFAULT_CONFIG: HudConfig = {
  refreshInterval: 3000,
  inputCostPer1M: 3.0,
  outputCostPer1M: 15.0,
  cacheWriteCostPer1M: 3.75,
  cacheReadCostPer1M: 0.30,
};

function ensureConfigFile(): void {
  if (!fs.existsSync(CONFIG_PATH)) {
    const template = `{
  "_说明": "Claude Code HUD 配置文件，修改后自动生效，无需重启。",

  "_contextLimit说明": "上下文 token 上限。留空（null）则根据模型名自动判断（Opus 4.x = 1M，其余 = 200K）。使用 1M context 版本时手动填 1000000。",
  "contextLimit": null,

  "_refreshInterval说明": "面板刷新间隔，单位毫秒，默认 3000（3秒）。",
  "refreshInterval": 3000,

  "_inputCostPer1M说明": "输入 token 单价，每 100 万 token 多少美元。Sonnet 4.x 默认 $3.00。",
  "inputCostPer1M": 3.0,

  "_outputCostPer1M说明": "输出 token 单价，每 100 万 token 多少美元。Sonnet 4.x 默认 $15.00。",
  "outputCostPer1M": 15.0,

  "_cacheWriteCostPer1M说明": "缓存写入单价，每 100 万 token 多少美元。默认 $3.75。",
  "cacheWriteCostPer1M": 3.75,

  "_cacheReadCostPer1M说明": "缓存读取单价，每 100 万 token 多少美元。默认 $0.30（比正常输入便宜 10 倍）。",
  "cacheReadCostPer1M": 0.30,

  "_dailyCostWarning说明": "每日费用黄色预警阈值（美元）。当日花费超过此值，近期费用栏数字变黄。留空则不预警。",
  "dailyCostWarning": null,

  "_dailyCostLimit说明": "每日费用红色上限（美元）。当日花费超过此值，数字变红并显示警告。留空则不限制。",
  "dailyCostLimit": null
}
`;
    fs.writeFileSync(CONFIG_PATH, template, 'utf8');
  }
}

function readConfig(): HudConfig {
  try {
    ensureConfigFile();
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    const merged = { ...DEFAULT_CONFIG, ...parsed };
    // null means "auto-detect" — treat same as undefined
    if (merged.contextLimit === null) merged.contextLimit = undefined;
    return merged;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function getWorkspacePath(): string {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return '';
  return folders[0].uri.fsPath;
}

function updateStatusBar(stats: SessionStats | null): void {
  if (!stats) {
    statusBarItem.text = '$(robot) Claude: --';
    statusBarItem.tooltip = 'No active Claude Code session';
    return;
  }

  const pct = Math.min(100, (stats.usage.inputTokens / stats.contextLimit) * 100);
  const cachePct = Math.round(stats.cache.hitRate * 100);
  const cost = stats.cost.totalCost;

  statusBarItem.text = `$(robot) ${pct.toFixed(0)}% ctx | cache:${cachePct}% | $${cost.toFixed(4)}`;
  statusBarItem.tooltip = [
    `Claude Code HUD`,
    `Context: ${pct.toFixed(1)}% (${(stats.usage.inputTokens / 1000).toFixed(1)}K / ${(stats.contextLimit / 1000).toFixed(0)}K)`,
    `Cache Hit Rate: ${cachePct}%`,
    `Session Cost: $${cost.toFixed(4)}`,
    `Model: ${stats.model}`,
  ].join('\n');
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new HudViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(HudViewProvider.viewType, provider)
  );

  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.command = 'claudeCodeHud.show';
  statusBarItem.text = '$(robot) Claude HUD';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  function refresh(): void {
    if (previewMode) return;
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      provider.update(null, []);
      updateStatusBar(null);
      return;
    }

    const cfg = readConfig();
    // Use pinned session or auto-detect latest
    const sessionFile = pinnedSessionFile ?? findActiveSession(workspacePath);
    if (!sessionFile) {
      provider.update(null, []);
      updateStatusBar(null);
      return;
    }

    const costCfg = {
      contextLimit: cfg.contextLimit,
      inputCostPer1M: cfg.inputCostPer1M,
      outputCostPer1M: cfg.outputCostPer1M,
      cacheWriteCostPer1M: cfg.cacheWriteCostPer1M,
      cacheReadCostPer1M: cfg.cacheReadCostPer1M,
    };
    const stats = parseSessionFile(sessionFile, costCfg);
    const sessions = listSessions(workspacePath);
    const dailySpend = calcDailySpend(workspacePath, costCfg);
    provider.update(stats, sessions, pinnedSessionFile, dailySpend, {
      warning: cfg.dailyCostWarning,
      limit: cfg.dailyCostLimit,
    });
    updateStatusBar(stats);

    // Watch project dir for new/updated session files
    const projectDir = path.dirname(sessionFile);
    if (!fileWatcher) {
      try {
        fileWatcher = fs.watch(projectDir, (_evt, filename) => {
          if (filename && filename.endsWith('.jsonl')) refresh();
        });
      } catch { /* ignore */ }
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeCodeHud.show', () => {
      vscode.commands.executeCommand('claudeCodeHud.panel.focus');
    }),
    vscode.commands.registerCommand('claudeCodeHud.refresh', () => {
      refresh();
    }),
    vscode.commands.registerCommand('claudeCodeHud.openSettings', async () => {
      ensureConfigFile();
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(CONFIG_PATH));
      await vscode.window.showTextDocument(doc, { preview: false });
      const watcher = vscode.workspace.createFileSystemWatcher(CONFIG_PATH);
      watcher.onDidChange(() => refresh());
      context.subscriptions.push(watcher);
    }),
    vscode.commands.registerCommand('claudeCodeHud.switchSession', (filePath: string | null) => {
      pinnedSessionFile = filePath; // null = back to auto-follow
      refresh();
    }),
    vscode.commands.registerCommand('claudeCodeHud.exitPreview', () => {
      previewMode = false;
      refresh();
      vscode.window.showInformationMessage('Claude Code HUD: Preview Mode off');
    }),
    vscode.commands.registerCommand('claudeCodeHud.previewMode', () => {
      previewMode = true;
      const cfg = readConfig();
      const mockStats = buildMockStats(cfg);
      const mockDaily: DailySpend[] = [
        { date: '2026-06-04', cost: 0.82 },
        { date: '2026-06-05', cost: 1.45 },
        { date: '2026-06-06', cost: 0.37 },
        { date: '2026-06-07', cost: 2.11 },
        { date: '2026-06-08', cost: 0.96 },
        { date: '2026-06-09', cost: 1.73 },
        { date: '2026-06-10', cost: 0.54 },
      ];
      provider.update(mockStats, [], null, mockDaily, { warning: 1.5, limit: 3.0 });
      vscode.commands.executeCommand('claudeCodeHud.panel.focus');
      vscode.window.showInformationMessage('Claude Code HUD: Preview Mode (mock data)');
    })
  );

  // Handle messages from the webview panel
  provider.onMessage((msg: Record<string, unknown>) => {
    if (msg.command === 'openSettings') {
      vscode.commands.executeCommand('claudeCodeHud.openSettings');
    } else if (msg.command === 'switchSession') {
      pinnedSessionFile = (msg.filePath as string) || null;
      refresh();
    } else if (msg.command === 'unpinSession') {
      pinnedSessionFile = null;
      refresh();
    }
  });

  function startTimer(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(refresh, readConfig().refreshInterval);
  }

  context.subscriptions.push({
    dispose: () => {
      if (refreshTimer) clearInterval(refreshTimer);
      if (fileWatcher) fileWatcher.close();
    }
  });

  refresh();
  startTimer();
}

function buildMockStats(cfg: HudConfig): SessionStats {
  return {
    sessionId: 'preview-mock-1234abcd',
    sessionFile: '/mock/preview.jsonl',
    sessionTitle: '帮我优化这个项目的性能，分析瓶颈并给出方案',
    usage: {
      inputTokens: 142000,
      outputTokens: 18400,
      cacheCreationTokens: 136000,
      cacheReadTokens: 505800,
    },
    cost: {
      inputCost: 0.426,
      outputCost: 0.276,
      cacheWriteCost: 0.510,
      cacheReadCost: 0.1517,
      totalCost: 1.3637,
      savedByCacheUSD: 1.3656,
    },
    cache: {
      totalInputTokens: 647800,
      cacheReadTokens: 505800,
      cacheCreationTokens: 136000,
      hitRate: 0.781,
    },
    tools: {
      counts: {
        Bash: 76,
        Edit: 75,
        Read: 37,
        Write: 11,
        mcp__ide__getDiagnostics: 8,
        mcp__ide__executeCode: 5,
        mcp__github__create_pull_request: 2,
        mcp__github__list_issues: 4,
        TodoWrite: 6,
        Agent: 3,
      },
      webSearches: 4,
      webFetches: 2,
    },
    bloat: {
      rounds: 24,
      minCostPerRound: 0.019,
    },
    todos: [
      { content: '分析项目性能瓶颈', status: 'completed', model: 'claude-sonnet-4-6' },
      { content: '优化数据库查询，添加索引', status: 'completed', model: 'claude-sonnet-4-6' },
      { content: '重构 API 响应缓存层', status: 'completed', model: 'claude-sonnet-4-6' },
      { content: '压测并对比优化前后数据', status: 'in_progress', model: 'claude-sonnet-4-6' },
      { content: '编写性能优化文档', status: 'pending', model: 'claude-sonnet-4-6' },
    ],
    model: 'claude-sonnet-4-6',
    lastUpdated: new Date(),
    contextLimit: cfg.contextLimit ?? 200000,
    contextLimitSource: 'auto',
    pricing: {
      inputPer1M: cfg.inputCostPer1M,
      outputPer1M: cfg.outputCostPer1M,
      cacheWritePer1M: cfg.cacheWriteCostPer1M,
      cacheReadPer1M: cfg.cacheReadCostPer1M,
    },
  };
}

export function deactivate(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  if (fileWatcher) fileWatcher.close();
}
