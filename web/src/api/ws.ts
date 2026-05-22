/**
 * Auto-reconnecting WebSocket client for /web/stream.
 * Single connection multiplexes all conversations — server pushes events
 * filtered by chatId; client routes them to the right place.
 */

export type ServerEvent =
  | { type: "chunk"; botId: string; chatId: string; messageId: string; chunk: string }
  | {
      type: "done";
      botId: string;
      chatId: string;
      messageId: string;
      tokensUsed: number;
      elapsedMs: number;
      fullText: string;
    }
  | { type: "typing"; botId: string; chatId: string; on: boolean }
  | { type: "agent_status"; botId: string; status: string };

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

type Listener = (event: ServerEvent) => void;
type StateListener = (state: ConnectionState) => void;

export class StreamClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private stateListeners = new Set<StateListener>();
  private retryDelay = 1000;
  private state: ConnectionState = "closed";
  private intentionallyClosed = false;

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.intentionallyClosed = false;
    this.setState("connecting");

    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/web/stream`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.retryDelay = 1000;
      this.setState("open");
    });

    ws.addEventListener("message", (e) => {
      try {
        const event = JSON.parse(e.data) as ServerEvent;
        for (const l of this.listeners) {
          try {
            l(event);
          } catch (err) {
            console.warn("ws listener error", err);
          }
        }
      } catch {
        // ignore malformed
      }
    });

    ws.addEventListener("close", () => {
      this.ws = null;
      if (this.intentionallyClosed) {
        this.setState("closed");
        return;
      }
      this.setState("reconnecting");
      setTimeout(() => this.connect(), this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
    });

    ws.addEventListener("error", () => {
      // close handler will trigger reconnect
    });
  }

  disconnect(): void {
    this.intentionallyClosed = true;
    this.ws?.close();
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onState(l: StateListener): () => void {
    this.stateListeners.add(l);
    l(this.state);
    return () => this.stateListeners.delete(l);
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    for (const l of this.stateListeners) l(s);
  }
}

export const streamClient = new StreamClient();
