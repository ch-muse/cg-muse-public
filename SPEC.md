# CG Muse — SPEC (MVP + Phase 3 Prompt UX)

このリポジトリは、ローカル実行前提の “CG制作支援ツール群” を 1つの Web UI にまとめた **個人用アプリ**です。
目的は「管理」ではなく、制作の速度と楽しさを上げることです。

- Monorepo（pnpm）
- API: Node.js + Express + TypeScript
- Web: Vite + React + TypeScript + Tailwind CSS
- DB: Postgres（Docker）
- ローカル連携: Ollama / whisper.cpp / ComfyUI

---

## 1. 画面とモジュール

### 1.1 共通
- 左ナビ（またはヘッダ）に以下を並べる:
  - Muse
  - Workshop
  - Comfy Runner
  - Whisper
  - Internals

### 1.2 Muse
- 画面: `/play/muse`
- LLM（Ollama）でアイデア出しを行う。
- セッション、履歴、Liked などは「最低限の可視化/回収導線」として扱う。

### 1.3 Workshop
“集めた素材（LoRA / Recipe）を管理のためではなく、**制作補助のために再利用**する” ための置き場。

- 画面:
  - `/workshop/loras`（LoRAライブラリ）
  - `/workshop/recipes`（レシピ）
- LoRA/Recipe それぞれ代表サムネイル 1 枚を表示できる。

### 1.4 Whisper
- 画面: `/play/whisper`
- whisper.cpp（whisper-cli.exe）を使い、音声 → テキスト（書き起こし）を行う。

### 1.5 Comfy Runner（Text2Img）
- 画面: `/play/comfy`
- ComfyUI の既存テンプレ workflow を **必要最低限のパラメータ差し込み**で実行する。
- “汎用エディタ” は作らない（ノード編集/配線/UI自動生成は非スコープ）。

### 1.6 Navigation
- ヘッダーにも左サイドにもナビを表示する。
- カテゴリ（グループ）単位で折りたたみ展開でき、クリックで展開する。
- 同一の nav 定義からヘッダー/サイドの双方を描画し、重複実装しない。

---

## 2. Runtime Data / Storage
- 生成物・アップロード物（Whisper音声、Workshop画像、Recipe/LoRAサムネ等）は “runtime data” として扱う。
- runtime data の保存先は環境変数で指定可能（例: `MUSE_DATA_DIR`）。
- デフォルトは OS 標準のユーザーデータ領域（Windows なら `%LOCALAPPDATA%` 配下など）を推奨し、リポジトリ外を基本とする。
- 互換のため `MEDIA_DIR` など個別上書きがある場合は **個別 > `MUSE_DATA_DIR` > OS 標準** の順で優先する。
- テンプレ/静的資材（workflow JSON など）は引き続きリポジトリ管理とする。

## 3. ローカル連携（外部プロセス）

### 3.1 Ollama
- API は `OLLAMA_BASE_URL` を参照する（デフォルト `http://127.0.0.1:11434`）。

### 3.2 whisper.cpp
- `WHISPER_BIN_DIR` 例: `C:\AI\whisper.cpp\build\bin`
- `WHISPER_MODELS_DIR` 例: `C:\AI\whisper.cpp\models`
- ffmpeg で音声を 16kHz/mono/pcm_s16le に正規化してから whisper に渡す。

### 3.3 ComfyUI
- ComfyUI base URL: `COMFY_BASE_URL`（デフォルト `http://127.0.0.1:8188`）
- テンプレ workflow: `apps/api/data/comfy/workflows/base_text2i.json`（MVP では 1つ固定）

Comfy Runner は以下を使う:
- 候補取得: `GET /object_info/{node_class}`
- 実行投入: `POST /prompt`
- 状態/成果物取得: `GET /history/{prompt_id}` と `GET /view?...`

---

## 4. Workshop（LoRA / Recipe）

### 4.1 LoRA ライブラリ
- LoRA は **ファイル名（例: `my_lora.safetensors`）** をキーに、以下を保持できる:
  - 表示名（任意）
  - trigger words（カンマ区切り文字列 or string[]）
  - メモ（任意）
  - 代表サムネ 1 枚（任意）

#### 重要（Comfy Runner との連携）
- Comfy Runner の LoRA 選択候補（ComfyUI object_info 由来）と Workshop LoRA を **ファイル名で突合**できること。
- Comfy Runner 側で「Insert triggers」操作ができること（positive prompt に追記）。

