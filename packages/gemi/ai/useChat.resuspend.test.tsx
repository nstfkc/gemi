/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { Activity, StrictMode, Suspense, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentStreamFrame } from "./types";
import { useChat, type UseChatResult } from "./useChat";

/**
 * #1391: React runs a component's effect cleanups without unmounting it, keeps
 * its state, and runs the effects again when it shows it. An `<Activity>`
 * hiding the chat does, and so does `<StrictMode>` when a `<Suspense>`
 * boundary that re-suspended shows its content again. Neither may cut a reply
 * that is streaming.
 */

type Api = UseChatResult<never>;

const ANSWER: AgentStreamFrame[] = [
  { seq: 0, event: { type: "run-start", runId: "run_1", threadId: "th_9" } },
  { seq: 1, event: { type: "message-start", messageId: "m1", role: "assistant" } },
  { seq: 2, event: { type: "text-delta", messageId: "m1", delta: "Hi there." } },
  { seq: 3, event: { type: "message-end", messageId: "m1", finishReason: "stop" } },
  { seq: 4, event: { type: "run-end", runId: "run_1", finishReason: "stop" } },
];

function encode(frames: AgentStreamFrame[]) {
  return frames.map((f) => `id: ${f.seq}\ndata: ${JSON.stringify(f.event)}\n\n`).join("");
}

/** A reply the test streams frame by frame; it errors when its request is aborted, as `fetch` does. */
let stream: { push(...frames: AgentStreamFrame[]): void; close(): void };
let signal: AbortSignal | undefined;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const encoder = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    signal = init.signal ?? undefined;
    signal?.addEventListener("abort", () =>
      controller.error(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
    stream = {
      push: (...frames) => controller.enqueue(encoder.encode(encode(frames))),
      close: () => controller.close(),
    };
    return new Response(body, { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function Chat({ box, onFinish }: { box: { api: Api }; onFinish?: () => void }) {
  box.api = (useChat as any)("/chat", { attach: false, onFinish });
  return <p>{box.api.status}</p>;
}

describe("a chat hidden and shown again keeps its reply (#1391)", () => {
  test("a Suspense boundary that re-suspends and reveals, under StrictMode", async () => {
    const box = { api: null as unknown as Api };
    let reveal!: () => void;
    const gate = new Promise<void>((resolve) => (reveal = resolve));
    let revealed = false;
    void gate.then(() => (revealed = true));
    function Lazy() {
      if (!revealed) throw gate;
      return null;
    }
    let suspend!: () => void;
    function View() {
      const [show, setShow] = useState(false);
      suspend = () => setShow(true);
      return (
        <Suspense fallback={<i>loading</i>}>
          <Chat box={box} />
          {show && <Lazy />}
        </Suspense>
      );
    }
    const { container } = render(
      <StrictMode>
        <View />
      </StrictMode>,
    );

    await act(async () => {
      void box.api.sendMessage("hi");
    });
    await act(async () => {
      stream.push(ANSWER[0]!, ANSWER[1]!);
      await settle();
    });
    expect(box.api.status).toBe("streaming");

    // A click that is not a transition: the boundary shows its fallback.
    await act(async () => suspend());
    expect(container.querySelector("i")?.textContent).toBe("loading");
    await act(async () => {
      reveal();
      await gate;
    });
    expect(container.querySelector("i")).toBeNull();
    expect(signal!.aborted).toBe(false);

    await act(async () => {
      stream.push(...ANSWER.slice(2));
      stream.close();
      await settle();
    });
    expect(box.api.status).toBe("idle");
    expect(box.api.error ?? null).toBeNull();
    expect(box.api.messages.at(-1)!.content).toEqual([{ type: "text", text: "Hi there." }]);
    // Sent once: nothing in the hook sends again when its effects run again.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(["/api/chat"]);
  });

  test("an Activity that hides the chat while its reply streams, and shows it", async () => {
    const box = { api: null as unknown as Api };
    const onFinish = vi.fn();
    let setMode!: (mode: "visible" | "hidden") => void;
    function View() {
      const [mode, set] = useState<"visible" | "hidden">("visible");
      setMode = set;
      return (
        <Activity mode={mode}>
          <Chat box={box} onFinish={onFinish} />
        </Activity>
      );
    }
    render(<View />);

    await act(async () => {
      void box.api.sendMessage("hi");
    });
    await act(async () => {
      stream.push(ANSWER[0]!, ANSWER[1]!);
      await settle();
    });
    await act(async () => setMode("hidden"));
    expect(signal!.aborted).toBe(false);

    // The run ends while the chat is hidden.
    await act(async () => {
      stream.push(...ANSWER.slice(2));
      stream.close();
      await settle();
    });
    expect(onFinish).toHaveBeenCalledTimes(1);

    await act(async () => setMode("visible"));
    expect(box.api.status).toBe("idle");
    expect(box.api.messages.at(-1)!.content).toEqual([{ type: "text", text: "Hi there." }]);
  });

  test("hidden past the grace, the request is closed and the chat says so instead of streaming forever", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const box = { api: null as unknown as Api };
    let setMode!: (mode: "visible" | "hidden") => void;
    function View() {
      const [mode, set] = useState<"visible" | "hidden">("visible");
      setMode = set;
      return (
        <Activity mode={mode}>
          <Chat box={box} />
        </Activity>
      );
    }
    render(<View />);

    await act(async () => {
      void box.api.sendMessage("hi");
    });
    await act(async () => {
      stream.push(ANSWER[0]!, ANSWER[1]!);
      await Promise.resolve();
    });
    await act(async () => setMode("hidden"));
    expect(signal!.aborted).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(signal!.aborted).toBe(true);

    await act(async () => setMode("visible"));
    expect(box.api.status).toBe("error");
    expect(box.api.error?.code).toBe("aborted");
    expect(box.api.runs).toEqual([]);
  });
});
