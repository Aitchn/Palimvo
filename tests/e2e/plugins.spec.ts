import { expect, test, type Page } from "@playwright/test";
import { mockApi, shotPath } from "./mocks.ts";

// The plugin host against a real browser: the sandbox and the content-security policy are
// enforced by Chromium, which no unit test can stand in for. The server is mocked.

const HASH = (n: string) => n.repeat(64).slice(0, 64);

interface FakePlugin {
  manifest: Record<string, unknown>;
  hash: string;
  files: Record<string, string>;
}

function plugin(
  id: string,
  main: string,
  manifest: Record<string, unknown>,
  extra: Record<string, string> = {},
): FakePlugin {
  return {
    hash: HASH(id.length.toString(16)),
    files: { "main.js": main, ...extra },
    manifest: {
      manifestVersion: 2,
      id,
      version: "1.0.0",
      name: { en: id },
      ...manifest,
    },
  };
}

async function serve(page: Page, plugins: FakePlugin[], widgets: Array<[string, string]>) {
  await mockApi(page);
  await page.route("**/api/vaults/sample/home", (route) =>
    route.fulfill({
      json: {
        config: {
          schemaVersion: 1,
          widgets: widgets.map(([pluginId, view], i) => ({
            id: `w${i}`,
            type: "plugin",
            plugin: pluginId,
            view,
          })),
          pinned: [],
          publicNote: null,
        },
        version: null,
      },
    }),
  );
  await page.route("**/api/vaults/sample/plugin-runtime", (route) =>
    route.fulfill({
      json: {
        plugins: plugins.map((p) => ({
          id: p.manifest.id,
          version: p.manifest.version,
          hash: p.hash,
          manifest: p.manifest,
        })),
      },
    }),
  );
  await page.route("**/api/vaults/sample/plugin-runtime/*", (route) => {
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split("/").pop()!);
    const found = plugins.find((p) => p.manifest.id === id);
    return found
      ? route.fulfill({ json: { id, hash: found.hash, files: found.files } })
      : route.fulfill({ status: 404, json: { code: "not_found", message: "no" } });
  });
}

/** Everything that must never reach the network is sent to /exfil/, which records and answers. */
async function watchExfil(page: Page): Promise<string[]> {
  const hits: string[] = [];
  await page.route("**/exfil/**", (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/plain", body: "ok" });
  });
  await page.route("**/pwned", (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: "pwned" });
  });
  return hits;
}

const frameOf = (page: Page, pluginId: string) =>
  page.frameLocator(`.plugin-host[data-plugin="${pluginId}"] iframe`);

