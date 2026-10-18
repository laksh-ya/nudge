/**
 * NVIDIA-hosted models (NIM) for the Nudge assistant. NVIDIA serves an OpenAI-compatible chat API
 * with function calling, so this is a small loop over fetch: no extra SDK. The key is the owner's
 * own (nvapi-…, sealed like an Anthropic key) or the deployment's NVIDIA_API_KEY.
 */

export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
/** The model the "NVIDIA" choice uses unless the deployment sets NVIDIA_MODEL. */
export const NVIDIA_DEFAULT_MODEL = "meta/llama-3.3-70b-instruct";

export const isNvidiaKey = (k: string) => /^nvapi-[A-Za-z0-9_-]{20,200}$/.test(k);

type Tool = { name: string; description?: string; input_schema: unknown };
type Msg =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

export class NvidiaError extends Error {
  constructor(
    public status: number | "network",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Run the tool loop on an NVIDIA model. `runTool` executes one tool and returns its JSON (or throws);
 * the loop feeds results back until the model answers in text or `maxSteps` runs out.
 */
export async function nvidiaChat(opts: {
  apiKey: string;
  model?: string;
  system: string;
  history: { role: "user" | "assistant"; text: string }[];
  tools: Tool[];
  maxSteps: number;
  runTool: (name: string, input: Record<string, unknown>) => Promise<{ content: string; isError: boolean }>;
}): Promise<string> {
  const messages: Msg[] = [{ role: "system", content: opts.system }];
  for (const m of opts.history) {
    const last = messages[messages.length - 1];
    if (last && last.role === m.role && typeof last.content === "string") last.content += `\n${m.text}`;
    else messages.push({ role: m.role, content: m.text });
  }
  const tools = opts.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description ?? "", parameters: t.input_schema } }));
  const base = (process.env.NVIDIA_BASE_URL ?? NVIDIA_BASE_URL).replace(/\/+$/, "");
  const model = opts.model ?? process.env.NVIDIA_MODEL ?? NVIDIA_DEFAULT_MODEL;
  let reply = "";
  for (let step = 0; step < opts.maxSteps; step++) {
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.apiKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.2, max_tokens: 1500 }),
      });
    } catch (e) {
      throw new NvidiaError("network", e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) throw new NvidiaError(res.status, (await res.text().catch(() => "")).slice(0, 300));
    const body = (await res.json()) as { choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[] };
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new NvidiaError(res.status, "empty response");
    reply = (msg.content ?? "").trim();
    const calls = msg.tool_calls ?? [];
    if (!calls.length) break;
    messages.push({ role: "assistant", content: msg.content ?? null, tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })) });
    for (const c of calls) {
      let input: Record<string, unknown> = {};
      try {
        input = c.function.arguments ? (JSON.parse(c.function.arguments) as Record<string, unknown>) : {};
      } catch {
        messages.push({ role: "tool", tool_call_id: c.id, content: "Error: arguments were not valid JSON" });
        continue;
      }
      const out = await opts.runTool(c.function.name, input);
      messages.push({ role: "tool", tool_call_id: c.id, content: out.isError ? `Error: ${out.content}` : out.content });
    }
  }
  return reply;
}
