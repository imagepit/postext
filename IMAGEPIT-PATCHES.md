# 上流から変えた箇所の一覧

このファイルは、IMAGEPITのフォークが上流（[drnachio/postext](https://github.com/drnachio/postext)）から変えた箇所を、上流の新しい版へ追従するときの手引きとしてまとめたものです。フォーク全体の方針と追従の手順は [IMAGEPIT.md](IMAGEPIT.md) にあります。

変更は次の4つに分かれます。上流の版を上げるときに注意が要るのは、**1. 本体への変更**と**3. 上流に依存している箇所**です。

| 区分 | 場所 | 上流の更新で衝突するか |
|---|---|---|
| 1. 本体への変更 | `packages/postext`・`packages/postext-sandbox` の既存ファイル | する。手で解消する |
| 2. 自社が足したファイル | `apps/books/`、`Dockerfile.imagepit` など上流にないファイル | しない |
| 3. 上流に依存している箇所 | `apps/books` が使う上流のAPI・ファイル | 衝突はしないが、上流の変更で壊れる |
| 4. 本体を変えずに実現したもの | 書籍のデザイン設定、合成フォント、WebMCPの使い方 | しない。動作の確認だけ要る |

## 基点

- 上流の基点: タグ `v1.82.0`（コミット `621d86582`）
- 既定ブランチ: `imagepit-v1.82.0`
- 2026-11-15時点の上流の最新は `v1.87.0` で、基点から116コミット進んでいる
- 自社のコミットは `git log --oneline v1.82.0..imagepit-v1.82.0` で一覧にできる（17コミット、PR #1〜#17）

上流との差分を見るには、次を実行します。

```bash
git diff --stat v1.82.0 imagepit-v1.82.0 -- packages
```

## 1. 本体への変更

上流の既存ファイルを変えたのは、次の4件だけです。どれも、使わなければ上流と同じに動きます（既定は無効、または引数を渡したときだけ動く）。

### 1-1. Sandboxを外部の保存先につなぐ橋（HostBridge）

- **目的:** 編集画面（Sandbox）で開く本を、ブラウザの中ではなくbooksアプリのデータベースに保存するため。本を `.postext` として開く・取り出す・変更を知らせる、の3つをホストへ渡す。
- **計画とPR:** CORE-201（[#3](https://github.com/imagepit/postext/pull/3)）
- **変えたファイル:**

  | ファイル | 変更 |
  |---|---|
  | `packages/postext-sandbox/src/bridge/hostBridge.tsx` | 新規。`SandboxBookBridge`（`openBundle`・`exportBundle`・`subscribe`）を実装する描画なしの部品 |
  | `packages/postext-sandbox/src/bridge/hostBridge.test.ts` | 新規。上のテスト |
  | `packages/postext-sandbox/src/PostextSandbox.tsx` | `onBridgeReady` を引数に足し、`<HostBridge>` を `SandboxWebMcp` の隣に置く（2か所） |
  | `packages/postext-sandbox/src/types/props.ts` | `PostextSandboxProps.onBridgeReady` を足す |
  | `packages/postext-sandbox/src/context/projectActions.ts` | `exportProject` の中身を `buildProjectBundle` に切り出し、ダウンロードせずにバイト列を返す `bundleProject` を足す |
  | `packages/postext-sandbox/src/context/projectActions/types.ts` | `ProjectActions.bundleProject` を足す |
  | `packages/postext-sandbox/src/index.ts` | `SandboxBookBridge` の型を公開する |

- **上流の更新で気をつける点:**
  - `projectActions.ts` の `exportProject` は上流でもよく変わる。上流側の変更を `buildProjectBundle` の中へ移し、`exportProject` と `bundleProject` の両方がそれを呼ぶ形を保つ。
  - `PostextSandbox.tsx` の引数の分割代入と、`SandboxWebMcp` を置いている箇所が動いていれば、`onBridgeReady` と `<HostBridge>` を同じ位置に入れ直す。
  - 上流が同じ目的の仕組みを入れたら、そちらに乗り換えてこの変更を消す。
- **確かめるテスト:** `packages/postext-sandbox` の `hostBridge.test.ts`。そのうえで、編集画面で本を開き、本文を変えて保存し、別の端末で開き直す。

### 1-2. 保存したデザインの保存先を差し替える（SavedDesignStorage）

- **目的:** 保存したデザインを、ブラウザのIndexedDBではなくbooksアプリのデータベースに置き、どの端末からも使えるようにするため。
- **計画とPR:** CORE-211（[#8](https://github.com/imagepit/postext/pull/8)）
- **変えたファイル:**

  | ファイル | 変更 |
  |---|---|
  | `packages/postext-sandbox/src/designs/designStore.ts` | 保存処理を `SavedDesignStorage`（`list`・`get`・`put`・`delete`）の差し替え可能な形にし、既定はIndexedDBのままにする。`setSavedDesignStorage` を足す。一覧は中身なしの `SavedDesignSummary` を返す |
  | `packages/postext-sandbox/src/designs/designStore.test.ts` | 新規。差し替えのテスト |
  | `packages/postext-sandbox/src/index.ts` | `setSavedDesignStorage` と型3つを公開する |

- **上流の更新で気をつける点:**
  - `designStore.ts` の `listSavedDesigns`・`getSavedDesign`・保存・削除の中身が上流で変わったら、その変更を `indexedDbStorage` の中に移す。外側の関数は `storage` を呼ぶだけの形を保つ。
  - 上流が `listSavedDesigns` の戻り値に中身（`bytes`）を前提とする処理を足した場合は、`SavedDesignSummary` との食い違いを直す。
- **確かめるテスト:** `designStore.test.ts`。そのうえで、編集画面でデザインを保存し、別の端末から適用する。

### 1-3. コードの行注釈と強調行の太字（codeStyle.annotations / highlightBold）

- **目的:** 教材のコードの行注釈（`// <--[説明]`、`// v--[説明]`、`// ^--[説明]`）を、矢印と太字の説明で組むため。あわせて、`highlight="…"` で指定した行を太字にする。白黒印刷で読めるようにする。
- **計画とPR:** CORE-213（[#12](https://github.com/imagepit/postext/pull/12)、[#14](https://github.com/imagepit/postext/pull/14)）
- **変えたファイル:**

  | ファイル | 変更 |
  |---|---|
  | `packages/postext/src/types/text/code.ts` | `CodeStyleConfig` と解決後の型に `annotations`・`highlightBold` を足す |
  | `packages/postext/src/defaults/text/codeStyle.ts` | 既定値 `false`、`resolveCodeStyleConfig` と `stripCodeStyleDefaults` に2つを通す |
  | `packages/postext/src/checks/configWarnings/unknownKeys.ts` | `CODE_STYLE_KEYS` に2つを足す（足さないと `unknownConfigKey` の警告が出る） |
  | `packages/postext/src/pipeline/code/codeLines.ts` | `annotatePieces` を足す。`runsAt` で注釈を矢印（`⟵`・`⬐`・`⬑`）と太字の説明に置き換え、角括弧と直前の `//`・`#` を外す。強調行を太字にする。太字にした区切りにコードの色を明示する |
  | `packages/postext/src/__tests__/pipeline/code/codeAnnotations.test.ts` | 新規。上のテスト |

- **上流の更新で気をつける点:**
  - `codeLines.ts` の `runsAt`（各行の区切りを作る関数）が上流で変わったら、次の3点を入れ直す。
    1. 区切りを `annotatePieces` に通す。
    2. `bold` の判定に `piece.role === 'note'` と強調行（`lineBold`）を足す。
    3. 色が未指定の太字に `cs.color.hex` を使う。
  - 上流が `CodeStyleConfig` に項目を足したら、`unknownKeys.ts` の `CODE_STYLE_KEYS` で衝突する。両方の項目を残す。
  - 矢印の字形は、合成フォント IMAGEPIT Mono が `U+27F5`・`U+2B10`・`U+2B11` に持っている（4章を参照）。
  - HTML・EPUB・Wordの書き出しには反映していない。
- **確かめるテスト:** `codeAnnotations.test.ts` と `packages/postext/src/__tests__/pipeline/code` 全体。そのうえで、教材をCLIで組み、注釈の行を目で見る。

### 1-4. プレビューの画像をクリックしたらリソース詳細を開く

- **目的:** プレビュー上の画像をクリックしたら、その画像のリソース詳細（幅・揃え・キャプション）を開くため。上流の動きは、内容モードでは本文の `::resource` 行へ移るだけで、UUIDのIDを一覧から探さないと設定を開けなかった。
- **計画とPR:** CORE-214
- **変えたファイル:**

  | ファイル | 変更 |
  |---|---|
  | `packages/postext-sandbox/src/viewport/canvas/CanvasPreview/interaction/targets.ts` | 内容モードの判定を `contentSelectionLeads` に切り出し、選ばれた最も内側の要素が画像（`resource`）ならページ選択の処理へ回す（リソースパネルが開く） |
  | `packages/postext-sandbox/src/viewport/canvas/CanvasPreview/interaction/targets.test.ts` | 新規。上のテスト |

- **上流の更新で気をつける点:**
  - `selectionLeads` の内容モードの条件が上流で変わったら、`contentSelectionLeads` に移し、`el.level === 'resource'` を残す。
  - 上流が画像のクリックを別の形でリソースパネルにつなぐようになったら、この変更を消す。
- **確かめるテスト:** `targets.test.ts` と `src/selection`、`src/viewport/canvas`。そのうえで、編集画面で画像をクリックしてリソース詳細が開くことを見る。

### 1-5. コードの行の種類（追加・削除・注目・エラー・警告）と行頭の記号（codeStyle.lineKinds）

- **目的:** デザインシステムの行注釈6種（`//addstart` など、契約 #6818）を組版で見分けるため。上流の行の強調は `highlight` の1種類（1色の帯）しかない。追加・削除の行頭に「+」「-」を付け、記号のない行には同じ幅の空白を入れて、桁とインデントをそろえる。
- **計画とPR:** CORE-230
- **変えたファイル:**

  | ファイル | 変更 |
  |---|---|
  | `packages/postext/src/types/text/code.ts` | `CodeLineKind`、`CodeLineKindStyle`（background・marker・bold・prefix・prefixColor）、`codeStyle.lineKinds` を追加 |
  | `packages/postext/src/defaults/text/codeStyle.ts` | `CODE_LINE_KINDS`（重なったときの優先順）、`lineKinds` の解決と、既定値の除去 |
  | `packages/postext/src/checks/configWarnings/unknownKeys.ts` | `lineKinds` とその中のキーを、知っているキーに追加 |
  | `packages/postext/src/pipeline/code/codeLines.ts` | フェンスの属性 `add`・`del`・`focus`・`error`・`warning` を読む（`kinds`）。種類の太字。行頭の記号の欄（`codePrefixColumn`）を、コピーされない leader として各行の先頭に置き、その幅だけ測りを狭める |
  | `packages/postext/src/vdt/lines.ts` | `codeLine.kind` を追加 |
  | `packages/postext/src/pipeline/callouts/calloutLayout/childPlace.ts` | 帯を集めるとき、種類と強調の有無も渡す |
  | `packages/postext/src/pipeline/callouts/calloutLayout/boxDecoration.ts` | 種類ごとの帯と左端の線（1.5pt）を塗る。黒地（箱の背景、または外側の箱の背景が暗い）では、明るい帯を塗らず線と記号だけにする |
  | `packages/postext/src/pipeline/callouts/calloutLayout/inputs.ts`・`childGroups.ts`・`layoutCallout.ts` | 入れ子の箱へ、外側の箱の背景色（`ground`）を渡す。帯の型の変更 |
  | `packages/postext/src/word/semantic/media/code.ts` | Word の出力でも、種類の背景と行頭の記号を付ける |
  | `packages/postext/src/__tests__/pipeline/code/codeLineKinds.test.ts` | 新規。上のテスト |

- **上流の更新で気をつける点:**
  - 上流のコードの組版（`codeLines.ts` の `runsAt`・`push`・折り返し）が変わったら、記号の欄（`prefixSegment` と `lead`）の差し込み位置を合わせ直す。
  - 上流が行の種類や差分表示を入れたら、そちらに寄せて、この変更を消す。取り込み（`apps/books/src/outline/convert.ts`）の属性名も合わせる。
  - 既定では `lineKinds` が空で、上流の表示は変わらない。
- **確かめるテスト:** `codeLineKinds.test.ts` と `src/__tests__/pipeline/code`・`callouts`。そのうえで、6種を使った見本をCLIでPDFに組み、帯・線・記号・桁の揃いを見る。

## 2. 自社が足したファイル

上流にないファイルなので、上流の更新で衝突しません。上流のビルドの仕組み（turbo・pnpm）が変わったときだけ見直します。

| ファイル | 中身 | PR |
|---|---|---|
| `apps/books/` | 書籍アプリ。データベース保存、Outline取り込み、版、デザインの保存、R2の資産 | #1〜#17 |
| `Dockerfile.imagepit` | `apps/books` のamd64イメージ。起動時にマイグレーションを適用する | #1・#2・#15・#17 |
| `.dockerignore` | イメージのビルドに要らないものを外す | #1 |
| `.github/workflows/imagepit-image.yml` | イメージのビルドと起動確認 | #1 |
| `IMAGEPIT.md` | フォークの方針と追従の手順 | #1 |
| `IMAGEPIT-PATCHES.md` | この一覧 | このファイルを足したPR |

このほか、ワークスペースの設定を2つ変えています。

- `pnpm-workspace.yaml`: `allowBuilds` に `esbuild: false` を足した（#2）。上流がこの欄を変えたら、両方を残す。
- `pnpm-lock.yaml`: `apps/books` の依存（`drizzle-orm`・`pg`・`next-intl`・`aws4fetch` など）が入る。上流の版を上げたら、競合は解かずに `pnpm install` で作り直す。

## 3. 上流に依存している箇所

`apps/books` は上流のファイルを複製せず、次のものを直接使います。上流がこれらの名前や形を変えると、衝突はしないまま、ビルドか動作が壊れます。版を上げたら必ず確かめます。

| 使っているもの | 使っている場所 | 壊れたときの症状 |
|---|---|---|
| `postext` の型 `PostextConfig`・`Resource`・`DesignPart`（テストでは `extractDesign`・`extractFrontmatter` も使う） | `src/books/bundle.ts`、`src/designs/model.ts`、`src/db/schema.ts` | 型エラー |
| `postext/bundle` の `createBundle`・`openBundle`・`openBundleZip`・`zipBundle`・`bundleFileMime`・`MANIFEST_FILE` | `src/books/bundle.ts`、`src/storage/zipSplit.ts`、`src/designs/repository.ts`、`src/editor/BookEditor.tsx` | 本の保存・読み込み・版・デザインの保存の失敗 |
| `postext-sandbox` の `PostextSandbox`・`DEFAULT_MARKDOWN_JA`・`setSavedDesignStorage`、型 `SandboxBookBridge`・`SandboxLabels`・`SavedDesign*` | `src/sandbox/BooksSandbox.tsx`、`src/editor/`、`src/designs/` | 編集画面が開かない |
| `apps/web/messages/ja.json` と `apps/web/src/components/sandbox/SandboxPage/labels.ts` の `buildSandboxLabels` | `src/sandbox/labels.ts` | 編集画面の日本語が出ない、ビルドの失敗 |
| `apps/web/src/app/globals.css` | `src/app/globals.css` | 色や書体が崩れる |
| `.postext` の中の資産のパス（`resources/<リソースID>.<拡張子>`） | `src/storage/`、Outline取り込み | Outlineの画像を原本として参照できず、複製になる |

`.postext` のパスは、Sandboxが保存し直すときにリソースIDの名前へ付け替えます。CORE-215では、この付け替えに気づかず、Outlineの画像がすべて複製に振り分けられた不具合がありました（[#16](https://github.com/imagepit/postext/pull/16)で修正）。上流がパスの付け方を変えたら、`src/storage/` と取り込みの処理を見直します。

## 4. 本体を変えずに実現したもの

次のものは本体を変えずに、設定やフォントで作りました。上流の更新で衝突はしません。ただし、設定の項目名や動きが変わると見た目が崩れるので、教材を組んで確かめます。

| もの | 作り方 | 置き場所 |
|---|---|---|
| 教材のデザイン（見出し、囲みのピル、手順の丸番号と縦線、ターミナルの囲み、細い罫線） | `calloutStyles` の `design`（テキスト要素の枠と負のオフセット）、`label` の `offset` で場所を確保する見えないタブ、`step-item` の入れ子の囲み | 公開中の本の設定と、保存したデザイン「IMAGEPIT 教材テキスト」 |
| 和文と英字・コードの書体 | 合成フォント IMAGEPIT Sans（Geist＋IBM Plex Sans JP）と IMAGEPIT Mono（Geist Mono＋IBM Plex Sans JP。合字は `->` と注釈の矢印だけ） | 本と保存したデザインに入っている（R2の `postext-assets`）。欠ける記号は `symbolFont` の Noto Sans JP で補う |
| AIによる画像幅の調整 | Sandboxの WebMCP ツール（`window.postextWebMcp` の `sandbox_get_warnings`・`sandbox_save_resource` など） | imagepit/imagepit の `claude-env/skills/postext-image-fit` |

WebMCPのツール名と引数は上流が決めています。版を上げたら、`postext-image-fit` スキルの `references/webmcp-tools.md` に書いたツールが、同じ名前と引数で使えるかを確かめます。

## 版を上げたときの確認

[IMAGEPIT.md](IMAGEPIT.md) の「上流の新しい版へ追従する」の手順に、次を足して確かめます。

1. 1章の4件について、衝突を解いた後に該当のテストを通す。
   - `hostBridge.test.ts`
   - `designStore.test.ts`
   - `codeAnnotations.test.ts`
   - `targets.test.ts`
2. `apps/books` のテストを、開発用のPostgreSQLを起動して全件通す。

   ```bash
   docker compose -f apps/books/docker-compose.dev.yml up -d
   corepack pnpm --dir apps/books exec vitest run
   ```

3. `apps/books` の型チェックとビルドを通す。3章の依存先が変わっていれば、ここで見つかる。
4. 公開中の教材「Git基礎研修 テキスト」の `.postext` をCLIでPDFに組み、版を上げる前と比べる。比べるのは、頁数・警告の件数・見た目の3つ。
5. 編集画面で次を確かめる。
   - 本を開き、保存し、別の端末で開き直せる。
   - デザインを保存し、別の端末から適用できる。
   - Outlineから取り込める。
6. 1章の変更のうち、上流に同じ機能が入ったものは消し、この一覧からも外す。

このファイルは、本体に変更を加えたとき、または版を上げたときに更新します。
