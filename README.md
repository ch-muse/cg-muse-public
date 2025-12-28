# CG Muse (MVP Skeleton)

MVP向けの monorepo スキャフォールドです。仕様は `SPEC.md` と `CONSTRAINTS.md` に従っています。

## クイックスタート（推奨）
- 依存インストール: `pnpm.cmd install`
- `.env` 作成: `cp apps/api/.env.example apps/api/.env` / `cp apps/web/.env.example apps/web/.env`
- 起動: `pnpm dev`（Windows は `start-dev.cmd` をダブルクリックまたは PowerShell からそのまま実行可能）  
  - `pnpm dev --comfy` または `pnpm dev:full` で ComfyUI も同時起動（`COMFYUI_DIR` など環境変数を設定）
  - `pnpm dev --no-comfy` または `pnpm dev:core` で ComfyUI をスキップ
- dev オーケストレーターは Windows では `cmd.exe /c pnpm ...` 経由で呼ぶため、PowerShell の ExecutionPolicy と `pnpm.ps1` 問題を回避できます。
- 起動確認: API `http://localhost:4010/api/health` / Web `http://localhost:5173/play/muse` / ComfyUI（起動時）`http://127.0.0.1:8188/`
- ComfyUI 状態確認・手動起動: Web から `/internals/comfy` を開くと状態が見えて Start/Stop（APIが起動した場合のみ）できます。
- ダブルクリック運用: `start-dev.cmd` を実行 → ブラウザで `/internals/comfy` を開く → Stopped なら Start を押す → Running になったら `http://127.0.0.1:8188/` が開ける（Stop は API が起動した場合のみ）。
- Whisper（文字起こし）: ナビから `/play/whisper` へ移動し、モデル・言語プリセット（auto/ja/en/...）を選んで音声ファイルをアップロード。ffmpeg が PATH に無い場合、任意形式の入力でエラーになります。ジョブ一覧は全ステータスを表示し、行を展開して transcript/stdout/stderr を確認・コピーでき、完了済みジョブは削除できます（実行中は削除不可）。

## 前提
- Node.js 20+
- pnpm 8+
- Docker / Docker Compose
- pnpm が PowerShell で ps1 を拾う場合は `pnpm.cmd` を使う（`pnpm dev` は内部で cmd.exe 経由）

## 手動セットアップ / 個別起動（参考）
1. 依存インストール（初回のみ）  
   ```bash
   pnpm.cmd install
   ```
2. 環境変数ファイルを作成  
   ```bash
   cp apps/api/.env.example apps/api/.env
   cp apps/web/.env.example apps/web/.env
   ```
3. DB起動  
   ```bash
   docker compose up -d
   ```
4. マイグレーション実行  
   ```bash
   pnpm.cmd -C apps/api db:migrate
   ```
5. API起動（別ターミナル）  
   ```bash
   pnpm.cmd -C apps/api dev
   ```
6. Web起動（別ターミナル）  
   ```bash
   pnpm.cmd -C apps/web dev
   ```

## 動作確認
- LLMモデル一覧  
  ```bash
  curl http://localhost:4010/api/llm/models
  ```
  期待レスポンス: `{"ok":true,"data":{"models":[{"name":"llama3:8b",...}]}}`

- セッション作成（PowerShell）  
  ```bash
  curl -X POST http://localhost:4010/api/sessions ^
    -H "Content-Type: application/json" ^
    -d "{\"mode\":\"MUSE\",\"title\":\"Demo\",\"llmModel\":\"llama3:8b\"}"
  ```
  セッション作成（Git Bash / bash）  
  ```bash
  curl -X POST http://localhost:4010/api/sessions \
    -H 'Content-Type: application/json' \
    -d '{"mode":"MUSE","title":"Demo"}'
  ```
  期待レスポンス: `{"ok":true,"data":{"session":{"id":"...","mode":"MUSE","llm_model":"llama3:8b",...}}}`

