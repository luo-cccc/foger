<p align="center">
  <img src="assets/logo.svg" width="120" height="120" alt="InkOS Logo">
  <img src="assets/inkos-text.svg" width="240" height="65" alt="InkOS">
</p>

<h1 align="center">Story Creation AI Agent<br><sub>面向长篇小说创作的智能体系统</sub></h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@actalk/inkos"><img src="https://img.shields.io/npm/v/@actalk/inkos.svg?color=cb3837&logo=npm" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL%20v3-blue.svg" alt="License: AGPL-3.0"></a>
  <a href="https://github.com/Narcooo/inkos/stargazers"><img src="https://img.shields.io/github/stars/Narcooo/inkos?style=flat&logo=github&color=yellow" alt="GitHub stars"></a>
  <a href="https://www.npmjs.com/package/@actalk/inkos"><img src="https://img.shields.io/npm/dm/@actalk/inkos?color=cb3837&logo=npm&label=downloads" alt="npm downloads"></a>
</p>

<p align="left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://kimi-file.moonshot.cn/prod-chat-kimi/kfs/4/1/2026-06-05/1d8h69mt3v89kkekg24gg">
    <img alt="Kimi Open Source Friends" width="420" src="https://kimi-file.moonshot.cn/prod-chat-kimi/kfs/4/1/2026-06-05/1d8h69fudcmosb3pipls0">
  </picture>
  <br>
  🎉🎉 InkOS 入选首批 KIMI 开源合作伙伴 🎉🎉
</p>

<p align="center">
  <a href="README.en.md">English</a> | 中文
</p>

<p align="center">
  <strong>InkOS 网页版上线！</strong>
  <a href="https://huohuaapi.com/apps">立刻体验</a>
</p>

---

InkOS 是一个面向长篇小说创作的 AI Agent 系统：从创作简报建书到卷纲规划、章节写作、审稿修订，支持续写已有作品。提供 Studio、TUI、CLI 三种交互形式，把创意、设定、角色、记忆、审稿、修订交给智能体统一管理，让长篇小说能持续生产、持续修改。

