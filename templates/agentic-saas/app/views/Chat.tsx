import { useCallback, useEffect, useRef, useState } from "react";
import { useChat, type ChatStatus } from "gemi/ai/client";
import { usePost } from "gemi/client";
import { PlusIcon } from "lucide-react";

import { Badge } from "@/app/views/components/ui/badge";
import { Button } from "@/app/views/components/ui/button";
import { ScrollArea } from "@/app/views/components/ui/scroll-area";
import { Skeleton } from "@/app/views/components/ui/skeleton";
import { Composer } from "@/app/views/components/chat/Composer";
import { ErrorBanner } from "@/app/views/components/chat/ErrorBanner";
import { LoadedTools } from "@/app/views/components/chat/LoadedTools";
import { PendingPanel } from "@/app/views/components/chat/PendingPanel";
import { Transcript } from "@/app/views/components/chat/Transcript";
import type { SupportMessage } from "@/app/views/components/chat/types";

/**
 * Everything one browser keeps about the conversation.
 *
 * `messages` and `cursor` are one record on purpose. The cursor is what
 * `/attach` is asked to resume from, so a transcript restored without it tells
 * the server "I have seen nothing" — and a run still inside the window it is
 * kept alive for after `run-end` replays from the top onto messages that
 * already hold it. Additive deltas arriving a second time is exactly how an
 * answer ends up printed twice, and storing the two together is the only thing
 * that makes it impossible to restore one without the other.
 */
type StoredThread = {
  threadId: string;
  messages: SupportMessage[];
  cursor?: { runId: string; seq: number };
};

const STORAGE_KEY = "agentic-saas.support-thread";

function readStoredThread(): StoredThread | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as StoredThread;
    return stored.threadId ? stored : null;
  } catch {
    // Private browsing, a cleared quota, or something under this key that is
    // not ours. A conversation is worth less than a page that renders.
    return null;
  }
}

function writeStoredThread(thread: StoredThread) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(thread));
  } catch {
    // Same bargain in the other direction: over quota is not worth a crash.
  }
}

function clearStoredThread() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do; the id it holds is already known to be dead.
  }
}

export default function Chat() {
  const [thread, setThread] = useState<StoredThread | null>(null);
  const [mintFailed, setMintFailed] = useState(false);

  /*
    The id has to come from the server's own store, through a route this app
    wrote: `agent()` mounts no thread route, because minting one is where an
    app records who owns it. An id the browser invented is a `thread_not_found`
    on the first turn.
  */
  const { trigger } = usePost("/support/threads");
  const mint = useRef(trigger);
  // The hook hands back a fresh closure on every render; the ref is what keeps
  // `start` stable, and a `start` that changed identity would re-run the mount
  // effect below and mint a thread per render.
  mint.current = trigger;

  const start = useCallback(async () => {
    setMintFailed(false);
    const stored = readStoredThread();
    if (stored) {
      setThread(stored);
      return;
    }
    const created = await mint.current();
    if (!created?.threadId) {
      setMintFailed(true);
      return;
    }
    const fresh: StoredThread = { threadId: created.threadId, messages: [] };
    writeStoredThread(fresh);
    setThread(fresh);
  }, []);

  const opened = useRef(false);
  useEffect(() => {
    // Once, even though React runs a mount effect twice in development: the
    // second pass would mint a second thread and abandon the first, and an
    // abandoned thread is a conversation the user cannot get back to.
    if (opened.current) return;
    opened.current = true;
    void start();
  }, [start]);

  const restart = useCallback(() => {
    clearStoredThread();
    setThread(null);
    void start();
  }, [start]);

  if (mintFailed) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-sm">
        <p className="text-muted-foreground">The support desk could not open a conversation.</p>
        <Button variant="outline" onClick={() => void start()}>
          Try again
        </Button>
      </div>
    );
  }

  if (!thread) return <ThreadSkeleton />;

  /*
    Keyed by the thread, so a restart really is a fresh hook: `useChat` probes
    `/attach` on mount only — the thread id is the handle that survives a
    refresh, and re-probing whenever it changed would race a stream already
    running on it — so a new id has to arrive with a new mount.
  */
  return <SupportThread key={thread.threadId} thread={thread} onRestart={restart} />;
}

