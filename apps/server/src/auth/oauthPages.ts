import { DEFAULT_LOCALE, flatten, locales, type Locale } from "@palimvo/i18n";
import type { TokenAccess } from "@palimvo/core";

/** The parameters of an authorize request, carried through the sign-in and consent forms. */
export const AUTHORIZE_FIELDS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;
export type AuthorizeFields = Partial<Record<(typeof AUTHORIZE_FIELDS)[number], string>>;

const flat = Object.fromEntries(
  (Object.keys(locales) as Locale[]).map((l) => [l, flatten(locales[l])]),
) as Record<Locale, Record<string, string>>;

/** Looks up a message and fills `{name}` placeholders; falls back to English. */
export function t(locale: Locale, key: string, vars: Record<string, string> = {}): string {
  const text = flat[locale]?.[key] ?? flat[DEFAULT_LOCALE]?.[key] ?? key;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Headers for every page: no framing (clickjacking on the consent button), nothing else loads. */
export const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
} as const;

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--fg:#1b1b1a;--muted:#62625e;--line:#d9d9d3;--accent:#4a3fd4;--accent-fg:#fff;--danger:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#212120;--fg:#ececea;--muted:#a3a39d;--line:#3a3a37;--accent:#8c84ff;--accent-fg:#14121f;--danger:#ff8a80}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{width:100%;max-width:26rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:1.2rem;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:.9rem}
.warn{border-left:3px solid var(--danger);padding-left:10px}
label{display:block;margin:12px 0 4px;font-weight:600;font-size:.9rem}
input[type=text],input[type=password]{width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:transparent;color:inherit;font:inherit}
fieldset{border:0;padding:0;margin:12px 0}legend{font-weight:600;font-size:.9rem;margin-bottom:4px}
.opt{display:flex;gap:8px;align-items:center;margin:4px 0;font-weight:400}.opt input{margin:0}
.row{display:flex;gap:8px;margin-top:16px}button{flex:1;padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit;cursor:pointer}
button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.error{color:var(--danger);margin:8px 0 0}
`;

function shell(locale: Locale, title: string, body: string): string {
  return `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · Palimvo</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function hidden(fields: AuthorizeFields): string {
  return AUTHORIZE_FIELDS.flatMap((name) => {
    const v = fields[name];
    return v === undefined ? [] : [`<input type="hidden" name="${name}" value="${escapeHtml(v)}">`];
  }).join("");
}

export function errorPage(locale: Locale, message: string): string {
  return shell(
    locale,
    t(locale, "oauth.errorTitle"),
    `<h1>${escapeHtml(t(locale, "oauth.errorTitle"))}</h1><p>${escapeHtml(message)}</p>`,
  );
}

export function signInPage(
  locale: Locale,
  input: {
    client: string;
    fields: AuthorizeFields;
    base: string;
    username?: string;
    error?: string;
  },
): string {
  const title = t(locale, "oauth.pageTitle");
  return shell(
    locale,
    title,
    `<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(t(locale, "oauth.signInIntro", { client: input.client }))}</p>
<form method="post" action="${escapeHtml(input.base)}/oauth/login">${hidden(input.fields)}
<label for="u">${escapeHtml(t(locale, "oauth.username"))}</label>
<input id="u" type="text" name="username" value="${escapeHtml(input.username ?? "")}" autocomplete="username" required autofocus>
<label for="p">${escapeHtml(t(locale, "oauth.password"))}</label>
<input id="p" type="password" name="password" autocomplete="current-password" required>
${input.error ? `<p class="error" role="alert">${escapeHtml(input.error)}</p>` : ""}
<div class="row"><button class="primary" type="submit">${escapeHtml(t(locale, "oauth.signIn"))}</button></div></form>`,
  );
}

export function consentPage(
  locale: Locale,
  input: {
    client: string;
    redirectHost: string;
    account: string;
    csrf: string;
    fields: AuthorizeFields;
    /** Path the server is published under (from the public address), without a trailing slash. */
    base: string;
    defaultAccess: TokenAccess;
  },
): string {
  const title = t(locale, "oauth.pageTitle");
  const option = (access: TokenAccess, key: string) =>
    `<label class="opt"><input type="radio" name="access" value="${access}"${access === input.defaultAccess ? " checked" : ""}> ${escapeHtml(t(locale, key))}</label>`;
  return shell(
    locale,
    title,
    `<h1>${escapeHtml(title)}</h1>
<p><strong>${escapeHtml(t(locale, "oauth.clientWants", { client: input.client }))}</strong></p>
<p class="muted warn">${escapeHtml(t(locale, "oauth.unverified"))}</p>
<p class="muted">${escapeHtml(t(locale, "oauth.redirectsTo", { host: input.redirectHost }))}</p>
<p>${escapeHtml(t(locale, "oauth.canDo"))}</p>
<form method="post" action="${escapeHtml(input.base)}/oauth/authorize">${hidden(input.fields)}
<input type="hidden" name="csrf" value="${escapeHtml(input.csrf)}">
<fieldset><legend>${escapeHtml(t(locale, "oauth.accessLabel"))}</legend>
${option("read", "oauth.accessRead")}${option("propose", "oauth.accessPropose")}${option("write", "oauth.accessWrite")}</fieldset>
<p class="muted">${escapeHtml(t(locale, "oauth.signedInAs", { name: input.account }))} · ${escapeHtml(t(locale, "oauth.revokeHint"))}</p>
<div class="row"><button type="submit" name="decision" value="deny">${escapeHtml(t(locale, "oauth.deny"))}</button><button class="primary" type="submit" name="decision" value="allow">${escapeHtml(t(locale, "oauth.allow"))}</button></div></form>`,
  );
}
