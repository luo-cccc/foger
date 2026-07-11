# InkOS 开发文档索引

本文档目录按“当前基线、专项设计、测试记录”分层，避免设计规范和按日期追加的实验日志互相覆盖。

## 当前基线

- [当前架构与开发优先级](current-architecture-and-priorities.md)：当前实现边界、主工作流、持久化与并发模型、性能判断、全项目自洽审查、技术债和开发顺序。涉及架构决策或排期时，以此文档为准。

## 专项设计

- [设定治理与卷级闭环](canon-governance-volume-closure-design.md)：CanonClaim、章级 claim、卷级合同、Hook 门禁和多模型治理协议。该文档描述专项协议，不再承担全项目路线图职责。

## 测试与实验记录

- [真实 LLM 测试方法与阶段记录](live-llm-testing-and-next-goals.md)：真实 provider、双 API 路由、多章连载和状态健康检查。该文档中的历史 P0/P1 记录不覆盖当前开发优先级。

## 文档维护规则

1. README 只保留产品定位、安装、使用方式和简要路线图。
2. 当前架构变化必须同步更新 `current-architecture-and-priorities.md`。
3. 专项设计文档描述稳定协议；按日期产生的测试数据写入测试记录。
4. 已完成事项应从当前优先级移入“已落地能力”或历史记录，不在多个位置重复列为待办。
5. 文档中的验证结果必须注明日期和命令，不能把单元测试通过表述为真实 LLM 质量已经得到证明。

## 工程维护入口

- 日常开发与验证规则见根目录 `CONTRIBUTING.md`。
- 脚本职责、真实 provider 测试和清理命令见[脚本索引](../scripts/README.md)。
- `pnpm clean` 只清理临时项目、报告、日志和缓存；`pnpm clean:build` 才会额外删除可再生成的 `dist`。