- Muse生成（`sessionId` は上のレスポンスの uuid を入れる。`<...>` は bash だとリダイレクトになるので使わない）  
  PowerShell:  
  ```bash
  curl -X POST http://localhost:4010/api/muse/generate ^
    -H "Content-Type: application/json" ^
    -d "{\"sessionId\":\"SESSION_UUID_HERE\",\"count\":2}"
  ```
  Git Bash / bash:  
  ```bash
  curl -X POST http://localhost:4010/api/muse/generate \
    -H 'Content-Type: application/json' \
    -d '{"sessionId":"SESSION_UUID_HERE","count":2}'
  ```
  期待レスポンス: `{"ok":true,"data":{"ideas":[{"id":"...","title":"...","description":"..."}]}}`

- Ideaいいね（`<...>` は bash だとリダイレクトになるので使わない）  
  PowerShell:  
  ```bash
  curl -X POST http://localhost:4010/api/ideas/IDEA_UUID_HERE/like ^
    -H "Content-Type: application/json" ^
    -d "{\"liked\":true}"
  ```
  Git Bash / bash:  
  ```bash
  curl -X POST http://localhost:4010/api/ideas/IDEA_UUID_HERE/like \
    -H 'Content-Type: application/json' \
    -d '{"liked":true}'
  ```
  期待レスポンス: `{"ok":true,"data":{"idea":{"id":"<IDEA_ID>","liked\":true,...}}}`

- Health API  
  ```bash
  curl http://localhost:4010/api/health
  ```
  期待レスポンス: `{"ok":true,"data":{"status":"ok"}}`

- いいね済みアイデア一覧  
  ```bash
  curl "http://localhost:4010/api/ideas?liked=true"
  ```

- Workshop API（最小）  
  - LoRA作成  
    ```bash
    curl -X POST http://localhost:4010/api/loras ^
      -H "Content-Type: application/json" ^
      -d "{\"name\":\"sample lora\",\"triggerWords\":[\"sample\"]}"
    ```
  - Recipe作成（空雛形）  
    ```bash
    curl -X POST http://localhost:4010/api/recipes ^
      -H "Content-Type: application/json" ^
      -d "{\"target\":\"SDXL\",\"promptBlocks\":{\"positive\":\"\",\"negative\":\"\"}}"
    ```
  - Recipe作成（Idea import）  
    ```bash
    curl -X POST http://localhost:4010/api/recipes ^
      -H "Content-Type: application/json" ^
      -d "{\"target\":\"SDXL\",\"sourceIdeaId\":\"IDEA_UUID_HERE\"}"
    ```
  - RecipeにLoRAを紐づけ  
    ```bash
    curl -X POST http://localhost:4010/api/recipes/RECIPE_UUID_HERE/loras ^
      -H "Content-Type: application/json" ^
      -d "{\"loraId\":\"LORA_UUID_HERE\",\"weight\":0.7,\"usageNotes\":\"face\"}"
    ```
  - Recipe詳細取得（紐づくLoRAも返す）  
    ```bash
    curl http://localhost:4010/api/recipes/RECIPE_UUID_HERE
    ```
- サムネイル配信: `/media/<key>`（MUSE_DATA_DIR/workshop に保存されたファイルを静的配信）
  - Recipe/LoRA の代表サムネイルも `/media` に保存・配信されます（1件につき1枚）。