### 4.2 Recipe
- recipe は “生成の型”。
- LoRA の組み合わせ・強さ、ControlNet の前処理/モデル、推奨サイズなどを保持できる。

---

## 5. Comfy Runner（仕様詳細）

### 5.1 テンプレ workflow（base_text2i.json）
前提:
- テンプレは Git 管理しやすい場所に置く:
  - `apps/api/data/comfy/workflows/base_text2i.json`
- テンプレに含まれる主要ノード（例）:
  - Efficient Loader（ckpt / positive / negative / width / height / vae_name / batch_size / lora_stack / cnet_stack）
  - KSampler (Efficient)
  - LoRA Stacker
  - ControlNetLoader / ControlNetPreprocessorSelector / LoadImage / ControlNet Stacker

差し込みポリシー:
- Efficient Loader の `vae_name` と `batch_size` はテンプレ値固定（UIに出さない・上書き禁止）。
- KSampler は **普段は折りたたみ（Advanced）**。必要時のみ変更できる。

### 5.2 API（Comfy Runner）
#### 5.2.1 object_info proxy
- `GET /api/comfy/object-info/:nodeClass`
  - ComfyUI の `GET /object_info/{nodeClass}` をそのままプロキシ
  - 60s 程度の簡易キャッシュは可（nodeClass 単位）

#### 5.2.2 runs（履歴）
- `POST /api/comfy/runs`（multipart/form-data）
  - テンプレ workflow を deep clone
  - whitelist に従って inputs を上書き
  - `POST /prompt` で ComfyUI に投入
  - `prompt_id` を保存し、run を `queued` で返す
- `GET /api/comfy/runs`（一覧、updated_at desc）
- `GET /api/comfy/runs/:id`（詳細）
- `DELETE /api/comfy/runs/:id`（履歴削除）

#### 5.2.3 status 更新（history 反映）
- `GET /api/comfy/runs` 取得時、もしくは Web 側ポーリング時に、
  `queued/running` の run のみ `GET /history/{prompt_id}` を照会して結果を取り込む。
- 生成には 1分以上かかるケースがあるため、**history が空でも即 failed にしない**。
  - 例: `history_empty` は `running` として一定時間リトライし、タイムアウトを超えた場合にのみ failed。

#### 5.2.4 画像表示 proxy
- `GET /api/comfy/view?filename=...&subfolder=...&type=...`
  - ComfyUI の `/view` を proxy
  - パラメータは whitelist（パストラバーサル禁止）

### 5.3 Web UI（/play/comfy）
#### 5.3.1 入力フォーム（最小）
- Checkpoint（ckpt）
- Positive / Negative prompt
- Width / Height + Swap
- LoRA（複数）
  - enabled toggle / 検索 or dropdown / weight
- ControlNet
  - 既定 disabled
  - enabled toggle
  - image file
  - preprocessorEnabled toggle（既定 disabled）+ preprocessor 選択
  - controlnet model 選択
  - strength

- Advanced（折りたたみ）: KSampler
  - steps / cfg / sampler_name / scheduler / seed / denoise
  - 初期値はテンプレと一致させる
  - seed の “ランダム” は `-1` ではなく、**クライアントで 0 以上の整数を生成して投入**する（ComfyUI の validation 仕様に従う）

#### 5.3.2 実行
- Run ボタンは視認性優先で大きめにする。
- 二重送信防止（in-flight 排他）
- Cancel は非対応（非スコープ）

#### 5.3.3 runs 一覧/詳細
- すべての status（queued/running/succeeded/failed）を表示
- 行クリックで Details 展開
  - 成果物サムネ（先頭1枚）
  - Open image（新タブ）
  - stdout tail（通常表示）
  - stderr tail はデバッグ欄のみ（通常 UI からは除外）
  - errorMessage があれば表示
- 削除（履歴削除）

---

## 6. Phase 3: Prompt UX（タグ補完 + トークン編集）

### 6.1 ゴール
- “textarea にダラダラ入力” をやめ、**単語（tag）単位で扱える UI**にする。
- 具体的には:
  - `masterpiece, 1girl, ...` を分離表示（chips）
  - 1語単位の削除、順番入れ替え、編集
  - 入力候補（autocomplete）
  - （任意）翻訳表示

### 6.2 Prompt Composer（MVP）
- positive / negative それぞれに “Composer” を提供（同一コンポーネント）
- 表示:
  - chips（token）一覧 + 末尾に入力欄
  - “Raw” 表示切替（生テキストも見られる）
  - Clear ボタン（positive / negative をそれぞれワンボタンで全消去）
