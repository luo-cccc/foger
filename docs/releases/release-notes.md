# InkOS 更新记录

### 2026-08-13（跨集凑时长重复检测）

- **补上 screenplay 下缺失的跨集重复门禁**：旧的 `detectCrossEpisodeRepetition` 只跑在自由文本分支（`creative.episodeScript ? [] : [...]`），分镜格式下整条被短路——放大制作时模型会复用上一集的镜头写法/舞台调度来凑时长，且无任何确定性拦截。新增 `auditCrossEpisodeShotRepeat`（`episode-quality-gate.ts`），用两个确定性信号检测：① 镜头表面短语跨集重复（zh 6-gram / en 3-word）；② 行为签名 Jaccard 重合（从镜头 action/visual 抽取动作词，≥60% 重合即报）。warning 级、reviewed_invariant，接入 `auditEpisodeScript` 的新可选 `recentScripts` 参数，runner 的 4 个审计点（standalone audit、revise 门禁合并、review 循环、write 落盘）统一传入最近 3 集。
- 验证：core 148 文件 1453 测试全绿（新增跨集重复 4 项单元测试）。

### 2026-08-13（max-tokens 提升：跟随模型能力）

- **创作输出上限从 8192 提升到 32768**：writer（分镜主写 + 解析失败修复）、reviser（整集重写）和 canon-extractor 的 per-call `maxTokens` 从硬编码 8192 改为 `min(安全上限 32768, 模型卡片 maxOutput)`——deepseek-v4-flash 等大模型（maxOutput 393216）用满 32768 上限，小模型自动回落到自身 maxOutput，不会触发 API 的 max_tokens 超限错误。放大制作（更长单集、更多镜头、更长对白）不再被输出长度截断。`INKOS_MAX_OUTPUT_TOKENS_PER_CALL` 仍可对整体输出做上限收紧。
- 验证：core 148 文件 1449 测试全绿（新增 writer"大模型用满上限/小模型回落"测试，更新 canon-extractor 断言）。

### 2026-08-13（生产工具去污染 + 模板感收敛 + 题材去模板化 + 污染守卫）

- **生产工具去污染（书剧情硬编码清零）**：清掉所有从真实付费测试书渗入生产源码的剧情细节——runner 审计归一化删除基于单本书情节的 critical 降级分支（角色/道具/地点专名，重名会误降级）；episode-quality-gate 的 hook noise 集与功能性角色豁免表删除书内专名（伏笔/编制/人名），角色豁免统一由词根规则覆盖；architect / planner 提示词示例改为题材中立（不再示范某本书的宗门/皮草剧情）；Studio 建书表单占位符去掉书剧情示例；删除两个引用旧小说 API、已无法运行的 live 死脚本。同时给建书提示词补**世界命名硬约束**：必须给世界起与标题/设定派生的专名，禁止"XX界/XX大陆/XX域"占位命名，brief 指定世界名必须沿用，确立后全剧不得改名。
- **模板感收敛**：writer 提示词新增「节拍变奏」规则（慢热/过渡/后效/布局集允许反转槽位替换为压力停滞+新威胁、情绪问题允许低音量、一集只改一个状态维度、时长允许落在软区间任意位置不硬凑、爽点类型与最近几集轮换），对抗"开场钩子→升级→反转→情绪问题"的每集同构曲线；新增标题句式结构轮换检测（连续 3 集共用"X的Y"/双字句式壳自动从正文换新意象改名）。
- **题材去模板化**：15 个题材的疲劳词表全部唯一——中文题材删除通用 AI 词尾（仿佛/不禁/宛如/竟然），由 auditor 硬编码词表作为唯一权威；英文 10 题材不再共用同一份英文 AI 味词表，按题材拆分专属词。爽点池全部扩到 8-10 类（原 6 类在 100 集尺度必然重复）。auditDimensions 题材差异化：romantasy/cozy/horror 补关系动态/读者期待等专用维度（唯一配置 5→8 套）。新增 `genre-config.test.ts` 五项防复发（通用词不得泄漏进题材、疲劳词全唯一、审计维度差异化、爽点池 ≥8）。
- **污染守卫**：新增 `scripts/audit-contamination.mjs`，拒绝测试夹具/付费书专名进入生产源码与提示词（角色/门派/地名/书名显式词表），接入 `pnpm verify` 作为强制门禁；所有历史污染均可追溯到"付费书剧情→回归测试夹具→抄入生产代码"同一条链，守卫注释记录该路径，词表作为新付费书角色的活档案维护。
- **验证**：core 148 文件 1448 测试全绿（新增 genre-config 5 项 + detectTitleShapeRepeat 4 项 + writer 节拍变奏断言），typecheck / hygiene / 污染守卫 / 语义审计全部通过。

