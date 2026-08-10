import { describe, expect, it } from "vitest";
import {
  compileEpisodeExecutionContract,
  renderEpisodeExecutionContract,
} from "../utils/episode-execution-contract.js";

describe("episode execution contract", () => {
  it("compiles the raw memo into a compact, stable downstream contract", () => {
    const memo = {
      episode: 3,
      goal: "锁定十三号塔的短期调查目标",
      isGoldenOpening: false,
      body: [
        "## 当前任务",
        "林澈进入十三号塔寻找物理证据。",
        "## 该兑现的 / 暂不掀的",
        "- 该兑现：H001（广播来源）→ 确认广播由十三号塔发出",
        "- 暂不掀：H002（老莫是否为回声体）→ 留到第4章",
        "## 章尾必须发生的改变",
        "- 林澈拿到发射记录并锁定下一步目标。",
        "## 本章 hook 账",
        "advance:",
        "- H001 “广播来源” → 确认塔内发射痕迹",
        "defer:",
        "- H002 “老莫是否为回声体” → 本章不动",
        "## 卷级 KR 绑定",
        "- V1-KR1 → 从信号溯源推进到名单破解",
        "## 不要做",
        "- 不要揭示完整名单。",
      ].join("\n"),
      threadRefs: ["H001", "H002"],
      volumeKrRefs: ["V1-KR1"],
      volumeKrRationale: "推进名单破解",
    };

    const first = compileEpisodeExecutionContract(memo);
    const second = compileEpisodeExecutionContract(memo);
    const rendered = renderEpisodeExecutionContract(first, "zh");

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.mustLand.map((item) => item.kind)).toEqual([
      "current-task",
      "payoff",
      "end-change",
    ]);
    expect(first.mustAvoid.map((item) => item.kind)).toEqual([
      "keep-buried",
      "do-not",
    ]);
    expect(first.hookActions).toEqual([
      expect.objectContaining({ hookId: "H001", action: "advance" }),
    ]);
    expect(first.deferredHooks).toEqual([
      expect.objectContaining({ hookId: "H002" }),
    ]);
    expect(rendered).toContain(first.fingerprint);
    expect(rendered).toContain("V1-KR1 → 从信号溯源推进到名单破解");
    expect(rendered).not.toContain("## 读者此刻在等什么");
  });

  it("passes the episode causal, payoff and handoff sections to the writer", () => {
    const memo = {
      episode: 4,
      goal: "拿到出口钥匙",
      isGoldenOpening: false,
      body: [
        "## 当前任务\n主角必须在封锁前夺取出口钥匙并带证人离开。",
        "## 本集爽点\n主角当众拆穿守卫的谎言并抢回主动权。",
        "## 进入状态\n主角受伤，证人被扣押，守卫掌握唯一出口。",
        "## 当前目标\n主角要拿到钥匙，封锁即将落下所以必须现在行动。",
        "## 反对力量\n守卫要销毁证据，筹码是出口和证人的性命。",
        "## 因果升级\n因为证人指出暗号，主角选择夺钥匙，守卫反制并引爆警报，出口状态改变并制造追兵压力。",
        "## 关系压力\n证人不再信任主角，主角必须用行动证明不会抛下她。",
        "## 方向性转折\n主角从逃跑转为保护证人。",
        "## 反转铺垫\n钥匙上的血迹证明守卫才是内鬼。",
        "## 本集反转\n守卫并非阻拦者，而是在拖延真正的追兵。",
        "## 反转后果\n主角错失逃生窗口并欠下守卫一条命。",
        "## 当集兑现\n主角拿到钥匙并救出证人，但失去安全路线。",
        "## 出去压力\n追兵即将从地下通道包围他们，因为警报已被触发。",
        "## 结尾交接状态\n证人获救，主角持钥匙，守卫身份翻转，三人被追兵逼入地下通道。",
        "## 信息权限\n观众知道守卫的真实目的，主角只怀疑，证人仍误信守卫。",
        "## 情绪钩子\n证人会不会在地下通道发现主角也隐瞒了真相？",
        "## 结尾状态\n关系从互不信任变成被迫共同行动。",
        "## 本集 Hook ledger\nopen:\n- H009 追兵来源\n\n## 不要做\n- 不要揭示真正雇主。",
      ].join("\n"),
      threadRefs: [],
    };
    const rendered = renderEpisodeExecutionContract(compileEpisodeExecutionContract(memo), "zh");
    expect(rendered).toContain("因果升级");
    expect(rendered).toContain("当集兑现");
    expect(rendered).toContain("出去压力");
    expect(rendered).toContain("信息权限");
  });
});
