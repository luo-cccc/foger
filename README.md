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

### 2026-08-11

- 单集时长改为 2-3 分钟制：默认目标 150 秒（软区间 120-180、硬区间 90-210），镜头数上限改为随目标时长动态预算的软约束（150 秒约 8-20 个），超上限只告警不拒绝。
- 真实付费复跑验证（《子夜当铺》20 集，deepseek-v4-flash）：20/20 一次过审、零 revise 缠斗、零内容人工干预，完本门禁一次通过，单集时长全部收敛在 147-154 秒。
- 六项生产修复落地：revise 严重度加权择优（critical 优先）、伏笔台账识别 advance 段内 `→ resolve` 终态标记、审稿解析失败自动重试、approve 前状态一致性守卫与可执行修复提示、planner memo 自相矛盾确定性告警、revise 落盘同步重写 JSON 侧车。
- writer 解析失败再加固：内部修复失败后由 runner 从零重生一次，最终失败把原始输出留存到 `story/runtime/` 并附路径；LLM 配置校验失败给出指向环境变量/配置命令的可执行提示。

### 2026-08-10

- 完成 100 集真实付费生产测试（《崖山抽卡人》，deepseek-v4-flash）：全流程零失败产出 100 集 ready-for-review 剧本，场景切换/气运账本/钩子叙事回收/终局闭环全部落地，完本门禁通过。
- 修复钩子账本不随计划推进：planner 的 advance/resolve/defer 注解在写作、修订与状态重放中确定性落账，伏笔健康监控恢复有效，核心钩子按卷计划回收。
- 修复 Writer 输出鲁棒性：剥离 PRE_WRITE_CHECK 前导后提取剧本 JSON；时长越界草稿先做确定性镜头时长归一化，减少修复调用与中断。
- 角色引用审计降噪：功能性角色标签全面豁免，已出场角色不再跨集重复告警，只保留"发明新名字"的首次告警（100 集数据反跑：未知角色告警 81→6）。
- 修订门禁修复：手动 revise 合并确定性门禁结果，不再出现"无可执行阻断证据"卡死；情绪钩子等单字段问题支持局部补丁。
- 标题去重后缀优化：优先选用正文中的新鲜实词，避免"计时长"式生硬片段。
- 修复后 10 集新书（《烽燧令》）真实生产验证：单进程零中断产出，钩子账本全程落账、完本门禁通过，审计告警密度大幅下降。

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
