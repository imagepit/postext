import { describe, expect, it } from "vitest";
import { initialState, SAVE_DELAY_MS, statusText, transition } from "./saveState";
import type { SaveEvent, SaveEffect, SaveState } from "./saveState";

/** イベント列を順に適用し、最後の状態と全ての副作用を返す。 */
function run(events: SaveEvent[], from: SaveState = initialState) {
  let state = from;
  const effects: SaveEffect[] = [];
  for (const event of events) {
    const next = transition(state, event);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

const saves = (effects: SaveEffect[]) => effects.filter((e) => e.type === "save");

describe("読み込み", () => {
  it("読み込み中から取得成功で保存済みになり、baseRevision を保持する", () => {
    expect(run([{ type: "loaded", revision: 7 }]).state).toEqual({ kind: "saved", revision: 7 });
  });

  it("読み込み直後に何もしなければ保存しない", () => {
    const { effects } = run([{ type: "loaded", revision: 3 }, { type: "quiet" }, { type: "leaving" }]);
    expect(saves(effects)).toEqual([]);
  });

  it("読み込み中の編集通知（開いた直後の通知）は編集として扱わない", () => {
    const { state, effects } = run([{ type: "edited" }, { type: "loaded", revision: 0 }, { type: "quiet" }]);
    expect(state).toEqual({ kind: "saved", revision: 0 });
    expect(effects).toEqual([]);
  });

  it("読み込み失敗は状態として持ち、再試行で読み込み中へ戻る", () => {
    const failed = run([{ type: "loadFailed", message: "404" }]);
    expect(failed.state).toEqual({ kind: "loadFailed", message: "404" });
    expect(run([{ type: "retry" }], failed.state)).toEqual({ state: { kind: "loading" }, effects: [{ type: "fetch" }] });
    expect(run([{ type: "reload" }], failed.state).state).toEqual({ kind: "loading" });
  });
});

describe("編集と保存", () => {
  const saved: SaveState = { kind: "saved", revision: 4 };

  it("編集で未保存になり、止まって待ち時間が過ぎると保存中になって baseRevision で保存する", () => {
    const edited = transition(saved, { type: "edited" });
    expect(edited.state).toEqual({ kind: "dirty", revision: 4 });
    expect(edited.effects).toEqual([{ type: "startTimer", ms: SAVE_DELAY_MS }]);
    const quiet = transition(edited.state, { type: "quiet" });
    expect(quiet.state).toEqual({ kind: "saving", revision: 4, editedDuring: false });
    expect(quiet.effects).toEqual([{ type: "save", baseRevision: 4, final: false }]);
  });

  it("編集が続く間はタイマーを張り直すだけで保存しない", () => {
    const { state, effects } = run([{ type: "edited" }, { type: "edited" }, { type: "edited" }], saved);
    expect(state.kind).toBe("dirty");
    expect(effects.filter((e) => e.type === "startTimer")).toHaveLength(3);
    expect(saves(effects)).toEqual([]);
  });

  it("保存成功で保存済みになり、応答の revision が新しい baseRevision になる", () => {
    const { state } = run([{ type: "edited" }, { type: "quiet" }, { type: "saveSucceeded", revision: 5 }], saved);
    expect(state).toEqual({ kind: "saved", revision: 5 });
    const next = run([{ type: "edited" }, { type: "quiet" }], state);
    expect(saves(next.effects)).toEqual([{ type: "save", baseRevision: 5, final: false }]);
  });

  it("保存中に入った編集は落とさず、完了後に新しい revision でもう一度保存する", () => {
    const { state, effects } = run(
      [{ type: "edited" }, { type: "quiet" }, { type: "edited" }, { type: "edited" }, { type: "saveSucceeded", revision: 5 }],
      saved,
    );
    expect(state).toEqual({ kind: "saving", revision: 5, editedDuring: false });
    expect(saves(effects)).toEqual([
      { type: "save", baseRevision: 4, final: false },
      { type: "save", baseRevision: 5, final: false },
    ]);
    expect(run([{ type: "saveSucceeded", revision: 6 }], state).state).toEqual({ kind: "saved", revision: 6 });
  });

  it("保存中の編集の通知は保存の重複を起こさない", () => {
    const { effects } = run([{ type: "edited" }, { type: "quiet" }, { type: "edited" }, { type: "quiet" }], saved);
    expect(saves(effects)).toHaveLength(1);
  });
});

describe("競合", () => {
  const conflicted = run([{ type: "edited" }, { type: "quiet" }, { type: "saveConflicted" }], { kind: "saved", revision: 1 });

  it("409 で競合になり、自動では再送しない", () => {
    expect(conflicted.state).toEqual({ kind: "conflict" });
    expect(saves(conflicted.effects)).toHaveLength(1);
  });

  it("競合中の編集通知や時間切れでは保存を始めない", () => {
    const { state, effects } = run([{ type: "edited" }, { type: "quiet" }, { type: "leaving" }, { type: "retry" }], conflicted.state);
    expect(state).toEqual({ kind: "conflict" });
    expect(effects).toEqual([]);
  });

  it("保存中に編集が入っていても、競合になれば再送しない", () => {
    const r = run([{ type: "edited" }, { type: "quiet" }, { type: "edited" }, { type: "saveConflicted" }], { kind: "saved", revision: 1 });
    expect(r.state).toEqual({ kind: "conflict" });
    expect(saves(r.effects)).toHaveLength(1);
  });

  it("最新版を読み込むと読み込み中になり、取得成功で保存済みに戻って以後の編集は保存できる", () => {
    const reloaded = transition(conflicted.state, { type: "reload" });
    expect(reloaded.state).toEqual({ kind: "loading" });
    expect(reloaded.effects).toEqual([{ type: "cancelTimer" }, { type: "fetch" }]);
    const after = run(
      [{ type: "loaded", revision: 9 }, { type: "edited" }, { type: "quiet" }, { type: "saveSucceeded", revision: 10 }],
      reloaded.state,
    );
    expect(after.state).toEqual({ kind: "saved", revision: 10 });
    expect(saves(after.effects)).toEqual([{ type: "save", baseRevision: 9, final: false }]);
  });
});

describe("保存失敗", () => {
  const failed = run(
    [{ type: "edited" }, { type: "quiet" }, { type: "saveFailed", message: "500" }],
    { kind: "saved", revision: 2 },
  );

  it("通信エラーや5xx で保存失敗になり、revision を保持する", () => {
    expect(failed.state).toEqual({ kind: "saveFailed", revision: 2, message: "500" });
  });

  it("自動では再試行せず、再試行の操作で同じ baseRevision のまま保存する", () => {
    const idle = run([{ type: "edited" }, { type: "quiet" }, { type: "leaving" }], failed.state);
    expect(idle.state.kind).toBe("saveFailed");
    expect(idle.effects).toEqual([]);
    const retry = transition(failed.state, { type: "retry" });
    expect(retry.state).toEqual({ kind: "saving", revision: 2, editedDuring: false });
    expect(retry.effects).toEqual([{ type: "save", baseRevision: 2, final: false }]);
    expect(run([{ type: "saveSucceeded", revision: 3 }], retry.state).state).toEqual({ kind: "saved", revision: 3 });
  });

  it("再試行で再び失敗しても無限には繰り返さない", () => {
    const r = run([{ type: "retry" }, { type: "saveFailed", message: "502" }], failed.state);
    expect(r.state.kind).toBe("saveFailed");
    expect(saves(r.effects)).toHaveLength(1);
  });
});

describe("ページを離れる", () => {
  it("未保存の変更があれば最後に1回保存し、タイマーは止める", () => {
    const r = transition({ kind: "dirty", revision: 6 }, { type: "leaving" });
    expect(r.state).toEqual({ kind: "saving", revision: 6, editedDuring: false });
    expect(r.effects).toEqual([{ type: "cancelTimer" }, { type: "save", baseRevision: 6, final: true }]);
  });

  it("保存済み、保存中、競合では何もしない", () => {
    for (const s of [{ kind: "saved", revision: 1 }, { kind: "saving", revision: 1, editedDuring: false }, { kind: "conflict" }] as SaveState[]) {
      expect(transition(s, { type: "leaving" })).toEqual({ state: s, effects: [] });
    }
  });

  it("続けて隠れる通知が来ても2回目は保存しない", () => {
    const r = run([{ type: "leaving" }, { type: "leaving" }], { kind: "dirty", revision: 6 });
    expect(saves(r.effects)).toHaveLength(1);
  });
});

describe("表示文言", () => {
  it("どの状態にも日本語の文言がある", () => {
    expect(statusText({ kind: "loading" })).toBe("読み込み中");
    expect(statusText({ kind: "saved", revision: 0 })).toBe("保存済み");
    expect(statusText({ kind: "dirty", revision: 0 })).toBe("未保存の変更があります");
    expect(statusText({ kind: "saving", revision: 0, editedDuring: false })).toBe("保存中");
    expect(statusText({ kind: "conflict" })).toContain("競合");
    expect(statusText({ kind: "saveFailed", revision: 0, message: "x" })).toContain("保存に失敗しました");
  });
});
