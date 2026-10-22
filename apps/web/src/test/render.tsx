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

/** Replaces `fetch` with a router of `path -> handler`; unmatched paths answer 404 JSON. */
export function mockFetch(handlers: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fake = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    const handler = handlers[url];
    return handler
      ? handler()
      : Response.json({ code: "not_found", message: "Not found." }, { status: 404 });
  };
  globalThis.fetch = fake as typeof fetch;
  return calls;
}
