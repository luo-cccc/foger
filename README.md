<p align="center">
  <img src="assets/logo.svg" width="120" height="120" alt="InkOS Logo">
  <img src="assets/inkos-text.svg" width="240" height="65" alt="InkOS">
</p>

<h1 align="center">漫剧剧本生产系统</h1>

<p align="center">
  面向长篇竖屏漫剧的规划、分镜写作、连续性审查、修订、审批与完本管理
</p>

<p align="center">
  <a href="README.en.md">English</a> | 中文
</p>

## 产品定位

InkOS 是 Episode-first 的文本漫剧生产系统。默认目标为 100 集、每集 150 秒，并以结构化 `EpisodeScript JSON` 作为剧本权威真源。Markdown 只用于阅读和交付投影，不能反向覆盖 JSON。

单集主流程：

```text
Planner → Composer → Writer → 确定性门禁 → Auditor/Reviser → 状态结算 → 持久化
```

首轮通过时通常只需要 Planner、Writer 和 Auditor 模型调用。状态、摘要、Hook、Canon 演化和交接胶囊由本地确定性逻辑推导；审查失败时才进入修订循环。

## 最新更新

### 2026-08-14

- **统一剧本真源**：人工编辑、审计、修订、同步和导出统一读取 `episodes/*.json`，JSON 与 Markdown 成对提交或回滚。
- **明确生产检查点**：手动模式初稿进入 `drafted`，不推进状态、快照或 Canon；审计通过后进入 `ready-for-review`，手动模式批准后才能继续。
- **收紧审批与交付**：批准要求当前 JSON 对应的有效审查证据；默认导出和全剧完结只接受 `approved/published`，`--approved-only` 可导出已批准子集。
- **状态与 Canon 可恢复**：逐集快照包含结构化状态和 Canon；拒绝、重写与最新集修订会恢复相应基线。

[查看完整更新记录](docs/releases/release-notes.md)

## 核心能力

- 全剧总纲、篇章计划、单集计划和 EpisodeScript 分层生产。
- 结构化场景与镜头，包括景别、机位、时长、画面、动作、对白、旁白、声音和转场。
- 单集戏剧合同：进入状态、目标、阻力、因果升级、局部结果、出去压力和交接状态。
- 确定性 schema、时长、合同、Canon、Hook、角色引用、AI 味和跨集重复检查。
- 带严重级别、责任方、证据位置和正文哈希的审查证据。
- JSON/Markdown、索引、运行状态、快照、Canon 和 sidecar 的事务化持久化与恢复。
- Studio、CLI、TUI 和自然语言 Agent 共用 Core 业务入口。

## 快速开始

要求：Node.js 20+，pnpm 9+。

```bash
pnpm install
pnpm build

inkos init my-drama
cd my-drama
```

配置模型。密钥只放在环境变量或本地密钥存储中：

```bash
inkos config set-global \
  --provider custom \
  --base-url https://api.example.com/v1 \
  --api-key-env MY_LLM_API_KEY \
  --model my-model
```

创建并生产一部漫剧：

```bash
inkos book create \
  --title "零点来电" \
  --genre urban \
  --episodes 100 \
  --duration 150 \
  --brief creative-brief.md

inkos plan episode 零点来电
inkos compose episode 零点来电
inkos write next 零点来电
```

审查、修订和审批：

```bash
inkos audit 零点来电 1
inkos revise 零点来电 1
inkos review list 零点来电
inkos review approve 零点来电 1
```

默认导出要求所有剧集均已批准或发布：

```bash
inkos export 零点来电 --format screenplay-md
inkos export 零点来电 --format screenplay-json
inkos export 零点来电 --format dialogue

# 只导出已批准部分
inkos export 零点来电 --format screenplay-md --approved-only
```

维护与完本：

```bash
inkos foundation extend 零点来电 --episodes 120
inkos canon refresh 零点来电
inkos series status 零点来电
inkos series complete 零点来电
```

直接运行 `inkos` 会启动 Studio，默认地址为 `http://127.0.0.1:4567`。

## 状态规则

| 状态 | 含义 | 是否可继续生产 |
| --- | --- | --- |
| `drafted` | 手动模式初稿，尚未审计 | 否 |
| `ready-for-review` | 审计通过，真相与快照已提交 | 自动模式可以；手动模式需先批准 |
| `audit-failed` | 存在阻断问题或人工编辑后待重审 | 否 |
| `state-degraded` | 正文可用，但状态提交或恢复不完整 | 否 |
| `approved` / `published` | 可交付状态 | 是 |
| `rejected` | 已拒绝，依赖状态必须回滚或重写 | 否 |

批准还要求当前 Episode JSON 有合法、哈希匹配且状态为 `PROVISIONAL` 的审查证据。详细状态转换见[架构说明](docs/architecture.md)。

## 单集合同

每集包含 1～3 个场景；默认 150 秒目标对应约 8～20 个镜头，下限为硬约束、上限为软告警。默认软时长区间为 120～180 秒，硬区间为 90～210 秒。

结构化合同字段：

```text
incomingState
objective
opposition
causalEscalation
localDramaticResult
outgoingPressure
handoffState
informationPermissions
```

## 项目结构

```text
books/<series-id>/
├── book.json
├── episodes/
│   ├── index.json
│   ├── 0001_标题.json       # 权威剧本
│   ├── 0001_标题.md         # 阅读投影
│   └── 0001_review.json     # 审查证据
└── story/
    ├── canon/               # 结构化设定
    ├── outline/             # 总纲与卷计划
    ├── roles/               # 角色资料
    ├── state/               # 结构化运行状态
    ├── runtime/             # 单次操作派生物与诊断
    ├── snapshots/           # 逐集状态与 Canon 快照
    ├── current_state.md
    ├── pending_hooks.md
    └── episode_summaries.md
```

旧小说目录、旧 schema 和旧 runtime 不会被静默解释为 Episode v2 项目。

## 开发与文档

```bash
pnpm verify
pnpm clean:dry-run
pnpm clean
```

- [文档索引](docs/README.md)
- [架构说明](docs/architecture.md)
- [运行与维护](docs/operations.md)
- [贡献指南](CONTRIBUTING.md)

## 边界

当前版本只负责文本剧本与结构化生产数据，不包含出图、配音、音效、视频生成或媒体资产制作。

## License

[AGPL-3.0-only](LICENSE)
