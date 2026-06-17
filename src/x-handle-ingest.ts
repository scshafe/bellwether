import { setTimeout as delay } from "node:timers/promises";

import { isFeatureEnabled } from "./config.js";
import {
  extractTickers,
  QUALITATIVE_EXCERPT_MAX_CHARS,
  type QualitativeItemInput,
  type QualitativeItemsStore,
  type SourceRecord,
  type SourcesStore
} from "./qualitative.js";
import type { XApiCredential, XApiCredentialVault } from "./secrets.js";

export const X_API_BASE_URL = "https://api.x.com/2";
export const X_HANDLES_FEATURE = "x-handles";

export type XApiPost = {
  id: string;
  text: string;
  created_at?: string;
  author_id?: string;
  conversation_id?: string;
  edit_history_tweet_ids?: string[];
  entities?: {
    cashtags?: Array<{ tag?: string }>;
  };
};

export type XApiTransport = {
  fetchRecentPosts(options: { handle: string; credential: XApiCredential; signal?: AbortSignal }): Promise<XApiPost[]>;
};

export type PollXHandleSourcesOnceResult = {
  sourcesChecked: number;
  postsSeen: number;
  inserted: number;
  duplicates: number;
};

export type XHandleIngestPollerOptions = {
  sourcesStore: SourcesStore;
  itemsStore: QualitativeItemsStore;
  credentialVault: XApiCredentialVault;
  transport?: XApiTransport;
  pollIntervalMs: number;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  logger?: Pick<Console, "error" | "log" | "warn">;
  sleepFn?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export function createFetchXApiTransport(options: { fetchFn?: typeof fetch; baseUrl?: string } = {}): XApiTransport {
  const fetchFn = options.fetchFn ?? fetch;
  const baseUrl = options.baseUrl ?? X_API_BASE_URL;

  return {
    async fetchRecentPosts({ handle, credential, signal }) {
      const user = await requestXApiObject(fetchFn, baseUrl, `/users/by/username/${encodeURIComponent(handle)}?user.fields=username`, credential, signal);
      const userId = requiredNestedString(user, ["data", "id"], "X user id");
      const tweets = await requestXApiObject(
        fetchFn,
        baseUrl,
        `/users/${encodeURIComponent(userId)}/tweets?max_results=10&exclude=retweets,replies&tweet.fields=created_at,entities,author_id,conversation_id,edit_history_tweet_ids`,
        credential,
        signal
      );
      const data = nestedValue(tweets, ["data"]);

      if (data === undefined) {
        return [];
      }

      if (!Array.isArray(data)) {
        throw new Error("X recent posts response must include a data array");
      }

      return data.filter(isXApiPost);
    }
  };
}

export async function runXHandleIngestPoller(options: XHandleIngestPollerOptions): Promise<void> {
  if (!isFeatureEnabled(X_HANDLES_FEATURE, options.env)) {
    return;
  }

  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error("X_HANDLE_INGEST_POLL_INTERVAL_MS must be a positive integer");
  }

  let credential: XApiCredential | null;
  try {
    credential = await options.credentialVault.getXApiCredential();
  } catch (error: unknown) {
    options.logger?.warn(`X handle ingest disabled: ${errorMessage(error)}`);
    return;
  }

  if (!credential) {
    options.logger?.warn("X handle ingest disabled: missing X API credential");
    return;
  }

  if ((await listEnabledXHandleSources(options.sourcesStore)).length === 0) {
    return;
  }

  const sleepFn = options.sleepFn ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));

  while (!options.signal.aborted) {
    try {
      const result = await pollXHandleSourcesOnce({ ...options, credential });

      if (result.sourcesChecked > 0) {
        options.logger?.log(`X handle ingest checked ${result.sourcesChecked} sources; inserted ${result.inserted}, duplicates ${result.duplicates}`);
      }
    } catch (error: unknown) {
      if (options.signal.aborted || isAbortError(error)) {
        break;
      }

      options.logger?.error(error);
    }

    try {
      await sleepFn(options.pollIntervalMs, options.signal);
    } catch (error: unknown) {
      if (isAbortError(error)) {
        break;
      }

      throw error;
    }
  }
}

