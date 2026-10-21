# S2 技術驗證報告：插件 MCP 工具能否安全地在伺服器端 QuickJS（wasm）沙箱執行

日期：2026-10-21　　程式：Palimvo 倉庫 `spikes/s2-plugin-sandbox/`（分支 `claude/project-thread-cfz8hl`）
CI：ubuntu / windows × Node 24 / 26 四格全綠（測試、探針、效能量測都在 CI 跑過）

## 1. 結論

**可行，採用 QuickJS（`quickjs-emscripten` 0.32，MIT），但不能照 D4 原樣「直接用」。** 有一個必須寫進設計的發現：

> **QuickJS 的 `setMemoryLimit()` 在這個 wasm 版本不是可靠的上限，OOM 之後堆積還可能損毀。** 實測：設 8 MB，惡意程式可以長到 382 MB（陣列）甚至 2 GB（TypedArray）；Map 成長觸發 OOM 後，`dispose` 會 abort、`computeMemoryUsage` 會 trap（記憶體存取越界）。

所以 ADR 0003 建議的做法是「**三道防線**」，缺一不可：

1. **wasm 線性記憶體硬上限**：每個沙箱實例自己建 `WebAssembly.Memory({ maximum })` 傳給 `newVariant(RELEASE_SYNC, { wasmMemory })`。實測 64 MB 上限下，記憶體炸彈 0.2–0.4 秒內以 `out of memory` 結束，不會長大。
2. **沙箱放在 worker thread 池，不放在主執行緒**：CPU 死迴圈、災難性正規式、卡住的 host 呼叫都由主執行緒在期限後 `worker.terminate()` 強制終止。主執行緒被卡的時間：行程內 406 ms（等於逾時值），worker 池 6–20 ms。
3. **任何非乾淨結束都視為「中毒」**：逾時、記憶體、引擎例外（trap / abort）一律丟掉整個 worker（連同它的 wasm 實例），不重用。這樣即使堆積損毀也影響不到其他插件或主程序。

加上 QuickJS 自帶的中斷處理器（逾時）、`setMaxStackSize`（遞迴），整體驗收項目都過了（見 §3）。

## 2. 建議的架構

```
主程序（MCP / 權限 / 稽核）
  └─ SandboxPool（預設 4 個長駐 worker，可設定；佇列）
       └─ worker：1 個 wasm 實例（記憶體硬上限）+ 1 個 runtime
            └─ 每次工具呼叫：新 context → 載入插件 server.js → 呼叫 tool → 丟掉 context
```

- **每次呼叫一個新 context、runtime 長駐在 worker 內**（策略 B）。context 內全域狀態、`Object.prototype` 汙染都不會跨呼叫（已測）。不採「長駐 context」：省不了多少（見 §4，瓶頸是解析插件原始碼），卻讓不同 AI 呼叫之間可能夾帶狀態。
- 長駐 runtime 在 3000 次呼叫後 RSS 成長 15 MB（Linux）／44 MB（Windows），疑似小量累積；**每 N 次（建議 500）或每 10 分鐘回收一個 worker**。
- worker 預熱約 100 ms（4 個），伺服器啟動時做；不在請求路徑上。
- worker 數量與 CPU 核心脫鉤的上限由 `PALIMVO_PLUGIN_WORKERS` 設定。

### Host API 形狀（建議）

插件程式碼（CommonJS 風格，打包成單一 `server.js`）：

```js
globalThis.__plugin = { tools: {
  record_decision: async (args) => { /* ... */ return { ok: true }; }
}};
```

注入的全域只有 `vault`（以及沒有輸出的 `console.log`，最多 100 行，回傳給呼叫者當除錯資訊）：

| 函式 | 說明 |
|---|---|
| `vault.read({path})` → string | 讀筆記／文字檔 |
| `vault.list({dir})` → string[] | 列檔 |
| `vault.search({q})` → string[] | 搜尋 |
| `vault.write({path, content})` | 寫入（見下） |
| `vault.propose({path, content})` | 建立編輯提案（不直接落地；T34 範圍） |

設計要點（原型已驗證前四項）：