- 操作:
  - 追加（Enter/Tab/カンマ入力で確定）
  - **貼り付け対応**: 入力欄へ `1girl,solo` のようなカンマ区切り文字列を貼り付けた場合も、複数 token に分割して取り込む
  - 削除（chipの削除ボタン。誤タップしにくいサイズにする）
  - 入れ替え（**ドラッグ & ドロップを主**。↑↓ボタン等の入れ替えUIは置かない）
    - DnD 時に「どこへ移るか」が分かる drop indicator（挿入位置のハイライト/ガイド）を必須とする
  - 編集（chipクリック → インライン編集）
- 生成時に API に送るのは **最終的な raw string**（カンマ区切り）

### 6.3 Tag Autocomplete（MVP）
- tag dictionary は “巨大データをリポジトリに同梱しない”。
- ユーザーが手元で入手した tag DB を **ブラウザから import** して使えるようにする。
  - 例: a1111-sd-webui-tagcomplete 相当の `tags.csv`（`tag,type,count,aliases`）
- import 後は IndexedDB に保存し、次回起動で復元できる。

保存仕様（IndexedDB）
- DB名: `muse`
- version: `1`
- store: `kv`（key-value の単一ストア）
- key: `muse.tagDictionary.v1`
- value: `{ entries: TagDictionaryStoredEntry[], savedAt: string }`
- `TagDictionaryStoredEntry`:
  - `tag: string`
  - `type?: string`
  - `count?: number`
  - `aliases: string[]`

候補表示
- prefix一致（高速）
- 上位N件表示（例: 30）
- `count` があるなら多い順優先
- alias も検索対象に含める（存在する場合）

Internals（管理）
- `/internals/tagcomplete` を提供し、tag dictionary を管理できること:
  - 検索/閲覧（件数、保存日時）
  - 追加/編集/削除（tag/type/count/aliases）
  - JSON export / import（復旧用。CSV import とは別）


### 6.4 翻訳（必須 / Ollama）
- CSV 事前リスト方式は廃止。Ollama で tag → 日本語を自動翻訳する。
- **トークン化された時点で必ず翻訳を試行**し、未翻訳 token を残さない（pending/done/error のいずれかに収束）。
  - pending は "..." などの placeholder でよい。
- 再翻訳（強制・キャッシュ無視）を chip 単体で提供（任意で Re-translate all）。
- 速度のため、キャッシュ（メモリ + 永続）と in-flight 排他は必須。

API（サーバ側で Ollama 呼び出し）
- `POST /api/ollama/translate-tags`
  - body: `{ tags: string[] }`
  - return: `{ ok: true, data: { translations: Record<string,string> } }`
- モデル:
  - 既定: `OLLAMA_TRANSLATE_MODEL`（例: `qwen2.5-translator` など）
- プロンプト方針（SDタグ翻訳）
  - カンマ区切りタグを日本語で短く
  - 技術用語/固有名詞は無理に意訳しない
  - 出力は **JSONのみ**（パース失敗時は JSON 部分抽出を1回だけ試みる）

永続キャッシュ（MVP）
- Web 側で translation cache を **永続化**し、再起動後も再利用できる。
- 永続キャッシュへの昇格（書き込み）条件:
  1) `tagcomplete`（5.3）に **存在する tag**、または
  2) 同一 tag が **2回以上観測**された場合（observedCount >= 2）
- 誤字・一発だけの入力で “変なレコードが永遠に残る” ことを避けるため、昇格条件を満たさない tag は **メモリキャッシュのみ**とする。
- 例外として、Internals で “手動追加/ピン留め” した translation は常に永続化される。

保存仕様（IndexedDB）
- DB名: `muse`
- version: `1`
- store: `kv`
- key: `muse.tagTranslations.v1`
- value: `{ entries: TagTranslationStoredEntry[], savedAt: string }`
- `TagTranslationStoredEntry`:
  - `tag: string`（キー）
  - `ja: string`
  - `source: "tagcomplete" | "observed" | "manual"`
  - `observedCount?: number`
  - `lastUsedAt?: string`
  - `pinned?: boolean`

Internals（管理）
- `/internals/translations` を提供し、永続 translation cache を管理できること:
  - 検索/閲覧（件数、保存日時）
  - 追加/編集/削除（tag/ja/source/pinned）
  - “再翻訳（API呼び出し）→上書き保存” の実行
  - JSON export / import

