"use client";

// CORE-228: 書籍の章を、取り込み元の Outline 文書へ反映するダイアログ。
// 章ごとの状態と差分を確かめてから、選んだ章を書き戻す。両方で変更された章は Postext の内容で上書きする。

import { useCallback, useEffect, useState } from "react";

type Status = "bookEdited" | "both" | "outlineUpdated" | "unchanged" | "missingInOutline";

interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

interface PushEntry {
  documentId: string;
  title: string;
  status: Status;
  warnings: string[];
  diff: DiffLine[];
  newImages: number;
}

const STATUS_LABEL: Record<Status, string> = {
  bookEdited: "Postextだけ変更",
  both: "両方で変更",
  outlineUpdated: "Outline側だけ更新",
  unchanged: "変更なし",
  missingInOutline: "Outlineにない",
};

const PUSHABLE: ReadonlySet<Status> = new Set(["bookEdited", "both"]);

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `サーバーがエラーを返しました (${response.status})`;
}

const buttonClass = "rounded bg-brand px-3 py-1 text-sm font-medium text-brand-contrast disabled:opacity-40";
const subButtonClass = "rounded border border-rule px-3 py-1 text-sm text-foreground hover:bg-background";

export function OutlinePushDialog({
  bookId,
  onClose,
  onPushed,
}: {
  bookId: string;
  onClose: () => void;
  /** 反映した後（書籍の記録も更新されるので、編集画面は読み込み直す）。 */
  onPushed: () => void;
}) {
  const [preview, setPreview] = useState<{ revision: number; chapters: PushEntry[] } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ pushed: number; warnings: string[] } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/books/${bookId}/outline/push`, { cache: "no-store" });
        if (!response.ok) throw new Error(await readError(response));
        const data = (await response.json()) as { revision: number; chapters: PushEntry[] };
        if (cancelled) return;
        setPreview(data);
        setChecked(new Set(data.chapters.filter((c) => PUSHABLE.has(c.status)).map((c) => c.documentId)));
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "通信できませんでした");
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const apply = useCallback(async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/books/${bookId}/outline/push`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseRevision: preview.revision,
          documentIds: preview.chapters.filter((c) => checked.has(c.documentId)).map((c) => c.documentId),
        }),
      });
      if (response.status === 409) throw new Error("他の場所で先に保存されました。もう一度やり直してください");
      if (!response.ok) throw new Error(await readError(response));
      const result = (await response.json()) as { pushed: number; warnings: string[] };
      setDone(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信できませんでした");
    } finally {
      setBusy(false);
    }
  }, [bookId, checked, preview]);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const close = done ? onPushed : onClose;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="Outlineへ反映">
      <div className="flex max-h-[85dvh] w-[min(52rem,94vw)] flex-col rounded border border-rule bg-surface text-sm text-foreground shadow-lg">
        <div className="flex items-center justify-between border-b border-rule px-4 py-2">
          <h2 className="font-medium">Outlineへ反映</h2>
          <button type="button" onClick={close} disabled={busy} className="text-slate hover:text-foreground">
            閉じる
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error && (
            <p role="alert" className="mb-3 text-vermilion">
              {error}
            </p>
          )}
          {!preview && !error && <p className="text-slate">Outline の文書と比べています</p>}

          {done && (
            <div className="mb-3" data-testid="push-done">
              <p>{done.pushed} 件の章を Outline へ反映しました。</p>
              {done.warnings.length > 0 && (
                <ul className="mt-1 list-disc pl-6 text-slate">
                  {done.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {preview && !done && (
            <>
              <p className="mb-2 text-slate">取り込み元の Outline 文書がある章: {preview.chapters.length} 件</p>
              {preview.chapters.length === 0 && <p className="text-slate">Outline から取り込んだ章がありません</p>}
              <ul className="divide-y divide-rule border border-rule">
                {preview.chapters.map((c) => {
                  const pushable = PUSHABLE.has(c.status);
                  const expanded = open === c.documentId;
                  return (
                    <li key={c.documentId} className="px-3 py-2" data-status={c.status}>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          aria-label={`${c.title} を反映する`}
                          disabled={!pushable || busy}
                          checked={pushable && checked.has(c.documentId)}
                          onChange={() => toggle(c.documentId)}
                        />
                        <span className="min-w-0 flex-1 truncate">{c.title || "（無題）"}</span>
                        <span className={c.status === "both" ? "text-vermilion" : "text-slate"}>{STATUS_LABEL[c.status]}</span>
                        {c.diff.length > 0 && (
                          <button type="button" className={subButtonClass} onClick={() => setOpen(expanded ? null : c.documentId)}>
                            {expanded ? "差分を隠す" : "差分を見る"}
                          </button>
                        )}
                      </div>
                      {c.status === "both" && <p className="mt-1 text-vermilion">Outlineの変更は上書きされます。</p>}
                      {c.status === "outlineUpdated" && <p className="mt-1 text-slate">Outline側の変更は「Outlineから取り込む」で取り込めます。</p>}
                      {c.newImages > 0 && <p className="mt-1 text-slate">Postextで足した画像 {c.newImages} 枚を、Outlineへ添付します。</p>}
                      {c.warnings.length > 0 && (
                        <ul className="mt-1 list-disc pl-8 text-slate">
                          {c.warnings.map((w, i) => (
                            <li key={i}>{w}</li>
                          ))}
                        </ul>
                      )}
                      {expanded && (
                        <pre className="mt-2 max-h-72 overflow-auto border border-rule bg-background p-2 text-xs leading-relaxed">
                          {c.diff.map((line, i) => (
                            <div
                              key={i}
                              className={line.type === "add" ? "bg-green-100 text-green-900" : line.type === "del" ? "bg-red-100 text-red-900" : "text-slate"}
                            >
                              {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
                              {line.text}
                            </div>
                          ))}
                        </pre>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        <div className="flex items-center justify-end border-t border-rule px-4 py-2">
          {done ? (
            <button type="button" className={buttonClass} onClick={onPushed}>
              閉じて読み込み直す
            </button>
          ) : (
            <button type="button" disabled={busy || !preview || checked.size === 0} className={buttonClass} onClick={() => void apply()}>
              {busy && preview ? "反映中" : `選んだ ${checked.size} 件をOutlineへ反映する`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