- **所有 host 函式都是 promise、JSON 進 JSON 出**，用 `JSON.parse` 在 context 內重建物件（不用 `evalCode` 拼字串，`__proto__` 鍵不會汙染原型，已測）。
- **權限在 host 端檢查，不信任插件**：`write` 只允許插件宣告過的路徑前綴（原型測試：寫 `decisions/` 以外被拒，錯誤以可被 `try/catch` 的例外回到插件）。
- **作者歸屬**由 host 端固定附上（「插件 X 代表 AI Y」），插件不能自選。
- **呼叫配額**（原型 200 次／呼叫），超過就拒絕；結果大小上限（1 MB）。
- 參數格式檢查由伺服器依插件 manifest 的 JSON Schema 做，不在沙箱內。

## 3. 驗收項目結果（`npm test`，全部通過；Linux + Windows × Node 24/26）

| 項目 | 結果 |
|---|---|
| 讀／列／搜／寫經 host API | ✔ |
| host 拒絕越權寫入，錯誤可被插件接住 | ✔ |
| 無環境權限：`fetch`、`require`、`process`、`module`、`Buffer`、`XMLHttpRequest`、`WebSocket`、`setTimeout`、`WebAssembly`、`Atomics` 皆不存在 | ✔（`SharedArrayBuffer` 型別存在但是引擎自己的、沒有執行緒，無害） |
| 動態 `import('node:fs' / 'file:' / 'https:')` | ✔ 全部失敗 |
| `eval` / `Function` / `constructor.constructor` 逃逸，拿不到 host 物件 | ✔ |
| 無窮迴圈、無窮 microtask 迴圈 | ✔ 逾時中止（300 ms 設定 → 約 306 ms） |
| host 呼叫永遠不回應 | ✔ 牆鐘逾時 |
| 記憶體炸彈（陣列、字串倍增） | ✔ 有 wasm 硬上限時；**只靠 `setMemoryLimit` 不行**（§1） |
| 遞迴爆棧 | ✔ 可被接住的 `InternalError: stack overflow`（**堆疊上限需 ≤ 256 KB；512 KB 會讓 wasm 先撞到 V8 堆疊，引擎中毒**） |
| 插件例外、語法錯誤、未知工具 | ✔ 分類成 tool / load 錯誤，下一次呼叫正常 |
| host 呼叫洪水、結果過大 | ✔ 配額與大小上限 |
| 50 個並行呼叫 | ✔ |
| 跨呼叫狀態汙染（全域變數、`Object.prototype`） | ✔ 不洩漏 |
| worker 池：旋轉、災難性正規式、記憶體炸彈、卡住的 host 呼叫之後池子自動補 worker，健康呼叫正常 | ✔ |

## 4. 效能數據（CI 的 Windows Node 24；Linux 相近）

| 項目 | p50 | p95 |
|---|---|---|
| 建一個 wasm 實例（記憶體上限 64 MB） | 2.5 ms | 4.6 ms |
| 策略 A：每次呼叫全新實例，小插件 | 3.5 ms | 6.3 ms |
| 策略 B：長駐 runtime、新 context，小插件 | **0.43 ms** | 0.68 ms |
| 策略 B，含 1 次 host 呼叫 | 0.54 ms | 0.70 ms |
| 解析載入 6 KB／31 KB／125 KB／200 KB 的插件原始碼 | 1.5 / 4.7 / 21.5 / ~26 ms | — |
| worker 池（暖）：呼叫 | 0.6 ms | 1.0 ms |
| worker 池：含 1 次 host 呼叫（跨執行緒往返） | 0.8 ms | 1.1 ms |
| 200 個並行呼叫過 4 個 worker | 總計 92 ms | |
| 每次呼叫新建 worker（不建議） | 約 81 ms | 109 ms |
| 閒置常駐記憶體 | 約 0.2–0.3 MB／實例 | |

