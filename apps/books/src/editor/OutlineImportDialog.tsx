"use client";

import { useCallback, useEffect, useState } from "react";

type Status = "new" | "outlineUpdated" | "bookEdited" | "both" | "unchanged" | "missingInOutline";

interface BrowseItem {
  id: string;
  title: string;
  hasChildren: boolean;
  collection?: string;
}

interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

interface PreviewEntry {
  documentId: string;
  title: string;
  status: Status;
  warnings: string[];
  diff: DiffLine[];
}

const STATUS_LABEL: Record<Status, string> = {
  new: "新規",
  outlineUpdated: "Outline側だけ更新",
  bookEdited: "書籍側だけ編集",
  both: "両方で変更",
  unchanged: "変更なし",
  missingInOutline: "Outlineにない",
};

const APPLICABLE: ReadonlySet<Status> = new Set(["new", "outlineUpdated", "both"]);
const DEFAULT_CHECKED: ReadonlySet<Status> = new Set(["new", "outlineUpdated"]);

async function readError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? `サーバーがエラーを返しました (${response.status})`;
}

const buttonClass = "rounded bg-brand px-3 py-1 text-sm font-medium text-brand-contrast disabled:opacity-40";
const subButtonClass = "rounded border border-rule px-3 py-1 text-sm text-foreground hover:bg-background";

export function OutlineImportDialog({
  bookId,
  onClose,
  onImported,
}: {
  bookId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  // 文書の選択（path は辿ってきた親文書）と、選んだ後の取り込み確認。
  const [path, setPath] = useState<{ id: string; title: string }[]>([]);
  const [items, setItems] = useState<BrowseItem[] | null>(null);
  const [source, setSource] = useState<{ id: string; title: string } | null>(null);
  const [preview, setPreview] = useState<{ revision: number; chapters: PreviewEntry[] } | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parentId = path.length > 0 ? path[path.length - 1]!.id : undefined;

  useEffect(() => {
    if (source) return;
    let cancelled = false;
    setItems(null);
    setError(null);
    void (async () => {
      try {
        const response = await fetch(`/api/outline/documents${parentId ? `?parentId=${encodeURIComponent(parentId)}` : ""}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(await readError(response));
        const { documents } = (await response.json()) as { documents: BrowseItem[] };
        if (!cancelled) setItems(documents);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "通信できませんでした");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [parentId, source]);

  const choose = useCallback(
    async (doc: { id: string; title: string }) => {
      setBusy(true);
      setError(null);
      try {
        const response = await fetch(`/api/books/${bookId}/outline?documentId=${encodeURIComponent(doc.id)}`, {
          cache: "no-store",
        });
        if (!response.ok) throw new Error(await readError(response));
        const data = (await response.json()) as { revision: number; chapters: PreviewEntry[] };
        setPreview(data);
        setSource(doc);
        setChecked(new Set(data.chapters.filter((c) => DEFAULT_CHECKED.has(c.status)).map((c) => c.documentId)));
        setOpen(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "通信できませんでした");
      } finally {
        setBusy(false);
      }
    },
    [bookId],
  );

  const apply = useCallback(async () => {
    if (!source || !preview) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/books/${bookId}/outline`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          documentId: source.id,
          baseRevision: preview.revision,
          documentIds: preview.chapters.filter((c) => checked.has(c.documentId)).map((c) => c.documentId),
        }),
      });
      if (response.status === 409) throw new Error("他の場所で先に保存されました。もう一度やり直してください");
      if (!response.ok) throw new Error(await readError(response));
      onImported();
    } catch (e) {
      setError(e instanceof Error ? e.message : "通信できませんでした");
      setBusy(false);
    }
  }, [bookId, checked, onImported, preview, source]);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" role="dialog" aria-modal="true" aria-label="Outlineから取り込む">
      <div className="flex max-h-[85dvh] w-[min(52rem,94vw)] flex-col rounded border border-rule bg-surface text-sm text-foreground shadow-lg">
        <div className="flex items-center justify-between border-b border-rule px-4 py-2">
          <h2 className="font-medium">Outlineから取り込む</h2>
          <button type="button" onClick={onClose} disabled={busy} className="text-slate hover:text-foreground">
            閉じる
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
          {error && (
            <p role="alert" className="mb-3 text-vermilion">
              {error}
            </p>
          )}

          {!source && (
            <>
              <p className="mb-2 text-slate">章にしたい文書の親（子文書が章になります）を選びます。</p>
              <div className="mb-2 flex flex-wrap items-center gap-1 text-slate">
                <button type="button" className="hover:text-foreground" onClick={() => setPath([])}>
                  コレクション
                </button>
                {path.map((p, i) => (
                  <span key={p.id} className="flex items-center gap-1">
                    <span>/</span>
                    <button type="button" className="hover:text-foreground" onClick={() => setPath(path.slice(0, i + 1))}>
                      {p.title}
                    </button>
                  </span>
                ))}
              </div>
              {parentId && (
                <button type="button" disabled={busy} className={`${buttonClass} mb-2`} onClick={() => void choose(path[path.length - 1]!)}>
                  「{path[path.length - 1]!.title}」の子文書を章として取り込む
                </button>
              )}
              {items === null && !error && <p className="text-slate">読み込み中</p>}
              {items?.length === 0 && <p className="text-slate">文書がありません</p>}
              <ul className="divide-y divide-rule border border-rule">
                {items?.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
                    <span className="min-w-0 truncate">
                      {item.title || "（無題）"}
                      {item.collection && <span className="ml-2 text-slate">{item.collection}</span>}
                    </span>
                    {item.hasChildren ? (
                      <button type="button" className={subButtonClass} onClick={() => setPath([...path, { id: item.id, title: item.title }])}>
                        開く
                      </button>
                    ) : (
                      <span className="text-slate">子文書なし</span>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          {source && preview && (
            <>
              <p className="mb-2 text-slate">
                取り込み元: {source.title}（{preview.chapters.length} 件）
              </p>
              {preview.chapters.length === 0 && <p className="text-slate">子文書がありません</p>}
              <ul className="divide-y divide-rule border border-rule">
                {preview.chapters.map((c) => {
                  const applicable = APPLICABLE.has(c.status);
                  const expanded = open === c.documentId;
                  return (
                    <li key={c.documentId} className="px-3 py-2" data-status={c.status}>
                      <div className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          aria-label={`${c.title} を取り込む`}
                          disabled={!applicable || busy}
                          checked={applicable && checked.has(c.documentId)}
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
                      {c.status === "both" && (
                        <p className="mt-1 text-vermilion">書籍側の編集は、取り込むと上書きされます。</p>
                      )}
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

        {source && preview && (
          <div className="flex items-center justify-between border-t border-rule px-4 py-2">
            <button
              type="button"
              disabled={busy}
              className={subButtonClass}
              onClick={() => {
                setSource(null);
                setPreview(null);
              }}
            >
              文書を選び直す
            </button>
            <button type="button" disabled={busy || checked.size === 0} className={buttonClass} onClick={() => void apply()}>
              {busy ? "取り込み中" : `選んだ ${checked.size} 件を取り込む`}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
