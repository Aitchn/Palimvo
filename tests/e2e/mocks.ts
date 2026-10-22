import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";

const textOf = (path: string) => `# ${path}\n\nText of ${path}.`;

/**
 * The live-editing connection of the fake server: it hands each note to the page as a Yjs
 * document (the first step of the y-websocket protocol) and ignores what the page sends back.
 */
async function mockCollab(page: Page): Promise<void> {
  await page.routeWebSocket(/\/api\/collab\//, (ws) => {
    const path = new URL(ws.url()).searchParams.get("path") ?? "";
    const doc = new Y.Doc();
    doc.transact(() => {
      doc.getMap("collab.meta").set("lineage", "mock");
      doc.getText("markdown").insert(0, textOf(path));
    });
    const send = (message: encoding.Encoder) =>
      ws.send(Buffer.from(encoding.toUint8Array(message)));
    ws.onMessage((raw) => {
      const decoder = decoding.createDecoder(new Uint8Array(Buffer.from(raw)));
      if (decoding.readVarUint(decoder) !== 0) return; // awareness
      const reply = encoding.createEncoder();
      encoding.writeVarUint(reply, 0);
      syncProtocol.readSyncMessage(decoder, reply, doc, null);
      if (encoding.length(reply) > 1) send(reply);
    });
    const step1 = encoding.createEncoder();
    encoding.writeVarUint(step1, 0);
    syncProtocol.writeSyncStep1(step1, doc);
    send(step1);
  });
}

/** A small fake server: one vault with a few files. */
export async function mockApi(page: Page): Promise<void> {
  await mockCollab(page);
  await page.route("**/api/vaults", (route) =>
    route.fulfill({ json: { vaults: [{ id: "sample", name: "sample" }] } }),
  );
  await page.route("**/api/vaults/sample/files", (route) =>
    route.fulfill({
      json: {
        tree: [
          {
            name: "Projects",
            path: "Projects",
            type: "folder",
            children: [
              { name: "Roadmap.md", path: "Projects/Roadmap.md", type: "file", kind: "markdown" },
              { name: "Board.canvas", path: "Projects/Board.canvas", type: "file", kind: "canvas" },
            ],
          },
          { name: "Tasks.base", path: "Tasks.base", type: "file", kind: "base" },
          { name: "Welcome.md", path: "Welcome.md", type: "file", kind: "markdown" },
        ],
      },
    }),
  );
  await page.route("**/api/vaults/sample/files/**", (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname).split("/files/")[1];
    return route.fulfill({
      json: { path, content: textOf(path), mtime: 1, version: "v1" },
    });
  });
}

/** Where a screenshot goes: tests/e2e/screenshots/<name>.png (CI uploads the folder). */
export function shotPath(name: string): string {
  return fileURLToPath(new URL(`./screenshots/${name}.png`, import.meta.url));
}
