// A plugin app draws the whole main area; the app's rail, sidebar and top bar stay around it.
export default (palimvo) => {
  palimvo.ui.registerApp(async ({ el }) => {
    const files = (await palimvo.vault.list("", { recursive: true })).filter(
      (entry) => entry.kind === "file",
    );
    el.style.padding = "24px";
    const heading = document.createElement("h1");
    heading.textContent = palimvo.i18n.t("title");
    const body = document.createElement("p");
    body.textContent = palimvo.i18n.t("body", { count: files.length });
    el.append(heading, body);
    if (files[0]) {
      const open = document.createElement("button");
      open.textContent = palimvo.i18n.t("open");
      open.onclick = () => palimvo.ui.openFile(files[0].path);
      el.append(open);
    }
  });
};
