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

每集持久化时，未被既有 claim 覆盖的交接知识/状态变化会确定性收集到 `story/canon/unclaimed_facts.json`（幂等，供 `canon refresh` 消费）。卷合同超纲（待写集号超出大纲卷范围）会在写结果中给出非阻断警告，请先运行 `inkos foundation extend` 再继续写作。

## 清理

仓库自带安全清理脚本：

```bash
pnpm clean:dry-run
pnpm clean
pnpm clean:build
```

`clean:build` 会删除各包 `dist`、Vite 缓存、覆盖率、Playwright 报告和已知临时目录，不删除源码或 `node_modules`。

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
