import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { AppError } from "@palimvo/core";
import { WebSocketServer } from "ws";
import { errorFields } from "../errors.ts";
import type { Logger } from "../log.ts";
import { MAX_TEXT_BYTES } from "../vault/fsutil.ts";
import { GONE, type CollabHub, type ConnectOptions } from "./hub.ts";

export const COLLAB_PATH = "/api/collab/";

/** Who may connect to a vault, and how; null refuses. Accounts (T10) plug in here. */
export type CollabAuthorizer = (
  req: IncomingMessage,
  vault: string,
) => Promise<ConnectOptions | null>;

export interface CollabSocket {
  /** Stops accepting clients. Open connections are closed by `CollabHub.closeAll`. */
  close(): void;
}

/**
 * Accepts y-websocket clients at `/api/collab/<room>?vault=<id>&path=<file>[&lineage=<id>]`.
 * The room segment is ignored; the document is identified by vault and path.
 */
export function attachCollab(
  server: Server,
  hub: CollabHub,
  options: {
    logger: Logger;
    ready: () => boolean;
    /** Believe `X-Forwarded-Host` when comparing the page's origin with this server. */
    trustProxy?: boolean;
    authorize?: CollabAuthorizer;
  },
): CollabSocket {
  const { logger, ready, trustProxy = false, authorize } = options;
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_TEXT_BYTES + 1024 * 1024 });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith(COLLAB_PATH)) {
      socket.destroy();
      return;
    }
    // A page on another site must not open a connection with this browser's session.
    if (!sameOrigin(req, trustProxy)) return reject(socket, 403, "Forbidden");
    if (!ready()) return reject(socket, 503, "Service Unavailable");
    const vault = url.searchParams.get("vault");
    const path = url.searchParams.get("path");
    if (!vault || !path) return reject(socket, 400, "Bad Request");
    const lineage = url.searchParams.get("lineage") ?? undefined;

    const upgrade = (connect: ConnectOptions) =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        hub.connect(ws, vault, path, lineage, connect).then(
          () => logger.debug("collab connected", { vault, path }),
          (err) => {
            const missing =
              err instanceof AppError &&
              (err.code === "not_found" ||
                err.code === "vault_not_found" ||
                err.code === "invalid_path");
            if (!missing)
              logger.error("collab connect failed", { vault, path, ...errorFields(err) });
            ws.close(missing ? GONE : 1011, missing ? "not found" : "error");
          },
        );
      });

    if (!authorize) return upgrade({});
    authorize(req, vault).then(
      (connect) => (connect ? upgrade(connect) : reject(socket, 401, "Unauthorized")),
      () => reject(socket, 500, "Internal Server Error"),
    );
  };

  server.on("upgrade", onUpgrade);
  return {
    close() {
      server.off("upgrade", onUpgrade);
      wss.close();
    },
  };
}

function sameOrigin(req: IncomingMessage, trustProxy: boolean): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser page
  try {
    // Behind a reverse proxy the public host is in X-Forwarded-Host.
    const forwarded = trustProxy
      ? (req.headers["x-forwarded-host"] as string | undefined)?.split(",")[0]?.trim()
      : undefined;
    const host = forwarded ?? req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}
