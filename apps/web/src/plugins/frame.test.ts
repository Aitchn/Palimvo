import { afterEach, describe, expect, it, vi } from "vitest";
import { contentSecurityPolicy, frameDocument, mountPlugin } from "./frame.ts";
import { PluginSession, bindingFor } from "./session.ts";
import { fakeBackend, makePlugin } from "./testing.ts";

const actor = { read: true, write: true, propose: true };

describe("contentSecurityPolicy", () => {
  const directive = (csp: string, name: string) =>
    csp
      .split("; ")
      .find((d) => d.startsWith(`${name} `))
      ?.slice(name.length + 1);

  it("lets nothing leave the frame without the network permission", () => {
    const csp = contentSecurityPolicy(false, "N0nce");
    expect(directive(csp, "default-src")).toBe("'none'");
    expect(directive(csp, "connect-src")).toBe("'none'");
    expect(directive(csp, "img-src")).toBe("data: blob:");
    expect(directive(csp, "media-src")).toBe("data: blob:");
    expect(directive(csp, "font-src")).toBe("data:");
    expect(directive(csp, "frame-src")).toBe("'none'");
    expect(directive(csp, "form-action")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'none'");
    expect(directive(csp, "object-src")).toBe("'none'");
  });

  it("takes script only from the runtime's nonce and local blobs, never from a host", () => {
    for (const network of [false, ["api.example.com"], ["*"]] as const) {
      const script = directive(contentSecurityPolicy(network, "N0nce"), "script-src");
      expect(script).toBe("'nonce-N0nce' blob:");
    }
  });

  it("allows only the listed hosts over https and wss", () => {
    const csp = contentSecurityPolicy(["api.example.com", "*.cdn.example.com"], "n");
    expect(directive(csp, "connect-src")).toBe(
      "https://api.example.com wss://api.example.com https://*.cdn.example.com wss://*.cdn.example.com",
    );
    expect(directive(csp, "img-src")).toBe(
      "data: blob: https://api.example.com https://*.cdn.example.com",
    );
  });

  it("opens every https host only for the explicit wildcard", () => {
    const csp = contentSecurityPolicy(["*"], "n");
    expect(directive(csp, "connect-src")).toBe("https: wss:");
    expect(directive(csp, "img-src")).toBe("data: blob: https:");
  });

  it("drops host names that could break out of the policy", () => {
    const csp = contentSecurityPolicy(
      ["good.example.com", "x; script-src *", "a b", "'self'"],
      "n",
    );
    expect(csp).not.toContain("script-src *");
    expect(csp).not.toContain("'self'");
    expect(directive(csp, "connect-src")).toBe("https://good.example.com wss://good.example.com");
  });
});

describe("frameDocument", () => {
  it("carries the policy, the nonce and the runtime, and nothing from the plugin", () => {
    const plugin = makePlugin({ id: "demo" }, { code: "SECRET-PLUGIN-CODE" });
    const html = frameDocument(plugin, "light", "abc123");
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain('<script nonce="abc123">');
    expect(html).toContain("script-src 'nonce-abc123' blob:");
    expect(html).toContain('data-theme="light"');
    // The plugin's code goes over the port, never into the page the CSP was written for.
    expect(html).not.toContain("SECRET-PLUGIN-CODE");
  });

  it("uses a fresh nonce each time", () => {
    const plugin = makePlugin({ id: "demo" });
    const nonce = (html: string) => /nonce="([^"]+)"/.exec(html)?.[1];
    expect(nonce(frameDocument(plugin, "dark"))).not.toBe(nonce(frameDocument(plugin, "dark")));
  });
});

describe("mountPlugin", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function mount(over: Partial<Parameters<typeof mountPlugin>[1]> = {}) {
    const plugin = makePlugin({ id: "demo", permissions: { read: ["**"] } });
    const session = new PluginSession(bindingFor("v", plugin.manifest, plugin.hash, actor));
    const container = document.createElement("div");
    document.body.append(container);
    const frame = mountPlugin(container, {
      plugin,
      session,
      backend: fakeBackend(),
      actions: { openFile: vi.fn(), showNotice: vi.fn(), invokeExtension: vi.fn() },
      mode: "view",
      target: "x",
      locale: "en",
      theme: "dark",
      ...over,
    });
    return { container, session, frame, plugin };
  }

  it("creates a sandboxed iframe that can run script and nothing else", () => {
    const { container } = mount();
    const iframe = container.querySelector("iframe")!;
    expect(iframe).not.toBeNull();
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(iframe.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(iframe.srcdoc).toContain("Content-Security-Policy");
  });

  it("removes the frame on cleanup", () => {
    const { container, frame } = mount();
    frame.cleanup();
    expect(container.querySelector("iframe")).toBeNull();
    expect(() => frame.cleanup()).not.toThrow();
  });

  it("removes the frame and says so when the session is revoked", () => {
    const onStopped = vi.fn();
    const { container, session } = mount({ onStopped });
    session.revoke("approval withdrawn");
    expect(container.querySelector("iframe")).toBeNull();
    expect(onStopped).toHaveBeenCalledWith("revoked", "approval withdrawn");
  });

  it("refuses to start for a session that was already revoked", () => {
    const plugin = makePlugin({ id: "demo" });
    const session = new PluginSession(bindingFor("v", plugin.manifest, plugin.hash, actor));
    session.revoke();
    expect(() => {
      mountPlugin(document.createElement("div"), {
        plugin,
        session,
        backend: fakeBackend(),
        actions: { openFile: vi.fn(), showNotice: vi.fn(), invokeExtension: vi.fn() },
        mode: "view",
        target: "x",
        locale: "en",
        theme: "dark",
      });
    }).toThrow();
  });

  it("rejects calls into a stopped background frame", async () => {
    const { frame } = mount({ mode: "background" });
    frame.cleanup();
    await expect(frame.invoke("p", "pt", {})).rejects.toThrow(/stopped/);
  });
});
