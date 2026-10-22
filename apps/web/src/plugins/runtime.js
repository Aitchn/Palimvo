// Runs inside a plugin's sandboxed iframe: an opaque origin with no access to the app, its
// cookies or its storage. The plugin reaches the vault only through the calls below, which the
// app checks against the folders the plugin declared and the rights of the person using it.
//
// Handshake: the frame says "hello" once; the app answers with "init" and a private port. All
// later messages travel over that port, so another page loaded into this frame has no way in.
(() => {
  "use strict";
  const SCHEMA = 1;
  const CALL_TIMEOUT_MS = 30000;

  const pending = new Map();
  const listeners = new Map();
  const views = new Map();
  const codeBlocks = new Map();
  const components = new Map();
  const viewers = new Map();
  const baseViews = new Map();
  const homeWidgets = new Map();
  const slots = new Map();
  const extensionHandlers = new Map();
  let app = null;
  let declared = {};
  let strings = { current: {}, en: {} };
  let locale = "en";
  let port = null;
  let started = false;
  let disposed = false;
  let deactivate = null;
  let cleanup = null;
  let nextId = 1;
  let drawing = Promise.resolve();
  let drawn = null;
  const prefix =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Date.now() + "-" + Math.random().toString(36).slice(2);
  const queued = [];

  function send(message) {
    if (disposed) return;
    if (port) port.postMessage(message);
    else queued.push(message);
  }

  function finish(requestId) {
    const item = pending.get(requestId);
    if (!item) return null;
    clearTimeout(item.timer);
    pending.delete(requestId);
    return item;
  }

  function failure(message, code) {
    const error = new Error(message);
    error.code = code || "unavailable";
    return error;
  }

  function call(method, params) {
    return new Promise((resolve, reject) => {
      if (disposed) return reject(failure("The plugin was stopped"));
      const requestId = prefix + ":" + nextId++;
      const timer = setTimeout(() => {
        if (finish(requestId)) {
          send({ type: "cancel", schemaVersion: SCHEMA, requestId });
          reject(failure("The call timed out"));
        }
      }, CALL_TIMEOUT_MS);
      pending.set(requestId, { resolve, reject, timer });
      send({ type: "rpc", schemaVersion: SCHEMA, requestId, method, params: params || {} });
    });
  }

  function translate(key, params) {
    let text = strings.current[key];
    if (text === undefined) text = strings.en[key];
    if (text === undefined) return key;
    return String(text).replace(/\{(\w+)\}/g, (whole, name) =>
      params && params[name] !== undefined ? String(params[name]) : whole,
    );
  }

  function emit(name, data) {
    for (const handler of listeners.get(name) || []) {
      try {
        handler(data);
      } catch (error) {
        console.error(error);
      }
    }
  }

  function showError(error) {
    const message = String((error && error.message) || error);
    const box = document.createElement("pre");
    box.className = "plugin-error";
    box.textContent = message;
    document.body.append(box);
    send({ type: "error", schemaVersion: SCHEMA, message });
  }

  function register(map, kind, key, allowed, handler) {
    if (!allowed.includes(key)) throw new Error("Undeclared " + kind + ": " + key);
    if (map.has(key)) throw new Error("Duplicate " + kind + ": " + key);
    if (typeof handler !== "function") throw new Error(kind + " renderer must be a function");
    map.set(key, handler);
    return () => map.delete(key);
  }

  function buildApi(init) {
    const base = {
      plugin: Object.freeze({ id: init.plugin.id, version: init.plugin.version }),
      vault: Object.freeze({
        read: (path) => call("vault.read", { path }),
        readBinary: (path) => call("vault.readBinary", { path }),
        list: (dir, options) =>
          call("vault.list", {
            ...(dir ? { dir } : {}),
            ...(options && options.recursive ? { recursive: true } : {}),
          }),
        search: (query, options) =>
          call("vault.search", {
            query,
            ...(options && options.limit ? { limit: options.limit } : {}),
            ...(options && options.folder ? { folder: options.folder } : {}),
          }),
        queryBase: (path, options) =>
          call("vault.queryBase", {
            path,
            ...(options && options.view ? { view: options.view } : {}),
          }),
        write: (path, content, options) =>
          call("vault.write", {
            path,
            content,
            ...(options && options.reason ? { reason: options.reason } : {}),
          }),
        propose: (input) =>
          call("vault.propose", {
            path: input.path,
            content: input.content,
            ...(input.title ? { title: input.title } : {}),
            ...(input.reason ? { reason: input.reason } : {}),
          }),
      }),
      ui: Object.freeze({
        registerView: (id, render) => register(views, "view", id, declared.views, render),
        registerCodeBlock: (language, render) =>
          register(codeBlocks, "code block", language, declared.codeBlocks, render),
        registerComponent: (type, render) =>
          register(components, "component", type, declared.components, render),
        registerViewer: (id, render) => register(viewers, "viewer", id, declared.viewers, render),
        registerBaseView: (type, render) =>
          register(baseViews, "base view", type, declared.baseViews, render),
        registerHomeWidget: (id, render) =>
          register(homeWidgets, "home widget", id, declared.homeWidgets, render),
        registerSlot: (slot, id, handler) => {
          if (
            !handler ||
            (typeof handler.run !== "function" && typeof handler.render !== "function")
          )
            throw new Error("A slot handler needs a run or render function");
          const key = slot + "/" + id;
          if (!declared.slots.includes(key)) throw new Error("Undeclared slot: " + key);
          if (slots.has(key)) throw new Error("Duplicate slot: " + key);
          slots.set(key, handler);
          return () => slots.delete(key);
        },
        registerApp: (render) => {
          if (!declared.app) throw new Error("Undeclared app");
          return register(views, "app", "@app", ["@app"], render);
        },
        showNotice: (message, options) => {
          void call("ui.showNotice", {
            message: String(message),
            ...(options && options.kind ? { kind: options.kind } : {}),
          }).catch(() => {});
        },
        openFile: (path) => {
          void call("ui.openFile", { path }).catch(() => {});
        },
      }),
      events: Object.freeze({
        on: (name, handler) => {
          if (typeof handler !== "function") throw new Error("An event handler must be a function");
          if (!listeners.has(name)) listeners.set(name, new Set());
          listeners.get(name).add(handler);
          return () => listeners.get(name).delete(handler);
        },
      }),
      i18n: {
        get locale() {
          return locale;
        },
        t: translate,
      },
      extensions: Object.freeze({
        invoke: (point, input) =>
          call("extensions.invoke", { point, input: input === undefined ? null : input }),
        contribute: (plugin, point, handler) => {
          const key = plugin + "/" + point;
          if (!declared.extensions.includes(key)) throw new Error("Undeclared extension: " + key);
          if (typeof handler !== "function")
            throw new Error("An extension handler must be a function");
          extensionHandlers.set(key, handler);
          return () => extensionHandlers.delete(key);
        },
      }),
    };
    return Object.freeze(base);
  }

  function baseContext(context) {
    return {
      el: document.getElementById("root"),
      locale,
      theme: document.documentElement.dataset.theme === "light" ? "light" : "dark",
      ...context,
    };
  }

  function contextFor(mode, context) {
    const ctx = baseContext(context);
    if (mode === "codeBlock") ctx.update = (source) => call("ui.updateSource", { source });
    if (mode === "viewer") {
      ctx.read = () => call("vault.readBinary", { path: ctx.path });
      ctx.readText = () => call("vault.read", { path: ctx.path });
    }
    return ctx;
  }

  function rendererFor(mode, target) {
    const maps = {
      view: [views, "view"],
      app: [views, "app"],
      codeBlock: [codeBlocks, "code block"],
      component: [components, "component"],
      viewer: [viewers, "viewer"],
      baseView: [baseViews, "base view"],
      homeWidget: [homeWidgets, "home widget"],
    };
    if (mode === "slot") {
      // Only settings sections draw; the target is "<slot>/<id>".
      const handler = slots.get(target);
      if (!handler || typeof handler.render !== "function")
        throw new Error('The slot entry "' + target + '" has no render function');
      return (context) => handler.render(context);
    }
    const entry = maps[mode];
    if (!entry) throw new Error("Unknown mode: " + mode);
    const key = mode === "app" ? "@app" : target;
    const render = entry[0].get(key);
    if (!render) throw new Error("The " + entry[1] + ' "' + target + '" was not registered');
    return render;
  }

  async function draw(mode, render, context) {
    if (typeof cleanup === "function") {
      try {
        cleanup();
      } catch (error) {
        console.error(error);
      }
      cleanup = null;
    }
    document.getElementById("root").replaceChildren();
    const result = await render(contextFor(mode, context));
    if (typeof result === "function") cleanup = result;
  }

  async function start(init) {
    declared = init.declared;
    strings = init.strings;
    locale = init.locale;
    document.documentElement.dataset.theme = init.theme;
    app = buildApi(init);
    try {
      const url = URL.createObjectURL(new Blob([init.code], { type: "text/javascript" }));
      const module = await import(url);
      URL.revokeObjectURL(url);
      const activate = module.default || module.activate;
      if (typeof activate !== "function")
        throw new Error("main.js must export a default function: export default definePlugin(...)");
      const result = await activate(app);
      if (typeof result === "function") deactivate = result;
      if (disposed) return;
      if (init.mode === "background") {
        send({ type: "ready", schemaVersion: SCHEMA });
        return;
      }
      const render = rendererFor(init.mode, init.target);
      drawn = { mode: init.mode, render };
      drawing = draw(init.mode, render, init.context);
      await drawing;
      send({ type: "ready", schemaVersion: SCHEMA });
    } catch (error) {
      showError(error);
    }
  }

  function dispose() {
    if (disposed) return;
    for (const requestId of [...pending.keys()]) {
      const item = finish(requestId);
      if (item) item.reject(failure("The plugin was stopped"));
    }
    for (const fn of [cleanup, deactivate]) {
      try {
        if (typeof fn === "function") fn();
      } catch (error) {
        console.error(error);
      }
    }
    disposed = true;
    queued.length = 0;
    listeners.clear();
    if (port) port.close();
  }

  function reply(message, fields) {
    send({ ...fields, schemaVersion: SCHEMA, requestId: message.requestId });
  }

  function onPortMessage(event) {
    const message = event.data || {};
    if (disposed || message.schemaVersion !== SCHEMA) return;
    if (message.type === "rpc-result") {
      const item = finish(message.requestId);
      if (!item) return;
      if (message.error) item.reject(failure(message.error.message, message.error.code));
      else item.resolve(message.result);
    } else if (message.type === "event") {
      if (message.name === "locale:changed") {
        locale = message.data.locale;
        strings = message.data.strings;
      }
      if (message.name === "theme:changed") {
        // Same variables as the app, freshly read, and the matching color scheme.
        document.documentElement.dataset.theme = message.data.theme;
        document.documentElement.style.cssText =
          message.data.tokens + "color-scheme:" + message.data.theme + ";";
        emit(message.name, { theme: message.data.theme });
        return;
      }
      emit(message.name, message.data);
    } else if (message.type === "update" && drawn) {
      // New data for the same contribution (the YAML or the vault changed): draw it again, in order.
      const context = message.context;
      drawing = drawing
        .catch(() => {})
        .then(() => draw(drawn.mode, drawn.render, context))
        .catch(showError);
    } else if (message.type === "invoke") {
      const handler = extensionHandlers.get(message.plugin + "/" + message.point);
      if (!handler) {
        reply(message, {
          type: "invoke-result",
          error: "No handler for " + message.plugin + "/" + message.point,
        });
        return;
      }
      Promise.resolve()
        .then(() => handler(message.input))
        .then(
          (result) => {
            try {
              reply(message, {
                type: "invoke-result",
                result: result === undefined ? null : result,
              });
            } catch {
              reply(message, {
                type: "invoke-result",
                error: "The result must be plain data (JSON)",
              });
            }
          },
          (error) =>
            reply(message, {
              type: "invoke-result",
              error: String((error && error.message) || error),
            }),
        );
    } else if (message.type === "slot") {
      const handler = slots.get(message.slot + "/" + message.id);
      if (!handler) {
        reply(message, { type: "slot-result", error: "Slot entry not registered" });
        return;
      }
      Promise.resolve()
        .then(() =>
          message.op === "visible"
            ? typeof handler.visible === "function"
              ? handler.visible(message.context || {}) !== false
              : true
            : typeof handler.run === "function"
              ? handler.run(message.context || {})
              : Promise.reject(new Error("Slot entry cannot be run")),
        )
        .then(
          (result) =>
            reply(message, { type: "slot-result", result: result === undefined ? null : result }),
          (error) =>
            reply(message, {
              type: "slot-result",
              error: String((error && error.message) || error),
            }),
        );
    } else if (message.type === "dispose") {
      dispose();
    }
  }

  window.addEventListener("message", (event) => {
    if (event.source !== parent || started) return;
    const message = event.data || {};
    if (message.type !== "init" || message.schemaVersion !== SCHEMA || !event.ports[0]) return;
    started = true;
    port = event.ports[0];
    port.onmessage = onPortMessage;
    for (const queuedMessage of queued.splice(0)) port.postMessage(queuedMessage);
    void start(message);
  });

  window.addEventListener("error", (event) => showError(event.error || event.message));
  window.addEventListener("unhandledrejection", (event) => showError(event.reason));
  window.addEventListener("pagehide", dispose);
  new ResizeObserver(() =>
    send({ type: "resize", schemaVersion: SCHEMA, height: document.documentElement.scrollHeight }),
  ).observe(document.body);
  parent.postMessage({ type: "hello" }, "*");
})();
