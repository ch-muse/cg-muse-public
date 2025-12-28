# CG Muse — CONSTRAINTS

このドキュメントは、CG Muse の実装・拡張時に必ず守る制約と、Phase 3（Prompt UX / 翻訳 / tagcomplete）での事故防止ルールを定義します。

## 1. 開発ルール（全タスク共通）
- 1タスク = 1テーマ（スコープを混ぜない）
- 1タスクでの変更ファイルは最大20
- 全体作り直し・大規模リファクタ禁止（小さく積む）
- 既存挙動の破壊は避け、UI/UX は段階的に改善する

### 1.1 GitHub事故防止（runtime data）
- repo 配下に runtime data を保存する場合は **必ず .gitignore 対象にする**
- 可能な限り repo 外へ逃がす（環境変数/OS標準ディレクトリを優先）
- 生成物・アップロード物は “runtime data” として扱い、テンプレ/静的資材のみ repo 管理

### 1.2 index.ts 分割（移動のみ）
- ルーティング/挙動/レスポンス形式は **変更しない**
- 差分は「移動」と「薄いラッパー化」に限定する（ロジック改変禁止）
- 既存のエラーハンドリング・ミドルウェア順序を維持する

## 2. ネットワーク / fetch（Web/Server 共通）
不具合の大半が「fetchが終端しない・並走する・古い応答で上書きされる」なので、以下を必須とする。

- timeout + AbortController を必ず入れる（UIが固まらないこと）
- in-flight 排他（同一キーのリクエストは前回完了まで次を開始しない）
- stale 更新破棄（requestId/sequence を比較して古い応答を捨てる）
- polling は再帰 setTimeout のみ（setInterval 並走禁止）
- Debug 表示（必要な画面のみ）
  - `phase / lastUpdatedAt / lastHttpStatus / lastError / lastRawText（先頭N文字）` を統一

## 3. ストレージ（IndexedDB）
tagcomplete / 翻訳の永続キャッシュはブラウザ（IndexedDB）に保存する。

共通
- DB名: `muse`
- version: `1`
- store: `kv`（key-value の単一ストア）

### 3.1 Tag Dictionary（tagcomplete）
- key: `muse.tagDictionary.v1`
- value: `{ entries: TagDictionaryStoredEntry[], savedAt: string }`
- `TagDictionaryStoredEntry`:
  - `tag: string`
  - `type?: string`
  - `count?: number`
  - `aliases: string[]`

### 3.2 Tag Translation Cache（永続）
- key: `muse.tagTranslations.v1`
- value: `{ entries: TagTranslationStoredEntry[], savedAt: string }`
- `TagTranslationStoredEntry`:
  - `tag: string`
  - `ja: string`
  - `source: "tagcomplete" | "observed" | "manual"`
  - `observedCount?: number`
  - `lastUsedAt?: string`
  - `pinned?: boolean`

永続キャッシュ昇格条件（重要）
- 永続に書き込むのは次のいずれかを満たす場合のみ:
  1) tagcomplete に存在する tag
  2) observedCount >= 2（同一タグが2回以上観測）
  3) Internals で manual/pinned として登録されたもの
- 誤字・一回だけの入力は永続化しない（メモリキャッシュのみ）

サイズ・劣化対策
- 永続 translation cache は無制限に増やさない（上限・削除戦略を設ける）
  - 例: 非pinnedを LRU（lastUsedAt）で上限 10,000 件まで
  - purge/compaction は “画面が固まらない” 範囲で行う（必要なら分割実行）

## 4. Phase 3（Prompt UX）実装の制約
### 4.1 Prompt Composer
- token の入れ替えは DnD を主とし、↑↓等の入れ替えボタンは置かない
- DnD 時は drop indicator を必須（挿入位置が明確であること）
- 削除ボタンは誤タップしにくいサイズ（×を小さくしすぎない）
- 入力欄への貼り付けで `1girl,solo` のようなカンマ区切りを分割できること
- positive / negative それぞれワンボタンで全消去できること

### 4.2 翻訳（Ollama）
- トークン化された時点で必ず翻訳を試行し、未翻訳 token を残さない（pending/done/error のいずれか）
- in-flight 排他 + キャッシュ（メモリ + 永続）は必須
- 再翻訳（force）を chip 単体で実行できること
- API が遅い/失敗しても UI が固まらず、失敗理由が分かること（簡素でよい）

## 5. Internals（管理画面）
- `/internals/tagcomplete`（辞書管理）
- `/internals/translations`（永続翻訳キャッシュ管理）
- Internals は「後で追加・削除・変更できる」ことを最優先し、UIは簡素でよい
- 破壊的操作（clear/大量削除）は確認を必須とする

---

## 6. Gallery / Import（制約）
- フォルダ取り込みは **許可した root 配下のみ**アクセス可（任意パス禁止）
- 外部画像は **MUSE_DATA_DIR 配下へサムネのみコピー**（原本は参照でもコピーでも良いが、Git 管理対象へ入れない）
- Gallery 一覧は **必ず pagination + 検索**（20,000 件でも落ちないこと）
- 編集画面は全件を一括で DOM 展開しない（virtual list またはページング）
- 画像配信は static / readFile のいずれでも良いが、**パス検証必須**
  - `resolve` 後に root 内判定を行う（パストラバーサル禁止）

---

## Phase 4 追加制約（Comfy Runner i2i / Workshop tagger）

### D1. ワークフロー管理
- Phase 4 で追加する workflow JSON は **リポジトリ直下に存在する前提**で取り込み、`apps/api/data/comfy/workflows/` 配下へ移動して管理する。
- `base_image2i.json` と `tagger_only.json` のファイル名は固定し、読み込み先はコード内で明示する（パス推測禁止）。

### D2. i2i の固定ノード
- `base_image2i.json` の node `"118"` と `"123"` は **Runner 側で上書き禁止**。
- i2i の width/height はテンプレ（ノード接続）に委ね、Runner 側の入力値で強制しない。

### D3. denoise の適用範囲
- denoise をユーザー操作で変更できるのは **i2i のみ**。
- t2i では denoise を UI から送らない／受け取っても無視する（テンプレ値固定）。

### D4. Tagger API の堅牢性
- `POST /api/comfy/tagger` は、タグ出力ノードの形式が揺れても壊れにくいように実装する。
  - history の outputs から「タグらしい文字列」を抽出するフォールバックを必ず持つ
  - 抽出に失敗した場合は `ok:false` とし、デバッグ可能な最小限の raw（先頭 N 文字など）を返す

### D5. タイムアウト / ポーリング
- ComfyUI へのアクセスは必ず timeout を設定する。
- Tagger は API 側で完了待ちポーリングを行うが、無限待ちは禁止（全体上限時間を設ける）。
- runs/history のポーリングも上限時間を必須とし、タイムアウト時は失敗として扱えること。
