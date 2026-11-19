/** @vitest-environment jsdom */
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";

// As in useSubscription.test.tsx: nothing here uses a database.
vi.mock("../database/DatabaseManager", () => ({ DatabaseManager: class {} }));
vi.mock("../services/change-feed/DatabaseChangeFeedDriver", () => ({
  DatabaseChangeFeedDriver: class {},
}));
vi.mock("../orm/context", () => ({
  currentTransaction: () => undefined,
  afterCommit: async (callback: () => unknown) => void (await callback()),
}));

import { ChangeFeedManager } from "../services/change-feed/ChangeFeedManager";
import type { WorkflowUpdate } from "../services/queue/workflow/wire";
import { useWorkflow } from "./useWorkflow";

let manager: ChangeFeedManager;
const urls: string[] = [];
const CHANNEL = "gemi:workflow:wf-1";

function serve() {
  manager = new ChangeFeedManager();
  urls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit = {}) => {
      urls.push(url);
      return manager.stream(new Request(`http://app.test${url}`, init), CHANNEL);
    }),
  );
}

afterEach(async () => {
  vi.restoreAllMocks();
  cleanup();
  vi.unstubAllGlobals();
  await manager?.close();
});

const tick = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

function update(fields: Partial<WorkflowUpdate>): WorkflowUpdate {
  return {
    id: "wf-1",
    name: "Import",
    status: "running",
    currentStep: "rows",
    progress: 0,
    error: null,
    steps: [],
    createdAt: 1,
    updatedAt: 1,
    ...fields,
  };
}

type Seen = { workflow?: WorkflowUpdate | null; status?: string };

function Follow(props: { seen: Seen; initial?: WorkflowUpdate | null; cursor?: string }) {
  const { workflow, status } = useWorkflow(
    "/imports/:importId/progress" as never,
    { params: { importId: "i1" } } as never,
    { initial: props.initial, cursor: props.cursor },
  );
  props.seen.workflow = workflow;
  props.seen.status = status;
  return null;
}

describe("useWorkflow", () => {
  test("shows the initial status, then each later update", async () => {
    serve();
    const seen: Seen = {};
    render(<Follow seen={seen} initial={update({ progress: 0.1, updatedAt: 10 })} />);
    expect(seen.workflow?.progress).toBe(0.1);
    await tick();
    expect(urls[0]).toBe("/api/imports/i1/progress");
    expect(seen.status).toBe("open");

    await act(async () => {
      await manager.publish(CHANNEL, update({ progress: 0.5, updatedAt: 20 }));
    });
    await tick();
    expect(seen.workflow?.progress).toBe(0.5);
  });

  test("keeps the later of two updates that arrive out of order", async () => {
    serve();
    const seen: Seen = {};
    render(<Follow seen={seen} initial={null} />);
    await tick();
    await act(async () => {
      await manager.publish(CHANNEL, update({ progress: 0.8, updatedAt: 30 }));
      await manager.publish(CHANNEL, update({ progress: 0.4, updatedAt: 25 }));
      await manager.publish(CHANNEL, "not an update");
    });
    await tick();
    expect(seen.workflow?.progress).toBe(0.8);
  });

  test("disconnects once the workflow has ended", async () => {
    serve();
    const seen: Seen = {};
    render(<Follow seen={seen} initial={update({ updatedAt: 1 })} />);
    await tick();
    expect(manager.subscriptions).toBe(1);
    await act(async () => {
      await manager.publish(CHANNEL, update({ status: "completed", progress: 1, updatedAt: 5 }));
    });
    await tick();
    expect(seen.workflow?.status).toBe("completed");
    expect(seen.status).toBe("closed");
    expect(manager.subscriptions).toBe(0);
  });

  test("an ended workflow never connects", async () => {
    serve();
    const seen: Seen = {};
    render(<Follow seen={seen} initial={update({ status: "failed", error: "boom" })} />);
    await tick();
    expect(urls).toHaveLength(0);
    expect(seen.workflow?.error).toBe("boom");
  });
});
