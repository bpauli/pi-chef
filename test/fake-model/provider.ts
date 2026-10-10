import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function fakeProvider(pi: ExtensionAPI) {
  pi.registerProvider("fake", {
    baseUrl: `http://127.0.0.1:${process.env.FAKE_MODEL_PORT}/v1`,
    apiKey: "fake",
    api: "openai-completions",
    models: [
      {
        id: "scripted",
        name: "Scripted",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
      },
    ],
  });
}