> 💡 **写小说，先给 Agent 接一层专业数据** —— 写小说不只缺模型，更缺素材。推荐搭配 [**火花数据API（huohuaapi）**](https://huohuaapi.com/)：按调用计费的小说 / 网文创作数据，让 Agent 动笔前先查小说正文、章节结构、人物设定、文风和创作方法等带来源素材，而不是只靠 Prompt 硬凑一份“剧情提纲”。

## 当前重点：长篇创作工作台

InkOS 现在聚焦长篇小说创作：Studio Chat 可以围绕建书、章节导入、续写、章节修订和项目文件编辑协作；重操作会走确认卡，避免误触发写入。

- **文件 / 图片附件**：Chat 支持上传文本、Markdown 和图片。文本会进入 LLM 上下文；图片会作为多模态输入传给支持视觉的模型。
- **章节导入**：可把已有小说正文或章节目录导入为真实章节，并自动逆向生成基础设定和运行状态，便于继续续写。
- **中断长任务**：Chat 运行中的长任务可以主动停止，避免模型或上游卡住时只能刷新页面。
- **旧章修订更可控**：在 Chat 里要求“重写 / 重修 / 调整方向”时，本轮对话会作为一次性修订 brief 传给 reviser；如果修订未落盘，系统会显示具体判定指标和剩余问题。

当前完成质量边界：本地章节生产、结构化状态、章节/工作流事务恢复和 1852 个确定性测试已经达到稳定可用基线；隔离 Studio E2E 完整套件为 8/8，preparing/committed 两个真实子进程强杀/重启 recovery 场景合并连续运行 5 轮共 10/10。`pnpm stress:process` 已通过 8 worker、400 次竞争 mutation 和 30 轮真实强杀恢复，`pnpm release` 全绿。Studio、CLI、Chat 与 sub-agent 的已知写入旁路、revise mode 校验、恢复前置和跨进程配置写入均已收敛。详细矩阵见[当前架构与开发优先级](docs/current-architecture-and-priorities.md#11-实际完成度与质量矩阵)。

## 核心特性

当前 InkOS 将 LLM 配置分成两条清晰路径：**Studio 用可视化服务配置**，**CLI / daemon / 部署环境支持 env 覆盖**。两者不会互相污染。

#### 方式一：Studio 服务配置（推荐）

适合本地写作、Web 工作台和可视化管理。

```bash
inkos init my-novel
cd my-novel
inkos
```

打开 Studio 后进入「模型配置」：

1. 选择服务商，例如 Google Gemini、Moonshot、MiniMax、智谱、百炼或自定义端点。
2. 粘贴 API Key，点击「测试连接」。
3. 选择可用模型，保存配置。
4. 回到书籍页面开始写作。

Studio 运行时只使用：

```text
provider bank 默认值
→ inkos.json 里的 services / 当前 service / defaultModel
→ .inkos/secrets.json 里的 service API Key
```

即使检测到 `~/.inkos/.env` 或项目 `.env`，Studio 也只会展示提示，不会用 env 覆盖 service、model、baseUrl 或 API Key。API Key 存在项目内的 `.inkos/secrets.json`，不会写进 `inkos.json`。

#### 方式二：CLI / daemon / 部署环境的 env 配置

适合终端批处理、服务器部署、CI、Docker、守护进程和一次性切模型。

全局 env：

```bash
inkos config set-global \
  --provider <openai|anthropic|custom> \
  --base-url <API 地址> \
  --api-key <你的 API Key> \
  --model <模型名>
```

也可以手动写 `~/.inkos/.env` 或项目 `.env`：

```bash
INKOS_LLM_PROVIDER=custom
INKOS_LLM_BASE_URL=https://api.moonshot.cn/v1
INKOS_LLM_API_KEY=sk-...
INKOS_LLM_MODEL=kimi-k2.5

# 可选
INKOS_LLM_SERVICE=moonshot                         # 推荐写；不写时会尽量从 baseUrl 自动识别
INKOS_LLM_TEMPERATURE=0.7
INKOS_LLM_THINKING_BUDGET=0
INKOS_DEFAULT_LANGUAGE=zh
INKOS_LLM_EXTRA_top_p=0.9
```

CLI 合成顺序：

```text
Studio/project service 配置
→ .inkos/secrets.json service key
→ global ~/.inkos/.env
→ project .env
→ 当前进程环境变量
→ CLI 参数
```

也就是说，CLI 默认可以复用 Studio 配好的服务和密钥；如果 env 里声明了 `INKOS_LLM_SERVICE`、`INKOS_LLM_MODEL`、`INKOS_LLM_BASE_URL` 或 `INKOS_LLM_API_KEY`，则作为覆盖层生效。旧 env 只写 `baseUrl + model + apiKey` 也能继续用，InkOS 会尽量从 baseUrl 反推 service。

一次性指定服务或模型：

```bash
inkos write next --service google --model gemini-2.5-flash
inkos write next --service moonshot --model kimi-k2.5 --no-stream
inkos agent "继续写下一章" --api-key-env MOONSHOT_API_KEY
inkos doctor --service minimaxCodingPlan --model MiniMax-M2.7
```

`--service` 会从 provider bank 自动推导 baseUrl、协议和兼容策略；`--model` 必须属于最终 service，否则会直接报错，避免把 Kimi 模型发到 Gemini 这类错配问题。

#### 方式三：多模型路由（可选）

给不同 Agent 分配不同模型，按需平衡质量与成本：

```bash
# 给不同 agent 配不同模型/提供商
inkos config set-model writer <model> --provider <provider> --base-url <url> --api-key-env <ENV_VAR>
inkos config set-model auditor <model> --provider <provider>
inkos config show-models        # 查看当前路由
```

未单独配置的 Agent 自动使用全局模型。

#### 配置排查

```bash
inkos doctor
```

`doctor` 会显示当前 effective config mode、service/model/API Key 来源，并尝试 API 连通性。常见模式：


| 模式               | 含义                                        |
| ---------------- | ----------------------------------------- |
| `studio-project` | Studio 运行时：只使用 Studio/project 配置和 secrets |
| `cli-project`    | CLI 运行时：以 Studio 配置为基础，再叠加 env 和 CLI 参数   |
| `legacy-env`     | 旧 env 模式：兼容老项目的纯 `.env` 配置                |


如果服务测试失败，优先检查服务商、模型和协议是否匹配。Google Gemini 的 AI Studio API Key 可用于 Gemini OpenAI-compatible endpoint；InkOS 会自动禁用 Google 不支持的 OpenAI `store` 参数。MiniMax 默认走官方 OpenAI-compatible `/v1/chat/completions`，并优先使用可工作的非流式 transport，避免流式返回 usage 但无正文的问题；`MiniMax-M3*` 会默认关闭 thinking 返回，M2.x thinking 由上游限制无法关闭。

### LLM 配置更新

- **Studio / CLI 配置隔离**：Studio 固定使用服务页配置和 `.inkos/secrets.json`；CLI、daemon、部署环境支持 env 覆盖和一次性命令参数。
- **Provider bank 能力表**：内置 Google Gemini、Moonshot、MiniMax、智谱、百炼、DeepSeek、硅基流动、火山、腾讯混元、文心、讯飞星火、OpenRouter、kkaiapi、Ollama、CodingPlan 等服务的 baseUrl、协议、模型和兼容策略。
- **模型归属校验**：`--service google --model kimi-k2.5` 这类错配会直接报错，避免把请求发到错误服务商。
- **Google Gemini 兼容修复**：AI Studio API Key 可直接用于 Gemini OpenAI-compatible endpoint，InkOS 会自动禁用 Google 不支持的 OpenAI `store` 参数。
- **MiniMax transport 探测**：MiniMax / MiniMax CodingPlan 使用官方 OpenAI-compatible `/v1` 入口，并自动使用可工作的非流式 transport，规避流式 usage 正常但正文为空的问题。
- **旧 env 兼容**：老的 `INKOS_LLM_BASE_URL + INKOS_LLM_MODEL + INKOS_LLM_API_KEY` 仍可用于 CLI；没有 `INKOS_LLM_SERVICE` 时会尝试从 baseUrl 反推服务商。

### 当前交互入口

**Studio Chat + CLI + TUI 共用同一套执行面**

- **Studio Chat**：讨论、建书、编辑持久化文件都从同一个对话入口发起；重动作会先展示确认卡。
- **开始创作入口**：长篇小说、续写创作可以从 Studio 顶部入口进入。
- **TUI 仪表盘**：`inkos tui` 进入终端全屏交互，适合键盘流用户。
- **外部 Agent 入口**：`inkos interact --json --message "..."` 是给外部 agent 和脚本使用的结构化入口。
- **原子命令保留**：`plan` / `compose` / `draft` / `audit` / `revise` / `write next` 仍适合脚本和高级用户。

### 写第一本书

```bash
inkos book create --title "吞天魔帝" --genre xuanhuan  # 创建新书
inkos write next 吞天魔帝      # 写下一章（草稿 → 审计 → 按配置修订）
inkos status                   # 查看状态
inkos review list 吞天魔帝     # 审阅草稿
inkos review approve-all 吞天魔帝  # 批量通过
inkos export 吞天魔帝          # 导出全书
inkos export 吞天魔帝 --format epub  # 导出 EPUB（手机/Kindle 阅读）
```

### 多维度审计 + 去 AI 味

连续性审计员从 37 个维度检查每一章草稿：角色记忆、物资连续性、伏笔回收、大纲偏离、叙事节奏、情感弧线等。内置 AI 痕迹检测维度，自动识别"LLM 味"表达（高频词、句式单调、过度总结）。默认长篇写作链路最多自动修订一次；如果你更看重自动闭环，可以通过 `writing.reviewRetries` 调整修订轮数。

去 AI 味规则内置于写手 agent 的 prompt 层——词汇疲劳词表、禁用句式、文风指纹注入，从源头减少 AI 生成痕迹。`revise --mode anti-detect` 可对已有章节做专门的反检测改写。

### 创作简报

`inkos book create --brief my-ideas.md` 传入你的脑洞、世界观设定、人设文档。建筑师 agent 会基于简报生成故事设定（`story_bible.md`）和创作规则（`book_rules.md`），而非凭空创作；同时把简报落盘到 `story/author_intent.md`，让这本书的长期创作意图不会只在建书时生效一次。

### 输入治理控制面

每本书现在都有两份长期可编辑的 Markdown 控制文档：

- `story/author_intent.md`：这本书长期想成为什么
- `story/current_focus.md`：最近 1-3 章要把注意力拉回哪里

写作前可以先跑：

```bash
inkos plan chapter 吞天魔帝 --context "本章先把注意力拉回师徒矛盾"
inkos compose chapter 吞天魔帝
```

这会生成 `story/runtime/chapter-XXXX.intent.md`、`context.json`、`rule-stack.yaml`、`trace.json`。其中 `intent.md` 给人看，其他文件给系统执行和调试。`plan` 会调用 LLM 生成章节意图；`compose` 只编译本地文档和状态，可在没配好 API Key 前先验证控制输入。

### 字数治理

`draft`、`write next`、`revise` 现在共享同一套保守型字数治理：

- `--words` 指定的是目标字数，系统会自动推导一个允许区间，不承诺逐字精确命中
- 中文默认按 `zh_chars` 计数，英文默认按 `en_words` 计数
- 如果正文超出允许区间，InkOS 最多只会追加 1 次纠偏归一化（压缩或补足），不会直接硬截断正文
- 如果 1 次纠偏后仍然超出 hard range，章节照常保存，但会在结果和 chapter index 里留下长度 warning / telemetry

### 续写已有作品

`inkos import chapters` 从已有小说文本导入章节，自动重建结构化状态、章节摘要、伏笔、角色关系和可读 Markdown 投影，支持 `第X章` 和自定义分割模式、断点续导。导入后 `inkos write next` 可继续创作。

### 多模型路由

不同 Agent 可以走不同模型和 Provider。写手用 Claude（创意强），审计用 GPT-4o（便宜快速）。`inkos config set-model` 按 agent 粒度配置，未配置的自动回退全局模型。

### 守护进程 + 通知推送

`inkos up` 启动后台循环自动写章。管线会自动推进可处理的非关键问题；需要人工判断的问题会暂停并留下可审结果。通知推送支持 Telegram、飞书、企业微信、Webhook（HMAC-SHA256 签名 + 事件过滤）。日志写入 `inkos.log`（JSON Lines），`-q` 静默模式。

### 本地模型兼容

支持任何 OpenAI 兼容接口（Studio 里新增自定义服务，或 CLI 使用 `--provider custom` / `INKOS_LLM_PROVIDER=custom`）。服务测试会尝试不同协议和流式开关组合，并保存或提示可用 transport。Fallback 解析器处理小模型不规范输出，流中断时自动恢复部分内容。

### 可靠性保障

每章自动创建状态快照，`inkos write rewrite` 可回滚任意章节。写手动笔前输出自检表（上下文、资源、伏笔、风险），写完输出结算表，审计员交叉验证。书籍写入和项目配置使用跨进程文件锁串行化；章节产物与 plan/compose/audit/consolidate 多文件输出使用事务 marker、备份、原子替换和失败恢复，避免正文、索引、truth 或 runtime/summary 只写入一部分。写后验证器含跨章重复检测和十余条硬规则自动 spot-fix。

Studio 默认只监听 `127.0.0.1`，不启用通配 CORS；服务密钥只返回“是否已配置”，不会把原始 API Key 回传给前端。需要局域网访问时必须显式设置 `INKOS_STUDIO_HOST`，并自行补充适合部署环境的认证边界。

伏笔系统使用 Zod schema 校验——`lastAdvancedChapter` 必须是整数，`status` 只能是 open/progressing/deferred/resolved。LLM 输出的 JSON delta 在写入前经过 `applyRuntimeStateDelta` 做 immutable 更新 + `validateRuntimeState` 结构校验。坏数据直接拒绝，不会滚雪球。

模型输出上限由 provider bank 的模型卡管理；`llm.extra` / `INKOS_LLM_EXTRA_*` 中的保留键（max_tokens、temperature、model、messages、stream 等）会被自动过滤，防止意外覆盖核心请求参数。

---

## 工作原理

InkOS 的长篇生产线负责生成可交付文本，各 agent 共享模型配置、Studio Chat、确认动作和产物预览。

<p align="center">
  <img src="assets/arch-system.svg" width="900" alt="InkOS 整体系统架构">
</p>

长篇每一章默认按“规划 → 编排 → 写作 → 审计 → 必要修订 → 状态同步”运行：

<p align="center">
  <img src="assets/arch-pipeline.svg" width="900" alt="InkOS 章节生产管线">
</p>


| Agent               | 职责                                                                |
| ------------------- | ----------------------------------------------------------------- |
| **规划师 Planner**     | 读取作者意图 + 当前焦点 + 记忆检索结果，产出本章意图（must-keep / must-avoid）             |
| **编排师 Composer**    | 从结构化状态、控制文档和 Markdown 投影中按任务选择上下文，编译规则栈和运行时产物                     |
| **建筑师 Architect**   | 建书或导入时生成基础设定：故事框架、规则、角色与长期控制文件                              |
| **写手 Writer**       | 基于编排后的精简上下文生成正文（字数治理 + 对话引导）                                      |
| **观察者 Observer**    | 从正文中过度提取 9 类事实（角色、位置、资源、关系、情感、信息、伏笔、时间、物理状态）                      |
| **反射器 Reflector**   | 输出 JSON delta（而非全量 markdown），由代码层做 Zod schema 校验后 immutable 写入    |
| **归一化器 Normalizer** | 仅在正文明显偏离 hard range 时单 pass 压缩/扩展                                 |
| **连续性审计员 Auditor**  | 对照结构化状态、控制文档和章节上下文验证草稿，执行连续性与质量检查                                 |
| **修订者 Reviser**     | 修复审计发现的关键问题；默认最多自动修订一次，可通过 `writing.reviewRetries` 调整，其他问题标记给人工审核 |


如果审计不通过，默认管线只做一次"修订 → 再审计"；仍未解决的问题会保留在结果和状态里，交给人工或后续命令继续处理。需要更强自动闭环时，可以运行 `inkos config set writing.reviewRetries 3` 把修订轮数调高。

### 长期记忆

每本书的权威记忆由三层组成：


| 层                    | 用途                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `story/state/*.json` | 权威结构化状态：当前状态、伏笔、章节摘要等，经过 Zod schema 校验                                                      |
| `story/*.md`         | 人类可读投影：`current_state.md`、`pending_hooks.md`、`chapter_summaries.md`、`character_matrix.md` 等 |
| `story/memory.db`    | Node 22+ 自动启用的 SQLite 时序记忆库，用于相关事实、伏笔和摘要检索                                                  |


连续性审计员对照这些状态检查每一章草稿。如果角色"记起"了从未亲眼见过的事，或者拿出了两章前已经丢失的武器，审计员会捕捉到。

Settler 不再要求模型输出完整 markdown 文件，而是输出 JSON delta，由代码层做 immutable apply + 结构校验后写入。Markdown 文件保留为人类可读投影。旧书首次运行时会从 legacy Markdown 自动迁移到结构化 JSON。

Node 22+ 环境下自动启用 SQLite 时序记忆数据库（`story/memory.db`），支持按相关性检索历史事实、伏笔和章节摘要，避免全量注入导致的上下文膨胀。

<p align="center">
  <img src="assets/arch-memory.svg" width="900" alt="InkOS 长期记忆与状态">
</p>

### 控制面与运行时产物

除了运行时状态，InkOS 还把“护栏”和“自定义”拆成可审阅的控制层：

- `story/author_intent.md`：长期作者意图
- `story/current_focus.md`：当前阶段的关注点
- `story/runtime/chapter-XXXX.intent.md`：本章目标、保留项、避免项、冲突处理
- `story/runtime/chapter-XXXX.context.json`：本章实际选入的上下文
- `story/runtime/chapter-XXXX.rule-stack.yaml`：本章的优先级层和覆盖关系
- `story/runtime/chapter-XXXX.trace.json`：本章输入编译轨迹

这样 `brief`、卷纲、书级规则、当前任务不再混成一坨 prompt，而是先编译，再写作。

### 创作规则体系

写手 agent 内置 ~25 条通用创作规则（人物塑造、叙事技法、逻辑自洽、语言约束、去 AI 味），适用于所有题材。

在此基础上，每个题材有专属规则（禁忌、语言约束、节奏、审计维度），每本书有独立的 `book_rules.md`（主角人设、数值上限、自定义禁令）、`story_bible.md`（世界观设定）、`author_intent.md`（长期方向）和 `current_focus.md`（近期关注点）。`volume_outline.md` 仍然是默认规划，但在 v2 输入治理模式下不再天然压过当前任务意图。

## 使用模式

InkOS 提供三种交互方式，主要 Studio/CLI 写作路径共享同一组 core 操作；仍在收敛的旁路见架构审查文档：

### 1. 完整管线（一键式）

```bash
inkos write next 吞天魔帝          # 写草稿 → 审计 → 按配置自动修订
inkos write next 吞天魔帝 --count 5 # 连续写 5 章
```

`write next` 现在默认走 `plan -> compose -> write` 的输入治理链路，审计后的自动修订轮数默认是 1。若你需要回退到旧的 prompt 拼装路径，可在 `inkos.json` 中显式设置：

```json
{
  "inputGovernanceMode": "legacy"
}
```

默认值为 `v2`。`legacy` 仅作为显式 fallback 保留。

### 2. 原子命令（可组合，适合外部 Agent 调用）

```bash
inkos plan chapter 吞天魔帝 --context "本章重点写师徒矛盾" --json
inkos compose chapter 吞天魔帝 --json
inkos draft 吞天魔帝 --context "本章重点写师徒矛盾" --json
inkos audit 吞天魔帝 31 --json
inkos revise 吞天魔帝 31 --json
```

每个命令独立执行单一操作，`--json` 输出结构化数据。`plan` / `compose` 负责控制输入，`draft` / `audit` / `revise` 负责正文与质量链路。可被外部 AI Agent 通过 `exec` 调用，也可用于脚本编排。

### 3. 自然语言 Agent 模式

```bash
inkos agent "帮我写一本都市修仙，主角是个程序员"
inkos agent "写下一章，重点写师徒矛盾"
```

Agent 模式暴露的是按场景收窄后的工具集：建书、读写控制面、规划、编排、写作、审稿、修订等能力会按当前 session 类型开放。推荐的 Agent 工作流是：先调整控制面，再 `plan` / `compose`，最后决定写草稿还是跑完整管线。

## Studio 实测截图

<p align="center">
  <img src="assets/studio-dashboard.png" width="760" alt="InkOS Studio 开始创作入口">
</p>

Studio 工作台本地实测截图。

## 命令参考


| 命令                                          | 说明                                                                                         |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `inkos init [name]`                         | 初始化项目（省略 name 在当前目录初始化）                                                                    |
| `inkos book create`                         | 创建新书（`--genre`、`--platform`、`--chapter-words`、`--target-chapters`、`--brief <file>` 传入创作简报） |
| `inkos book update [id]`                    | 修改书设置（`--chapter-words`、`--target-chapters`、`--status`）                                    |
| `inkos book list`                           | 列出所有书籍                                                                                     |
| `inkos book delete <id>`                    | 删除书籍及全部数据（`--force` 跳过确认）                                                                  |
| `inkos genre list/show/copy/create`         | 查看、复制、创建题材                                                                                 |
| `inkos plan chapter [id]`                   | 生成下一章的 `intent.md`（`--context` / `--context-file` 传入当前指令）                                  |
| `inkos compose chapter [id]`                | 生成下一章的 `context.json`、`rule-stack.yaml`、`trace.json`                                       |
| `inkos write next [id]`                     | 完整管线写下一章（`--words` 覆盖字数，`--count` 连写，`-q` 静默模式）                                            |
| `inkos write rewrite [id] <n>`              | 重写第 N 章（恢复状态快照，`--force` 跳过确认，`--words` 覆盖字数）                                              |
| `inkos draft [id]`                          | 只写草稿（`--words` 覆盖字数，`-q` 静默模式）                                                             |
| `inkos audit [id] [n]`                      | 审计指定章节                                                                                     |
| `inkos revise [id] [n]`                     | 修订指定章节                                                                                     |
| `inkos agent <instruction>`                 | 自然语言 Agent 模式                                                                              |
| `inkos review list [id]`                    | 审阅草稿                                                                                       |
| `inkos review approve-all [id]`             | 批量通过                                                                                       |
| `inkos status [id]`                         | 项目状态                                                                                       |
| `inkos export [id]`                         | 导出书籍（`--format txt/md/epub`、`--output <path>`、`--approved-only`）                           |
| `inkos eval [id]`                           | 生成质量评估报告（支持 `--json`、章节范围）                                                                 |
| `inkos consolidate [id]`                    | 归并长篇章节摘要，降低长书上下文压力                                                                         |
| `inkos interact`                            | 外部 agent / CLI 自然语言入口（`--json`、`--message`、`--book`）                                       |
| `inkos config set-global`                   | 设置 CLI / daemon / 部署环境的全局 LLM env（`~/.inkos/.env`）                                         |
| `inkos config show-global`                  | 查看全局配置                                                                                     |
| `inkos config set/show`                     | 查看/更新项目配置                                                                                  |
| `inkos config set-model <agent> <model>`    | 为指定 agent 设置模型覆盖（`--base-url`、`--provider`、`--api-key-env` 支持多 Provider 路由）                |
| `inkos config remove-model <agent>`         | 移除 agent 模型覆盖（回退到默认）                                                                       |
| `inkos config show-models`                  | 查看当前模型路由                                                                                   |
| `inkos doctor`                              | 诊断配置问题（显示 effective config mode、来源、API 连通性和提供商兼容性提示）                                       |
| `inkos detect [id] [n]`                     | AIGC 检测（`--all` 全部章节，`--stats` 统计）                                                         |
| `inkos import canon [id] --from <parent>`   | 导入正传正典到番外书                                                                                 |
| `inkos import chapters [id] --from <path>`  | 导入已有章节续写（`--split`、`--resume-from`）                                                        |
| `inkos analytics [id]` / `inkos stats [id]` | 书籍数据分析（审计通过率、高频问题、章节排名、token 用量）                                                           |
| `inkos update`                              | 更新到最新版本                                                                                    |
| `inkos studio` / `inkos`                    | 启动 Web 工作台（`-p` 指定端口，默认 4567；Studio 使用服务页配置，不使用 env 覆盖）                                    |
| `inkos tui`                                 | 启动终端全屏 TUI                                                                                 |
| `inkos up / down`                           | 启动/停止守护进程（`-q` 静默模式，自动写入 `inkos.log`）                                                      |


`[id]` 参数在项目只有一本书时可省略，自动检测。所有命令支持 `--json` 输出结构化数据。`draft` / `write next` / `plan chapter` / `compose chapter` 支持 `--context` 传入创作指导，`--words` 覆盖每章目标字数。`book create` 支持 `--brief <file>` 传入创作简报（你的脑洞/设定文档），Architect 会基于此生成设定而非凭空创作。`plan chapter` 会调用 LLM 生成章节意图；`compose chapter` 不要求在线 LLM，可在配置 API Key 之前先检查输入治理结果。

CLI 运行时还支持一次性 LLM 覆盖参数：`--service`、`--model`、`--api-key-env`、`--base-url`、`--api-format <chat|responses>`、`--stream`、`--no-stream`。例如：

```bash
inkos write next --service google --model gemini-2.5-flash
inkos up --service moonshot --model kimi-k2.5 --api-key-env MOONSHOT_API_KEY
```

## 开发与设计文档

- [开发文档索引](docs/README.md)
- [当前架构与开发优先级](docs/current-architecture-and-priorities.md)
- [设定治理与卷级闭环设计](docs/canon-governance-volume-closure-design.md)
- [真实 LLM 测试方法与阶段记录](docs/live-llm-testing-and-next-goals.md)

## 路线图

当前开发顺序以[当前架构与开发优先级](docs/current-architecture-and-priorities.md)为准：

- **P0（已完成）**：统一 core mutation、章节/工作流恢复、跨进程配置锁、真实强杀 E2E 和进程压力基准。
- **P1（当前）**：建立真实多章质量报告和 token/context 预算；按业务域拆分 Studio server 与 PipelineRunner；继续按需加载 Mermaid、Shiki 和 WASM 重依赖。
- **P2**：局部章节重写、自定义 agent/plugin 合同、起点/番茄等平台格式导出。

当前不计划迁移微服务或远程数据库；本地优先的文件系统、结构化 truth 和 SQLite 记忆仍是默认架构。

## 参与贡献

欢迎贡献代码。提 issue 或 PR。

```bash
pnpm install
pnpm dev          # 监听模式
pnpm test         # 运行测试
pnpm typecheck    # 类型检查
```

## Star History

<a href="https://www.star-history.com/#Narcooo/inkos&type=date&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=Narcooo/inkos&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=Narcooo/inkos&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=Narcooo/inkos&type=date&legend=top-left" />
 </picture>
</a>


## Repobeats

![Repobeats analytics image](https://repobeats.axiom.co/api/embed/024114415c1505a8c27fb121e3b392524e48f583.svg)

## Contributors

<a href="https://github.com/Narcooo/inkos/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=Narcooo/inkos" alt="Contributors" />
</a>

## 致谢

InkOS 的 agent 运行时构建在 [pi](https://github.com/badlogic/pi-mono)（`@mariozechner/pi-ai` 与 `@mariozechner/pi-agent-core`，作者 Mario Zechner）之上。感谢 pi 提供的扎实底座。

本开源项目已链接并认可 [LINUX DO](https://linux.do/) 社区，感谢社区成员的反馈、测试与讨论。

## 许可证

[AGPL-3.0](LICENSE)
