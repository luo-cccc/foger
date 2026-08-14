import { describe, expect, it } from "vitest";
import {
  renderEpisodeSummariesProjection,
  renderCurrentStateProjection,
  renderHooksProjection,
} from "../state/state-projections.js";

describe("state projections", () => {
  it("renders pending hooks projection with deterministic English ordering", () => {
    const markdown = renderHooksProjection({
      hooks: [
        {
          hookId: "b-courier",
          startEpisode: 12,
          type: "mystery",
          status: "open",
          lastAdvancedEpisode: 13,
          expectedPayoff: "Identify the courier.",
          notes: "The seal is still broken.",
        },
        {
          hookId: "a-debt",
          startEpisode: 4,
          type: "relationship",
          status: "progressing",
          lastAdvancedEpisode: 11,
          expectedPayoff: "Reveal the debt.",
          notes: "Old oath token resurfaces.",
        },
      ],
    }, "en");

    expect(markdown).toBe([
      "# Pending Hooks",
      "",
      "| hook_id | start_episode | type | status | last_advanced_episode | expected_payoff | payoff_timing | depends_on | pays_off_in_arc | core_hook | half_life | promoted | notes |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      "| a-debt | 4 | relationship | progressing | 11 | Reveal the debt. | mid-arc | none |  | false |  |  | Old oath token resurfaces. |",
      "| b-courier | 12 | mystery | open | 13 | Identify the courier. | mid-arc | none |  | false |  |  | The seal is still broken. |",
      "",
    ].join("\n"));
  });

  it("renders episode summaries projection with deterministic Chinese ordering", () => {
    const markdown = renderEpisodeSummariesProjection({
      rows: [
        {
          episodeNumber: 12,
          title: "河埠对账",
          characters: "林己",
          events: "林己核对货单与誓令碎片",
          stateChanges: "师债线索进一步收束",
          hookActivity: "mentor-debt 推进",
          mood: "紧绷",
          episodeType: "主线推进",
        },
        {
          episodeNumber: 11,
          title: "雨巷旧账",
          characters: "林己",
          events: "林己查到旧账册断页",
          stateChanges: "师债线被重新钉牢",
          hookActivity: "mentor-debt 推进",
          mood: "压抑",
          episodeType: "主线推进",
        },
      ],
    }, "zh");

    expect(markdown).toBe([
      "# 剧集摘要",
      "",
      "| 剧集 | 标题 | 出场人物 | 关键事件 | 状态变化 | 伏笔动态 | 情绪基调 | 剧集类型 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
      "| 11 | 雨巷旧账 | 林己 | 林己查到旧账册断页 | 师债线被重新钉牢 | mentor-debt 推进 | 压抑 | 主线推进 |",
      "| 12 | 河埠对账 | 林己 | 林己核对货单与誓令碎片 | 师债线索进一步收束 | mentor-debt 推进 | 紧绷 | 主线推进 |",
      "",
    ].join("\n"));
  });

  it("renders current state projection with placeholders and additional notes", () => {
    const markdown = renderCurrentStateProjection({
      episode: 12,
      facts: [
        {
          subject: "protagonist",
          predicate: "Current Goal",
          object: "Track the mentor debt through the river-port ledger.",
          validFromEpisode: 12,
          validUntilEpisode: null,
          sourceEpisode: 12,
        },
        {
          subject: "protagonist",
          predicate: "Current Conflict",
          object: "Guild pressure keeps pulling against the debt trail.",
          validFromEpisode: 12,
          validUntilEpisode: null,
          sourceEpisode: 12,
        },
        {
          subject: "current_state",
          predicate: "note_1",
          object: "Lin Yue still hides the broken oath token.",
          validFromEpisode: 12,
          validUntilEpisode: null,
          sourceEpisode: 12,
        },
      ],
    }, "en");

    expect(markdown).toBe([
      "# Current State",
      "",
      "| Field | Value |",
      "| --- | --- |",
      "| Current Episode | 12 |",
      "| Current Location | (not set) |",
      "| Protagonist State | (not set) |",
      "| Current Goal | Track the mentor debt through the river-port ledger. |",
      "| Current Constraint | (not set) |",
      "| Current Alliances | (not set) |",
      "| Current Conflict | Guild pressure keeps pulling against the debt trail. |",
      "",
      "## Additional State",
      "- Lin Yue still hides the broken oath token.",
      "",
    ].join("\n"));
  });
});