UI 表示
- chip のサブラベルまたは tooltip で日本語を表示（通常表示はスッキリ）
- 失敗時は chip 内に簡易エラー（例: `!` + tooltip）で良い


## 7. Gallery / Import / Recipe → Run

### 7.1 Gallery Item（統一モデル）
- Gallery Item は runs 由来 / フォルダ由来を同一モデルとして扱う（一覧/UI の表示契約を統一）。
- `GalleryItem`（最低限の共通フィールド）:
  - `id`: uuid
  - `source_type`: `run` | `folder`
  - `source_id`: run_id or folder_item_id
  - `image_key`: MUSE_DATA_DIR 配下の相対キー
  - `thumb_key?`: text
  - `image_created_at?`: timestamp（生成 or ファイル由来の作成日時）
  - `width?` / `height?` / `mime?`
  - `favorite`: boolean
  - `recipe_id?`: uuid（run 由来のみ）
  - `meta_extracted`: jsonb（抽出結果）
  - `meta_overrides`: jsonb（ユーザー編集）
  - `needs_review`: boolean（抽出失敗/未抽出の救済フラグ）
  - `created_at` / `updated_at`

#### 7.1.1 生成メタ（抽出 / 上書き / 有効）
- `meta_extracted` は画像/履歴から抽出した結果を保存する。
- `meta_overrides` は UI からの後編集のみを保存する（抽出結果は上書きしない）。
- 表示・検索・編集の既定値は `effective = overrides > extracted` の優先で合成する。
- 保持対象（代表例）:
  - `ckpt`, `loras`, `positive`, `negative`, `seed`, `steps`, `cfg`, `sampler`, `scheduler`, `model_hashes` など

#### 7.1.2 抽出 → 保存 → 後編集 → 再抽出（必要時）
- 抽出はまず `meta_extracted` に保存し、UI での編集は `meta_overrides` に保存する。
- 必要に応じて「再抽出」を実行し、`meta_extracted` を更新しても `meta_overrides` は保持する。
- 表示は常に `effective = overrides > extracted` を使う。

### 7.2 Gallery API
- `GET /api/gallery/items`
  - pagination 必須（`limit` + `cursor` or `page`）
  - return: `{ items: GalleryItem[], nextCursor?: string }`
- `GET /api/gallery/sources`
  - 取り込み許可済みの root 一覧を返す（id + 表示名 + path）
- `POST /api/gallery/import`
  - body: `{ source_id, relative_path? }`
  - return: `{ ok: true, imported: number, skipped: number }`
- `POST /api/gallery/rehydrate`
  - body: `{ source_type?, source_id? }`
  - 既存 Gallery Item の再構築/メタ更新（run または folder を対象）
- `POST /api/gallery/favorite`
  - body: `{ item_id, favorite }`
  - favorite の ON/OFF を更新

### 7.3 Recipe → Run
- Recipe 画面から実行する場合は `recipe_id` を付与する。
  - `POST /api/comfy/runs` に `recipe_id` を追加（任意）
  - `comfy_runs` に `recipe_id` を保存（nullable）
- run 由来の Gallery Item は `recipe_id` を引き継ぎ、Recipe への紐付けを維持する。

### 7.4 データ保存場所
- Gallery/Import/Recipe の runtime data（import index/thumbnail/コピー等）は **必ず `MUSE_DATA_DIR` 配下**に置く。
- repo 配下への保存は禁止（テンプレ/静的資材を除く）。

### 7.5 メタデータ抽出（Gallery）
- 対応パターン:
  - PNG parameters（A1111）
  - PNG iTXt: prompt / workflow（ComfyUI 埋め込みがある場合）
  - ComfyUI `/history` を filename 逆引き（画像単体にメタが無い場合の救済）
- 何も取れない場合は `meta_extracted` を空で保存し、`needs_review=true` とする。

---

## 8. データモデル（抜粋）

### 8.1 comfy_runs（既存）
- id: uuid (PK)
- status: text (queued/running/succeeded/failed)
- prompt_id: text (ComfyUI prompt_id)
- params: jsonb（入力パラメータの保存）
- result: jsonb（history から抽出した成果物・メタ情報）
- created_at, updated_at

### 8.2 loras（Workshop）
- id: uuid (PK)
- file_name: text UNIQUE NOT NULL（例: `foo.safetensors`）
- display_name: text nullable
- trigger_words: text[] NOT NULL default '{}'
- notes: text nullable
- thumbnail_key: text nullable
- created_at, updated_at

---

