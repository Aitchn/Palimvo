import { render } from "@testing-library/react";
import type { i18n as I18n } from "i18next";
import type { ReactElement } from "react";
import { I18nextProvider } from "react-i18next";
import { RouterProvider, createMemoryRouter } from "react-router";
import type { Locale } from "@palimvo/i18n/negotiate";
import { routes } from "../app/routes.tsx";
import { createI18n } from "../i18n/index.ts";
import { ToastProvider } from "../ui/index.ts";

/** jsdom has no matchMedia; this one answers the phone query from `mobile` and everything else with false. */
export function mockMatchMedia(mobile: boolean): void {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("max-width") ? mobile : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
}

export async function renderWithProviders(ui: ReactElement, locale: Locale = "en") {
  const i18n: I18n = await createI18n(locale);
  return {
    i18n,
    ...render(
      <I18nextProvider i18n={i18n}>
        <ToastProvider>{ui}</ToastProvider>
      </I18nextProvider>,
    ),
  };
}

export async function renderRoute(path: string, locale: Locale = "en") {
  const i18n = await createI18n(locale);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  return {
    i18n,
    router,
    ...render(
      <I18nextProvider i18n={i18n}>
        <RouterProvider router={router} />
      </I18nextProvider>,
    ),
  };
}

/** The home page of the `sample` vault most tests open: the default blocks with nothing in them. */
export const SAMPLE_HOME = {
  config: {
    schemaVersion: 1,
    widgets: [
      { id: "proposals", type: "proposals" },
      { id: "activity", type: "activity" },
      { id: "pinned", type: "pinned" },
    ],
    pinned: [],
    publicNote: null,
  },
  version: null,
};

/** Every page asks who is using it first; unless a test says otherwise, someone administrator is. */
const SIGNED_IN: Record<string, () => Response> = {
  "/api/auth/me": () =>
    Response.json({
      state: "account",
      account: {
        id: "a1",
        username: "ada",
        displayName: "Ada",
        serverAdmin: true,
        disabled: false,
        createdAt: 1,
      },
      csrfToken: "csrf",
    }),
  "/api/vaults/sample/home": () => Response.json(SAMPLE_HOME),
  "/api/vaults/sample/home/activity": () =>
    Response.json({ filter: "all", entries: [], authors: [] }),
  "/api/me/permissions": () =>
    Response.json({
      server: ["server.manage", "users.manage", "roles.manage", "vaults.create"],
      vault: ["vault.view", "note.read", "note.write", "note.delete", "file.upload"],
    }),
};

/** Replaces `fetch` with a router of `path -> handler`; unmatched paths answer 404 JSON. */
export function mockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  handlers = { ...SIGNED_IN, ...handlers };
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const handler = handlers[url] ?? handlers[url.split("?")[0]!];
    return handler
      ? handler()
      : Response.json({ code: "not_found", message: "Not found." }, { status: 404 });
  };
  globalThis.fetch = fake as typeof fetch;
  return calls;
}

export interface RecordedCall {
  method: string;
  url: string;
  body?: unknown;
  headers: Record<string, string>;
}

/**
 * Like {@link mockFetch}, but routes by `"METHOD url"` (the method defaults to GET) and records the
 * parsed JSON body of every call. Handlers may be replaced during a test through the returned map.
 */
export function mockRoutes(
  handlers: Record<string, (call: RecordedCall) => Response | Promise<Response>>,
) {
  handlers = {
    ...Object.fromEntries(Object.entries(SIGNED_IN).map(([k, v]) => [`GET ${k}`, v])),
    ...handlers,
  };
  const calls: RecordedCall[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const call: RecordedCall = {
      method,
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    const handler = handlers[`${method} ${url}`] ?? handlers[`${method} ${url.split("?")[0]}`];
    return handler
      ? handler(call)
      : Response.json({ code: "not_found", message: "Not found." }, { status: 404 });
  };
  globalThis.fetch = fake as typeof fetch;
  return { calls, handlers };
}
