import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.ts";
import { mockMatchMedia, mockRoutes, renderRoute } from "../test/render.tsx";

const ada = {
  id: "a1",
  username: "ada",
  displayName: "Ada",
  serverAdmin: true,
  disabled: false,
  createdAt: 1,
};
const signedOut =
  (state: "guest" | "setup" | "open" = "guest") =>
  () =>
    Response.json({ state });
const tree = () =>
  Response.json({
    tree: [{ name: "Welcome.md", path: "Welcome.md", type: "file", kind: "markdown" }],
  });

beforeEach(() => {
  mockMatchMedia(false);
  initTheme();
  localStorage.clear();
});

describe("first-time setup", () => {
  it("sends a fresh server to the wizard and creates the administrator", async () => {
    const user = userEvent.setup();
    const server = mockRoutes({
      "GET /api/auth/me": signedOut("setup"),
      "GET /api/setup/status": () => Response.json({ required: true, needsCode: false }),
      "POST /api/setup": () =>
        Response.json(
          { account: ada, csrfToken: "tok", vault: { id: "notes", name: "notes" } },
          { status: 201 },
        ),
      "GET /api/vaults/notes/files": tree,
    });
    const { router } = await renderRoute("/");
    expect(await screen.findByRole("heading", { name: "Set up Palimvo" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/setup");
    const next = await screen.findByRole("button", { name: "Continue" });
    expect(screen.queryByLabelText("Setup code")).toBeNull();
    await user.click(next);
    await user.type(screen.getByLabelText("Username"), "ada");
    await user.type(screen.getByLabelText("Password"), "short");
    await user.type(screen.getByLabelText("Password again"), "different");
    await user.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Use at least 10 characters.")).toBeInTheDocument();
    expect(screen.getByText("The two passwords are not the same.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Password"));
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.clear(screen.getByLabelText("Password again"));
    await user.type(screen.getByLabelText("Password again"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    await user.clear(screen.getByLabelText("Vault name"));
    await user.type(screen.getByLabelText("Vault name"), "bad name!");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByText(/Use letters, digits, dash or underscore/)).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Vault name"));
    await user.type(screen.getByLabelText("Vault name"), "notes");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    await waitFor(() => expect(router.state.location.pathname).toBe("/v/notes"));
    const post = server.calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      username: "ada",
      password: "correct horse battery",
      vault: { id: "notes", sample: true },
    });
  });

  it("asks for the setup code when the server wants one", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/auth/me": signedOut("setup"),
      "GET /api/setup/status": () => Response.json({ required: true, needsCode: true }),
    });
    await renderRoute("/setup");
    await user.click(await screen.findByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Enter the setup code.")).toBeInTheDocument();
    expect(screen.getByLabelText("Setup code")).toBeInTheDocument();
  });

  it("is written in the chosen language", async () => {
    mockRoutes({
      "GET /api/auth/me": signedOut("setup"),
      "GET /api/setup/status": () => Response.json({ required: true, needsCode: false }),
    });
    await renderRoute("/setup", "zh-TW");
    expect(await screen.findByRole("heading", { name: "設定 Palimvo" })).toBeInTheDocument();
  });
});

