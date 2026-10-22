# 0018. Plugin web host

- Status: accepted
- Date: 2026-10-22

## Context

Plugins draw inside the app: pages, code blocks, component types, file viewers, base views and
home widgets. Their code is written by other people and approved by a person who reads a
summary, so the browser side must assume it is hostile. The old product ran plugins in sandboxed
iframes and that part held up in real use; this ADR keeps its shape and fixes what was awkward:
authority was a mix of account, role and manifest checks spread over three files, and the
frame's page and policy were hard to test.

## Decision

- **One iframe per drawn contribution**, `sandbox="allow-scripts"` and nothing else. No
  `allow-same-origin`, so the frame has an opaque origin: no cookies, no storage, no access to
  `parent`, no forms, popups or top navigation. Each frame gets a content-security policy in a
  `<meta>` tag: `default-src 'none'`; scripts only from the runtime's per-frame nonce and `blob:`
  (the plugin's approved `main.js` is loaded from a blob, never from the network); images, media,
  fonts and `connect-src` only for the hosts of the `network` permission (`https:`/`wss:` only,
  `*` only when the manifest says `*`). The plugin's code is not in the page the policy was
  written for; it travels over the port.
- **A private `MessagePort` after one handshake.** The frame posts `hello`; the app answers
  `init` with a port and the code. Everything else uses the port, so a page the frame navigates
  to has no way to talk to the app. A frame whose `load` fires twice has left its page; it is
  removed and the person is told. (CSP cannot stop navigation, and the request may already have
  gone out: approving a plugin means trusting its code with what it may read.)
- **Authority is one object.** `PluginSession` holds what a person approved (hash, folder
  patterns, network, extension points) and the acting person's rights (read, write, propose). It
  is never sent to the frame. Revoking it (approval withdrawn, new hash, rights changed, sign-out
  or lost session) removes every frame that holds it, cancels pending calls and drops results that
  arrive afterwards. Sessions are rebuilt when the hash or the person's rights change.
- **Every call is checked by `PluginBridge`, in the app, against the manifest and the person.**
  Paths are normalized with the same function the server uses and matched case-sensitively
  against the declared folders, so `..`, backslashes, `.palimvo`, `.git` and differently spelled
  folders are refused before any request is made. Listing and search show only what the plugin
  may read (a folder appears only if it leads to a readable file); database rows from other
  folders are dropped. Calls have a size and shape check (`parseRpc`), a timeout, a pending cap,
  a request-id replay check, and cancellation.
- **The app's own API is the backend.** Plugin calls ride on the signed-in person's session, so
  the server's role and folder checks apply too: effective right = manifest ∩ person, enforced
  twice. Writes carry `X-Palimvo-Reason: Plugin <id>: …`; the history credits the person. A real
  plugin author kind ("plugin X on behalf of Y") needs a server endpoint and belongs to T32.
  `propose` writes a one-hunk proposal replacing the file, so a reviewer sees before and after.
- **Server contract for T32.** The host reads two routes, defined here so T32 can build to them:
  `GET /api/vaults/:vault/plugin-runtime` returns `{ plugins: [{ id, version, hash, manifest }] }`
  for plugins that are enabled, approved at exactly that hash and whose dependencies can run;
  `GET /api/vaults/:vault/plugin-runtime/:id` returns `{ id, hash, files }` with the text of
  `manifest.main`, the `locales` files and a theme stylesheet. The browser re-validates the
  manifest, requires the bundle's hash to be the listed one, and refuses otherwise. A 401/403/404
  on the list stops every plugin; a network error keeps what runs.
- **Extension points run in hidden frames**, one per contributor, started on first use. A
  contributor runs with its own permissions, never the provider's; each answers within 10 s and a
  failing or slow one does not fail the rest; data in both directions is plain JSON up to 1 MB.
  The same hidden frame will serve UI slot entries (T33): the runtime already registers them and
  answers `run`/`visible` calls.
- **Events are scoped per plugin.** `file:changed` and `file:opened` reach only plugins that may
  read the path; a move across the border is reported as a create or a delete so the other end
  is not disclosed. The file tree carries no author or change time, so for now only creates and
  deletes are reported, with an empty author; a live change feed adds the rest.
- **Surfaces.** Home widgets (`{type: "plugin", plugin, view}` where `view` is a `homeWidgets`
  id), plugin pages (`/v/<vault>?plugin=&view=`, listed in the sidebar), file viewers (with a
  switch back to the text), and the frame component for code blocks, components and base views,
  which T21/T23 attach. The look comes from the app's own CSS variables, read when the frame
  starts, and `locale`/`theme` changes are sent to running frames.

## Consequences

- The strongest guarantee is the browser's: sandbox and CSP are tested in Chromium
  (`tests/e2e/plugins.spec.ts`), including what each attempt was stopped by, not only that it
  failed.
- Plugins have no network by default and cannot load remote code even with the permission, which
  also means a plugin that needs a library must bundle it.
- A plugin can still read everything in its declared folders and, with `network`, send it to the
  listed hosts. That is what approval is for; the approval screen (T32) must say so.
- Each frame costs an iframe and a copy of the runtime; boards with many code blocks should
  reuse the lazy-start pattern (frames mount when visible), which T23 does.