### 2026-08-11（150 秒时长改造 + 六项生产修复 + 20 集复跑验证）

- **单集时长 2-3 分钟制**：默认目标从 90 秒改为 150 秒（`EPISODE_DURATION_TARGET_SECONDS`），软区间为目标 ±30 秒（默认 120-180），硬区间 90-210；建书 schema、CLI 默认值、Studio 建书表单、writer/reviser/auditor 提示词、时长归一化与容量估算全部同步。镜头数上限从硬约束 12 改为随目标时长动态预算的**软上限**（`episodeShotBudget`，150 秒约 8-20 个），超上限由审计报 `screenplay-shot-count` warning（craft_default），只保留下限硬约束。
- **六项生产修复**（源自首轮 20 集真实付费测试报告）：① revise 择优改严重度加权（critical×10+warning），strict 接受条件允许"critical 减少、warning 略增"的候选收敛；② 伏笔台账解析识别 advance 段内 bare `→ resolve` 终态标记（`resolved?` 正则），重分类为 resolve 指令，修复伏笔 payoff 集状态不翻转；③ 审稿输出解析失败自动重试一次并合并 token 用量；④ approve/approve-all 前校验运行时状态一致性（新错误码 `RUNTIME_STATE_INCONSISTENT`），状态漂移错误信息附带 `write sync` / `repair-state` 修复指引；⑤ planner memo 新增 `validateMemoInternalConsistency` 确定性自检，"当前任务 vs 不要做"概念重叠报非阻断 warning；⑥ revise 落盘同步重写 JSON 侧车，修复 md 投影与 JSON 字段不一致（丢问号）问题。
- **复跑发现的残留修复**：写路径 `hardLengthPassed` 仍用字面量 60-120 判定，147 秒剧集被误判 audit-failed，已改为引用硬区间常量；`BookConfigSchema.episodeDurationSeconds` 上限从 120 同步为 210（4 处），否则默认 150 秒建书直接被 schema 拒绝。
- **writer 解析失败再加固**：writer 内部修复重试失败后，runner 从零重新生成一次；最终失败把原始输出留存到 `story/runtime/episode-XXXX-writer-raw-fail.txt` 并在错误信息附路径，失败 attempt 的 token 并入该集用量；解析失败错误携带稳定机器码 `WRITER_OUTPUT_PARSE_FAILED` 与 `rawOutput`。
- **配置可诊断性**：`ProjectConfigSchema` 校验失败的 llm 字段错误改写为可执行提示，说明配置来源（configSource=studio 时 inkos.json 端点被接管）并指向 `INKOS_LLM_BASE_URL` 等环境变量与 `inkos config set-global`。
- **复跑验证**（`docs/测试报告-子夜当铺-20集复跑-150秒改造验证.md`）：同一创意、同一模型（deepseek-v4-flash）20 集复跑——20/20 initial-passed、零 revise、零内容人工干预、完本门禁一次通过（首测需人工对账 6 条伏笔），单集时长 147-154 秒、镜头 10-19 个，总 token 456,650（时长 +67% 而 token 低于首测），生产耗时约为首测 1/3。验证：core 1425 / cli 215 / studio 420 测试全绿，`pnpm verify` 全链路通过。

### 2026-08-10（drama-skills 改造复审缺口修复）

