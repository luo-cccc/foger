# InkOS 工具代码全量审查报告（不动用技能）

- 审查日期：2026-08-11
- 审查对象：本轮生产暴露问题修复的全部工具代码改动（9 文件 +295/-11 行 + 新测试）
- 审查方式：diff 全量逐文件 + 调用点完整性 + 边界/错误处理/行为改变 + 三包构建与测试
- 结论：**3 个真实问题已在本轮修复，无遗留阻断**

---

## 一、审查发现并修复的问题

| # | 问题 | 位置 | 影响 | 修复 |
|---|---|---|---|---|
| 1 | **early-hook 门禁只接入 write 路径** | `runner.ts` 的 `writeNextEpisodeLocked` | `inkos audit`/`inkos revise` 独立审计不触发提前揭晓警告，工具行为不一致 | `auditDraft` 确定性审计处补接入（读 pending_hooks.md + `auditEarlyHookPayoff`） |
| 2 | **write sync 描述过时** | `cli/commands/write.ts` sync 命令 description 仍写 "from the latest edited episode body" | 行为已改为以 .json 权威重投影，帮助文本误导 | 更新为 "from the authoritative episode JSON (re-projected into markdown)" |
| 3 | **HANDOFF_PROP_WORDS 正则重复项** | `episode-quality-gate.ts` 实物词表含两个"镜" | 冗余无功能影响，但属编码瑕疵 | 去重 |

## 二、逐文件审查结论（通过项）

| 文件 | 审查结论 |
|---|---|
| `composer.ts` author_intent 截断 | ✓ 只对 author_intent 截断（3000 字符），不误伤其他 stable source；CJK 1 字符≈1 token，3000 字符留足余量 |
| `episode-script.ts` stripMarkedPreamble | ✓ 标记正则 `[A-Z_]+` 只匹配大写英文标记（PRE_WRITE_CHECK/EPISODE_SCRIPT_JSON），不会误匹配散文中的小写 `===`；`sliceStart` 从标记行尾后开始找 `{`，正确处理"散文+标记+JSON" |
| `writer-parser.ts` 守卫 | ✓ 保留裸散文快速失败（EPISODE_SCRIPT_REQUIRED，不浪费重生轮次），有标记才包 WRITER_OUTPUT_PARSE_FAILED code + rawOutput 触发 runner 重生/dump——行为与既有测试语义一致 |
| `post-write-validator.ts` 后缀归一化 | ✓ 仅在**新标题为裸标题**时应用（`bareBase === normalized`），新生成的"X：限定词"不会被误判为既有裸 X 的变体而拒绝——避免生成器死锁 |
| `series-completion.ts` 宽松判定 | ✓ `episodeTextSurface` 对 `scenes ?? []` 防御；`hookSeemsPaidOff` 只取 `「」`/`""` 引用词（避免通配误判）；降级后 message 明确提示"请人工对账台账"，不静默放行 |
| `episode-quality-gate.ts` handoff 检查 | ✓ 收紧为 physical 桶前 4 项 + 实物词 + 排除负向/认知/关系状态，噪声 82→16；`isScreenableHandoffFact` 长度上下限防边界 |
| `episode-quality-gate.ts` early-hook | ✓ warning 级不阻断；`parseEpisodeNumber` 对"第29集"/"29"/"ep 3"通用；关键词只取 `「」`/`""` 引用 + 实物后缀词，避免高频词误报 |
| `runner.ts` 标题去重同步 | ✓ 去重后同步 `episodeScript.title` + 重渲染 md + 重建 handoff capsule——JSON/md/index 三轨一致 |
| `runner.ts` initBook authorIntent | ✓ 移除 `?? effectiveExternalContext`，占位符兜底；brief 仍单独写 `brief.md`（planner semantic 层） |
| `runner.ts` sync 权威源 | ✓ 优先 .json → `renderEpisodeScriptMarkdown`，无 .json 回退 md；行为与既有 sync 的"重放确定性"路径兼容 |
| `cli/write.ts` rewrite 提示 | ✓ `loadEpisodeIndex` 后计算后续集数并显示范围（`episode+1–episode+laterCount`）；`--force` 跳过 |

## 三、行为改变清单（有意为之）

1. 无 authorIntent 时 `author_intent.md` 为占位符而非完整 brief（修复预算超限）
2. sync 以 .json 为权威（脚本改 JSON 后 md 自动重投影）
3. 标题去重后脚本 title 同步更新（不再出现 index 与 md 标题不一致）
4. 完本门禁对"final 集已兑现但台账未 resolve"的 hook 降级 warning + 提示对账（不再静默或硬拒）

## 四、验证结果

| 项目 | 结果 |
|---|---|
| `pnpm check:hygiene` | 通过 |
| core typecheck + build | 通过 |
| core 全量测试 | 147 文件 / 1437 通过 |
| CLI build + 测试 | 214 通过（1 失败确认为 `~/.inkos/.env` 全局配置污染，移开即 51/51 全过，与改动无关） |
| Studio typecheck | 通过 |
| 生产数据冒烟 | `series complete` 通过、交付物重导（8972s） |

## 五、遗留（非阻断）

- `cli-integration.test.ts` 的 `show-models` 用例在开发者本机 `~/.inkos/.env` 存在时失败（测试假设无全局配置）——测试环境隔离问题，非本次改动引入
- early-hook 关键词启发式（`「」`引用 + 实物后缀）对"同名不同物"存在理论误报可能，但为 warning 级不阻断，且倾向放行合法铺垫
