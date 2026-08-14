# 运行与维护

## 环境与密钥

- Node.js 20 或更高版本。
- pnpm 9 或更高版本。
- 模型密钥通过环境变量、全局配置密钥文件或 Studio 本地密钥存储提供。

不要把真实密钥写入 `inkos.json`、`.env.example`、源码、剧本、日志、报告或提交历史。真实模型运行前先确认 Provider、模型、输出上限和预算。

## 日常生产

自动审查模式：

```bash
inkos write next <book-id>
inkos review list <book-id>
inkos review approve <book-id> <episode>
```

自动模式在审查通过后提交真相并进入 `ready-for-review`，可继续下一集；审批仍是默认交付和完本的必要条件。

手动审查模式：

```bash
inkos config set writing.reviewMode manual
inkos write next <book-id>                # 结果为 drafted
inkos audit <book-id> <episode>           # 通过后为 ready-for-review
inkos review approve <book-id> <episode>  # 批准后才能继续
```

人工编辑剧本后，正文会进入需要重新审查的状态。不要直接修改 `episodes/index.json`、`story/state/`、`story/runtime/` 或快照来伪造通过结果。

## 状态处理

| 最新集状态 | 处理方式 |
| --- | --- |
| `drafted` | 运行 `inkos audit <book-id> <episode>` |
| `ready-for-review` | 手动模式执行 approve/reject；自动模式可继续，交付前仍需 approve |
| `audit-failed` | 运行 `inkos revise`、`write rewrite`，或修正权威 JSON 后重新审计 |
| `state-degraded` | 优先运行 `inkos write repair-state <book-id> <episode>`；人工改过 JSON 时使用 `write sync` |
| `rejected` | 重写或移除该集；较早集拒绝会要求处理所有后续依赖 |

恢复命令：

```bash
# 从权威 Episode JSON 重建 Markdown、真相和派生索引
inkos write sync <book-id> <episode>

# 不改正文，只修复该集状态派生物
inkos write repair-state <book-id> <episode>

# 重写某集；默认处理所有后续依赖
inkos write rewrite <book-id> <episode>
```

不要使用 `--keep-subsequent` 保留已经依赖被改写正文的后续集；Core 会拒绝已存在依赖集的危险保留请求。

## 审批、导出与完本

批准要求剧集为 `ready-for-review`、Episode JSON 合法，且当前 JSON 哈希与 `PROVISIONAL` 审查证据一致。`approve-all` 只处理满足条件的待审剧集，不包含 `audit-failed`。

```bash
inkos review list <book-id>
inkos review approve <book-id> <episode>
inkos review approve-all <book-id>
inkos review reject <book-id> <episode>
```

默认导出要求每一集均为 `approved/published`：

```bash
inkos export <book-id> --format screenplay-md
inkos export <book-id> --format screenplay-json
inkos export <book-id> --format dialogue

# 明确导出已批准子集
inkos export <book-id> --format screenplay-md --approved-only
```

`inkos series complete <book-id>` 同样要求全部剧集已批准或发布，并通过终局冲突、人物弧线、Hook 和关系收束检查。

## Canon 与卷计划

```bash
# 扩展 volume_map，保留 story_frame、roles、规则和 Hook
inkos foundation extend <book-id> --episodes <n>

# 将未认领事实裁决为已有 claim、变体、新资产或 unresolved
inkos canon refresh <book-id>
```

未认领事实达到配置阈值时，`plan episode` 和 `write next` 会返回 `CANON_REFRESH_REQUIRED`。刷新后应人工审阅新增 claims；系统不会自动把 Writer 临时发明的设定写成权威事实。

## 内容门禁

- 情绪钩子必须是关于关系、危险、身份、牺牲或选择的具体观众疑问。
- 禁止发布的敏感内容在 Writer 边界阻断，不依赖事后审查兜底。
- Hook 提前回收只按 `targetPayoffEpisode` 与完整 `payoffEvidence` 判断。
- Warning-only 审查不触发自动整集修订；critical 或硬性长度问题才进入自动修复。
- Episode v2 执行结构化剧本门禁；遗留 prose 才执行完整小说散文规则。

## 验证

提交前优先运行完整离线门禁：

```bash
pnpm verify
git diff --check
```

`pnpm verify` 包含代码卫生、类型检查、语义审计、污染审计、构建、Studio bundle 检查、全部测试和发布清单检查。

分包测试：

```bash
pnpm --filter @actalk/inkos-core test
pnpm --filter @actalk/inkos test
pnpm --filter @actalk/inkos-studio test
```

涉及锁、事务标记、恢复或进程生命周期时，额外运行：

```bash
pnpm stress:process
```

真实 Provider 测试是手工验收，不属于普通单元测试。原始输出放在 Git 忽略的隔离目录；长期结论写入 `docs/releases/release-notes.md`。

## 污染防护

`pnpm audit:contamination` 扫描生产源码、测试、提示词、题材配置、脚本和规范文档，拒绝付费生产项目专名进入 Agent 会读取的上下文。

- 付费生产数据和原始报告不得提交到源码树。
- 回归测试必须使用中性虚构名和最小必要剧情。
- 新付费运行产生的专名登记到 `scripts/audit-contamination.mjs`，同时保证这些名字不进入被扫描文件。
- 更新历史可以记录长期结论，但不要粘贴完整剧本、密钥、绝对生产路径或大段模型原始输出。

## 清理与项目数据

```bash
pnpm clean:dry-run
pnpm clean
pnpm clean:build
```

- `clean` 删除已知缓存、覆盖率、报告、日志和临时项目。
- `clean:build` 额外删除包内 `dist`。
- 清理脚本不会删除 `node_modules`、`books/`、`.inkos/` 或生产数据。

生产与付费测试项目应位于仓库外，或位于明确的 Git 忽略隔离目录。人工删除数据前必须核对绝对路径、项目 ID、导出目录、遥测、Canon 和状态缓存；外部生产数据通常无法通过 Git 恢复。

## 旧格式与发布

Episode v2 不继续写旧小说项目。检测到旧 schema、`chapters/` 或旧 runtime 时应返回 `UNSUPPORTED_LEGACY_FORMAT`，不能静默迁移。

发布前确认：

- README 只保留最新日期块，中英文内容同步。
- 架构和运维文档描述当前行为，历史变化进入 release notes。
- 没有构建产物、生产剧情、临时报告、绝对生产路径或密钥进入提交。
- `pnpm verify` 与 `git diff --check` 通过。