- Tag Library API（Postgres）  
  - 辞書一覧（ページング）
    ```bash
    curl "http://localhost:4010/api/tags/dictionary?limit=1"
    ```
  - 辞書 upsert（単体）
    ```bash
    curl -X PUT http://localhost:4010/api/tags/dictionary \
      -H "Content-Type: application/json" \
      -d "{\"tag\":\"1girl\",\"type\":\"tag\",\"count\":12,\"aliases\":[\"girl\"]}"
    ```
  - 辞書 bulk upsert（最大1000件）
    ```bash
    curl -X POST http://localhost:4010/api/tags/dictionary/bulk-upsert \
      -H "Content-Type: application/json" \
      -d "{\"items\":[{\"tag\":\"masterpiece\",\"aliases\":[]}]}"
    ```
  - 翻訳一覧（ページング）
    ```bash
    curl "http://localhost:4010/api/tags/translations?limit=1"
    ```
  - 翻訳 upsert（単体）
    ```bash
    curl -X PUT http://localhost:4010/api/tags/translations \
      -H "Content-Type: application/json" \
      -d "{\"tag\":\"1girl\",\"ja\":\"女の子1人\",\"source\":\"ollama\"}"
    ```
  - 翻訳 lookup（最大200件）
    ```bash
    curl -X POST http://localhost:4010/api/tags/translations/lookup \
      -H "Content-Type: application/json" \
      -d "{\"tags\":[\"1girl\",\"masterpiece\"]}"
    ```

- アイデア削除  
  ```bash
  curl -X DELETE http://localhost:4010/api/ideas/IDEA_UUID_HERE
  ```

- セッション履歴削除  
  ```bash
  curl -X DELETE http://localhost:4010/api/sessions/SESSION_UUID_HERE/events
  ```

- セッション削除  
  ```bash
  curl -X DELETE http://localhost:4010/api/sessions/SESSION_UUID_HERE
  ```

- Webルート確認（ブラウザで開く）  
  - http://localhost:5173/play/muse  
  - http://localhost:5173/play/whisper  
  - http://localhost:5173/play/comfy  
  - http://localhost:5173/play/liked  
  - http://localhost:5173/workshop/recipes  
  - http://localhost:5173/workshop/loras  
  - http://localhost:5173/internals/sessions  
  - http://localhost:5173/internals/sessions/demo-id （IDは任意）

## Comfy Runner 動作確認（最小）
- 前提: ComfyUI が `http://127.0.0.1:8188` で起動しており、必要なモデルが ComfyUI 側に存在すること。
- env: `COMFY_BASE_URL`（デフォルト `http://127.0.0.1:8188`）、`MUSE_DATA_DIR`（Comfy Runner の画像は `MUSE_DATA_DIR/comfy` 配下に保存されるため、ComfyUI の input directory をそこに合わせる）

- options
  ```bash
  curl http://localhost:4010/api/comfy/runner/text2i/options
  ```
- run 作成（controlnet 無し）
  ```bash
  curl -X POST http://localhost:4010/api/comfy/runs ^
    -F "workflowId=base_text2i" ^
    -F "positive=masterpiece, 1girl" ^
    -F "negative=low quality" ^
    -F "ckptName=YOUR_CHECKPOINT.safetensors" ^
    -F "width=1024" ^
    -F "height=1024" ^
    -F "loras=[]" ^
    -F "controlnetEnabled=false" ^
    -F "preprocessorEnabled=false"
  ```
- run 作成（controlnet 有り / 画像あり）
  ```bash
  curl -X POST http://localhost:4010/api/comfy/runs ^
    -F "workflowId=base_text2i" ^
    -F "positive=masterpiece, 1girl" ^
    -F "negative=low quality" ^
    -F "ckptName=YOUR_CHECKPOINT.safetensors" ^
    -F "width=1024" ^
    -F "height=1024" ^
    -F "loras=[]" ^
    -F "controlnetEnabled=true" ^
    -F "controlnetModel=YOUR_CONTROLNET.safetensors" ^
    -F "controlnetStrength=1" ^
    -F "preprocessorEnabled=false" ^
    -F "controlnetImage=@C:\\path\\to\\controlnet.png"
  ```
- runs 一覧
  ```bash
  curl http://localhost:4010/api/comfy/runs
  ```
- refresh
  ```bash
  curl -X POST http://localhost:4010/api/comfy/runs/RUN_ID/refresh
  ```
