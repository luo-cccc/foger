<p align="center">
  <img src="assets/logo.svg" width="120" height="120" alt="InkOS Logo">
  <img src="assets/inkos-text.svg" width="240" height="65" alt="InkOS">
</p>

<h1 align="center">漫剧剧本生产系统</h1>

<p align="center">
  面向 100 集竖屏漫剧的规划、分镜写作、连续性审计、修订与完本管理
</p>

<p align="center">
  <a href="README.en.md">English</a> | 中文
</p>

## 产品定位

InkOS 将原长篇小说生产链改造成统一的漫剧剧本工作流。系统默认规划 100 集，每集目标 150 秒（约 2.5 分钟），并以结构化 `EpisodeScript JSON` 作为权威创作真源，同时生成便于阅读和交付的分镜 Markdown。

创作标准统一为：

> 新颖设定 × 熟悉爽点 × 高压关系 × 高频反转 × 情绪钩子

每一集都经过：

```text
Planner → Composer → Writer → 确定性质量门 → 状态结算 → Auditor → 持久化
```

正常生产最多调用 Planner、Writer、Auditor 三次模型。结构化剧本的状态、摘要、Hook 和交接胶囊由本地 reducer 推导，不再默认调用额外的 LLM Settlement。

## 最新更新

### 2026-08-13

- **跨集凑时长重复检测**：补上分镜格式下被短路的跨集重复门禁——新增镜头表面短语重复 + 行为签名重合（Jaccard）两个确定性信号，检测"复用上一集镜头写法/舞台调度凑时长"，接入写路径与审计路径（最近 3 集）。
- **创作输出上限提升**：writer/reviser/canon-extractor 的 per-call max-tokens 从硬编码 8192 改为 `min(32768, 模型卡片上限)`——deepseek-v4-flash 等大模型用满 32768，小模型自动回落自身上限。放大制作（更长单集/更多镜头）不再被输出长度截断。
- **生产工具去污染**：清掉所有从真实付费测试书渗入生产源码的剧情细节；建书提示词新增**世界命名硬约束**——世界名必须从标题与设定派生、禁止"XX界/XX大陆/XX域"占位命名。
- **模板感收敛**：writer 新增节拍变奏指令，标题句式结构轮换检测（连续 3 集同句式壳自动换名）。
- **题材去模板化**：15 题材疲劳词全部唯一、爽点池扩到 8-10 类、审计维度题材差异化。
- **污染守卫**：新增 `scripts/audit-contamination.mjs` 拒绝测试夹具/付费书专名进入生产源码，接入 `pnpm verify`。
- 验证：core 148 文件 1453 测试全绿。

[查看完整更新记录](docs/releases/release-notes.md)

## 核心能力

- **100 集规划**：全剧总纲、10 个故事篇章、篇章计划、单集计划和分镜剧本逐层收敛。
- **结构化分镜**：每个镜头包含景别、机位、时长、画面、动作、对白、旁白、声音和转场。
- **戏剧合同**：强制区分反转、局部兑现、情绪钩子、出去压力和最终状态变化。
- **连续性治理**：跟踪人物位置、伤势、能力、道具、信息权限、关系压力、世界规则和 Hook。
- **状态交接**：每集生成带剧本哈希的 handoff capsule，恢复时校验来源，避免使用过期状态。
- **证据审查**：审计问题包含严重级别、规则类别、描述、修复建议、证据引用和源文件哈希。
- **可靠持久化**：剧本 JSON、Markdown、索引、状态、摘要、审查和交接数据在同一事务中提交或回滚。
- **全剧完本审计**：最终集必须解决主线、人物弧线、关键 Hook 和核心关系冲突，才能标记完成。
- **多入口操作**：提供 Studio、CLI、TUI 和自然语言 Chat。

## 快速开始

环境要求：Node.js 20+，pnpm 9+。

```bash
pnpm install
pnpm build
```

创建项目并配置模型：

```bash
inkos init my-drama
cd my-drama

inkos config set-global \
  --provider custom \
  --base-url https://api.deepseek.com \
  --api-key-env DEEPSEEK_API_KEY \
  --model deepseek-chat
```

密钥应放入环境变量或项目密钥库，不要写入 `inkos.json`、剧本、日志或报告。

创建一部漫剧：

```bash
inkos book create \
  --title "零点来电" \
  --genre urban \
  --episodes 100 \
  --duration 150 \
  --brief creative-brief.md
```

规划、编排并生成下一集：

```bash
inkos plan episode 零点来电
inkos compose episode 零点来电
inkos write next 零点来电
```

审计、修订与查看进度：

```bash
inkos audit 零点来电 1
inkos revise 零点来电 1
inkos series status 零点来电
inkos series complete 零点来电
```

导出交付物：

```bash
inkos export 零点来电 --format screenplay-md
inkos export 零点来电 --format screenplay-json
inkos export 零点来电 --format dialogue
```

设定维护（书超纲续写或 canon 增量入库时使用）：

```bash
inkos foundation extend 零点来电 --episodes 120
inkos canon refresh 零点来电
```

直接运行 `inkos` 会启动 Studio，默认地址为 `http://127.0.0.1:4567`。

## 单集合同

每集剧本必须满足：

- 1～3 个场景；镜头数按目标时长动态预算（150 秒目标约 8～20 个），仅下限为硬约束、上限为软告警。
- 目标时长默认 150 秒；软区间为 ±30 秒（120～180 秒），硬区间为 90～210 秒。
- 每个镜头必须有可制作的视觉信息。
- 心理活动必须转换为动作、表情、对白或旁白。
- 至少包含一个明确冲突、一个有铺垫的方向性转折和一个局部兑现。
- 结尾必须产生由本集结果自然引出的新压力，并改变关系、信息、权力或生存状态。

结构化合同的主要字段：

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

完整模型与审计规则见[架构说明](docs/architecture.md)。

## 项目结构

```text
books/<series-id>/
├── book.json
├── episodes/
│   ├── index.json
│   ├── 0001_标题.json
│   ├── 0001_标题.md
│   └── 0001_review.json
└── story/
    ├── canon/            # 结构化设定（claims / world_system / asset_registry / unclaimed_facts）
    ├── outline/
    ├── roles/
    ├── state/
    ├── runtime/
    ├── snapshots/
    ├── current_state.md
    ├── pending_hooks.md
    └── episode_summaries.md
```

`episodes/*.json` 是剧本权威真源。Markdown 是阅读和导出投影。`story/state/*.json` 保存结构化运行状态，`story/runtime/` 保存单次操作的计划、上下文、规则、审查、性能和交接数据，`story/canon/` 保存机器可校验的结构化设定（随剧集确定性演化，可通过 `inkos canon refresh` 增量入库）。

旧小说目录、旧 schema 或旧字段不会被静默解释为漫剧项目。

## 开发与验证

```bash
pnpm check:hygiene
pnpm typecheck
pnpm audit:semantic-patterns
pnpm build
pnpm test
pnpm verify:publish-manifests
```

清理构建和测试产物：

```bash
pnpm clean:build
```

更多维护说明见[运行与维护](docs/operations.md)。

## 边界

当前版本只负责文本漫剧生产，不包含出图、配音、音效素材、视频生成或资产生产链。第一版导出范围为分镜 Markdown、结构化 JSON、全剧状态/完本报告和角色台词表。

## License

[AGPL-3.0-only](LICENSE)
