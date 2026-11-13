"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SandboxBookBridge, SandboxLabels } from "postext-sandbox";
import { BooksSandbox } from "@/sandbox/BooksSandbox";
import { initialState, statusText, transition } from "./saveState";
import type { SaveEffect, SaveEvent, SaveState } from "./saveState";

// ページを離れる直前の fetch は keepalive でないと途中で切られるが、本文が 64KB を超えると使えない。
const KEEPALIVE_LIMIT = 60_000;

class HttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

const messageOf = (error: unknown, notFound = "書籍が見つかりません"): string => {
  if (error instanceof HttpError) return error.status === 404 ? notFound : `サーバーがエラーを返しました (${error.status})`;
  return "通信できませんでした";
};

export function BookEditor({ bookId, labels }: { bookId: string; labels: SandboxLabels }) {
  const [state, setState] = useState<SaveState>(initialState);
  const stateRef = useRef<SaveState>(initialState);
  const bridgeRef = useRef<SandboxBookBridge | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // 読み込みのやり直しが重なったとき、古い応答を捨てるための世代。
  const generationRef = useRef(0);
  const startedRef = useRef(false);
  const dispatchRef = useRef<(event: SaveEvent) => void>(() => undefined);

  const run = useCallback(
    (effect: SaveEffect) => {
      const dispatch = (event: SaveEvent) => dispatchRef.current(event);
      switch (effect.type) {
        case "startTimer":
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => dispatch({ type: "quiet" }), effect.ms);
          return;
        case "cancelTimer":
          if (timerRef.current) clearTimeout(timerRef.current);
          timerRef.current = null;
          return;
        case "fetch": {
          const generation = ++generationRef.current;
          void (async () => {
            try {
              const response = await fetch(`/api/books/${bookId}/bundle`, { cache: "no-store" });
              if (!response.ok) throw new HttpError(response.status);
              const revision = Number(response.headers.get("X-Book-Revision"));
              if (!Number.isSafeInteger(revision)) throw new Error("revision missing");
              const bytes = new Uint8Array(await response.arrayBuffer());
              // 開くたびに同じ origin の古いプロジェクトを消し、常にサーバーの内容で始める。
              await bridgeRef.current!.openBundle(bytes, { origin: `book:${bookId}` });
              if (generation === generationRef.current) dispatch({ type: "loaded", revision });
            } catch (error) {
              if (generation === generationRef.current) dispatch({ type: "loadFailed", message: messageOf(error) });
            }
          })();
          return;
        }
        case "save":
          void (async () => {
            try {
              const bytes = await bridgeRef.current!.exportBundle();
              const response = await fetch(`/api/books/${bookId}/bundle`, {
                method: "PUT",
                headers: { "Content-Type": "application/zip", "If-Match": String(effect.baseRevision) },
                body: new Blob([bytes as BlobPart]),
                keepalive: effect.final && bytes.length < KEEPALIVE_LIMIT,
              });
              if (response.status === 409) return dispatch({ type: "saveConflicted" });
              if (!response.ok) throw new HttpError(response.status);
              const { revision } = (await response.json()) as { revision: number };
              dispatch({ type: "saveSucceeded", revision });
            } catch (error) {
              dispatch({ type: "saveFailed", message: messageOf(error) });
            }
          })();
          return;
      }
    },
    [bookId],
  );

  const dispatch = useCallback(
    (event: SaveEvent) => {
      const next = transition(stateRef.current, event);
      stateRef.current = next.state;
      setState(next.state);
      for (const effect of next.effects) run(effect);
    },
    [run],
  );
  dispatchRef.current = dispatch;

  const onBridgeReady = useCallback(
    (bridge: SandboxBookBridge) => {
      bridgeRef.current = bridge;
      unsubscribeRef.current?.();
      unsubscribeRef.current = bridge.subscribe(() => dispatchRef.current({ type: "edited" }));
      if (!startedRef.current) {
        startedRef.current = true;
        run({ type: "fetch" });
      }
    },
    [run],
  );

  useEffect(() => {
    const leaving = () => dispatchRef.current({ type: "leaving" });
    const onVisibility = () => {
      if (document.visibilityState === "hidden") leaving();
    };
    // 書き出しは非同期なので、ページが破棄される遷移では最後の保存が間に合わないことがある。
    // 未送信の内容がある間は、離れる前にブラウザーの確認を出す。
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (["dirty", "saving", "saveFailed"].includes(stateRef.current.kind)) event.preventDefault();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", leaving);
      unsubscribeRef.current?.();
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const failed = state.kind === "saveFailed" || state.kind === "loadFailed" || state.kind === "conflict";

  return (
    <div className="flex h-dvh w-screen flex-col overflow-hidden bg-background text-foreground">
      <div
        className="flex h-9 shrink-0 items-center gap-4 border-b border-rule bg-surface px-3 text-sm"
        data-testid="save-bar"
      >
        <a href="/" className="text-slate hover:text-foreground">
          ← 書籍一覧
        </a>
        <span
          role="status"
          data-testid="save-status"
          data-state={state.kind}
          data-revision={"revision" in state ? state.revision : undefined}
          className={failed ? "text-vermilion" : state.kind === "saved" ? "text-slate" : "text-foreground"}
        >
          {statusText(state)}
        </span>
        {state.kind === "conflict" && (
          <button
            type="button"
            onClick={() => dispatch({ type: "reload" })}
            className="rounded bg-brand px-2 py-0.5 font-medium text-brand-contrast"
          >
            最新版を読み込む
          </button>
        )}
        {(state.kind === "saveFailed" || state.kind === "loadFailed") && (
          <button
            type="button"
            onClick={() => dispatch({ type: "retry" })}
            className="rounded bg-brand px-2 py-0.5 font-medium text-brand-contrast"
          >
            再試行
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1">
        <BooksSandbox labels={labels} onBridgeReady={onBridgeReady} />
      </div>
    </div>
  );
}
