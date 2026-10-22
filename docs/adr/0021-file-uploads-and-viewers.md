# 0021. File uploads, upload links and viewers

- Status: accepted
- Date: 2026-10-22

## Context

A vault holds more than notes: pictures, sound, video, PDFs and, through plugins, any type a vault
chooses to accept. Files range from a logo to a multi-gigabyte recording. AI clients cannot push
gigabytes through a tool call, and the server may sit behind a proxy that refuses request bodies
over 100 MB. T22 brings the old project's uploads (ADR 0017 to 0019 there) into Palimvo.

## Decision

- **Three ways in, one policy.** `UploadPolicy` decides what a vault accepts: notes, canvases and
  databases are refused (they are written as text); built-in media and documents are accepted;
  extra types come from a `FileTypeSource` that the plugin platform will supply (empty until then),
  each with its own size limit, which wins when it is lower. Single-request limit 64 MiB, resumable
  limit 4 GiB. The same check runs when an upload begins and again when it finishes.
- **Single request:** `PUT /api/vaults/:vault/raw/<path>[?create=1]` (the same address as the
  download, `GET`). The body is held in memory (at most 64 MiB).
- **Resumable:** `POST …/uploads` starts, `PUT …/uploads/:id?offset=N` appends one part of at most
  32 MiB, `POST …/finish` moves the file into place, `DELETE` cancels. Parts are streamed to
  `.palimvo/uploads/<id>/data` (never held in memory) and the progress is a small JSON file next
  to it, so an upload survives a restart. A part that breaks off is cut away and sent again from
  the offset the server reports. Staging folders are unversioned and are swept after a day without
  activity; a vault keeps at most 20, and the disk must keep 512 MiB free after the file.
  `placeUpload` renames the finished file into the vault with the same per-file lock as other
  writes. A file over 64 MiB gets a size-and-time version instead of a hash of gigabytes.
- **Upload links** let a program or person upload without an account: the link names one path,
  works for a day and is used up when the file is saved. Only the hash of the token is stored, in
  the `upload_links` table (migration 4). The history credits whoever made the link, with their
  reason. The routes are mounted before the session and CSRF checks because a script run from a
  terminal carries neither. `GET` on a link answers a browser with an upload page (own CSP with a
  nonce, English, Traditional and Simplified Chinese) and a program with JSON; `upload.sh` (POSIX
  sh, curl, dd) and `upload.ps1` (PowerShell 5.1) are generated with the link filled in.
- **MCP:** `upload_file` and `download_file` use the shared policy. The advanced tier gains
  `begin_upload`, `upload_part`, `finish_upload`, `cancel_upload` and `create_upload_link`;
  `list_file_types` lists plugin types. Pieces sent through a tool call are base64, so the tool
  text recommends about 8 MiB.
- **Raw downloads.** The `GET …/raw/<path>` route (ranges, ETag, `nosniff`, sandbox CSP, SVG as
  text) comes from PR #19 and now checks `note.read` and the guest rules. `?download=1` forces a
  save-as.
- **Viewers.** The web app shows pictures, audio, video, PDF, JSON (collapsible tree, text on
  request), CSV (table, first 2000 rows), YAML and text in place, and offers a download for
  anything else. Text over 5 MiB is not drawn. SVG is drawn through `<img>` from a blob of its
  text, so scripts in it never run. Plugin-provided viewers belong to the plugin tasks.
- **Browser side.** Files dropped on the tree or chosen with the picker that are not text go to
  `uploadFile` (one request, or parts with retry); a panel shows progress and a cancel button.
  Retries only cover a broken connection or a restarting proxy, not a full disk.

## Consequences

- The 4 GiB limit assumes the disk has room; `storage_full` (507) says so before the first byte.
- A link's secret lives in the URL, so anyone holding it can upload one file to that path until it
  is used or expires. It is shown once, like other secrets.
- Overwriting a file larger than the text limit through `writeBytes` still reads the old file into
  memory to compute its version; only the upload path avoids that.

## Alternatives

- tus or S3-style multipart: more moving parts for the same result.
- Storing staged parts in the database: gigabytes in SQLite are slow to back up.
