import { saveStoryGraph, StoryGraphSchema } from "@actalk/inkos-core";
import { E2E_PROJECT_ROOT } from "./e2e-root.js";

export const E2E_ROOT = E2E_PROJECT_ROOT;

export const E2E_FLOW_ID = "e2e-flow-demo";

export async function seedFlowGraph(): Promise<void> {
  await saveStoryGraph(E2E_ROOT, E2E_FLOW_ID, StoryGraphSchema.parse({
    schemaVersion: 1, projectId: E2E_FLOW_ID, title: "E2E 流程图样例", variables: [], characters: [],
    nodes: [
      { id: "s", type: "start", title: "开场", choices: [{ id: "a", text: "好", targetNodeId: "g" }, { id: "b", text: "坏", targetNodeId: "x" }] },
      { id: "g", type: "ending", title: "好结局", choices: [] },
      { id: "x", type: "ending", title: "坏结局", choices: [] },
    ],
    endings: [{ id: "e1", nodeId: "g", title: "好", type: "good", description: "" }, { id: "e2", nodeId: "x", title: "坏", type: "bad", description: "" }],
  }));
}
