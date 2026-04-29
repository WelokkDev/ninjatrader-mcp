import { createServer, type Server as HttpServer, type IncomingMessage } from "http";
import { WebSocketServer, type WebSocket } from "ws";
import type { ConnectionManager } from "./connection.js";
import { encode } from "./protocol.js";

export const DEFAULT_PORT = 9472;
export const SERVER_VERSION = "0.1.0";

export interface BridgeServer {
  port: number;
  stop(): Promise<void>;
}

function extractBearer(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

export async function startServer(opts: {
  port: number;
  token: string;
  connections: ConnectionManager;
}): Promise<BridgeServer> {
  const { port, token, connections } = opts;

  const http: HttpServer = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on("upgrade", (req, socket, head) => {
    const provided = extractBearer(req);
    if (!provided || provided !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      console.error("[bridge] rejected upgrade: bad or missing token");
      return;
    }
    if (connections.hasActiveConnection()) {
      socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
      socket.destroy();
      console.error("[bridge] rejected upgrade: client already connected");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  wss.on("connection", (ws: WebSocket) => {
    connections.attach(ws);
    ws.send(encode({ v: 1, type: "hello_ack", serverVersion: SERVER_VERSION }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    http.once("error", onError);
    http.listen(port, "127.0.0.1", () => {
      http.off("error", onError);
      resolve();
    });
  });

  console.error(`[bridge] listening on 127.0.0.1:${port}`);

  return {
    port,
    async stop() {
      connections.closeActive(1001, "server shutdown");
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
