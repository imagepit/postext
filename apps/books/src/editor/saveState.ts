// 編集画面の保存状態機械。React にも Next.js にも依存せず、状態とイベントから
// 次の状態と「呼び出し側が行う副作用」を返す。タイマーや通信は呼び出し側の責務。

/** 編集が止まってから保存を始めるまでの待ち時間。 */
export const SAVE_DELAY_MS = 1500;

export type SaveState =
  | { kind: "loading" }
  | { kind: "loadFailed"; message: string }
  /** サーバーの内容と同じ。revision は次の保存の baseRevision。 */
  | { kind: "saved"; revision: number }
  | { kind: "dirty"; revision: number }
  /** editedDuring: 保存中に新しい編集が入った。完了後にもう一度保存する。 */
  | { kind: "saving"; revision: number; editedDuring: boolean }
  /** 他の場所で先に保存された。ローカルの内容は自動では送らない。 */
  | { kind: "conflict" }
  /** 未保存の内容はエディターに残っている。 */
  | { kind: "saveFailed"; revision: number; message: string };

export type SaveEvent =
  | { type: "loaded"; revision: number }
  | { type: "loadFailed"; message: string }
  | { type: "edited" }
  | { type: "quiet" }
  | { type: "saveSucceeded"; revision: number }
  | { type: "saveConflicted" }
  | { type: "saveFailed"; message: string }
  /** 競合や読み込み失敗からの「最新版を読み込む」。ローカルの編集は捨てる。 */
  | { type: "reload" }
  | { type: "retry" }
  /** タブが隠れる、ページを離れる。 */
  | { type: "leaving" };

export type SaveEffect =
  | { type: "fetch" }
  | { type: "startTimer"; ms: number }
  | { type: "cancelTimer" }
  /** final: ページを離れる前の最後の保存。 */
  | { type: "save"; baseRevision: number; final: boolean };

export interface Transition {
  state: SaveState;
  effects: SaveEffect[];
}

export const initialState: SaveState = { kind: "loading" };

const stay = (state: SaveState): Transition => ({ state, effects: [] });

export function transition(state: SaveState, event: SaveEvent): Transition {
  switch (event.type) {
    case "loaded":
      return state.kind === "loading" ? { state: { kind: "saved", revision: event.revision }, effects: [] } : stay(state);

    case "loadFailed":
      return state.kind === "loading" ? stay({ kind: "loadFailed", message: event.message }) : stay(state);

    case "edited":
      switch (state.kind) {
        case "saved":
        case "dirty":
          return { state: { kind: "dirty", revision: state.revision }, effects: [{ type: "startTimer", ms: SAVE_DELAY_MS }] };
        case "saving":
          return stay({ ...state, editedDuring: true });
        default:
          // 読み込み中は開いた直後の通知、競合と失敗では自動で保存を始めない。
          return stay(state);
      }

    case "quiet":
      return state.kind === "dirty"
        ? { state: { kind: "saving", revision: state.revision, editedDuring: false }, effects: [{ type: "save", baseRevision: state.revision, final: false }] }
        : stay(state);

    case "saveSucceeded":
      if (state.kind !== "saving") return stay(state);
      return state.editedDuring
        ? { state: { kind: "saving", revision: event.revision, editedDuring: false }, effects: [{ type: "save", baseRevision: event.revision, final: false }] }
        : stay({ kind: "saved", revision: event.revision });

    case "saveConflicted":
      return state.kind === "saving" ? { state: { kind: "conflict" }, effects: [{ type: "cancelTimer" }] } : stay(state);

    case "saveFailed":
      return state.kind === "saving"
        ? stay({ kind: "saveFailed", revision: state.revision, message: event.message })
        : stay(state);

    case "reload":
      return state.kind === "conflict" || state.kind === "loadFailed"
        ? { state: { kind: "loading" }, effects: [{ type: "cancelTimer" }, { type: "fetch" }] }
        : stay(state);

    case "retry":
      if (state.kind === "saveFailed") {
        return {
          state: { kind: "saving", revision: state.revision, editedDuring: false },
          effects: [{ type: "save", baseRevision: state.revision, final: false }],
        };
      }
      return state.kind === "loadFailed" ? { state: { kind: "loading" }, effects: [{ type: "fetch" }] } : stay(state);

    case "leaving":
      return state.kind === "dirty"
        ? {
            state: { kind: "saving", revision: state.revision, editedDuring: false },
            effects: [{ type: "cancelTimer" }, { type: "save", baseRevision: state.revision, final: true }],
          }
        : stay(state);
  }
}

export function statusText(state: SaveState): string {
  switch (state.kind) {
    case "loading":
      return "読み込み中";
    case "loadFailed":
      return `読み込みに失敗しました: ${state.message}`;
    case "saved":
      return "保存済み";
    case "dirty":
      return "未保存の変更があります";
    case "saving":
      return "保存中";
    case "conflict":
      return "競合: 他の場所で先に保存されました";
    case "saveFailed":
      return `保存に失敗しました: ${state.message}`;
  }
}