function SupportThread({ thread, onRestart }: { thread: StoredThread; onRestart: () => void }) {
  const {
    messages,
    status,
    error,
    cursor,
    pending,
    loadedTools,
    sendMessage,
    setMessages,
    stop,
    regenerate,
    approve,
    answer,
  } = useChat("/support", {
    threadId: thread.threadId,
    initialMessages: thread.messages,
    cursor: thread.cursor,
    onError: (failure) => {
      // The store is in memory, so every thread it holds dies with the process.
      // A dev server restart therefore leaves this browser holding an id the
      // server has never heard of, and the only honest fix is a new thread —
      // silently retrying on the dead id would fail forever.
      if (failure.code === "thread_not_found") onRestart();
    },
  });

  useEffect(() => {
    writeStoredThread({
      threadId: thread.threadId,
      messages,
      // Undefined until a run has named itself, and the pair means nothing
      // until then — there is no run to resume.
      ...(cursor.runId ? { cursor: { runId: cursor.runId, seq: cursor.seq } } : {}),
    });
  }, [thread.threadId, messages, cursor.runId, cursor.seq]);

  /**
   * Retry, on both shapes a failure takes.
   *
   * `regenerate` drops the last assistant turn and re-runs the user turn before
   * it, which is what a half-finished answer needs. A send that never reached a
   * run has no assistant turn at all and `regenerate` rightly does nothing with
   * it — which would leave the button dead on the failure people actually hit.
   * There the last message is the user's own, so the repair is to take it back
   * out of the transcript and send it again rather than have it appear twice.
   */
  const retry = useCallback(() => {
    const last = messages[messages.length - 1];
    if (last?.role === "user") {
      const text = last.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
      setMessages(messages.slice(0, -1));
      void sendMessage(text);
      return;
    }
    void regenerate();
  }, [messages, regenerate, sendMessage, setMessages]);

  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages, pending.length]);

  const busy = status === "submitted" || status === "streaming";

  return (
    <>
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">Support desk</h1>
          <p className="truncate text-xs text-muted-foreground">thread {thread.threadId}</p>
        </div>
        <StatusBadge status={status} />
        <Button variant="ghost" size="sm" className="ml-auto" onClick={onRestart}>
          <PlusIcon />
          New thread
        </Button>
      </header>

      <ScrollArea className="flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
          {messages.length === 0 ? (
            <EmptyState onPick={(text) => void sendMessage(text)} />
          ) : (
            <Transcript messages={messages} />
          )}

          <LoadedTools tools={loadedTools} />

          {/* Non-empty exactly when the status is `awaiting-input`. */}
          <PendingPanel pending={pending} approve={approve} answer={answer} />

          {error ? <ErrorBanner error={error} onRetry={retry} /> : null}

          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <Composer
        busy={busy}
        onSend={(text) => void sendMessage(text)}
        onStop={() => void stop()}
        hint={
          status === "awaiting-input"
            ? // A turn that leaves a pending call unanswered denies it — the
              // provider rejects a history with a dangling tool call, so
              // something has to resolve it. Worth saying out loud, because
              // typing past a question does not feel like refusing one.
              "Sending a message now answers nothing above, and an unanswered request is refused."
            : undefined
        }
      />
    </>
  );
}

function StatusBadge({ status }: { status: ChatStatus }) {
  if (status === "idle") return null;
  const label =
    status === "awaiting-input"
      ? "waiting on you"
      : status === "submitted"
        ? "thinking"
        : status === "streaming"
          ? "answering"
          : status;
  return (
    <Badge variant={status === "error" ? "destructive" : "secondary"} className="font-normal">
      {label}
    </Badge>
  );
}

/** The tools are fakes with canned data, so the suggestions name the ids they
 *  know about — a demo that returns "no such order" teaches nothing. */
const SUGGESTIONS = [
  "What did customer cus_ada order?",
  "Run diagnostics on ord_2001 and tell me what is wrong",
  "Refund ord_2001 in full, it arrived broken",
];

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="flex flex-col items-start gap-3 py-10">
      <h2 className="text-lg font-semibold">How can we help?</h2>
      <p className="text-sm text-muted-foreground">
        The agent can look orders up, run diagnostics, ask you a question, hand the hard ones to a
        research agent, and issue a refund — that last one only once you approve it.
      </p>
      <div className="flex flex-col items-start gap-2 pt-2">
        {SUGGESTIONS.map((suggestion) => (
          <Button key={suggestion} variant="outline" size="sm" onClick={() => onPick(suggestion)}>
            {suggestion}
          </Button>
        ))}
      </div>
    </div>
  );
}

function ThreadSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
      <Skeleton className="h-6 w-40" />
      <Skeleton className="h-20 w-full" />
      <Skeleton className="h-20 w-2/3" />
    </div>
  );
}
