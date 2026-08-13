# 运行与维护

## 环境

- Node.js 20 或更高版本。
- pnpm 9 或更高版本。
- 模型密钥通过环境变量或 `.inkos/secrets.json` 提供。

不要把真实密钥写入 `inkos.json`、`.env.example`、代码、剧本、日志、报告或提交历史。

## 常用验证

```bash
pnpm check:hygiene
pnpm typecheck
pnpm audit:semantic-patterns
pnpm audit:contamination
pnpm build
pnpm test
pnpm verify:publish-manifests
git diff --check
```

Core 聚焦测试：

```bash
pnpm --filter @actalk/inkos-core test
```

测试使用确定性 LLM stub 时不会产生付费请求。真实模型测试必须显式注入密钥，并在运行前确认调用预算。

## 设定与 canon 维护

```bash
# 重写 volume_map 以覆盖新的目标集数（保留 story_frame / roles / book_rules / pending_hooks）
inkos foundation extend <book-id> --episodes <n>

# 把未认领剧集事实合并为新 canon claims（一次显式 LLM 调用，不进单集预算）
inkos canon refresh <book-id>
```

每集持久化时，未被既有 claim 覆盖的交接知识/状态变化会确定性收集到 `story/canon/unclaimed_facts.json`（幂等，供 `canon refresh` 消费）。当积压达到 `PipelineConfig.unclaimedFactsBacklogThreshold`（默认 50 条）时，`plan episode` 与 `write next` 会以 `CANON_REFRESH_REQUIRED` 暂停；执行 `inkos canon refresh <book-id>` 并审阅新 claims 后再继续。该闸门不自动把 Writer 临时发明的角色或设定写入 Canon。卷合同超纲（待写集号超出大纲卷范围）会在写结果中给出非阻断警告，请先运行 `inkos foundation extend` 再继续写作。

## 内容与交付门禁

- Writer 落盘前会拒绝不是具体观众疑问句的结尾情绪钩子（关系、危险、身份、牺牲或选择），错误码为 `INVALID_EMOTIONAL_HOOK`。
- Writer 落盘前会拒绝命中的禁止发布政治敏感词，错误码为 `BLOCKED_SENSITIVE_CONTENT`；不要依赖审计报告作为内容红线的唯一拦截点。
- Hook 的提前回收只依据 `targetPayoffEpisode` 与全部 `payoffEvidence` 判定。维护 Hook 时，在 Planner memo 的新增/推进项中写明 `证据：` 或 `evidence:` 的可见载体；不要以角色名或自由文本备注代替终局证据。
- `audit-failed` 或 `state-degraded` 剧集不能默认导出。先完成修订、重审和状态恢复，再执行 `inkos export`。

## 污染守卫与题材配置

- `pnpm audit:contamination`（已接入 `pnpm verify`）：拒绝付费测试书专名（角色/门派/地名/书名）出现在生产源码、提示词与 Studio 文案中。新付费书产生的角色请先登记到 `scripts/audit-contamination.mjs` 的 `KNOWN_CONTAMINATION`，并保持不进提示词与管线代码。
- 内置题材（`packages/core/genres/*.md`）维护规则：`fatigueWords` 只放题材特有词——通用 AI 味词（中文：仿佛/不禁/宛如/竟然/忽然/猛地；英文：delve/tapestry/testament 等）由 auditor 统一硬编码检查，不要写回题材文件；爽点池保持 ≥8 类以支撑长卷轮换。`genre-config.test.ts` 会强制这些约束。

## 输出长度（max-tokens）

writer / reviser / canon-extractor 的每次调用输出上限为 `min(32768, 模型卡片 maxOutput)`，随模型能力自适应：

- 大模型（如 deepseek-v4-flash，maxOutput 393216）用满 32768。
- 小模型（如 gpt-4o，maxOutput 16384）自动回落到自身 16384，不会触发 API 的 max_tokens 超限。

需要整体收紧输出时，设置环境变量（只降不升）：

```bash
INKOS_MAX_OUTPUT_TOKENS_PER_CALL=8192
```

放大制作（更长单集、更多镜头、更长对白）无需任何配置即可受益——只要模型卡片声明更大的 maxOutput，上限就自动放宽。

## 清理

仓库自带安全清理脚本：

```bash
pnpm clean:dry-run
pnpm clean
pnpm clean:build
```

`pnpm clean` 只删除已知缓存、覆盖率、报告、日志和临时目录；不会删除 `node_modules`、`dist`、`books/`、`.inkos/` 或生产数据。`clean:build` 才会额外删除各包 `dist`；两者都不删除源码或 `node_modules`。

## 项目数据

生产或付费测试项目应位于仓库外，或位于 Git 忽略的隔离目录。清理测试剧情时应同时处理：

- `books/<series-id>`。
- 对应导出文件。
- `.inkos/runtime/llm-calls/<series-id>.jsonl`。
- `story/canon/` 下的结构化设定（`claims.json`、`world_system.json`、`asset_registry.json`、`unclaimed_facts.json`）。
- `story/state/claim_visibility.json` 等状态文件。
- 可能包含剧本上下文的编译缓存。

删除前必须核对绝对路径和项目 ID。删除后的外部测试数据通常不能通过 Git 恢复。

## 旧格式

Episode v2 不继续写旧小说项目。检测到旧 schema、`chapters/` 或旧 runtime 形式时应返回 `UNSUPPORTED_LEGACY_FORMAT`，不能静默迁移或解释。

内部持久化 schema 中尚存的旧字段名只能出现在明确的适配边界。新的 reducer、业务合同和公共交互统一使用 Episode 语义。

## 发布检查

提交前确认：

- README 最新更新只保留最新日期块。
- `docs/releases/release-notes.md` 保留完整历史并追加当天内容。
- 没有构建产物、测试剧情、临时报告或密钥进入提交。
- 全量测试、类型检查、构建、发布清单和 `git diff --check` 通过。
