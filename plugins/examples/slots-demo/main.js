// One entry per UI slot. The app draws the button, menu item, palette row and settings heading;
// what happens when they are used, and the settings content, is this sandboxed code.
export default (palimvo) => {
  const t = (key, params) => palimvo.i18n.t(key, params);

  palimvo.ui.registerSlot("toolbar", "count", {
    async run() {
      const files = await palimvo.vault.list("", { recursive: true });
      const notes = files.filter((entry) => entry.kind === "file" && entry.path.endsWith(".md"));
      palimvo.ui.showNotice(t("counted", { count: notes.length }), { kind: "info" });
    },
  });

  palimvo.ui.registerSlot("context-menu", "size", {
    // Only offered on files; `path` is left out when this plugin may not read it.
    visible: (context) => typeof context.path === "string" && context.path.endsWith(".md"),
    async run(context) {
      const text = await palimvo.vault.read(context.path);
      palimvo.ui.showNotice(t("size", { path: context.path, count: text.length }));
    },
  });

  palimvo.ui.registerSlot("command-palette", "hello", {
    run: () => palimvo.ui.showNotice(t("hello"), { kind: "success" }),
  });

  palimvo.ui.registerSlot("status-bar", "path", {
    visible: (context) => typeof context.path === "string",
    run: (context) => palimvo.ui.showNotice(t("where", { path: context.path ?? t("none") })),
  });

  palimvo.ui.registerSlot("settings", "about", {
    render({ el }) {
      const text = document.createElement("p");
      text.textContent = t("about");
      el.append(text);
    },
  });
};
