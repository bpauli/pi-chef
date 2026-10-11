import { createServer } from "node:http";

const textOf = (m) => typeof m.content === "string" ? m.content : (m.content ?? []).map((p) => p.text ?? "").join("");

function nextStep(messages) {
  const users = messages.filter((m) => m.role === "user");
  const steps = textOf(users[0] ?? { content: "" }).split("\n").filter((l) => l.startsWith("STEP ")).map((l) => l.slice(5));
  const done = messages.filter((m) => m.role === "assistant").length;
  const step = steps[done] ?? "say: (script finished)";
  const [verb, ...rest] = step.split(" ");
  const arg = rest.join(" ");
  if (verb === "tool") {
    const [name, ...json] = arg.split(" ");
    return { tool: { name, arguments: json.join(" ") || "{}" } };
  }
  if (verb === "bash:") return { tool: { name: "bash", arguments: JSON.stringify({ command: arg }) } };
  if (verb === "echo-users:") return { text: users.slice(1).map(textOf).join(" | ") || "(no extra user messages)" };
  if (verb === "echo-system:") return { text: messages.filter((m) => m.role === "system").map(textOf).join("\n") || "(no system prompt)" };
  return { text: arg };
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { messages = [], model } = JSON.parse(body || "{}");
    const step = nextStep(messages);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (step.tool) {
      chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: step.tool.name, arguments: step.tool.arguments } }] });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: step.text });
      chunk({}, "stop");
    }
    res.write(`data: ${JSON.stringify({ id: "fake", object: "chat.completion.chunk", created: 0, model, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
server.listen(Number(process.env.FAKE_MODEL_PORT ?? 0), "127.0.0.1", () => console.log(server.address().port));
