---
status: accepted
date: 2026-10-04
deciders: [Aitchn, Claude]
related: [packages/core/src/decisions.ts, apps/server/src/mcp.ts, apps/web/src/components/DecisionsPanel.tsx, examples/plugins/decision-timeline/main.js, docs/decisions/0005-history-and-decisions.md]
---

# 0014 多棵決策樹

## 背景
決策紀錄原本只有專案庫最上層的 `decisions/NNNN-標題.md`，全部排在同一條線上。Minecraft 專案庫裡有很多不同插件的筆記，每個插件各有一串自己的決策，混在一起看不出哪個決策屬於哪個插件，也看不出誰取代了誰。

## 選項
1. 每則決策加 `tags`，用標籤分類。
2. 用資料夾分：決策放在哪個 `decisions/` 資料夾就屬於哪棵樹，必要時再用 frontmatter `tree:` 指定。
3. 每棵樹另開一個專案庫。

## 決定
選 2。任何層級的 `decisions/` 資料夾都算決策資料夾：`decisions/Prism/0001-x.md` 與 `Prism/decisions/0001-x.md` 都屬於「Prism」樹，`decisions/0001-x.md` 不屬於任何樹（「未分類」）；frontmatter `tree:` 可以覆寫。編號在每個資料夾內各自從 0001 開始。新增時指定樹：已經有這棵樹的資料夾就放那裡，否則專案庫裡有同名資料夾就放 `<樹>/decisions/`（決策跟插件筆記放在一起），再不然放 `decisions/<樹>/`。

`supersedes`（編號、檔名、路徑或 [[連結]]）會解析成實際的檔案（`supersedesPath`），先找同資料夾，再找同一棵樹。

樹之間會互相依賴，例如 MoreMobs 0.3.1 需要 Prism 的「API 3.25」。決策的 `requires:` 列出它需要的決策，可以寫 [[連結]]、路徑、`Prism#0003`（樹#編號），或同一棵樹裡的編號；伺服器解析成 `requiresPaths`，並反過來算出每筆決策的 `requiredBy`。透過 API 或 MCP 新增時，能解析的引用會寫成 `[[路徑]]`，在 Obsidian 裡也點得開。`related` 裡指到決策的項目同樣解析成 `relatedPaths`。

一棵樹裡也會分岔，例如 Prism 3.x 繼續維護、同時開始 4.x。決策的 `branch:` 標出它在樹裡的哪條分支（不寫就是主線）；取代某筆分支決策的新決策沿用同一條分支。時間軸 plugin 的「節點圖」模式（預設）像 `git log --graph`：每棵樹、每條分支各一條線，顏色跟著樹（分支是同色較淺），新的在上；一筆決策接在它取代的那筆後面，否則接在同一條線的上一筆；分支的第一筆從主線上比它早的最新一筆岔出去。跨樹的 `requires` 畫成虛線。線結束後欄位會被重用，樹很多時也不會太寬。只看一棵樹時，它需要的別棵樹決策仍會淡淡地顯示，讓虛線有終點。被需要的決策如果已被取代或未採用，畫面會加上 ⚠，提醒依賴它的決策可能要跟著改。側欄「決策」依樹分組並可篩選；決策時間軸 plugin（1.2.0）的時間軸以樹的顏色標記每則決策並列出資料夾，「決策樹」模式把取代關係畫成分支。每棵樹的顏色由名稱決定並互相錯開。MCP 的 `record_decision`/`list_decisions` 多了 `tree`（`record_decision` 也收 `requires`、`branch`），新增 `list_decision_trees`（含每棵樹依賴哪些樹）；只限部分資料夾的權杖只看得到、也只能寫進自己資料夾裡的決策。

## 後果
原本的 `decisions/*.md` 不用改，照舊是「未分類」。編號不再全專案庫唯一，引用時要帶路徑或在同一棵樹內用編號。遊客與限資料夾的權杖看不到隱藏的決策，也不會從 `supersedesPath`、`requiresPaths`、`requiredBy` 得知它的路徑。
