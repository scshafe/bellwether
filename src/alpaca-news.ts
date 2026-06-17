import { setTimeout as delay } from "node:timers/promises";

import { ALPACA_PAPER_BROKER_ACCOUNT_ID } from "./broker.js";
import {
  ALPACA_NEWS_SOURCE_ID,
  extractTickers,
  type QualitativeItemInput,
  type QualitativeItemsStore
} from "./qualitative.js";
import type { BrokerCredential, BrokerCredentialVault } from "./secrets.js";

export const ALPACA_NEWS_STREAM_URL = "wss://stream.data.alpaca.markets/v1beta1/news";

export type AlpacaNewsWireMessage = Record<string, unknown>;

export type AlpacaNewsSocket = {
  send(message: string): void | Promise<void>;
  messages: AsyncIterable<unknown>;
  close(): void | Promise<void>;
};

export type AlpacaNewsSocketFactory = (options: { url: string; signal: AbortSignal }) => Promise<AlpacaNewsSocket>;

export type AlpacaNewsConnectionOptions = {
  credential: BrokerCredential;
  itemsStore: QualitativeItemsStore;
  sourceId?: string;
  socketFactory?: AlpacaNewsSocketFactory;
  streamUrl?: string;
  newsSymbols?: string[];
  signal: AbortSignal;
};

export type AlpacaNewsIngestStreamOptions = Omit<AlpacaNewsConnectionOptions, "credential"> & {
  credentialVault: BrokerCredentialVault;
  reconnectInitialDelayMs?: number;
  reconnectMaxDelayMs?: number;
  sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>;
  logger?: Pick<Console, "error" | "log" | "warn">;
};

export type AlpacaNewsIngestResult = {
  eventsSeen: number;
  inserted: number;
  duplicates: number;
};

const defaultReconnectInitialDelayMs = 1_000;
const defaultReconnectMaxDelayMs = 30_000;

export async function runAlpacaNewsIngestStream(options: AlpacaNewsIngestStreamOptions): Promise<void> {
  if (options.signal.aborted) {
    return;
  }

  let credential: BrokerCredential | null;
  try {
    credential = await options.credentialVault.getBrokerCredential(ALPACA_PAPER_BROKER_ACCOUNT_ID);
  } catch (error: unknown) {
    options.logger?.warn(`alpaca news ingest disabled: ${errorMessage(error)}`);
    return;
  }

  if (!credential) {
    options.logger?.warn(`alpaca news ingest disabled: missing broker credentials for ${ALPACA_PAPER_BROKER_ACCOUNT_ID}`);
    return;
  }

  const sleepFn = options.sleepFn ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const initialDelayMs = positiveInteger(options.reconnectInitialDelayMs ?? defaultReconnectInitialDelayMs, "ALPACA_NEWS_RECONNECT_INITIAL_DELAY_MS");
  const maxDelayMs = positiveInteger(options.reconnectMaxDelayMs ?? defaultReconnectMaxDelayMs, "ALPACA_NEWS_RECONNECT_MAX_DELAY_MS");
  let nextDelayMs = initialDelayMs;

  while (!options.signal.aborted) {
    try {
      const result = await ingestAlpacaNewsConnectionOnce({ ...options, credential });

      if (result.eventsSeen > 0) {
        options.logger?.log(`alpaca news ingest saw ${result.eventsSeen} events; inserted ${result.inserted}, duplicates ${result.duplicates}`);
      }

      nextDelayMs = initialDelayMs;
      if (!options.signal.aborted) {
        throw new Error("Alpaca news stream disconnected");
      }
    } catch (error: unknown) {
      if (options.signal.aborted || isAbortError(error)) {
        break;
      }

      options.logger?.error(error);
      await sleepFn(nextDelayMs, options.signal).catch((sleepError: unknown) => {
        if (!isAbortError(sleepError)) {
          throw sleepError;
        }
      });
      nextDelayMs = Math.min(nextDelayMs * 2, maxDelayMs);
    }
  }
}

export async function ingestAlpacaNewsConnectionOnce(options: AlpacaNewsConnectionOptions): Promise<AlpacaNewsIngestResult> {
  const socketFactory = options.socketFactory ?? createWebSocketAlpacaNewsSocket;
  const socket = await socketFactory({ url: options.streamUrl ?? ALPACA_NEWS_STREAM_URL, signal: options.signal });
  const result: AlpacaNewsIngestResult = { eventsSeen: 0, inserted: 0, duplicates: 0 };

  try {
    await socket.send(JSON.stringify({ action: "auth", key: options.credential.keyId, secret: options.credential.secretKey }));
    await socket.send(JSON.stringify({ action: "subscribe", news: normalizeNewsSymbols(options.newsSymbols) }));

    for await (const rawMessage of socket.messages) {
      if (options.signal.aborted) {
        break;
      }

      for (const message of decodeAlpacaNewsMessages(rawMessage)) {
        if (message.T === "error") {
          throw new Error(`Alpaca news stream error: ${String(message.msg ?? message.code ?? "unknown")}`);
        }

        const item = normalizeAlpacaNewsEvent(message, options.sourceId ?? ALPACA_NEWS_SOURCE_ID);
        if (!item) {
          continue;
        }

        result.eventsSeen += 1;
        const stored = await options.itemsStore.upsertItem(item);

        if (stored) {
          result.inserted += 1;
        } else {
          result.duplicates += 1;
        }
      }
    }
  } finally {
    await socket.close();
  }

  return result;
}

