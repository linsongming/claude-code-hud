# Claude Code HUD

一个 VSCode 插件，实时展示 Claude Code 的会话状态：上下文用量、费用、缓存命中率、任务进度等。

## 功能概览
<img width="336" height="786" alt="Image" src="https://github.com/user-attachments/assets/13fd1492-2ff7-4e8d-907e-032cf4659b82" />

<img width="329" height="474" alt="Image" src="https://github.com/user-attachments/assets/7213bf06-d42f-4250-b36e-a181ff159fb8" />

### Context Window — 上下文用量
- 进度条 + 百分比，实时反映当前 token 消耗
- 显示 input / output token 数量和当前模型
- 自动识别模型对应的上下文上限（Opus 4.x = 1M，其余 = 200K），也可手动覆盖

### Cache Hit Rate — 缓存命中率
- 命中率进度条（绿 / 黄 / 灰分级显示）
- Cache Read / Cache Write token 数量
- 与全价输入相比节省的费用

### Cost This Session — 本次会话费用
- 按 Input / Output / Cache Write / Cache Read 分类展示
- 底部显示定价参考表（每 1M token 单价 × 实际 token 数）
- 支持自定义单价，适配不同模型或企业折扣

### 会话臃肿度
- 追踪本次对话已进行的轮数
- 根据缓存命中率 + 上下文占用，给出健康度评级：
  - 🟢 绿色：缓存完美，继续保持
  - 🟡 黄色：缓存劣化或上下文偏高，考虑 `/clear`
  - 🔴 红色：上下文告急 or 缓存崩塌，建议新开对话

### 近期费用统计
- 最近 7 天每日费用横向柱状图
- 可设置黄色预警（`dailyCostWarning`）和红色上限（`dailyCostLimit`）
- 设置上限后，今日费用显示动态进度条，超预算时红色闪烁

### 工具调用统计
- 按调用次数排序展示所有内置工具
- MCP 工具按 server 分组展示（`mcp__server__tool` 格式）
- 包含 WebSearch / WebFetch 次数

### Tasks — 任务列表
- 解析 Claude Code 的 `TodoWrite` 记录，展示每个任务的状态
- `○` 待办 / `◉` 进行中 / `✓` 已完成
- 底部汇总整体完成进度

### 状态栏
底部状态栏实时显示：`🤖 XX% ctx | cache:XX% | $X.XXXX`，点击跳转到 HUD 面板。

## 安装

从 `.vsix` 文件安装：

```
Extensions 面板 → … → Install from VSIX → 选择 claude-code-hud-0.1.0.vsix
```

或通过命令行：

```bash
code --install-extension claude-code-hud-0.1.0.vsix
```

## 配置

插件首次激活时，会在 `~/.claude/claude-code-hud.json` 自动创建配置文件，内含各字段的中文说明，**修改后无需重启，自动生效**。

点击 HUD 面板右上角的 ⚙ 按钮可直接打开配置文件。

```jsonc
{
  // null = 根据模型自动判断（Opus 4.x = 1M，其余 = 200K）
  "contextLimit": null,

  // 面板刷新间隔（毫秒），默认 3000
  "refreshInterval": 3000,

  // 以下为 Sonnet 4.x 默认定价，按需修改
  "inputCostPer1M": 3.0,
  "outputCostPer1M": 15.0,
  "cacheWriteCostPer1M": 3.75,
  "cacheReadCostPer1M": 0.30,

  // 每日费用预警（黄色），null = 不预警
  "dailyCostWarning": null,

  // 每日费用上限（红色），null = 不限制
  "dailyCostLimit": null
}
```

也可在 VSCode 设置（`Ctrl+,`）中搜索 `Claude Code HUD` 进行配置。

## 命令

| 命令 | 说明 |
|------|------|
| `Claude Code HUD: Show Panel` | 聚焦到 HUD 侧边栏面板 |
| `Claude Code HUD: Refresh` | 手动刷新数据 |

## 工作原理

插件读取 `~/.claude/projects/<project>/` 目录下 Claude Code 写入的 `.jsonl` 会话文件，解析 token 用量、工具调用记录和 Todo 状态，在侧边栏实时渲染。无需任何 API 密钥，完全本地运行。

## 要求

- VSCode 1.85+
- Claude Code CLI（本地会话文件由其生成）
