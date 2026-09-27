import { createExtensionRuntime, type ResourceLoader } from "@earendil-works/pi-coding-agent";

/** Explicit resources only: no discovery, packages, extensions, or host instructions. */
export function createIsolatedResources(systemPrompt: string): ResourceLoader {
  const runtime = createExtensionRuntime();
  return {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {
      throw new Error("Resource extension is disabled.");
    },
    reload: async () => {},
  };
}
