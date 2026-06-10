import * as vscode from 'vscode';
import { SessionStats, DailySpend, TodoItem } from './parser';

export interface CostThresholds {
  warning?: number | null;
  limit?: number | null;
}

type MessageHandler = (msg: Record<string, unknown>) => void;

export class HudViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'claudeCodeHud.panel';
  private _view?: vscode.WebviewView;
  private _stats: SessionStats | null = null;
  private _dailySpend: DailySpend[] = [];
  private _thresholds: CostThresholds = {};
  private _msgHandler?: MessageHandler;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  onMessage(handler: MessageHandler): void {
    this._msgHandler = handler;
  }

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage(msg => {
      this._msgHandler?.(msg as Record<string, unknown>);
    });
    this._render();
  }

  // sessions/pinned are legacy params, ignored after session switcher removal
  update(stats: SessionStats | null, _sessions?: unknown, _pinned?: unknown, dailySpend?: DailySpend[], thresholds?: CostThresholds): void {
    this._stats = stats;
    this._dailySpend = dailySpend ?? [];
    this._thresholds = thresholds ?? {};
    this._render();
  }

  private _render(): void {
    if (!this._view) return;
    this._view.webview.html = this._stats
      ? buildHtml(this._stats, this._dailySpend, this._thresholds)
      : buildEmptyHtml();
  }
}

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function fmtCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return '$' + usd.toFixed(4);
}

function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s: string, max: number): string {
  // Remove newlines for display, then trim
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length > max ? oneline.slice(0, max - 1) + '…' : oneline;
}

function progressBar(pct: number, width: number = 20): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

function todoStatusIcon(status: TodoItem['status']): string {
  switch (status) {
    case 'completed': return '✓';
    case 'in_progress': return '◉';
    default: return '○';
  }
}

function todoStatusClass(status: TodoItem['status']): string {
  switch (status) {
    case 'completed': return 'todo-done';
    case 'in_progress': return 'todo-active';
    default: return 'todo-pending';
  }
}

function shortModel(model: string): string {
  // claude-sonnet-4-6 → Sonnet-4.6, claude-opus-4-8 → Opus-4.8, etc.
  return model
    .replace(/^us\.anthropic\./, '')
    .replace(/^claude-/, '')
    .replace(/-(\d+)-(\d+)$/, '-$1.$2')
    .split('-')
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('-');
}

