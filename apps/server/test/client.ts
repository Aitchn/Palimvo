import type { TestServer } from "./harness.ts";

export const PASSWORD = "correct horse battery";

/** A tiny browser: keeps the session cookie and sends the CSRF header like the web app will. */
export class Client {
  cookie = "";
  csrf = "";

  constructor(private readonly server: TestServer) {}

  async request(path: string, init: RequestInit & { json?: unknown } = {}) {
    const headers = new Headers(init.headers);
    if (this.cookie) headers.set("cookie", this.cookie);
    if (this.csrf) headers.set("x-palimvo-csrf", this.csrf);
    let body = init.body;
    if (init.json !== undefined) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(init.json);
    }
    const res = await this.server.fetch(path, { ...init, headers, ...(body ? { body } : {}) });
    const set = res.headers.getSetCookie().find((c) => c.startsWith("palimvo_session="));
    if (set) this.cookie = set.split(";")[0]!;
    return res;
  }

  get = (path: string) => this.request(path);
  post = (path: string, json?: unknown) => this.request(path, { method: "POST", json });
  put = (path: string, json?: unknown) => this.request(path, { method: "PUT", json });
  patch = (path: string, json?: unknown) => this.request(path, { method: "PATCH", json });
  del = (path: string) => this.request(path, { method: "DELETE" });

  async login(username: string, password = PASSWORD) {
    const res = await this.post("/api/auth/login", { username, password });
    if (res.status === 200) this.csrf = ((await res.json()) as { csrfToken: string }).csrfToken;
    return res;
  }
}

export const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;