- 对照改造方案逐项复审 P0–P2 落地质量后修复四个缺口，core 146 个测试文件 1410 通过，`pnpm verify` 全量通过。
- P0-4（关键）：改写回归检查表此前只在局部补丁（changeKind=patch）路径触发，方案认定的真正缺口——完整改写回退路径——没有任何回归保障。现在 rewrite 与 patch 一样携带 verificationIssues 进入修订复核，复核提示词按修订方式区分措辞（改写前草稿 / 补丁前草稿），并要求整集改写时与 finding 无关的内容逐字保留；同时豁免"确定性门禁干净即跳过 LLM 复核"的短路——门禁看不见 Hook 落点丢失，带复核请求的修订候选必须到达回归检查表。
- P2-4：英文建书提示词补前提装置契约段（能力范围、失效条件、可见代价、规则可靠性），此前只有中文版有而 foundation-reviewer 双语都查，产销不一致；补双语结构断言测试。
- P0-2：补齐 planner/canon 类 finding 的反馈回路。审查循环停在 `requires-upstream-revision` 时，上游 finding 持久化到 `story/runtime/upstream-revision-feedback.json`（新模块 `pipeline/upstream-revision-feedback.ts`），下一次对同集的 `inkos plan episode` 把它渲染进 memo 请求（"上次审查的上游修订要求"段，双语），规划成功后清除；问题若仍存在，下一轮审查会重新记录。
- P2-3：canon refresh 现在会清理未认领事实池——已决（reuse/new_variant/new_asset）事实移出，只有 unresolved 或模型未裁决的事实保留待下集，避免已入库事实每次刷新重复提交；逐字匹配兜底，裁决措辞有出入时只可能多留、不会误删。

### 2026-08-10（drama-skills 借鉴改造 P1–P2）

- 按 `docs/ref/inkos-drama-skills-改造方案.md` 完成 Writer/Reviser 工艺深化（P1）与 Planner/系统层（P2）全部条目，zh/en 提示词双份同步，`pnpm verify` 全量通过，20 集零失败基线不变。
- P1-1 Writer 对白纪律新增"对白手法的失效条件"段（dialogue-craft 反向条件表）：潜台词、打断、沉默、先承认一部分、借第三人施压各配失效条件，craft_default 语气，不进确定性门禁。
- P1-2 SCR-09 长发言断开：Writer 纪律明确长发言只在议程转折处用动作行断开、无内部转折应缩短；确定性门禁新增 `long-speech-without-action`（同一说话人单镜头合计 >160 字且镜头无 action 字段时报 craft_default 警告，不阻断），原单句 >80 字规则保留。
- P1-3 Reviser 提示词按 script-craft §9 组织为"一遍只解决一种失败"：多 finding 按 因果→场景运动→可表演性→对白→生产事实→交接 顺序逐个处理，FIXED_ISSUES 声明每处修改解决的 finding；局部修订的保留保证由确定性 patch 应用器与修订复核承担。
- P1-4 Auditor 新增交换说话者思想实验（dialogue-craft §10.5）：交换后台词仍成立记 warning 并指明缺目标差/关系差/认知差；独白、宣告、仪式性对话豁免。
- P2-1 新增确定性容量可行性估算模块 `episode-capacity-estimate.ts`（STY-16，episode-design §9.4）：从本书已接受集采样"每镜头平均承载字数/秒数"，把 memo 体量换算成镜头数与时长，只在 ≥2 倍量级偏差时输出非阻断提示（基准不足 3 集跳过）；接入 `inkos plan episode` 输出，并附 memo 承诺节拍数（场景意图+因果链）辅助度量。
- P2-2 升级判据（STY-03，episode-design §5.3）：Planner memo"因果升级"段要求相邻两拍间筹码/知识/关系边界/退路/不可撤回决定/威胁变现实至少一项可引用变化；Auditor 判停滞前必须核对上述状态维度，无一变化才可记 finding。
- P2-3 canon 刷新改两段式（借 short-drama-assets）：occurrence 段保持剧本原始表述与证据集号、含混指代标 unresolved 不猜；decision 段只给 reuse / new_variant / new_asset / unresolved 四结论，服装、伤势、临时状态只能 new_variant；unresolved 留在 unclaimed_facts 不阻断。
- P2-4 前提装置约束（premise-devices）：brief 含重生/预知/系统/金手指类装置时，architect 要求 story_frame 显式记录装置契约（能力范围、失效条件、可见代价、规则可靠性），foundation-reviewer 对缺失给非阻断工艺建议。

### 2026-08-10（cli 构建测试债清理）