describe("signing in", () => {
  it("shows the wrong-password message in the interface language", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/auth/me": signedOut(),
      "POST /api/auth/login": () =>
        Response.json({ code: "invalid_credentials", message: "x" }, { status: 401 }),
    });
    await renderRoute("/login", "zh-TW");
    await user.type(await screen.findByLabelText("使用者名稱"), "ada");
    await user.type(screen.getByLabelText("密碼"), "nope");
    await user.click(screen.getByRole("button", { name: "登入" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("名稱或密碼錯誤");
  });

  it("goes back to where the person was heading and sends the CSRF token afterwards", async () => {
    const user = userEvent.setup();
    let signedIn = false;
    const server = mockRoutes({
      "GET /api/auth/me": () =>
        signedIn
          ? Response.json({ state: "account", account: ada, csrfToken: "tok" })
          : Response.json({ state: "guest" }),
      "POST /api/auth/login": () => {
        signedIn = true;
        return Response.json({ account: ada, csrfToken: "tok" });
      },
      "GET /api/vaults": () => Response.json({ vaults: [] }),
      "POST /api/auth/password": () => new Response(null, { status: 204 }),
    });
    const { router } = await renderRoute("/login?next=%2Fsettings%2Faccount");
    await user.type(await screen.findByLabelText("Username"), "ada");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/settings/account"));

    await user.type(await screen.findByLabelText("Current password"), "correct horse battery");
    await user.type(screen.getByLabelText("New password"), "another long password");
    await user.type(screen.getByLabelText("Password again"), "another long password");
    await user.click(screen.getByRole("button", { name: "Change password" }));
    await waitFor(() =>
      expect(server.calls.some((c) => c.url === "/api/auth/password")).toBe(true),
    );
    const change = server.calls.find((c) => c.url === "/api/auth/password");
    expect(change?.headers["X-Palimvo-Csrf"]).toBe("tok");
    const login = server.calls.find((c) => c.url === "/api/auth/login");
    expect(login?.headers["X-Palimvo-Csrf"]).toBeUndefined();
  });

  it("does not follow a next address that leaves the site", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/auth/me": signedOut(),
      "POST /api/auth/login": () => Response.json({ account: ada, csrfToken: "tok" }),
      "GET /api/vaults": () => Response.json({ vaults: [] }),
    });
    const { router } = await renderRoute("/login?next=%2F%2Fevil.example");
    await user.type(await screen.findByLabelText("Username"), "ada");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("offers guests a sign-in link and keeps settings behind it", async () => {
    mockRoutes({
      "GET /api/auth/me": signedOut(),
      "GET /api/vaults": () => Response.json({ vaults: [{ id: "pub", name: "pub" }] }),
    });
    const { router } = await renderRoute("/");
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/login?next=%2F",
    );
    router.navigate("/settings/users");
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toBe("?next=%2Fsettings%2Fusers");
  });
});

describe("invites", () => {
  it("shows what the invite gives and creates the account", async () => {
    const user = userEvent.setup();
    const server = mockRoutes({
      "GET /api/auth/me": signedOut(),
      "GET /api/auth/invites/abc": () =>
        Response.json({
          note: "Welcome, designer",
          expiresAt: Date.now() + 1000,
          vaults: [{ vaultId: "notes", position: "member" }],
          roles: [{ id: "r1", name: "Reader" }],
        }),
      "POST /api/auth/invites/abc/accept": () =>
        Response.json(
          { account: { ...ada, serverAdmin: false, displayName: "Bo" }, csrfToken: "t" },
          { status: 201 },
        ),
      "GET /api/vaults/notes/files": tree,
    });
    const { router } = await renderRoute("/invite/abc");
    expect(await screen.findByText("Welcome, designer")).toBeInTheDocument();
    expect(screen.getByText("Reader")).toBeInTheDocument();
    await user.type(screen.getByLabelText("Username"), "bo");
    await user.type(screen.getByLabelText("Password"), "correct horse battery");
    await user.type(screen.getByLabelText("Password again"), "correct horse battery");
    await user.click(screen.getByRole("button", { name: "Create my account" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/v/notes"));
    expect(server.calls.find((c) => c.url.endsWith("/accept"))?.body).toEqual({
      username: "bo",
      password: "correct horse battery",
    });
  });

  it("explains an invite that no longer works", async () => {
    mockRoutes({
      "GET /api/auth/me": signedOut(),
      "GET /api/auth/invites/old": () =>
        Response.json({ code: "invite_invalid", message: "x" }, { status: 410 }),
    });
    await renderRoute("/invite/old");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This invite link is not valid or has expired.",
    );
  });
});

describe("what a reader sees", () => {
  it("hides every way to change things when the vault only allows reading", async () => {
    const user = userEvent.setup();
    mockRoutes({
      "GET /api/auth/me": () =>
        Response.json({
          state: "account",
          account: { ...ada, serverAdmin: false },
          csrfToken: "t",
        }),
      "GET /api/me/permissions": () =>
        Response.json({ server: [], vault: ["vault.view", "note.read", "history.view"] }),
      "GET /api/vaults": () => Response.json({ vaults: [{ id: "notes", name: "notes" }] }),
      "GET /api/vaults/notes/files": tree,
      "GET /api/vaults/notes/files/Welcome.md": () =>
        Response.json({ path: "Welcome.md", content: "Hello", mtime: 1, version: "v" }),
    });
    await renderRoute("/v/notes/Welcome.md");
    expect(await screen.findByText("View only")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Import/ })).toBeNull();
    await waitFor(() =>
      expect(document.querySelector(".cm-content")?.getAttribute("contenteditable")).toBe("false"),
    );

    await user.click(screen.getByRole("button", { name: "Commands" }));
    expect(await screen.findByRole("option", { name: /Quick open/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Rename/ })).toBeNull();
    expect(screen.queryByRole("option", { name: /^Delete/ })).toBeNull();
  });

  it("offers editing to someone who may write", async () => {
    mockRoutes({
      "GET /api/vaults": () => Response.json({ vaults: [{ id: "notes", name: "notes" }] }),
      "GET /api/vaults/notes/files": tree,
    });
    await renderRoute("/v/notes");
    expect(await screen.findByRole("button", { name: "New note" })).toBeInTheDocument();
  });
});

