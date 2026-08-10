import { cjk } from "@streamdown/cjk";
import { math } from "@streamdown/math";
import type { DiagramPlugin } from "streamdown";
import { studioCodePlugin } from "./studio-code-plugin";

type MermaidInstance = ReturnType<DiagramPlugin["getMermaid"]>;
type MermaidConfig = Parameters<MermaidInstance["initialize"]>[0];

let activeConfig: MermaidConfig | undefined;
let loadedInstance: MermaidInstance | undefined;
let instancePromise: Promise<MermaidInstance> | undefined;

function loadMermaid(): Promise<MermaidInstance> {
  instancePromise ??= import("@streamdown/mermaid").then(({ createMermaidPlugin }) => {
    loadedInstance = createMermaidPlugin({ config: activeConfig }).getMermaid();
    return loadedInstance;
  });
  return instancePromise;
}

const lazyMermaid: DiagramPlugin = {
  name: "mermaid",
  type: "diagram",
  language: "mermaid",
  getMermaid: (config) => {
    if (config) activeConfig = config;
    return {
      initialize: (nextConfig) => {
        activeConfig = nextConfig;
        loadedInstance?.initialize(nextConfig);
      },
      render: async (id, source) => {
        const instance = await loadMermaid();
        if (activeConfig) instance.initialize(activeConfig);
        return instance.render(id, source);
      },
    };
  },
};

export const lightweightStreamdownPlugins = { cjk };
export const richStreamdownPlugins = {
  cjk,
  code: studioCodePlugin,
  math,
  mermaid: lazyMermaid,
};