test.describe("sandbox", () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: "en", reducedMotion: "reduce" });

  const PROBE = `
export default (palimvo) => {
  palimvo.ui.registerHomeWidget("probe", async ({ el }) => {
    const results = {};
    const violations = [];
    document.addEventListener("securitypolicyviolation", (e) => violations.push(e.effectiveDirective));
    const attempt = async (name, fn) => {
      try { results[name] = { ok: true, value: String(await fn()) }; }
      catch (e) { results[name] = { ok: false, error: (e && e.code) || (e && e.name) || String(e) }; }
    };
    const origin = "http://127.0.0.1:4173";
    await attempt("cookie", () => document.cookie);
    await attempt("parentDocument", () => parent.document.title);
    await attempt("localStorage", () => localStorage.getItem("palimvo.theme"));
    await attempt("indexedDB", () => indexedDB.open("x"));
    await attempt("topNavigation", () => { top.location.href = origin + "/pwned"; return "tried"; });
    await attempt("popup", () => window.open(origin + "/exfil/popup") === null ? "blocked" : "opened");
    await attempt("fetch", () => fetch(origin + "/exfil/fetch").then((r) => r.status));
    await attempt("xhr", () => new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("GET", origin + "/exfil/xhr");
      x.onload = () => resolve("loaded"); x.onerror = () => reject(new Error("blocked"));
      x.send();
    }));
    await attempt("image", () => new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve("loaded"); i.onerror = () => reject(new Error("blocked"));
      i.src = origin + "/exfil/img.png";
    }));
    await attempt("beacon", () => navigator.sendBeacon(origin + "/exfil/beacon", "x"));
    await attempt("websocket", () => new Promise((resolve, reject) => {
      const w = new WebSocket("ws://127.0.0.1:4173/exfil/ws");
      w.onopen = () => resolve("open"); w.onerror = () => reject(new Error("blocked"));
    }));
    await attempt("stylesheet", () => new Promise((resolve, reject) => {
      const l = document.createElement("link");
      l.rel = "stylesheet"; l.href = origin + "/exfil/style.css";
      l.onload = () => resolve("loaded"); l.onerror = () => reject(new Error("blocked"));
      document.head.append(l);
    }));
    await attempt("externalScript", () => new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = origin + "/exfil/script.js";
      s.onload = () => resolve("loaded"); s.onerror = () => reject(new Error("blocked"));
      document.head.append(s);
    }));
    await attempt("inlineScript", () => new Promise((resolve) => {
      window.__inline = "not-run";
      const s = document.createElement("script");
      s.textContent = "window.__inline = 'ran'";
      document.head.append(s);
      setTimeout(() => resolve(window.__inline), 50);
    }));
    await attempt("eval", () => eval("1 + 1"));
    await attempt("form", () => new Promise((resolve) => {
      const f = document.createElement("form");
      f.action = origin + "/exfil/form"; f.method = "post";
      document.body.append(f); f.submit();
      setTimeout(() => resolve("submitted"), 100);
    }));
    await attempt("readInside", () => palimvo.vault.read("notes/a.md"));
    await attempt("readOutside", () => palimvo.vault.read("private/diary.md"));
    await attempt("readHidden", () => palimvo.vault.read(".palimvo/config.json"));
    await attempt("readTraversal", () => palimvo.vault.read("notes/../private/diary.md"));
    await attempt("listIsFiltered", async () => (await palimvo.vault.list("", { recursive: true })).map((e) => e.path).join(","));
    await attempt("write", () => palimvo.vault.write("notes/a.md", "x"));
    await attempt("writeOutside", () => palimvo.vault.write("private/diary.md", "x"));
    await new Promise((resolve) => setTimeout(resolve, 200));
    results.violations = { ok: true, value: [...new Set(violations)].sort().join(",") };
    el.textContent = JSON.stringify(results);
    el.dataset.done = "1";
  });
};`;

  test("a hostile plugin gets nothing beyond its declared folder and cannot talk to the network", async ({
    page,
  }) => {
    const hits = await watchExfil(page);
    const requested: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/vaults/sample/files/")) requested.push(r.url());
    });
    await serve(
      page,
      [
        plugin("probe", PROBE, {
          permissions: { read: ["notes"] },
          contributes: { homeWidgets: [{ id: "probe", name: "Probe" }] },
        }),
      ],
      [["probe", "probe"]],
    );
    // The mocked file tree has no notes/ folder; the probe lists what the host lets it see.
    await page.goto("/v/sample");
    const root = frameOf(page, "probe").locator("#root");
    await expect(root).toHaveAttribute("data-done", "1", { timeout: 20_000 });
    const results = JSON.parse((await root.textContent()) ?? "{}") as Record<
      string,
      { ok: boolean; value?: string; error?: string }
    >;

    // An opaque origin: no cookies, no parent, no storage.
    for (const name of ["cookie", "parentDocument", "localStorage", "indexedDB", "topNavigation"]) {
      expect(results[name], name).toMatchObject({ ok: false });
    }
    expect(results.popup).toMatchObject({ ok: true, value: "blocked" });

    // The policy: nothing goes out, nothing external comes in, no inline script from the plugin.
    for (const name of [
      "fetch",
      "xhr",
      "image",
      "websocket",
      "stylesheet",
      "externalScript",
      "eval",
    ]) {
      expect(results[name], name).toMatchObject({ ok: false });
    }
    // sendBeacon only queues the request; the empty `hits` below shows it never went out.
    expect(results.inlineScript).toMatchObject({ ok: true, value: "not-run" });
    // Chromium itself reports which rule stopped each attempt, so these are the policy at work,
    // not accidents of the opaque origin.
    const stopped = (results.violations?.value ?? "").split(",");
    for (const directive of ["connect-src", "img-src", "script-src-elem", "style-src-elem"]) {
      expect(stopped, directive).toContain(directive);
    }
    expect(hits, `requests that escaped: ${hits.join(", ")}`).toEqual([]);

    // The host's folder rules.
    expect(results.readInside).toMatchObject({ ok: true });
    expect(results.readInside?.value).toContain("notes/a.md");
    for (const name of ["readOutside", "readHidden", "readTraversal"]) {
      expect(results[name], name).toMatchObject({ ok: false });
    }
    expect(results.readOutside?.error).toBe("permission_denied");
    expect(results.readHidden?.error).toBe("invalid_argument");
    expect(results.write?.error).toBe("permission_denied");
    expect(results.writeOutside?.error).toBe("permission_denied");
    // Files outside the folder were never even asked for from the server.
    expect(requested.some((url) => url.includes("private"))).toBe(false);
    expect(requested.some((url) => url.includes(".palimvo"))).toBe(false);

    // The app itself did not move.
    expect(new URL(page.url()).pathname).toBe("/v/sample");
  });

  test("a plugin that navigates its frame away is stopped and the person is told", async ({
    page,
  }) => {
    const hits = await watchExfil(page);
    await serve(
      page,
      [
        plugin(
          "leaver",
          `export default (palimvo) => {
            palimvo.ui.registerHomeWidget("w", () => { location.href = "http://127.0.0.1:4173/exfil/nav"; });
          };`,
          {
            contributes: { homeWidgets: [{ id: "w", name: "Leaver" }] },
          },
        ),
      ],
      [["leaver", "w"]],
    );
    await page.goto("/v/sample");
    await expect(
      page.getByRole("alert").filter({ hasText: "tried to leave its sandbox" }),
    ).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.locator('.plugin-host[data-plugin="leaver"] iframe')).toHaveCount(0);
    void hits;
  });

  test("a plugin that throws shows its message inside its own card", async ({ page }) => {
    await serve(
      page,
      [
        plugin(
          "broken",
          `export default (palimvo) => {
            palimvo.ui.registerHomeWidget("w", () => { throw new Error("kaboom"); });
          };`,
          { contributes: { homeWidgets: [{ id: "w", name: "Broken" }] } },
        ),
      ],
      [["broken", "w"]],
    );
    await page.goto("/v/sample");
    await expect(page.getByRole("alert").filter({ hasText: "kaboom" })).toBeVisible({
      timeout: 20_000,
    });
    // The rest of the page is unaffected.
    await expect(page.getByRole("main")).toContainText("Home");
  });

  test("a plugin cannot register what its manifest does not declare", async ({ page }) => {
    await serve(
      page,
      [
        plugin(
          "greedy",
          `export default (palimvo) => {
            palimvo.ui.registerCodeBlock("mermaid", () => {});
          };`,
          { contributes: { homeWidgets: [{ id: "w", name: "Greedy" }] } },
        ),
      ],
      [["greedy", "w"]],
    );
    await page.goto("/v/sample");
    await expect(page.getByRole("alert").filter({ hasText: "Undeclared code block" })).toBeVisible({
      timeout: 20_000,
    });
  });
});