describe("administration", () => {
  it("lists people and makes an invite link", async () => {
    const user = userEvent.setup();
    const server = mockRoutes({
      "GET /api/admin/users": () =>
        Response.json({
          users: [
            { ...ada, roles: [], vaults: [] },
            {
              ...ada,
              id: "b2",
              username: "bo",
              displayName: "Bo",
              serverAdmin: false,
              roles: [{ id: "r1", name: "Reader" }],
              vaults: [],
            },
          ],
        }),
      "GET /api/admin/roles": () =>
        Response.json({
          roles: [
            { id: "e", name: "@everyone", position: 0, everyone: true, manageable: false },
            { id: "r1", name: "Reader", position: 1, everyone: false, manageable: true },
          ],
        }),
      "GET /api/admin/invites": () => Response.json({ invites: [] }),
      "GET /api/vaults": () => Response.json({ vaults: [{ id: "notes", name: "notes" }] }),
      "POST /api/admin/invites": () =>
        Response.json(
          { url: "http://localhost/invite/secret", token: "secret", invite: {} },
          { status: 201 },
        ),
    });
    await renderRoute("/settings/users");
    const bo = (await screen.findByText("Bo")).closest("li")!;
    expect(within(bo).getByText("Reader")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Invite people" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(await within(dialog).findByLabelText("notes"));
    await user.click(within(dialog).getByLabelText("Reader"));
    await user.click(within(dialog).getByRole("button", { name: "Create invite link" }));
    expect(
      await within(dialog).findByDisplayValue("http://localhost/invite/secret"),
    ).toBeInTheDocument();
    const post = server.calls.find((c) => c.method === "POST");
    expect(post?.body).toMatchObject({
      roleIds: ["r1"],
      vaults: [{ vaultId: "notes", position: "member" }],
    });
  });

  it("hides the people page link from someone who cannot manage users", async () => {
    mockRoutes({
      "GET /api/auth/me": () =>
        Response.json({
          state: "account",
          account: { ...ada, serverAdmin: false },
          csrfToken: "t",
        }),
      "GET /api/me/permissions": () => Response.json({ server: [] }),
      "GET /api/auth/sessions": () => Response.json({ sessions: [] }),
    });
    await renderRoute("/settings/account");
    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "People" })).toBeNull();
  });
});