export async function pollXHandleSourcesOnce(
  options: Omit<XHandleIngestPollerOptions, "credentialVault" | "pollIntervalMs"> & { credential: XApiCredential }
): Promise<PollXHandleSourcesOnceResult> {
  const transport = options.transport ?? createFetchXApiTransport();
  const result: PollXHandleSourcesOnceResult = { sourcesChecked: 0, postsSeen: 0, inserted: 0, duplicates: 0 };

  for (const source of await listEnabledXHandleSources(options.sourcesStore)) {
    const handle = parseXHandle(source.feedUrl ?? "");

    if (!handle) {
      continue;
    }

    result.sourcesChecked += 1;
    const posts = await transport.fetchRecentPosts({ handle, credential: options.credential, signal: options.signal });
    result.postsSeen += posts.length;

    for (const post of posts) {
      const item = normalizeXPost(source, handle, post);

      if (!item) {
        continue;
      }

      const stored = await options.itemsStore.upsertItem(item);

      if (stored) {
        result.inserted += 1;
      } else {
        result.duplicates += 1;
      }
    }
  }

  return result;
}

export async function listEnabledXHandleSources(sourcesStore: SourcesStore): Promise<SourceRecord[]> {
  return (await sourcesStore.listEnabledSources()).filter((source) => source.sourceType === "x-handle" && Boolean(parseXHandle(source.feedUrl ?? "")));
}

export function normalizeXPost(source: SourceRecord, handle: string, post: XApiPost): QualitativeItemInput | null {
  const postId = post.id.trim();
  const text = normalizeWhitespace(post.text);

  if (!postId || !text) {
    return null;
  }

  const normalizedHandle = parseXHandle(handle);

  if (!normalizedHandle) {
    return null;
  }

  const link = `https://x.com/${normalizedHandle}/status/${encodeURIComponent(postId)}`;
  const cashtags = post.entities?.cashtags?.map((cashtag) => cashtag.tag).filter((tag): tag is string => Boolean(tag?.trim())) ?? [];
  const tickers = [...new Set([...extractTickers(text), ...cashtags.map((tag) => tag.trim().replace(/^\$/u, "").toUpperCase())])].filter(Boolean).sort();

  return {
    sourceId: source.id,
    sourceItemId: postId,
    link,
    title: `X post by @${normalizedHandle}`,
    excerpt: attributedExcerpt(normalizedHandle, text),
    publishedAt: post.created_at,
    tickers,
    metadata: {
      sourceKey: source.sourceKey,
      sourceType: source.sourceType,
      qualityRating: source.qualityRating,
      provider: "x-api-v2",
      postId,
      authorId: post.author_id,
      authorHandle: normalizedHandle,
      conversationId: post.conversation_id,
      editHistoryTweetIds: post.edit_history_tweet_ids,
      embedRef: {
        provider: "x",
        postId,
        url: link
      }
    }
  };
}

export function parseXHandle(value: string): string | null {
  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const candidate = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;

  if (isHandle(candidate)) {
    return candidate;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");

    if (host !== "x.com" && host !== "twitter.com") {
      return null;
    }

    const [firstSegment] = url.pathname.split("/").filter(Boolean);
    return firstSegment && isHandle(firstSegment) ? firstSegment : null;
  } catch {
    return null;
  }
}

function attributedExcerpt(handle: string, text: string): string {
  const prefix = `@${handle}: "`;
  const suffix = "\"";
  const available = QUALITATIVE_EXCERPT_MAX_CHARS - prefix.length - suffix.length;
  const body = text.length <= available ? text : `${text.slice(0, Math.max(0, available - 3)).trimEnd()}...`;
  return `${prefix}${body}${suffix}`;
}

async function requestXApiObject(fetchFn: typeof fetch, baseUrl: string, path: string, credential: XApiCredential, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetchFn(`${baseUrl}${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${credential.bearerToken}` },
    signal
  });

  if (!response.ok) {
    throw new Error(`X API request failed with status ${response.status}`);
  }

  const body = (await response.json()) as unknown;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("X API response must be an object");
  }

  return body as Record<string, unknown>;
}

function requiredNestedString(record: Record<string, unknown>, path: string[], name: string): string {
  const value = nestedValue(record, path);

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  throw new Error(`${name} is required`);
}

function nestedValue(record: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = record;

  for (const part of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }

    value = (value as Record<string, unknown>)[part];
  }

  return value;
}

function isXApiPost(value: unknown): value is XApiPost {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const post = value as Record<string, unknown>;
  return typeof post.id === "string" && typeof post.text === "string";
}

function isHandle(value: string): boolean {
  return /^[A-Za-z0-9_]{1,15}$/u.test(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown credential error";
}