test.describe("working plugins", () => {
  test.use({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });

  const HELLO = `
export default (palimvo) => {
  palimvo.ui.registerHomeWidget("greeting", async ({ el, locale, theme }) => {
    const note = await palimvo.vault.read("Welcome.md");
    el.innerHTML = "";
    const h = document.createElement("p");
    h.id = "hello"; h.textContent = palimvo.i18n.t("hello", { name: "Ada" }) + " [" + locale + "/" + theme + "]";
    const n = document.createElement("p");
    n.id = "note"; n.textContent = note.split("\\n")[0];
    el.append(h, n);
    for (let i = 0; i < 6; i++) { const p = document.createElement("p"); p.textContent = "line " + i; el.append(p); }
  });
  palimvo.ui.registerView("board", ({ el }) => { el.id = "board"; el.textContent = "BOARD VIEW"; });
  palimvo.ui.registerViewer("log", async ({ el, readText, path }) => {
    el.textContent = "VIEWER:" + path + ":" + (await readText()).split("\\n")[0];
  });
};`;
  const hello = () =>
    plugin(
      "hello",
      HELLO,
      {
        permissions: { read: ["**"] },
        contributes: {
          homeWidgets: [{ id: "greeting", name: { en: "Greeting", "zh-TW": "問候" } }],
          views: [{ id: "board", name: "Board view" }],
          viewers: [{ id: "log", name: "Log viewer", extensions: ["log"] }],
        },
        locales: { en: "locales/en.json", "zh-TW": "locales/zh-TW.json" },
      },
      {
        "locales/en.json": '{"hello":"Hello {name}"}',
        "locales/zh-TW.json": '{"hello":"哈囉 {name}"}',
      },
    );

  test("a home widget draws in its card, reads an allowed note and speaks the interface language", async ({
    page,
  }) => {
    await serve(page, [hello()], [["hello", "greeting"]]);
    await page.goto("/v/sample");
    const frame = frameOf(page, "hello");
    const theme = await page.locator("html").getAttribute("data-theme");
    await expect(frame.locator("#hello")).toHaveText(`Hello Ada [en/${theme}]`);
    await expect(frame.locator("#note")).toHaveText("# Welcome.md");
    // The card grows with what the plugin drew.
    const height = await page
      .locator('.plugin-host[data-plugin="hello"]')
      .evaluate((el) => el.getBoundingClientRect().height);
    expect(height).toBeGreaterThan(100);
    await page.screenshot({ path: shotPath("plugin-home-widget") });
  });

  test("a plugin page opens from the sidebar and fills the main area", async ({ page }) => {
    await serve(page, [hello()], []);
    await page.goto("/v/sample");
    await page.getByRole("button", { name: "Board view" }).click();
    await expect(frameOf(page, "hello").locator("#board")).toHaveText("BOARD VIEW");
    expect(new URL(page.url()).search).toContain("plugin=hello");
    const box = await page.locator(".plugin-view").boundingBox();
    expect(box!.height).toBeGreaterThan(300);
  });

  test("plugins reach each other only through declared extension points", async ({ page }) => {
    const provider = plugin(
      "board",
      `export default (palimvo) => {
        palimvo.ui.registerHomeWidget("cards", async ({ el }) => {
          const answers = await palimvo.extensions.invoke("badges", { card: "ship it" });
          el.id = "cards";
          el.textContent = JSON.stringify(answers);
        });
      };`,
      {
        version: "1.2.0",
        contributes: {
          homeWidgets: [{ id: "cards", name: "Cards" }],
          extensionPoints: [{ id: "badges" }],
        },
      },
    );
    const contributor = plugin(
      "board-due",
      `export default (palimvo) => {
        palimvo.extensions.contribute("board", "badges", (input) => ({ text: "due: " + input.card }));
      };`,
      {
        dependencies: { board: "^1.0.0" },
        contributes: { extensions: [{ plugin: "board", point: "badges" }] },
      },
    );
    await serve(page, [provider, contributor], [["board", "cards"]]);
    await page.goto("/v/sample");
    await expect(frameOf(page, "board").locator("#cards")).toHaveText(
      JSON.stringify([{ text: "due: ship it" }]),
    );
  });

  test("a plugin cannot invoke an extension point it did not declare", async ({ page }) => {
    const p = plugin(
      "nosy",
      `export default (palimvo) => {
        palimvo.ui.registerHomeWidget("w", async ({ el }) => {
          try { await palimvo.extensions.invoke("secret", {}); el.textContent = "allowed"; }
          catch (e) { el.textContent = "denied:" + e.code; }
          el.id = "out";
        });
      };`,
      { contributes: { homeWidgets: [{ id: "w", name: "Nosy" }] } },
    );
    await serve(page, [p], [["nosy", "w"]]);
    await page.goto("/v/sample");
    await expect(frameOf(page, "nosy").locator("#out")).toHaveText("denied:permission_denied");
  });
});

test.describe("language", () => {
  test.use({ viewport: { width: 1280, height: 800 }, locale: "zh-TW", reducedMotion: "reduce" });

  test("plugin strings and names come in the interface language", async ({ page }) => {
    await serve(
      page,
      [
        plugin(
          "hello",
          `export default (palimvo) => {
            palimvo.ui.registerHomeWidget("greeting", ({ el }) => {
              el.id = "hello"; el.textContent = palimvo.i18n.t("hello", { name: "Ada" }) + "/" + palimvo.i18n.locale;
            });
          };`,
          {
            contributes: {
              homeWidgets: [{ id: "greeting", name: { en: "Greeting", "zh-TW": "問候" } }],
            },
            locales: { en: "locales/en.json", "zh-TW": "locales/zh-TW.json" },
          },
          {
            "locales/en.json": '{"hello":"Hello {name}"}',
            "locales/zh-TW.json": '{"hello":"哈囉 {name}"}',
          },
        ),
      ],
      [["hello", "greeting"]],
    );
    await page.goto("/v/sample");
    await expect(page.getByRole("region", { name: "問候" })).toBeVisible();
    await expect(frameOf(page, "hello").locator("#hello")).toHaveText("哈囉 Ada/zh-TW");
  });
});