function buildHtml(s: SessionStats, dailySpend: DailySpend[], thresholds: CostThresholds): string {
  const contextPct = Math.min(100, (s.usage.inputTokens / s.contextLimit) * 100);
  const cachePct = Math.round(s.cache.hitRate * 100);

  const totalTodos = s.todos.length;
  const doneTodos = s.todos.filter(t => t.status === 'completed').length;
  const activeTodos = s.todos.filter(t => t.status === 'in_progress').length;
  const totalPct = totalTodos > 0 ? Math.round((doneTodos / totalTodos) * 100) : 0;

  const todoRows = s.todos.map((t, i) => {
    const pct = t.status === 'completed' ? 100 : t.status === 'in_progress' ? 50 : 0;
    const bar = progressBar(pct, 10);
    const model = t.model ? shortModel(t.model) : shortModel(s.model);
    const cost = t.cost != null ? fmtCost(t.cost) : '';
    const label = t.content.length > 45 ? t.content.slice(0, 44) + '…' : t.content;
    const dots = '.'.repeat(Math.max(2, 48 - label.length - model.length));
    return `
      <div class="todo-row ${todoStatusClass(t.status)}">
        <span class="todo-idx">${i + 1}.</span>
        <span class="todo-bar">[${bar}]</span>
        <span class="todo-pct">${pct}%</span>
        <span class="todo-label">${label}</span>
        <span class="todo-dots">${dots}</span>
        <span class="todo-model">[${model}]</span>
        ${cost ? `<span class="todo-cost">(${cost})</span>` : ''}
      </div>`;
  }).join('');

  const contextBar = progressBar(contextPct, 30);
  const cacheBar = progressBar(cachePct, 20);
  const overallBar = progressBar(totalPct, 20);

  const contextColor = contextPct > 85 ? '#f87171' : contextPct > 60 ? '#fbbf24' : '#4ade80';
  const cacheColor = cachePct > 50 ? '#4ade80' : cachePct > 20 ? '#fbbf24' : '#94a3b8';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'Cascadia Code', 'Fira Code', 'Consolas', monospace;
    font-size: 12px;
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 10px;
    line-height: 1.5;
  }
  .section {
    margin-bottom: 14px;
    border: 1px solid var(--vscode-widget-border, #333);
    border-radius: 4px;
    overflow: hidden;
  }
  .section-header {
    background: var(--vscode-sideBarSectionHeader-background, #252526);
    color: var(--vscode-sideBarSectionHeader-foreground, #bbb);
    padding: 4px 8px;
    font-weight: bold;
    font-size: 11px;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    border-bottom: 1px solid var(--vscode-widget-border, #333);
  }
  .section-body { padding: 8px; }
  .stat-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 5px;
    flex-wrap: wrap;
  }
  .stat-label { color: var(--vscode-descriptionForeground, #888); min-width: 70px; }
  .bar {
    font-family: monospace;
    letter-spacing: 1px;
  }
  .pct { font-weight: bold; min-width: 38px; text-align: right; }
  .val { color: var(--vscode-textLink-foreground, #4ec9b0); }
  .cost-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 3px 12px;
  }
  .cost-item { display: flex; justify-content: space-between; }
  .cost-label { color: var(--vscode-descriptionForeground, #888); }
  .cost-val { font-weight: bold; }
  .cost-total {
    margin-top: 5px;
    padding-top: 5px;
    border-top: 1px solid var(--vscode-widget-border, #444);
    display: flex;
    justify-content: space-between;
    font-size: 13px;
  }
  .cost-total .cost-val { color: #fbbf24; }
  .saved { color: #4ade80; font-size: 11px; }
  .todo-row {
    display: flex;
    align-items: center;
    gap: 4px;
    margin-bottom: 3px;
    font-size: 11px;
    white-space: nowrap;
    overflow: hidden;
  }
  .todo-done { opacity: 0.55; }
  .todo-active { color: #4ade80; }
  .todo-pending { color: var(--vscode-foreground); }
  .todo-idx { color: #888; min-width: 18px; text-align: right; }
  .todo-bar { color: #60a5fa; font-family: monospace; letter-spacing: 0; }
  .todo-pct { min-width: 34px; text-align: right; color: #888; }
  .todo-label { flex: 1; overflow: hidden; text-overflow: ellipsis; }
  .todo-dots { color: #555; }
  .todo-model { color: #a78bfa; }
  .todo-cost { color: #fbbf24; }
  .overall-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: 6px;
    font-size: 11px;
    color: #94a3b8;
  }
  .pricing-table {
    margin-top: 6px;
    padding-top: 5px;
    border-top: 1px dashed var(--vscode-widget-border, #333);
  }
  .pricing-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: #666;
    margin-bottom: 1px;
  }
  .pricing-type { min-width: 68px; }
  .pricing-rate { min-width: 60px; color: #888; font-weight: bold; }
  .pricing-tokens { color: #555; }
  .daily-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
    font-size: 11px;
  }
  .daily-date { min-width: 36px; color: #888; }
  .daily-bar {
    height: 8px;
    background: #3b82f6;
    border-radius: 2px;
    min-width: 2px;
    flex-shrink: 0;
  }
  .daily-cost { color: #94a3b8; min-width: 55px; text-align: right; }
  .daily-total {
    margin-top: 5px;
    padding-top: 4px;
    border-top: 1px solid var(--vscode-widget-border, #333);
    font-size: 11px;
    color: #888;
    text-align: right;
  }
  .tool-row {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-bottom: 2px;
    font-size: 11px;
  }
  .tool-name { min-width: 80px; color: #94a3b8; }
  .tool-bar { color: #60a5fa; letter-spacing: 1px; flex: 1; overflow: hidden; }
  .tool-count { color: #fbbf24; min-width: 24px; text-align: right; font-weight: bold; }
  .tool-group-header {
    font-size: 10px;
    color: #7dd3fc;
    margin: 5px 0 2px;
    padding-top: 4px;
    border-top: 1px dashed var(--vscode-widget-border, #333);
    letter-spacing: 0.04em;
  }
  .bloat-badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    margin-left: 6px;
    font-weight: bold;
  }
  .bloat-red { background: #7f1d1d; color: #fca5a5; }
  .bloat-yellow { background: #78350f; color: #fcd34d; }
  .snowball-row {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    color: #888;
    margin-top: 4px;
    flex-wrap: wrap;
  }
  .no-todos { color: #666; font-style: italic; padding: 4px 0; }
  .session-info { font-size: 10px; color: #555; margin-top: 6px; }
  .refresh-time { font-size: 10px; color: #555; text-align: right; margin-top: 4px; }
  .session-title-bar {
    background: var(--vscode-sideBarSectionHeader-background, #1e1e2e);
    border: 1px solid var(--vscode-widget-border, #333);
    border-radius: 4px;
    padding: 5px 8px;
    margin-bottom: 10px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .session-title-icon { font-size: 13px; flex-shrink: 0; }
  .session-title-text {
    flex: 1;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--vscode-foreground);
    font-size: 11px;
  }
  .session-title-id {
    color: #555;
    font-size: 10px;
    flex-shrink: 0;
  }
  .gear-btn {
    flex-shrink: 0;
    background: none;
    border: none;
    cursor: pointer;
    color: #555;
    font-size: 14px;
    padding: 0 2px;
    line-height: 1;
    transition: color 0.15s;
  }
  .gear-btn:hover { color: var(--vscode-foreground); }
  .cost-alert { font-size: 11px; margin-top: 4px; padding: 3px 6px; border-radius: 3px; }
  .cost-alert-warn { background: #78350f; color: #fcd34d; }
  .cost-alert-limit { background: #7f1d1d; color: #fca5a5; }
  .budget-bar-wrap {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .budget-bar-track {
    flex: 1;
    height: 6px;
    background: #1e293b;
    border-radius: 3px;
    position: relative;
    overflow: visible;
  }
  .budget-bar-fill {
    height: 100%;
    border-radius: 3px;
    transition: width 0.4s ease;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
  .budget-bar-pulse { animation: pulse 1.4s ease-in-out infinite; }
  .budget-bar-marker {
    position: absolute;
    top: -3px;
    width: 2px;
    height: 12px;
    background: #fbbf24;
    border-radius: 1px;
  }
  .budget-bar-label { font-size: 11px; font-weight: bold; min-width: 32px; text-align: right; }
  .budget-bar-hint { font-size: 10px; color: #888; margin-bottom: 6px; }
  .snowball-hint {
    font-size: 10px;
    color: #888;
    margin: 3px 0;
    padding: 2px 4px;
  }
  .snowball-hint code {
    font-family: monospace;
    background: #1e293b;
    padding: 1px 4px;
    border-radius: 2px;
    color: #7dd3fc;
  }
</style>
</head>
<body>
<script>
  const vscode = acquireVsCodeApi();
  function openSettings() { vscode.postMessage({ command: 'openSettings' }); }
</script>

<!-- Session Title -->
<div class="session-title-bar">
  <span class="session-title-icon">💬</span>
  <span class="session-title-text" title="${escHtml(s.sessionTitle)}">${escHtml(truncate(s.sessionTitle, 60))}</span>
  <span class="session-title-id">${s.sessionId.slice(0, 8)}</span>
  <button class="gear-btn" onclick="openSettings()" title="打开配置文件">⚙</button>
</div>

<!-- Context Usage -->
<div class="section">
  <div class="section-header">⬡ Context Window</div>
  <div class="section-body">
    <div class="stat-row">
      <span class="stat-label">Used</span>
      <span class="bar" style="color:${contextColor}">${contextBar}</span>
      <span class="pct" style="color:${contextColor}">${contextPct.toFixed(1)}%</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Tokens</span>
      <span class="val">${fmt(s.usage.inputTokens)}</span>
      <span style="color:#555"> / </span>
      <span>${fmt(s.contextLimit)}</span>
      <span style="color:#555;font-size:10px;margin-left:4px">${s.contextLimitSource === 'config' ? '(手动)' : '(自动)'}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Output</span>
      <span class="val">${fmt(s.usage.outputTokens)}</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Model</span>
      <span style="color:#a78bfa">${shortModel(s.model)}</span>
    </div>
  </div>
</div>

<!-- Cache Stats -->
<div class="section">
  <div class="section-header">⚡ Cache Hit Rate</div>
  <div class="section-body">
    <div class="stat-row">
      <span class="stat-label">Hit Rate</span>
      <span class="bar" style="color:${cacheColor}">${cacheBar}</span>
      <span class="pct" style="color:${cacheColor}">${cachePct}%</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Cache Read</span>
      <span class="val">${fmt(s.cache.cacheReadTokens)}</span>
      <span style="color:#555"> tokens</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Cache Write</span>
      <span class="val">${fmt(s.cache.cacheCreationTokens)}</span>
      <span style="color:#555"> tokens</span>
    </div>
    <div class="stat-row">
      <span class="stat-label">Saved</span>
      <span class="saved">+${fmtCost(s.cost.savedByCacheUSD)}</span>
    </div>
  </div>
</div>

<!-- Cost Breakdown -->
<div class="section">
  <div class="section-header">💰 Cost This Session</div>
  <div class="section-body">
    <div class="cost-grid">
      <div class="cost-item">
        <span class="cost-label">Input</span>
        <span class="cost-val">${fmtCost(s.cost.inputCost)}</span>
      </div>
      <div class="cost-item">
        <span class="cost-label">Output</span>
        <span class="cost-val">${fmtCost(s.cost.outputCost)}</span>
      </div>
      <div class="cost-item">
        <span class="cost-label">Cache Write</span>
        <span class="cost-val">${fmtCost(s.cost.cacheWriteCost)}</span>
      </div>
      <div class="cost-item">
        <span class="cost-label">Cache Read</span>
        <span class="cost-val" style="color:#4ade80">${fmtCost(s.cost.cacheReadCost)}</span>
      </div>
    </div>
    <div class="cost-total">
      <span class="cost-label">Total</span>
      <span class="cost-val">${fmtCost(s.cost.totalCost)}</span>
    </div>
    ${s.cost.savedByCacheUSD > 0 ? `<div class="saved">⬇ Cache saved ${fmtCost(s.cost.savedByCacheUSD)} vs full price</div>` : ''}
    <div class="pricing-table">
      <div class="pricing-row">
        <span class="pricing-type">Input</span>
        <span class="pricing-rate">$${s.pricing.inputPer1M.toFixed(2)}/1M</span>
        <span class="pricing-tokens">${fmt(s.usage.inputTokens)} tokens</span>
      </div>
      <div class="pricing-row">
        <span class="pricing-type">Output</span>
        <span class="pricing-rate">$${s.pricing.outputPer1M.toFixed(2)}/1M</span>
        <span class="pricing-tokens">${fmt(s.usage.outputTokens)} tokens</span>
      </div>
      <div class="pricing-row">
        <span class="pricing-type">Cache Write</span>
        <span class="pricing-rate">$${s.pricing.cacheWritePer1M.toFixed(2)}/1M</span>
        <span class="pricing-tokens">${fmt(s.usage.cacheCreationTokens)} tokens</span>
      </div>
      <div class="pricing-row">
        <span class="pricing-type">Cache Read</span>
        <span class="pricing-rate" style="color:#4ade80">$${s.pricing.cacheReadPer1M.toFixed(2)}/1M</span>
        <span class="pricing-tokens">${fmt(s.usage.cacheReadTokens)} tokens</span>
      </div>
    </div>
  </div>
</div>

<!-- Session Bloat -->
${s.bloat.rounds > 0 ? (() => {
  const r = s.bloat.rounds;
  const minCost = s.bloat.minCostPerRound;
  const hitPct = Math.round(s.cache.hitRate * 100);

  // Primary signal: cache hit rate + context pressure.
  // minCostPerRound grows naturally with a long cached session but is NOT a warning signal
  // when cache is healthy — high cache reads at $0.30/1M is still the cheapest possible state.
  const cachePerfect = hitPct >= 95;
  const cacheDecaying = hitPct >= 50 && hitPct < 80;
  const cachePoor = hitPct < 50;
  const contextNearLimit = contextPct > 85;
  const contextHigh = contextPct > 65;

  let bloatLevel: 'green' | 'yellow' | 'red';
  if (contextNearLimit || cachePoor) {
    bloatLevel = 'red';
  } else if (cacheDecaying || contextHigh) {
    bloatLevel = 'yellow';
  } else {
    bloatLevel = 'green';
  }

  const roundColor = bloatLevel === 'red' ? '#f87171' : bloatLevel === 'yellow' ? '#fbbf24' : '#4ade80';
  const clearCode = '<code style="font-family:monospace;background:#1e293b;padding:1px 4px;border-radius:2px;color:#7dd3fc">/clear</code>';

  let statusLine = '';
  if (bloatLevel === 'green') {
    statusLine = `<span style="color:#4ade80">🟢 雪球效应：当前缓存完美命中（${hitPct}%），单轮最低消费极低，建议继续保持。</span>`;
  } else if (bloatLevel === 'yellow') {
    const reason = cacheDecaying
      ? `缓存命中率降至 ${hitPct}%，对话混入较多新内容`
      : `上下文已用 ${contextPct.toFixed(0)}%，剩余空间有限`;
    statusLine = `<span style="color:#fbbf24">🟡 ${reason}</span><span style="color:#888"> — 考虑 ${clearCode}</span>`;
  } else {
    const reason = contextNearLimit
      ? `上下文已用 ${contextPct.toFixed(0)}%，即将耗尽`
      : `缓存命中率仅 ${hitPct}%，每轮真实输入激增`;
    statusLine = `<span style="color:#f87171">🔴 ${reason}</span><span style="color:#888"> — 建议 ${clearCode} 新开对话</span>`;
  }

  const badge = bloatLevel === 'red'
    ? (contextNearLimit ? '<span class="bloat-badge bloat-red">上下文告急</span>' : '<span class="bloat-badge bloat-red">缓存崩塌</span>')
    : bloatLevel === 'yellow'
    ? '<span class="bloat-badge bloat-yellow">缓存劣化</span>'
    : (cachePerfect ? '<span class="bloat-badge" style="background:#14532d;color:#86efac">缓存健康</span>' : '');

  return `
<div class="section">
  <div class="section-header">💬 会话臃肿度</div>
  <div class="section-body">
    <div class="stat-row">
      <span class="stat-label">当前第</span>
      <span class="val" style="color:${roundColor};font-size:18px;font-weight:bold">${r}</span>
      <span style="color:${roundColor};margin-left:2px">轮</span>
      ${badge}
    </div>
    <div class="snowball-row">${statusLine}</div>
  </div>
</div>`;
})() : ''}

<!-- Daily Spend -->
${dailySpend.length > 0 ? (() => {
  const today = new Date().toISOString().slice(0, 10);
  const todayCost = dailySpend.find(d => d.date === today)?.cost ?? 0;
  const weekTotal = dailySpend.filter(d => d.date !== today).reduce((a, b) => a + b.cost, 0);
  const maxCost = Math.max(...dailySpend.map(x => x.cost), 0.001);
  const warn = thresholds.warning ?? null;
  const limit = thresholds.limit ?? null;

  // Today's budget progress relative to limit (can exceed 100%); null if no limit set
  const todayPct = limit != null ? (todayCost / limit) * 100 : null;
  const zone = todayPct == null ? 'normal'
    : todayPct >= 100 ? 'red'
    : todayPct >= 81 ? 'orange'
    : 'normal';
  const zoneColor = zone === 'red' ? '#f87171' : zone === 'orange' ? '#fb923c' : '#4ade80';

  // Budget progress bar (only if limit is set); bar capped at 100% width but label shows real %
  const barFillPct = todayPct != null ? Math.min(100, todayPct) : null;
  const budgetBar = todayPct != null ? `
    <div class="budget-bar-wrap">
      <div class="budget-bar-track">
        <div class="budget-bar-fill ${zone === 'red' ? 'budget-bar-pulse' : ''}"
          style="width:${barFillPct!.toFixed(1)}%;background:${zoneColor}"></div>
        ${warn != null ? `<div class="budget-bar-marker" style="left:${Math.min(100,(warn/limit!)*100).toFixed(1)}%"></div>` : ''}
      </div>
      <span class="budget-bar-label" style="color:${zoneColor}">${todayPct.toFixed(0)}%</span>
    </div>
    <div class="budget-bar-hint">
      ${fmtCost(todayCost)} / ${fmtCost(limit!)}
      ${zone === 'red' ? ' <span style="color:#f87171">💸 已超预算</span>' : zone === 'orange' ? ' <span style="color:#fb923c">⚠️ 建议收尾</span>' : ''}
    </div>` : '';

  // Previous 6 days only (exclude today), newest first
  const prevDays = dailySpend.filter(d => d.date !== today).slice(-6).reverse();
  const prevMaxCost = Math.max(...prevDays.map(x => x.cost), 0.001);
  const rows = prevDays.map(d => {
    const barW = Math.round((d.cost / prevMaxCost) * 80);
    const overL = limit != null && d.cost >= limit;
    const overW = warn != null && d.cost >= warn;
    const barColor = overL ? '#f87171' : overW ? '#fb923c' : '#3b82f6';
    const costColor = overL ? '#f87171' : overW ? '#fb923c' : '#94a3b8';
    return `<div class="daily-row">
      <span class="daily-date">${d.date.slice(5)}</span>
      <span class="daily-bar" style="width:${barW}px;background:${barColor}"></span>
      <span class="daily-cost" style="color:${costColor}">${fmtCost(d.cost)}</span>
    </div>`;
  }).join('');

  return `
<div class="section">
  <div class="section-header">📅 近期费用统计</div>
  <div class="section-body">
    ${budgetBar ? '<div style="font-size:10px;color:#888;margin-bottom:3px">今日</div>' : ''}
    ${budgetBar}
    ${budgetBar ? '<div style="height:8px"></div>' : ''}
    ${rows}
    <div class="daily-total">
      <span>前六天合计</span>
      <span style="color:#fbbf24;font-weight:bold">${fmtCost(weekTotal)}</span>
    </div>
  </div>
</div>`;
})() : ''}

<!-- Tool Calls (built-in + MCP) -->
${(() => {
  // Separate built-in tools from MCP tools (mcp__server__tool naming)
  const builtIn: [string, number][] = [];
  const mcpGroups: Record<string, [string, number][]> = {};

  for (const [name, count] of Object.entries(s.tools.counts)) {
    if (name.startsWith('mcp__')) {
      const parts = name.split('__');
      const server = parts[1] || 'unknown';
      const tool = parts.slice(2).join('__') || name;
      if (!mcpGroups[server]) mcpGroups[server] = [];
      mcpGroups[server].push([tool, count]);
    } else {
      builtIn.push([name, count]);
    }
  }
  if (s.tools.webSearches > 0) builtIn.push(['WebSearch', s.tools.webSearches]);
  if (s.tools.webFetches > 0) builtIn.push(['WebFetch', s.tools.webFetches]);

  const hasMcp = Object.keys(mcpGroups).length > 0;
  if (builtIn.length === 0 && !hasMcp) return '';

  const toolRow = (label: string, count: number, indent = false) => `
    <div class="tool-row" style="${indent ? 'padding-left:12px' : ''}">
      <span class="tool-name" style="${indent ? 'color:#7dd3fc' : ''}">${escHtml(label)}</span>
      <span class="tool-bar">${'▪'.repeat(Math.min(count, 20))}</span>
      <span class="tool-count">${count}</span>
    </div>`;

  const builtInRows = builtIn.sort((a, b) => b[1] - a[1]).map(([n, c]) => toolRow(n, c)).join('');
  const mcpRows = Object.entries(mcpGroups).map(([server, tools]) => `
    <div class="tool-group-header">MCP: ${escHtml(server)}</div>
    ${tools.sort((a, b) => b[1] - a[1]).map(([n, c]) => toolRow(n, c, true)).join('')}
  `).join('');

  return `
<div class="section">
  <div class="section-header">🔧 工具调用统计${hasMcp ? ' (含 MCP)' : ''}</div>
  <div class="section-body">
    ${builtInRows}
    ${mcpRows}
  </div>
</div>`;
})()}

<!-- Task List -->
<div class="section">
  <div class="section-header">📋 Tasks (${doneTodos}/${totalTodos})</div>
  <div class="section-body">
    ${totalTodos === 0
      ? '<div class="no-todos">No tasks tracked yet</div>'
      : todoRows}
    ${totalTodos > 0 ? `
    <div class="overall-row">
      <span>Overall</span>
      <span class="bar" style="color:#60a5fa">${overallBar}</span>
      <span class="pct">${totalPct}%</span>
      <span style="color:#555">(${activeTodos} active)</span>
    </div>` : ''}
  </div>
</div>

<div class="refresh-time">↺ ${s.lastUpdated.toLocaleTimeString()}</div>

</body>
</html>`;
}

function buildEmptyHtml(): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<style>
  body {
    font-family: monospace;
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-sideBar-background);
    padding: 20px;
    text-align: center;
  }
  .icon { font-size: 32px; margin-bottom: 12px; }
  p { line-height: 1.6; }
</style>
</head>
<body>
  <div class="icon">🤖</div>
  <p>No active Claude Code session found.</p>
  <p style="color:#555;font-size:11px;margin-top:8px;">Open a project and start Claude Code to see stats.</p>
</body>
</html>`;
}