- 修复 cli/studio 长期编译失败与 56 个测试失败的根因：内部依赖声明为纯语义版本（`"@actalk/inkos-core": "1.6.3"`），pnpm 9/10 不再自动链接语义版本的 workspace 包，安装时从 registry 拉到 Episode v2 迁移前的旧版 1.6.3 实体副本，导致 cli/studio 对着过期 `.d.ts` 类型检查与运行。内部依赖改为 `workspace:*`（cli→core/studio、studio→core），重新安装后恢复符号链接，约 130 个编译错误全部归零。
- 发布校验脚本语义对齐：`verify-no-workspace-protocol.mjs` 从"源清单禁止 workspace 协议"改为"workspace 协议只允许指向本工作区内的包、钉死版本必须归一到当前 workspace 版本"；prepack 的 `prepare-package-for-publish.mjs` 仍在打包前把 `workspace:*` 重写为真实版本号，发布产物不变。
- 发布测试更新：源清单内部依赖断言为 `workspace:*`；拒绝用例改为指向工作区外包的 `workspace:` 引用（不可解析）；钉错内部版本的拒绝用例保持不变。
- 验证：`pnpm verify` 全量通过（hygiene + typecheck + 语义模式审计 + build + studio bundle + core 144 文件 1385 测试 + cli 37 文件 215 测试 + studio 测试 + publish-manifests），cli 从基线 7 个失败文件/56 个失败用例恢复为全绿。
- 包管理器升级到 pnpm 10.34.5 并在根 package.json 加 `packageManager` 字段锁定；pnpm-workspace.yaml 中的 `allowBuilds`/`overrides` 等 pnpm 10 配置项现在被正确读取（esbuild/msw/protobufjs 的 postinstall 正常放行），重装后 `pnpm verify` 再次全量通过。

### 2026-08-10（drama-skills 借鉴改造 P0）

- 借鉴公开短剧技能套件的审查契约完成四项 P0 改造，全部保持双语提示词同步与零失败基线（core 144 个测试文件 1385 通过）。
- Auditor 审计提示词新增 Finding 质量要求段：每条 issue 必须引用具体证据位置（场景/镜头/contract 字段/Hook id），suggestion 只写修订后必须达到的结果、不得代写台词，数量习惯（字数/镜头数/句式）本身不是缺陷，"AI 味"必须定位具体手法并说明损失。
- 审查 finding 新增 owner 路由（`resolveAuditIssueOwner`）：钩子状态矛盾类问题归 planner，不交给修稿环节；剩余阻塞问题全部属于上游负责人时，审查循环以新终止原因 `requires-upstream-revision` 显式停机，避免 writer 在执行层越权改上游决策；canon 负责人集合当前为空、作为预留。
- AI 味确定性检测（段落等长/套话密度/公式化转折/列表式结构）现在报出具体位置：段落编号与长度、套话/转折词的段落定位与原文摘录、连续同前缀句的实际句组，不再只有统计值。
- Auditor 新增模板感诊断规范段：先区分重复手法/套话替代具体内容/无铺垫文句模式三类机制，附误报反例（仪式性重复、running gag、题材固定结构、创伤性动作停滞不得仅凭表面重复判模板），此类 finding 默认 warning 不阻断、只有破坏剧情理解才可标 critical。
- 修订复核（verification）提示词新增改写回归检查表：原文覆盖、镜头目的与 Hook 落点、时长预算、资产与连续性、对白逐字内容、memo 约束逐项确认"保留/丢失/改变"，非预期丢失即 critical 回归；被补丁触及镜头的未关联字段不得漂移。改写后的确定性门禁 `auditEpisodeScript` 已在评估路径逐轮重跑，无需额外接入。

### 2026-08-10

