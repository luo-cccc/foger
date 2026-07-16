# InkOS 开发文档索引

本文档目录按“当前基线、专项设计、测试记录”分层，避免设计规范和按日期追加的实验日志互相覆盖。

## 当前基线

- [当前架构与开发优先级](current-architecture-and-priorities.md)：当前实现边界、主工作流、持久化与并发模型、性能判断、全项目自洽审查、技术债和开发顺序。涉及架构决策或排期时，以此文档为准。

截至 2026-07-16，真实 DeepSeek 20 章 linked acceptance 已连续持久化 15 章；第 16 章因 resync 输出把标准伏笔编号与展示标题混成 ID 而未提交。规范化修复和 2067 项离线门禁已完成，当前唯一的真实主链路目标是从干净隔离项目重新完成 20/20 章，并验证 truth、快照、Doctor 和报告终态一致。详细数据见测试记录的 8.23-8.24。

## 专项设计

- [设定治理与卷级闭环](canon-governance-volume-closure-design.md)：CanonClaim、章级 claim、卷级合同、Hook 门禁和多模型治理协议。该文档描述专项协议，不再承担全项目路线图职责。

## 测试与实验记录

- [真实 LLM 测试方法与阶段记录](live-llm-testing-and-next-goals.md)：真实 provider、双 API 路由、多章连载、Studio 前后端复测和状态健康检查。该文档中的历史 P0/P1 记录不覆盖当前开发优先级。

## 文档维护规则

1. README 只保留产品定位、安装、使用方式和简要路线图。
2. 当前架构变化必须同步更新 `current-architecture-and-priorities.md`。
3. 专项设计文档描述稳定协议；按日期产生的测试数据写入测试记录。
4. 已完成事项应从当前优先级移入“已落地能力”或历史记录，不在多个位置重复列为待办。
5. 文档中的验证结果必须注明日期和命令，不能把单元测试通过表述为真实 LLM 质量已经得到证明。
6. 最新精确测试计数只在 `current-architecture-and-priorities.md` 的“当前验证基线”维护；README 和专项设计只引用能力边界或保留明确标注日期的历史快照。
7. 被外部中断的 live report 只能作为中间证据；最终章节状态以 `chapters/index.json`、结构化 truth、快照和运行时 telemetry 交叉判定。

## 工程维护入口

- 日常开发与验证规则见根目录 `CONTRIBUTING.md`。
- 脚本职责、真实 provider 测试和清理命令见[脚本索引](../scripts/README.md)。
- `pnpm clean` 只清理临时项目、报告、日志和缓存；`pnpm clean:build` 才会额外删除可再生成的 `dist`。