## 9. 非スコープ（当面やらない）
- 汎用 ComfyUI ワークフローエディタ
- Comfy Runner の Cancel
- 多人数/認証/クラウド同期
- prompt-all-in-one の “全部入り” をそのまま移植（必要なコアだけを実装する）

---

## Phase 4: Comfy Runner i2i 拡張 + Workshop 画像→tagger 連携

### 4.1 追加ワークフロー（リポジトリ直下 → API 管理ディレクトリへ移動）

Phase 4 では、以下 2 ファイルが **リポジトリ直下** に存在する前提で実装を進める（git 管理しやすい名前で固定）。

- `base_image2i.json`（Image2Img 用テンプレ）
  - 追加先: `apps/api/data/comfy/workflows/base_image2i.json`
- `tagger_only.json`（画像→tagger 用テンプレ）
  - 追加先: `apps/api/data/comfy/workflows/tagger_only.json`

### 4.2 Comfy Runner: 参照画像がある場合のみ i2i に切替

#### 挙動
- `/play/comfy` で **initImage（参照画像）** を選択した場合のみ i2i として実行する。
- initImage が未指定の場合は従来通り t2i（`base_text2i`）として実行する。
- i2i では **denoise を操作可能** とする（t2i では denoise を UI から操作しない／テンプレ値固定）。

#### i2i テンプレの重要ノード（`base_image2i.json`）
- Efficient Loader: node `"122"`
  - inputs: `ckpt_name / positive / negative / lora_stack / cnet_stack`
  - `vae_name` と `batch_size` はテンプレ固定（UI 非表示・上書き禁止）
- KSampler (Efficient): node `"3"`
  - i2i では `denoise` を UI で変更可能
- init image:
  - LoadImage: node `"117"`（init image）
  - ImageResize+: node `"118"` **固定**
  - ImageResize+: node `"123"` **固定**
- VAEEncode: node `"119"`（latent_image）
- ControlNet（t2i と同様に Runner 側で ON/OFF 可能）
  - ControlNetLoader: node `"83"`
  - ControlNetPreprocessorSelector: node `"112"`
  - AIO_Preprocessor: node `"113"`
  - LoadImage: node `"114"`（controlnet image）
  - Control Net Stacker: node `"104"`（strength, image）

#### 118/123 の固定要件
- node `"118"` と node `"123"` は **Runner 側で上書き禁止**。
- サイズ上限/下限（例: 上限 2047, 下限 1300）はテンプレに従い固定する（i2i のサイズ調整はテンプレ側で吸収）。

### 4.3 API: i2i 対応（/api/comfy/runs）

- `POST /api/comfy/runs` の入力に `initImage`（任意ファイル）を追加する。
- `initImage` が存在する場合:
  - 使用テンプレ: `apps/api/data/comfy/workflows/base_image2i.json`
  - node `"117"` の `image` をアップロードしたファイル名へ差し替える
  - denoise を request から反映（node `"3"` の `denoise`）
  - width/height はテンプレ接続に従う（Runner 側で上書きしない）
- `initImage` が存在しない場合:
  - 使用テンプレ: `apps/api/data/comfy/workflows/base_text2i.json`
  - 従来通り width/height を node `"91"` の `empty_latent_width/height` に反映
- ControlNet の ON/OFF は t2i と i2i で同一仕様（enabled=false の場合は node `"104"` strength=0）

### 4.4 API: 画像→tagger（Workshop 用）

- 新規: `POST /api/comfy/tagger`（multipart/form-data）
  - input: `image`（必須ファイル）
  - 挙動:
    1) `apps/api/data/comfy/workflows/tagger_only.json` を読み込み deep clone
    2) LoadImage node `"1"` の `image` をアップロードしたファイル名へ差し替え
    3) ComfyUI に `/prompt` を投入し、prompt_id を取得
    4) `/history/{prompt_id}` を一定間隔でポーリングして完了を待つ（上限時間あり）
    5) history からタグ文字列を抽出し、`{ tags: string }` を返す
  - 抽出は「キー名が不明でも壊れにくい」ように、history.outputs を走査してタグらしい文字列（カンマ区切り・長文）を選ぶ。

### 4.5 Web: Workshop Recipe 新規作成で tagger 結果を Positive に反映

- Recipe 新規作成フォームで画像を選択し、`/api/comfy/tagger` を呼び出して tags を取得する。
- 取得した tags を Positive prompt textarea に反映し、ユーザーが編集して保存できるようにする。
- 同じ画像ファイルを Recipe のサムネイルとして保存する（既存の thumbnail upload API を利用）。