- 完成 100 集真实付费生产测试（《崖山抽卡人》，deepseek-v4-flash）：全流程零失败产出 100 集 ready-for-review 剧本；场景切换（采石→襄阳→临安→厓山→崖山）、气运账本、钩子叙事回收（玉佩/正气歌/崖山遗录）与终局个人闭环全部按卷计划落地，`series complete` 完本门禁通过。
- 修复钩子账本不随计划推进：planner memo 的 advance/resolve/defer 注解在写作、修订与状态重放路径中统一确定性落账（修订/重放不再丢失注解），伏笔健康监控基于真实账本恢复有效；100 集反跑每集 hookActivity 从空变为完整账目，核心钩子按卷计划回收；兼容 `**advance:**` 加粗小节；"已阻 N 章"措辞统一为"已阻 N 集"。
- 修复 Writer 输出解析鲁棒性：解析前剥离 `=== PRE_WRITE_CHECK ===` 等前导区块再提取剧本 JSON（此前 2 次因 `=== PRE_WR...` 前导导致整集失败）；时长越界草稿（低于 60s / 高于 120s）先做确定性镜头时长归一化（单镜头夹 2-45s、结果仍须在硬区间）再判定，减少修复调用与批次中断。
- 角色引用审计降噪：功能性角色标签全面豁免（哨兵、斥候队长、狱卒、火种营亲兵、校尉、探子、都统制等，含任意长度角色词判定）；已出场说话人（更早持久化剧集引入）不再跨集重复告警，只保留首次出现的"发明人名"告警；100 集数据反跑未知角色告警 81→6。
- 修复手动修订门禁：`inkos revise` 重审时合并确定性剧本门禁（情绪钩子、角色引用、时长）与 LLM 审计结果，不再因"无可执行阻断证据"拒绝修订；情绪钩子等单字段 finding 改为局部可修（repairScope=local），reviser 局部补丁可直接改写。
- 标题去重后缀优化：限定词改为全文优先扫描 2 字实词，并加入"时长/计时"类弱词过滤，避免"书生报国：计时长"式生硬片段。
- 修复后真实生产验证：新书《烽燧令》（10 集，架空边关军事）单进程零中断产出，25 次模型调用（约 2.5 次/集），钩子账本全程落账、终局核心钩子全部回收、`series complete` 通过，审计告警密度大幅下降（10 集仅 8 条，其中 6 条为账本恢复后正常出现的伏笔健康提醒）。
- 此前的 20 集付费测试结论（canon 演化、角色引用完整性、卷级 KR 绑定、visible 归因）在 100 集测试中继续成立。

- 完成 20 集真实付费生产测试（《子夜修表匠》，deepseek-v4-flash），全流程零失败产出 20 集 ready-for-review 剧本；canon 随集演化、角色引用完整性审计、卷级 KR 绑定与 visible 归因在真实运行中验证生效。
- 修复镜头数越界时的修复提示：校验错误现在带上实测镜头/场景数量，修复指令明确要求按数量增删镜头（测试中第 7 集复现并修复）。
- 修复剧集索引重复行：读写索引时按集号去重（保留第一条完整记录），杜绝重建/占位行与权威记录并存。
- 修复卷进度 visible 归因：后写门禁不再依赖可能被上下文预算折叠的上下文条目，直接读取权威卷合同文件；planned/visible 归因在真实运行中恢复。
- 生产优化（基于 20 集测试）：timeline-drift 检查改为语义子集判定，消除 carry-forward 合并后的误报；角色引用审计豁免功能性路人标签（陌生女人/路人等），只对正式人名式未知说话人告警；写后确定性时长归一化（镜头秒数按比例收敛到目标，硬区间外不应用）；卷合同超纲时给出覆盖警告并新增 `inkos foundation extend`；canon 未认领事实确定性收集与 `inkos canon refresh` 显式刷新；reviser 新增局部补丁模式（REVISED_PATCH）降低修订成本；标题去重后缀优先取实义词，避免“预计”类弱词。
- 审查修正：角色引用审计对带括号限定语的说话人（顾维远（画外）、姜楠（电话）、旁白（母亲的信）等）先剥离限定语与常见修饰前缀再匹配设定索引，并补充家庭角色与发声设备白名单；真实 20 集数据反跑 findings 从 26 条降到 4 条（timeline-drift 9→0、角色引用 8→0、时长 4→0）。
- 文档整理：README 快速开始补充设定维护命令；architecture 新增生产优化机制说明；operations 补充 foundation extend / canon refresh 用法与 canon/资产数据文件；发布检查与清理指引保持同步。

### 2026-08-09

