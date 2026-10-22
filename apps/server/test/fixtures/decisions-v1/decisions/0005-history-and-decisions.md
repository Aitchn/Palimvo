---
status: accepted
date: 2026-10-04
deciders: [Aitchn, Claude]
related: [docs/architecture-plan.md, apps/server/src/history.ts, apps/server/src/backup.ts, packages/core/src/decisions.ts]
---

# 0005 版本歷史：每個 vault 一個 git repo，依作者分批 commit

## 背景
多個人與 AI 同時編輯，需要知道誰（哪個人、哪個 AI）在什麼時候為什麼改了什麼，能看差異、能還原，重要決定要留下紀錄；服務 24/7 運行，資料需要異地備份。

## 選項
- isomorphic-git（純 JS）或 git CLI
- 每次存檔就 commit，或批次 commit
- 決策紀錄放資料庫，或放在 vault 裡的 Markdown

## 決定
- 用 **git CLI**（Docker 映像內安裝 git）：功能完整、效能好，vault 也能直接用一般 git 工具或 Obsidian Git 外掛打開。已經是 git repo 的匯入 vault 會直接沿用。
- 寫入 API 與協作層會記錄「哪個檔案被誰改了、理由是什麼」。修改停下約 10 秒（持續修改時至少每 60 秒）後 commit：**每位作者一個 commit**，同一檔案也被其他人改過時，其他人列為 `Co-authored-by`。沒有紀錄的修改（Obsidian 桌面版、git pull 等外部程式）另成一個「外部修改」commit。伺服器啟動時也會先 commit 停機期間的外部修改。
- 作者身分：瀏覽器使用者是 `human:<名字>`（在設定裡改名字）；AI 與腳本用 `X-Aivault-Author: ai:<名稱>` 標頭，理由用 `X-Aivault-Reason`。git 的作者 email 是 `human@`、`ai@`、`external@aivault.local`，用來區分種類。
- `.aivault/collab/`（協作狀態）與寫入中的暫存檔寫在 `.git/info/exclude`，不改動 vault 自己的 `.gitignore`。
- 還原 = 把舊版內容當成一次新的寫入（經過協作層，正在編輯的人會即時看到），所以還原本身也留在歷史裡、可以再還原。
- 存檔點 = 先把開啟中文件存檔，立即 commit 並可加 git tag。
- 決策紀錄是 vault 裡的 `decisions/NNNN-標題.md`（frontmatter：status、date、deciders、related、supersedes），與 Obsidian 相容，也跟著版本歷史走。編號在伺服器端依 vault 排隊分配。
- 遠端備份：每個 vault 可設定一個 https/ssh git 遠端，定時推送所有分支與標籤；網址存在 vault 的 `.git/config`，API 回傳時遮住帳密。不允許本機路徑或 `file://`，避免 API 呼叫者寫入伺服器上任意位置。

## 後果
- 歷史面板可看到每次修改的作者種類（人／AI／外部）、理由與差異，並可一鍵還原。
- 推送失敗（網路、權限、遠端有其他人推過）只記在狀態與日誌，不影響編輯；遠端分歧時需人工處理。
- 目前 API 沒有登入驗證，任何能連到服務的人都能設定備份遠端；M8 加入帳號權限前，服務不應直接暴露在公開網路。
- 「AI 在分支上提案、人審核後合併」留到 MCP（M6）之後再做。
