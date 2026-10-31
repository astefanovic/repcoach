import type * as net from "node:net";

/**
 * Tracks the raw TCP sockets behind the dev-server's Node HTTP server so the
 * `/__test__/drop-socket` control-channel endpoint (issue #16) can force-close
 * every live connection — including upgraded WebSocket connections, since a
 * WS connection rides on the same TCP socket. Kept outside Effect because it
 * hooks a plain Node `net.Server` "connection" event at server-construction
 * time, before any Effect layer has run.
 */
export class ConnectionRegistry {
  private readonly sockets = new Set<net.Socket>();

  readonly track = (socket: net.Socket): void => {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
  };

  /** Force-closes every currently tracked connection (drop-socket lever). */
  readonly dropAll = (): number => {
    const count = this.sockets.size;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    return count;
  };

  readonly size = (): number => this.sockets.size;
}