- EpisodeScript JSON 的导入、手工编辑和模型输出现在统一经过严格解析与结构校验，无法解析的自由文本不会被误存为权威剧本。
- 剧集生产链进一步收敛为 Episode 原生流程，移除不会再执行的小说分析、自由文本润色和模型结算路径，减少额外调用与状态分歧。
- 同一次规划、生成、审计或修订操作共享唯一上下文快照；复用既有单集计划时也会补齐当前规划记忆，避免重复读取和上下文缺项。
- CLI、Studio 与 Core 的剧集字段、提示、诊断、导入导出和旧格式拒绝行为保持一致，旧小说数据不会被静默转换。
- 完成全仓可靠性收口，覆盖 Episode 状态、持久化恢复、审查证据、用户入口和构建发布检查。
- 修复终局集写完后主线 Hook 仍停留在“未回收/待推进”的问题：计划中以「→ resolved / → 已回收」标注的收尾动作现在会被确定性结算正确结清，全剧完本判断不再依赖过期的伏笔状态。
- 恢复单集与卷级关键结果（KR）的绑定与进度归因：每集计划必须声明本集推进的 KR 或写明缓冲/过渡理由，卷进度看板按集归因，不再出现整卷 KR 全空的情况。
- 伏笔池会过滤非 ID 形态的占位文本（例如散文式“这条线索”行），避免被当作真实伏笔写入状态。
- 下一集进入状态自动合并上一集交接事实，跨集连续性边界保持一致，不再出现 incoming 与 handoff 不一致的阻断。
- 审计层术语统一为剧集语义：审计报告类别名与 Auditor 提示词不再混用“章节/章尾”旧措辞，统一为“剧集/集末”，降低模型与报告的语义噪音。
- 审查证据文件支持缺失自愈：当剧集已有审计结果但 `review.json` 缺失或丢失时，系统会从权威剧本 JSON 确定性重建审查证据，且不会覆盖已有文件。
- 卷进度 KR 归因回归验证：完整写流程会记录单集规划绑定的卷级 KR 与正文可见证据，重写同一集时不再清空已记录的可见归因。
- 借鉴公开短剧技能套件强化创作提示词：Writer 加入“对白即行动”与“场景工作卡”（每句对白先有议程、表演提示必须是可执行策略而非情绪词、巧合只能制造压力不能解决困境）；Planner 加入巧合/误会判据、钩子六类型与情绪交接；Auditor 加入对白议程审查与去模板四层诊断（因果/策略/表达重复、代价即时结清）。
- 剧本交接状态新增情绪位（只记录会改变下一步行为的情绪选择）；审查证据记录审查者来源（self_check / independent_agent），存在未关闭阻断问题的剧集不能再被直接批准。
- 提示词全量审阅清理：英文书不再混入中文提示词块（题材/主角/规则/文风指纹全部本地化，补英文全员追踪）；移除一批未使用的旧小说时代提示词函数；消除活提示词中的“章/章尾”旧措辞与跨提示词矛盾（如叙事驱动合同对 rhythm principles 的错误引用）；状态校验提示词与解析协议对齐。
- 设定权威化：canon claim 随剧集确定性演化（事实落进交接/当集兑现/结尾状态时自动结算，信息权限中的角色知晓范围自动合并；零模型调用、幂等、旧书零迁移）；新增角色引用完整性审计（对白说话人与本集目标角色必须能回指 roles/ 或 canon，防剧本发明设定）；新增资产注册表结构（角色外观/道具状态/场景视图），为后续出图出视频预留接缝，本轮不接入生成。
- 全量审查收尾：用户可见面（Chat 快捷指令与提示、TUI 帮助、写作日志、审计纠偏文件、导入回放种子、校验文案）的“章”措辞统一为“集”；架构文档补充设定权威化与资产注册表说明。

### 2026-08-08

