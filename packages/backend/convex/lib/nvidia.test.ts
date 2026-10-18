import { afterEach, describe, expect, it, vi } from "vitest";
import { NvidiaError, isNvidiaKey, nvidiaChat } from "./nvidia";

afterEach(() => vi.unstubAllGlobals());

describe("NVIDIA-hosted model for the Nudge assistant", () => {
  it("runs the tool loop over the OpenAI-compatible API and returns the final text", async () => {
    const calls: { url: string; body: { model: string; tools: { function: { name: string } }[]; messages: { role: string }[] } }[] = [];
    const replies = [
      { choices: [{ message: { content: null, tool_calls: [{ id: "c1", function: { name: "get_overview", arguments: "{}" } }] } }] },
      { choices: [{ message: { content: "You have ₹22,907 safe to spend." } }] },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: { body: string; headers: Record<string, string> }) => {
        calls.push({ url, body: JSON.parse(init.body) });
        expect(init.headers.authorization).toBe("Bearer nvapi-test-key-0123456789abcdef");
        return new Response(JSON.stringify(replies.shift()), { status: 200 });
      }),
    );
    const ran: string[] = [];
    const text = await nvidiaChat({
      apiKey: "nvapi-test-key-0123456789abcdef",
      system: "You are Nudge.",
      history: [{ role: "user", text: "How much can I spend?" }],
      tools: [{ name: "get_overview", description: "Money overview", input_schema: { type: "object", properties: {} } }],
      maxSteps: 4,
      runTool: async (name) => {
        ran.push(name);
        return { content: '{"safeToSpend":"₹22,907"}', isError: false };
      },
    });
    expect(text).toBe("You have ₹22,907 safe to spend.");
    expect(ran).toEqual(["get_overview"]);
    expect(calls[0]!.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(calls[0]!.body.model).toBe("meta/llama-3.3-70b-instruct");
    expect(calls[0]!.body.tools[0]!.function.name).toBe("get_overview");
    // The tool result went back to the model on the second call.
    expect(calls[1]!.body.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  });

  it("reports an API error so the assistant falls back to the basic replies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    await expect(
      nvidiaChat({ apiKey: "nvapi-bad-key-0123456789abcdef0", system: "s", history: [{ role: "user", text: "hi" }], tools: [], maxSteps: 2, runTool: async () => ({ content: "", isError: false }) }),
    ).rejects.toBeInstanceOf(NvidiaError);
  });

  it("recognises NVIDIA keys", () => {
    expect(isNvidiaKey("nvapi-abcdefghijklmnopqrstuvwxyz012345")).toBe(true);
    expect(isNvidiaKey("sk-ant-abcdefghijklmnopqrstuvwxyz")).toBe(false);
  });
});
