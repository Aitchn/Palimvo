import { Awareness } from "y-protocols/awareness";
import type * as Y from "yjs";

type Handler = (...args: never[]) => void;

/** Stands in for y-websocket: the test plays the server by emitting its events. */
export class FakeProvider {
  static all: FakeProvider[] = [];
  readonly awareness: Awareness;
  readonly params: Record<string, string>;
  wsconnected = false;
  synced = false;
  destroyed = false;
  private readonly handlers = new Map<string, Handler[]>();

  constructor(
    readonly url: string,
    readonly room: string,
    readonly doc: Y.Doc,
    options: { params: Record<string, string> },
  ) {
    this.params = { ...options.params };
    this.awareness = new Awareness(doc);
    FakeProvider.all.push(this);
  }
  on(event: string, handler: Handler) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) (h as (...a: unknown[]) => void)(...args);
  }
  disconnect() {
    this.wsconnected = false;
  }
  destroy() {
    this.destroyed = true;
    this.awareness.destroy();
  }

  /** The server accepted the connection and sent the document. */
  serve(lineage = "L1", text = "hello") {
    this.wsconnected = true;
    this.synced = true;
    this.doc.transact(() => {
      this.doc.getMap("collab.meta").set("lineage", lineage);
      if (this.doc.getText("markdown").length === 0) this.doc.getText("markdown").insert(0, text);
    }, this);
    this.emit("status", { status: "connected" });
    this.emit("sync", true);
  }
  drop() {
    this.wsconnected = false;
    this.synced = false;
    this.emit("status", { status: "disconnected" });
  }
}
