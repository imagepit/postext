```yaml
title: Gitの基本操作
draft: false
outline_poc_id: 56e8aa7745cbb3e8ab7d
```

{{ toch3 }}

## ローカルリポジトリを作る

練習として自分のPCにGitのローカルリポジトリを作成してみます。ローカルリポジトリは次の手順で作成します。


1. フォルダを作成
2. Gitローカルリポジトリ作成コマンド（`git init`）実行

:::step
1. フォルダの作成

   まずは任意の場所（デスクトップなど）に「git-text」という名前のフォルダを作成します。

   ![git-testフォルダの作成](/api/attachments.redirect?id=65feaeab-9dc6-4e19-ac4b-bcb721c5ca33)
2. Gitリポジトリを作成

   ターミナルに下記のコマンドを入力してローカルリポジトリを作成します。

   *コマンド実行*

   ```bash
   git init
   ```

   次のように「`Initialized empty Git repository`」と表示されればローカルリポジトリの作成が完了です。

   ![](/api/attachments.redirect?id=16a272a4-3618-4fb6-826e-13236ae242b9){w=80}

:::

:::syntax ローカルリポジトリの初期化
ローカルリポジトリにしたいフォルダを作成し、次のコマンドを入力してローカルリポジトリを作成します。

```
git init
```

:::

//clearpage


:::note .gitフォルダについて
リポジトリに指定されたフォルダには「.git」というフォルダが作成されます。

 ![.gitフォルダの確認](/api/attachments.redirect?id=0c359496-0938-44b5-b871-1c485a9cd259)

| 項目  | 内容  |
|-----|-----|
| Graph | コミットの履歴をグラフで表示 |
| `Commit` | **コミット**のハッシュ値 |

:::

### 複数ファイルを同時にコミット

*index.html（25行目あたり）*

```html
  <div class="content">
    //delstart
    <h1 class="hedding01">当ホテルからのご案内</h1>
    //delend
    //addstart
    <h1 class="heading01">当ホテルからのご案内</h1>
    //addend
    <p>インターネットで予約すると、特別料金でご宿泊いただけます。</p>
  </div>
```

#### リモートからローカルにプルする

* テキストファイルでなく、バイナリファイルの場合は管理しない方が都合がいい場合がある
  * Javaの.classファイルなど