export function normalizeAlpacaNewsEvent(message: AlpacaNewsWireMessage, sourceId = ALPACA_NEWS_SOURCE_ID): QualitativeItemInput | null {
  if (message.T !== "n") {
    return null;
  }

  const sourceItemId = requiredScalarString(message.id, "id");
  const title = optionalString(message.headline)?.trim();
  const link = optionalString(message.url)?.trim();
  const excerpt = (optionalString(message.summary) ?? title ?? optionalString(message.content) ?? "").trim();

  if (!title || !link || !excerpt) {
    return null;
  }

  const symbols = Array.isArray(message.symbols) ? message.symbols.filter((symbol): symbol is string => typeof symbol === "string") : [];
  const tickers = symbols.length > 0 ? symbols : extractTickers(`${title} ${excerpt}`);
  const publishedAt = optionalString(message.created_at) ?? optionalString(message.updated_at);

  return {
    sourceId,
    sourceItemId,
    link,
    title,
    excerpt,
    publishedAt,
    tickers,
    metadata: {
      sourceKey: "alpaca-news",
      sourceType: "programmatic",
      vendorSource: optionalString(message.source),
      author: optionalString(message.author),
      symbols
    }
  };
}

export function decodeAlpacaNewsMessages(rawMessage: unknown): AlpacaNewsWireMessage[] {
  const decoded = decodeJsonMessage(rawMessage);
  const messages = Array.isArray(decoded) ? decoded : [decoded];

  return messages.filter(isRecord);
}

function normalizeNewsSymbols(symbols: string[] | undefined): string[] {
  const normalized = [...new Set((symbols ?? ["*"]).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
  return normalized.length > 0 ? normalized : ["*"];
}

async function createWebSocketAlpacaNewsSocket(options: { url: string; signal: AbortSignal }): Promise<AlpacaNewsSocket> {
  const WebSocketConstructor = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;

  if (!WebSocketConstructor) {
    throw new Error("global WebSocket is not available in this Node runtime");
  }

  const socket = new WebSocketConstructor(options.url);
  await waitForOpen(socket, options.signal);

  return {
    send(message: string) {
      socket.send(message);
    },
    messages: webSocketMessages(socket, options.signal),
    close() {
      socket.close();
    }
  };
}

async function waitForOpen(socket: RuntimeWebSocket, signal: AbortSignal): Promise<void> {
  if (socket.readyState === 1) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener?.("open", onOpen);
      socket.removeEventListener?.("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (event: unknown) => {
      cleanup();
      reject(event instanceof Error ? event : new Error("Alpaca news websocket failed to open"));
    };
    const onAbort = () => {
      cleanup();
      socket.close();
      reject(abortError());
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function* webSocketMessages(socket: RuntimeWebSocket, signal: AbortSignal): AsyncIterable<unknown> {
  const queue: unknown[] = [];
  let pending: (() => void) | null = null;
  let done = false;
  let thrown: unknown;
  const wake = () => {
    pending?.();
    pending = null;
  };
  const onMessage = (event: { data?: unknown }) => {
    queue.push(event.data);
    wake();
  };
  const onClose = () => {
    done = true;
    wake();
  };
  const onError = (event: unknown) => {
    thrown = event instanceof Error ? event : new Error("Alpaca news websocket error");
    done = true;
    wake();
  };
  const onAbort = () => {
    done = true;
    socket.close();
    wake();
  };

  socket.addEventListener("message", onMessage);
  socket.addEventListener("close", onClose);
  socket.addEventListener("error", onError);
  signal.addEventListener("abort", onAbort, { once: true });

  try {
    while (!done || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift();
        continue;
      }

      await new Promise<void>((resolve) => {
        pending = resolve;
      });

      if (thrown) {
        throw thrown;
      }
    }
  } finally {
    socket.removeEventListener?.("message", onMessage);
    socket.removeEventListener?.("close", onClose);
    socket.removeEventListener?.("error", onError);
    signal.removeEventListener("abort", onAbort);
  }
}

function decodeJsonMessage(rawMessage: unknown): unknown {
  if (typeof rawMessage === "string") {
    return JSON.parse(rawMessage) as unknown;
  }

  if (rawMessage instanceof Uint8Array) {
    return JSON.parse(new TextDecoder().decode(rawMessage)) as unknown;
  }

  if (rawMessage instanceof ArrayBuffer) {
    return JSON.parse(new TextDecoder().decode(rawMessage)) as unknown;
  }

  return rawMessage;
}

function requiredScalarString(value: unknown, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }

  throw new Error(`Alpaca news ${name} is required`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is AlpacaNewsWireMessage {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown credential error";
}

type WebSocketConstructor = new (url: string) => RuntimeWebSocket;

type RuntimeWebSocket = {
  readyState: number;
  send(message: string): void;
  close(): void;
  addEventListener(type: string, listener: (...args: any[]) => void, options?: unknown): void;
  removeEventListener?(type: string, listener: (...args: any[]) => void): void;
};
