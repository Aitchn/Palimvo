# 0020. Plugin UI layers: themes, slots and apps

- Status: accepted
- Date: 2026-10-22

## Context

Plugins already draw pages, code blocks and file viewers inside sandboxed frames (ADR 0019). People
also want to change how the app itself looks and add their own buttons and pages. Each step
gives a plugin more reach into the app than the one before it, so each needs its own boundary.

## Decision

Three layers, each with a different answer to "whose code runs where":

1. **Theme: the plugin's text enters the app's page, so it is parsed and filtered.** The
   stylesheet is run through `sanitizeThemeCss` (an allow-list parser, not a blocklist): only
   rules whose selector is `:root` or the light/dark selectors survive, only custom properties
   and five typographic properties are kept, and any value that could load or run something
   (`url()`, `image-set()`, `src()`, `expression()`, escapes, `data:`, `javascript:`, braces,
   `;`, angle brackets, `!important`) is dropped with its declaration. At-rules and nested blocks
   are dropped whole. The result is re-serialised from the parsed pieces, never passed through,
   and set as `textContent` of a `<style>` element. Selectors are rewritten to the specificity of
   the app's own tokens so a theme wins without `!important`. Which theme is active is a
   per-device choice (`palimvo.pluginTheme`), not part of the vault.
2. **Slots: the app draws, the plugin decides.** The host draws the button, menu item, palette
   row or status item from the manifest (localised title, optional built-in icon). What happens
   on use, and whether the entry shows, is answered by the plugin's hidden background frame over
   the existing port (`slot` messages). The only plugin-supplied content that is displayed is the
   `settings` section, which is drawn inside a sandboxed frame under a heading the app owns. No
   slot accepts HTML or a URL from a plugin.
3. **App: a frame in the main area.** `?app=<id>` replaces the main area with the plugin's frame;
   rail, sidebar, top bar and sign-in stay. It is just a view that fills the page, with its own
   address so it can be linked and left with the back button.

Two guarantees apply to every layer: a slot never gives a plugin a file path it may not read (the
context is scoped with the same rules the bridge uses), and a plugin that fails, is slow or is
revoked disappears from the bars and menus without breaking them.

## Consequences

- The theme filter is strict on purpose: themes can change colours and fonts, not layout or
  content. Plugins that need more should be an app or a view. A theme author sees a dropped part
  only by it having no effect; the example and the docs list what is allowed.
- Asking each entry whether it shows starts a hidden frame per plugin that has slot entries, on
  first need, and one round trip per menu opening. That is the price of keeping all plugin logic
  out of the app's page; frames are reused afterwards.
- Slot handlers are objects (`run`, `visible`, `render`), unlike other `register*` functions. The
  runtime used to reject them (a bug found by the end-to-end test); it now accepts them.
- Keyboard shortcuts, drag and drop, editor extensions and sidebar panels are not slots yet.