- InkOS 从长篇小说生产切换为 Episode v2 漫剧剧本生产系统，默认支持 100 集、单集约 90 秒的完整创作与完本流程。
- 单集使用统一的结构化剧本合同，明确进入状态、人物目标、反对力量、因果升级、局部兑现、出去压力、信息权限和交接状态；JSON 是权威真源，Markdown 是阅读与导出投影。
- Writer 输出限制为 1～3 个场景、6～12 个镜头和 60～120 秒硬时长区间；反转必须有前置证据并产生后果，情绪钩子不能代替本集兑现。
- 增加确定性剧集状态结算、跨集 handoff capsule、证据型审查、源文件哈希失效、性能报告和全剧完本门禁。
- 正常单集生产收敛为 Planner、Writer、Auditor 最多三次模型调用；上下文快照在单次操作内由 Planner、Composer、Writer、Auditor 和 Reviser 共享。
- CLI 与 Studio 更新为剧集语义，支持 100 集建书、逐集规划/编排/生成、全剧状态和完成审计，以及分镜 Markdown、结构化 JSON 和台词表导出。
- 旧小说项目不再迁移或继续写作；检测到旧格式时返回 `UNSUPPORTED_LEGACY_FORMAT`。
- 清理旧长篇架构计划和真实模型测试流水账，文档现在只维护当前漫剧架构、运行方式和发布日期记录。

### 2026-07-26

- 长篇生产提示词统一采用“新颖设定、熟悉爽点、高压关系、因果反转、情绪钩子”的叙事驱动标准，贯通建书、章节规划、正文执行、连续性检查和基础设定审稿。
- 每章按需要选择主要驱动力；反转必须有前置证据并改变后续行动，喘息章可以承接既有反转的代价，不再为了频率机械翻转或无限新增伏笔。
- 新增 `inkos book backup [book-id]`、`--list` 和 `inkos book restore <book-id> <backup-id>`。备份在书籍写锁内生成，临时复制完成并通过 `book.json`、章节索引校验后才会公开。
- 恢复前会自动创建带 `pre-restore` 后缀的整书备份；恢复事务标记存放在书目录外，替换过程中若进程被终止，下一次取得书锁时会自动恢复原目录。恢复已提交但临时清理未完成时保留新版本并继续清理。
- Studio Chat 保存最后一次失败发送的原始文本、附件和动作参数，提供一键重试；重试开始前先消费失败记录，避免连续点击重复发送，用户主动中止不会被误记为失败。
- 修复局部章节 patch 后 `chapters/index.json` 字数未同步的问题，整章替换与局部编辑现在使用同一正文计数规则。
- 修复会话 transcript 以纯工具调用结束时，刷新后工具结果卡可能消失的问题；恢复逻辑会创建独立 assistant 工具消息并保留 thinking、参数、结果和详情。
- 小米 MiMo 默认端点更新为 `https://api.xiaomimimo.com/v1`，并增加 provider 结构回归测试。
- Studio 远程监听改为显式安全配置：非本机地址必须提供长认证令牌、声明 HTTPS 反向代理并限制 HTTPS 来源；支持浏览器 Basic Auth 和脚本 Bearer Token，同时拒绝跨站写请求。
- 新增 `writing.reviewMode`。Studio 日常生产建议使用 `manual`，写完后交由人工审阅；无人值守任务使用 `auto`，继续执行有界自动审校，达到预算或质量门禁时暂停。
- 加强本地凭据与依赖安全：POSIX 系统上的密钥目录和文件采用仅当前用户可访问的权限，生产依赖已消除已知漏洞。
- Studio 的 Markdown 代码高亮语言与 Mermaid 图表改为按需加载，降低首屏资源体积并保留代码、推理过程和摘要渲染能力。

### 2026-07-24

- 无人值守写作改用完整 Cron 计划，固定时刻和复杂计划会按本地时间正确触发；非法计划会在保存配置时被拒绝。
- 停止 daemon 时会取消并等待当前写作任务退出，停止完成前不会启动第二个 daemon；主动停止不会被记录为章节失败。
- 多书无人值守任务会处理全部活跃书籍，同时维持配置的并发上限；每日章节配额会在并发写作开始前预留，并按本地日期统计。
- Studio 快速切换书籍或章节时会取消旧请求，过期响应不会覆盖当前页面的数据。
- 同名书正在创建时，后续创建请求会直接返回进行中状态，避免重复模型调用和状态覆盖。
- 基础设定重修会先在隔离目录完成设定写入与 Canon 抽取，再整体替换线上设定；任一步失败都会保留原设定和原 Canon。
- Studio 端到端测试现在会恢复临时修改的模型服务配置，避免后续写作流程受到前序测试状态影响。