- 瓶頸是**解析插件原始碼**，與引擎無關：典型決策插件（< 30 KB）約 5 ms，可接受；若之後有大型插件，再評估 bytecode 快取（`evalCode` 支援 `compileOnly`，但序列化 bytecode 目前沒有公開 API）。
- 模組大小：wasm 492 KB（gzip 232 KB）。直接依賴 `quickjs-emscripten-core` + `@jitl/quickjs-wasmfile-release-sync` 即可，約 0.5 MB（`quickjs-emscripten` 套件全包含 4 種變體共 9 MB，不要用）。
- Windows：全部正常，沒有原生編譯。

## 5. 風險與限制

1. **引擎本身的記憶體上限不可靠、OOM 會損毀堆積**（最大風險）。靠 §1 的三道防線化解；不要為了省 worker 重用「中毒」的實例。
2. **QuickJS 是否有未知逃逸漏洞**：它是 C 寫的引擎，歷來有過記憶體安全 bug；wasm 把這類漏洞限制在線性記憶體內（不能碰 host），這就是選 wasm 的理由。仍應：固定版本、Dependabot 追蹤、插件雜湊核准機制照舊（人核准才會跑）。
3. **瀏覽器端與伺服器端是兩套沙箱**（前者 iframe，後者 QuickJS）：同一個插件包的 `server.js` 與前端程式碼必須分檔，API 不共用。
4. **同步 CPU 工作的逾時粒度**：中斷處理器只在 JS 分支／呼叫點檢查；引擎內部長時間 native 迴圈（例如一次超大 `sort`）要靠 worker 的硬逾時（+300 ms）終止。已把它做成兩層。
5. **Node 24 的 worker `resourceLimits` 管不到 wasm 記憶體**，所以才需要 wasm 自己的 `maximum`。
6. **不支援**：插件內的 `setTimeout`、網路、檔案、原生模組、`async` 以外的等待方式。對決策插件夠用；需要網路的插件另案（建議走宣告式 host API，如 `http.fetch` 白名單網域，預設不提供）。
7. **除錯體驗**：錯誤只有 `name: message`，沒有原始碼對應；插件作者用本機測試工具跑（可直接重用此原型的 `runTool`）。

## 6. 替代方案比較

| 方案 | 優點 | 缺點 | 建議 |
|---|---|---|---|
| **QuickJS-wasm + worker 池（本報告）** | 純 JS 依賴、跨平台、毫秒級、可硬殺、wasm 隔離 | 要自己做三道防線；除錯弱 | **採用** |
| Node `vm` | 零依賴 | 不是安全邊界（官方明說），可逃逸 | 不採用 |
| `isolated-vm` | V8 速度、記憶體上限可靠 | 原生模組，要為各平台預編譯，Windows／新 Node 常出問題 | 備案（僅在 QuickJS 太慢時） |
| 子程序 + Node permission model | 作業系統層隔離 | 啟動 50–100 ms、permission model 非完整沙箱、跨平台差異大 | 不採用 |
| 只允許宣告式工具（YAML／JSON 查詢＋樣板） | 最安全 | 決策插件的邏輯（狀態轉換、關聯檢查）寫不出來 | 可作為第二種更簡單的插件型態 |
| Wasm 組件（Extism 等） | 語言不限 | 插件作者要編 wasm，門檻高 | 不採用 |

## 7. 對計畫的建議修改（T34）

- D4 文字改為：「QuickJS-wasm，每個 worker 一個有硬記憶體上限的 wasm 實例，worker 池可強制終止，中毒即丟棄」。
- T34 範圍加入：`SandboxPool`（預設 4 worker、佇列、回收、設定）、中毒判定、`PALIMVO_PLUGIN_WORKERS`、堆疊上限 256 KB、本報告 §3 的整套測試納入伺服器測試（可直接搬 `spikes/s2-plugin-sandbox/src/tests.mjs`、`pool-tests.mjs`）。
- T34 驗收加一條：記憶體炸彈與逾時之後，同一個池的其他插件呼叫不受影響。
- ADR 0003 由 T01 或 T34 以本報告為依據撰寫。

## 8. 重現方式

```
cd spikes/s2-plugin-sandbox && npm ci
npm test      # 20 項安全測試 + 7 項 worker 池測試
npm run probe # 證明 setMemoryLimit 單獨不可靠、wasm 硬上限可靠
npm run bench # 本報告 §4 的數據
```
