# IMAGEPITのフォークについて

このリポジトリは [drnachio/postext](https://github.com/drnachio/postext) のフォークです。IMAGEPITが自社の書籍を管理、編集、出版するWebアプリを、Postextの組版エンジンと編集画面の上に作ります。全体の計画は Plane の CORE-196 にあります。

## 変更を置く場所

自社の変更は `apps/books` に置きます。上流の `apps/web` と `packages/*` は、必要がない限り変更しません。上流の新しい版を取り込むときの競合を減らすためです。

`apps/books` は上流のファイルを複製せずに参照します。

- 編集画面は、ワークスペースの `postext-sandbox` です。npmには公開されていないため、このリポジトリの中からだけ使えます。
- 画面の日本語の文言は `apps/web/messages/ja.json` と `apps/web/src/components/sandbox/SandboxPage/labels.ts` から組み立てます。
- 色と書体のCSS変数は `apps/web/src/app/globals.css` を取り込みます。

上流がこの3つを動かした場合は、`apps/books/src/sandbox/labels.ts` と `apps/books/src/app/globals.css` の参照先を直します。

## ブランチ

| ブランチ | 用途 |
|---|---|
| `imagepit-v<上流の版>` | 既定ブランチ。上流のタグに自社の変更を載せたもの。現在は `imagepit-v1.82.0` |
| `main` | 上流の `main` の写し。自社の変更を入れない |

作業はトピックブランチで行い、既定ブランチへのPull Requestにします。

## 手元で動かす

Node 22とcorepackが必要です。

```bash
corepack pnpm install
corepack pnpm exec turbo run build --filter=books
corepack pnpm --dir apps/books start
```

`http://localhost:3000` で編集画面が開きます。`/api/health` は起動確認用で、`{"status":"ok"}` を返します。

## コンテナイメージ

`Dockerfile.imagepit` が `apps/books` のイメージを作ります。配備先に合わせて linux/amd64 でビルドします。

```bash
docker buildx build --platform linux/amd64 --load -f Dockerfile.imagepit -t imagepit/postext:local .
docker run --rm -p 3000:3000 imagepit/postext:local
```

`.github/workflows/imagepit-image.yml` は、既定ブランチへのpushとPull Requestで同じビルドを行い、コンテナを起動して `/api/health` と `/` を確かめます。Docker Hubへの発行と配備は imagepit/imagepit リポジトリのワークフローが行います。

## 上流の新しい版へ追従する

1. 上流を取得します。`git fetch upstream --tags`
2. 新しいタグから次の既定ブランチを作ります。`git switch -c imagepit-v<新しい版> v<新しい版>`
3. 現在の既定ブランチにある自社のコミットを載せ替えます。`git cherry-pick v<現在の版>..imagepit-v<現在の版>`
4. ビルドと上流のテストを通します。`corepack pnpm exec turbo run build --filter=books` と `corepack pnpm test:quick`
5. 編集画面を開き、日本語で表示されることと、本文を変えるとページが組み直されることを確かめます。
6. GitHubで既定ブランチを新しいブランチへ切り替えます。imagepit/imagepit の配備ワークフローが参照するブランチ名も合わせて変えます。
