/** Where upload links point: the configured public address, else the address this request came in on. */
export function publicBase(
  c: { req: { url: string; header(name: string): string | undefined } },
  publicUrl?: string,
  trustProxy = false,
): string {
  if (publicUrl) return publicUrl.replace(/\/+$/, "");
  const url = new URL(c.req.url);
  const proto =
    (trustProxy ? c.req.header("x-forwarded-proto")?.split(",")[0]?.trim() : undefined) ||
    url.protocol.replace(/:$/, "");
  const host =
    (trustProxy ? c.req.header("x-forwarded-host")?.split(",")[0]?.trim() : undefined) ||
    c.req.header("host") ||
    url.host;
  return `${proto}://${host}`;
}

export const uploadLinkPath = (token: string) => `/api/upload-links/${token}`;

/** Ready-to-run commands that upload a file through a link (the caller fills in the file's path). */
export function uploadCommands(url: string): { bash: string; powershell: string } {
  return {
    bash: `curl -fsSL '${url}/upload.sh' | sh -s -- '/path/to/file'`,
    powershell: `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; & ([scriptblock]::Create((Invoke-RestMethod '${url}/upload.ps1'))) -File 'C:\\path\\to\\file'`,
  };
}

/** POSIX sh + curl + dd: begins (or resumes) the upload, sends each part, retries, then finishes. */
export function shellScript(url: string): string {
  return `#!/bin/sh
# Uploads one file through an upload link. Usage: sh upload.sh /path/to/file
set -eu
f="$1"; u='${url}'
[ -f "$f" ] || { echo "No such file: $f" >&2; exit 1; }
num() { sed -n "s/.*\\"$1\\":\\([0-9][0-9]*\\).*/\\1/p"; }
size=$(wc -c < "$f" | tr -d ' ')
st=$(curl -fsS -X POST "$u/begin" -H 'content-type: application/json' -d "{\\"size\\":$size}")
part=$(printf '%s' "$st" | num partBytes); off=$(printf '%s' "$st" | num received); tries=0
while [ "$off" -lt "$size" ]; do
  if st=$(dd if="$f" bs="$part" skip=$((off / part)) count=1 2>/dev/null | curl -fsS -X PUT "$u/parts?offset=$off" -H 'content-type: application/octet-stream' --data-binary @-); then
    tries=0
  else
    tries=$((tries + 1)); [ "$tries" -le 6 ] || { echo "Upload failed; run this again to carry on." >&2; exit 1; }
    sleep $((tries * 5)); st=$(curl -fsS "$u") || continue
  fi
  off=$(printf '%s' "$st" | num received)
  echo "$off / $size bytes"
done
curl -fsS -X POST "$u/finish"; echo
`;
}