- Web UI: `http://localhost:5173/play/comfy`

## Web操作の流れ（Muse→Internals）
1. ブラウザで `http://localhost:5173/play/muse` を開き、ヘッダのモデル一覧が読み込まれるのを待ちます。
2. 任意のタイトルを入力し、利用する Ollama モデルをドロップダウンで選んで「新規セッション作成」を押します（成功すると現在のセッション情報が表示されます）。
3. 同じ画面の「アイデア生成」でテーマ（任意）と生成件数（1〜10、デフォルト3）を指定し、「生成」を押すとアイデアカードが並びます。
4. 各カードの「Like」ボタンで いいね を切り替えられ、状態は即座に API (`POST /api/ideas/:id/like`) に保存されます。
5. 画面右上または Ideas セクションにあるリンクから Internals (`/internals/sessions/:id`) を開くと、同じセッションの概要・アイデア・イベントログ（LLM_REQUEST/LLM_RESPONSE など）が確認できます。
6. `/internals/sessions` の一覧テーブルでは作成日時・モデル・アイデア数・Liked数が表示され、任意のセッション詳細へ遷移できます。

## 環境変数
- `apps/api/.env`
  - `PORT` (デフォルト: 4010)
  - `DATABASE_URL` 例: `postgres://muse_user:muse_password@localhost:5432/muse_db`
  - `OLLAMA_BASE_URL` 例: `http://localhost:11434`
  - `OLLAMA_TIMEOUT_MS` 例: `300000`（重いモデルは初回が遅いので 5分推奨）
  - `OLLAMA_TEMPERATURE` 例: `0.9`
  - `OLLAMA_KEEP_ALIVE` 例: `5m`
  - `DEFAULT_LLM_MODEL` 例: `gpt-oss:20b`
  - `OLLAMA_NUM_GPU` 例: `999`（GPUに載せたい場合のヒント: `options.num_gpu` を Ollama に渡す）
  - `MUSE_DATA_DIR` 例: `C:\AI\cg-muse-data`（Whisper/Workshop/Comfy の保存先。未設定時は OS 標準のユーザーデータ領域）
- ComfyUI関連（ローカル利用のみ）
  - `COMFYUI_DIR`（必須、status/start/stop と dev オーケストレーターで使用）
  - `COMFYUI_PYTHON` （省略時は `COMFYUI_DIR\venv\Scripts\python.exe` を優先し、なければ `python`）
  - `COMFYUI_LISTEN` デフォルト: `127.0.0.1`
  - `COMFYUI_PORT` デフォルト: `8188`
  - `COMFYUI_EXTRA_ARGS` 
  - `start-dev.cmd` は上記を「未設定の場合のみ」自動セットするので、事前に環境変数を設定すれば上書きされません。
  - `pnpm dev` を直接使う場合は `COMFYUI_DIR` を自分で環境変数に設定してください（未設定だと ComfyUI の Start は失敗します）。
- `apps/web/.env`
  - `VITE_API_BASE_URL` 例: `http://localhost:4010`
- Whisper関連（apps/api）
  - `WHISPER_BIN_DIR` 
  - `WHISPER_MODELS_DIR` 
  - `WHISPER_EXE` 例: `whisper-cli.exe`（省略時は bin ディレクトリ内を探索）
  - `FFMPEG_PATH` 例: `ffmpeg`（PATH にある ffmpeg を利用）
  - `WHISPER_DEFAULT_LANGUAGE` 例: `auto`（プリセットのみ: auto/ja/en/zh/ko/fr/de/es/it/pt/ru）
  - `WHISPER_CONCURRENCY` 例: `1`（同時実行数）

## リポジトリ構成
- `apps/api`: Express + TypeScript、軽量SQLマイグレーションランナー付き
- `apps/web`: Vite + React + TypeScript + Tailwind、基本ルーティング済み
- `docker-compose.yml`: Postgres (muse_db / muse_user / muse_password)