/** Windows PowerShell 5.1+: the same steps, reading the file part by part. */
export function powershellScript(url: string): string {
  return `param([Parameter(Mandatory = $true)][string]$File)
# Uploads one file through an upload link.
$ErrorActionPreference = 'Stop'
$u = '${url}'
$fs = [IO.File]::OpenRead((Resolve-Path -LiteralPath $File).ProviderPath)
try {
  $size = $fs.Length
  $st = Invoke-RestMethod -Method Post -Uri "$u/begin" -ContentType 'application/json' -Body ('{"size":' + $size + '}')
  $part = [int64]$st.partBytes; $off = [int64]$st.received; $tries = 0
  while ($off -lt $size) {
    $n = [int][Math]::Min($part, $size - $off); $buf = New-Object byte[] $n
    $fs.Position = $off; $read = 0
    while ($read -lt $n) { $read += $fs.Read($buf, $read, $n - $read) }
    try {
      $st = Invoke-RestMethod -Method Put -Uri "$u/parts?offset=$off" -ContentType 'application/octet-stream' -Body $buf
      $tries = 0
    } catch {
      $tries++; if ($tries -gt 6) { throw "Upload failed; run this again to carry on. $_" }
      Start-Sleep -Seconds ($tries * 5); $st = Invoke-RestMethod -Uri $u
    }
    $off = [int64]$st.received
    Write-Host "$off / $size bytes"
  }
  Invoke-RestMethod -Method Post -Uri "$u/finish"
} finally { $fs.Close() }
`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

const STRINGS = {
  en: {
    title: "Upload a file",
    intro:
      "This link saves one file to {path}. It works until {until} and stops working once the file is saved.",
    drop: "Drop a file here, or click to choose one",
    progress: "Uploading {pct}% ({sent} of {total})",
    retry: "Connection lost. Trying again in {s} seconds…",
    done: "Done. Saved to {path}. You can close this page.",
    failed: "The upload failed: {error}. Choose the same file again to carry on.",
    badTitle: "This upload link cannot be used",
    badText: "It may have been used already, have expired, or be incomplete. Ask for a new link.",
  },
  "zh-TW": {
    title: "上傳檔案",
    intro: "這條連結會把一個檔案存到 {path}，可以用到 {until}，存好後就失效。",
    drop: "把檔案拖到這裡，或點一下選擇檔案",
    progress: "上傳中 {pct}%（{sent} / {total}）",
    retry: "連線中斷，{s} 秒後接著傳…",
    done: "完成，已存到 {path}。可以關掉這個頁面了。",
    failed: "上傳失敗：{error}。重新選同一個檔案可以接著傳。",
    badTitle: "這條上傳連結無法使用",
    badText: "它可能已經用過、過期，或網址不完整。請重新要一條連結。",
  },
  "zh-CN": {
    title: "上传文件",
    intro: "这条链接会把一个文件存到 {path}，可以用到 {until}，存好后就失效。",
    drop: "把文件拖到这里，或点一下选择文件",
    progress: "上传中 {pct}%（{sent} / {total}）",
    retry: "连接中断，{s} 秒后接着传…",
    done: "完成，已存到 {path}。可以关掉这个页面了。",
    failed: "上传失败：{error}。重新选同一个文件可以接着传。",
    badTitle: "这条上传链接无法使用",
    badText: "它可能已经用过、过期，或网址不完整。请重新获取一条链接。",
  },
} as const;

/** A page where a person drops the file in; it uploads in parts and carries on after a dropped connection. */
export function uploadPage(
  link: { path: string; expiresAt: string } | null,
  nonce: string,
): string {
  const body = link
    ? `<h1 id="title"></h1>
<p id="intro"></p>
<label class="drop" id="drop"><input type="file" id="pick"><span id="dropText"></span></label>
<progress id="bar" max="1" value="0" hidden></progress>
<p id="status" role="status"></p>`
    : `<h1 id="title"></h1><p id="intro"></p>`;
  const data = JSON.stringify({
    strings: STRINGS,
    path: link?.path ?? null,
    expiresAt: link?.expiresAt ?? null,
  }).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${escapeHtml(STRINGS.en.title)}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,sans-serif}
body{max-width:560px;margin:40px auto;padding:0 16px;line-height:1.6}
.drop{display:block;border:2px dashed #888;border-radius:12px;padding:40px 16px;text-align:center;cursor:pointer}
.drop.over{border-color:#4a8af4;background:rgba(74,138,244,.08)}
.drop input{display:none}
progress{width:100%;height:12px;margin-top:16px}
code{word-break:break-all}
</style></head><body>${body}
<script nonce="${nonce}" type="application/json" id="data">${data}</script>
<script nonce="${nonce}">
const data = JSON.parse(document.getElementById("data").textContent);
const lang = (navigator.language || "en").toLowerCase();
const S = data.strings[lang.startsWith("zh") ? (/tw|hk|hant/.test(lang) ? "zh-TW" : "zh-CN") : "en"];
const fmt = (t, v) => t.replace(/\\{(\\w+)\\}/g, (_, k) => v[k]);
const $ = (id) => document.getElementById(id);
if (!data.path) {
  $("title").textContent = S.badTitle; $("intro").textContent = S.badText;
} else {
  document.documentElement.lang = lang.startsWith("zh") ? (/tw|hk|hant/.test(lang) ? "zh-Hant" : "zh-Hans") : "en";
  document.title = S.title; $("title").textContent = S.title;
  $("intro").textContent = fmt(S.intro, { path: data.path, until: new Date(data.expiresAt).toLocaleString() });
  $("dropText").textContent = S.drop;
  const base = location.pathname.replace(/\\/$/, "");
  const drop = $("drop"), pick = $("pick"), bar = $("bar"), status = $("status");
  const say = (t) => { status.textContent = t; };
  const mib = (n) => (n / 1048576).toFixed(1) + " MiB";
  async function json(res) { const body = await res.json().catch(() => ({})); if (!res.ok) { const e = new Error(body.message || res.status + " " + res.statusText); e.status = res.status; throw e; } return body; }
  let busy = false;
  async function upload(file) {
    if (busy) return; busy = true; drop.hidden = true; bar.hidden = false;
    try {
      let st = await json(await fetch(base + "/begin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ size: file.size }) }));
      let off = st.received, fails = 0;
      while (off < file.size) {
        bar.value = off / Math.max(1, file.size);
        say(fmt(S.progress, { pct: Math.floor((off / Math.max(1, file.size)) * 100), sent: mib(off), total: mib(file.size) }));
        try {
          st = await json(await fetch(base + "/parts?offset=" + off, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: file.slice(off, off + st.partBytes) }));
          fails = 0;
        } catch (err) {
          if (err.status && err.status < 500 && err.status !== 409) throw err;
          if (++fails > 6) throw err;
          say(fmt(S.retry, { s: fails * 5 }));
          await new Promise((r) => setTimeout(r, fails * 5000));
          st = { ...st, ...(await json(await fetch(base))) };
        }
        off = st.received;
      }
      const saved = await json(await fetch(base + "/finish", { method: "POST" }));
      bar.value = 1; say(fmt(S.done, { path: saved.path }));
    } catch (err) {
      say(fmt(S.failed, { error: err.message })); drop.hidden = false; bar.hidden = true;
    } finally { busy = false; }
  }
  pick.addEventListener("change", () => pick.files[0] && upload(pick.files[0]));
  drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); if (e.dataTransfer.files[0]) upload(e.dataTransfer.files[0]); });
}
</script>
</body></html>`;
}
