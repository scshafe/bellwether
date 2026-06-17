import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import type { Pool } from "pg";

export const SOURCE_TYPES = ["rss", "atom", "programmatic", "x-handle"] as const;

export type SourceType = (typeof SOURCE_TYPES)[number];

export type SourceRecord = {
  id: string;
  sourceKey: string;
  name: string;
  sourceType: SourceType;
  feedUrl?: string;
  enabled: boolean;
  qualityRating: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateSourceInput = {
  id?: string;
  sourceKey: string;
  name: string;
  sourceType?: SourceType;
  feedUrl?: string;
  enabled?: boolean;
  qualityRating: number;
};

export type UpdateSourcePatch = {
  name?: string;
  feedUrl?: string | null;
  enabled?: boolean;
  qualityRating?: number;
};

export interface SourcesStore {
  createSource(input: CreateSourceInput): Promise<SourceRecord>;
  getSource(id: string): Promise<SourceRecord | null>;
  listSources(): Promise<SourceRecord[]>;
  listEnabledSources(): Promise<SourceRecord[]>;
  updateSource(id: string, patch: UpdateSourcePatch): Promise<SourceRecord>;
  deleteSource(id: string): Promise<boolean>;
}

export class SourceNotFoundError extends Error {
  constructor(sourceId: string) {
    super(`source ${sourceId} was not found`);
    this.name = "SourceNotFoundError";
  }
}

export type QualitativeItemInput = {
  id?: string;
  sourceId: string;
  sourceItemId: string;
  link: string;
  title: string;
  excerpt: string;
  publishedAt?: string;
  tickers: string[];
  metadata?: Record<string, unknown>;
};

export type QualitativeItem = Required<Pick<QualitativeItemInput, "id" | "sourceId" | "sourceItemId" | "link" | "title" | "excerpt" | "tickers">> & {
  publishedAt?: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type ListRecentQualitativeItemsOptions = {
  limit?: number;
  ticker?: string;
};

export interface QualitativeItemsStore {
  upsertItem(input: QualitativeItemInput): Promise<QualitativeItem | null>;
  listRecentItems(options?: ListRecentQualitativeItemsOptions): Promise<QualitativeItem[]>;
}

export type QualitativeFetchResponse = {
  ok?: boolean;
  status?: number;
  text(): Promise<string>;
};

export type QualitativeFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<QualitativeFetchResponse>;

export type PollQualitativeFeedsOnceResult = {
  sourcesChecked: number;
  entriesSeen: number;
  inserted: number;
  duplicates: number;
};

export type RssAtomIngestPollerOptions = {
  sourcesStore: SourcesStore;
  itemsStore: QualitativeItemsStore;
  fetchFn?: QualitativeFetch;
  pollIntervalMs: number;
  signal: AbortSignal;
  logger?: Pick<Console, "error" | "log">;
};

export const ALPACA_NEWS_SOURCE_ID = "77777777-7777-4777-8777-777777777777";
export const ALPACA_NEWS_SOURCE_KEY = "alpaca-news";

export const QUALITATIVE_EXCERPT_MAX_CHARS = 240;
const TICKER_STOPWORDS = new Set([
  "A",
  "AN",
  "AND",
  "API",
  "CEO",
  "CFO",
  "ETF",
  "FED",
  "GDP",
  "IPO",
  "LLC",
  "NYSE",
  "RSS",
  "SEC",
  "THE",
  "USA",
  "USD"
]);

export class InMemorySourcesStore implements SourcesStore {
  private readonly sources = new Map<string, SourceRecord>();

  constructor(initialSources: SourceRecord[] = []) {
    for (const source of initialSources) {
      this.sources.set(source.id, cloneSource(source));
    }
  }

  async createSource(input: CreateSourceInput): Promise<SourceRecord> {
    const source = normalizeCreateSourceInput(input);

    if ([...this.sources.values()].some((existing) => existing.sourceKey === source.sourceKey)) {
      throw new Error(`source ${source.sourceKey} already exists`);
    }

    this.sources.set(source.id, cloneSource(source));
    return cloneSource(source);
  }

  async getSource(id: string): Promise<SourceRecord | null> {
    const source = this.sources.get(id.trim());
    return source ? cloneSource(source) : null;
  }

  async listSources(): Promise<SourceRecord[]> {
    return sortSources([...this.sources.values()]).map(cloneSource);
  }

  async listEnabledSources(): Promise<SourceRecord[]> {
    return sortSources([...this.sources.values()].filter((source) => source.enabled)).map(cloneSource);
  }

  async updateSource(id: string, patch: UpdateSourcePatch): Promise<SourceRecord> {
    const source = this.sources.get(id.trim());

    if (!source) {
      throw new SourceNotFoundError(id);
    }

    const updated = applySourcePatch(source, patch);
    this.sources.set(updated.id, cloneSource(updated));
    return cloneSource(updated);
  }

  async deleteSource(id: string): Promise<boolean> {
    return this.sources.delete(id.trim());
  }
}

export class PostgresSourcesStore implements SourcesStore {
  constructor(private readonly pool: Pool) {}

  async createSource(input: CreateSourceInput): Promise<SourceRecord> {
    const normalized = normalizeCreateSourceInput(input);
    const result = await this.pool.query<SourceRow>(
      `
        INSERT INTO sources (id, source_key, name, source_type, feed_url, enabled, quality_rating)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id, source_key, name, source_type, feed_url, enabled, quality_rating, created_at, updated_at
      `,
      [
        normalized.id,
        normalized.sourceKey,
        normalized.name,
        normalized.sourceType,
        normalized.feedUrl ?? null,
        normalized.enabled,
        normalized.qualityRating
      ]
    );

    return rowToSource(result.rows[0]);
  }

  async getSource(id: string): Promise<SourceRecord | null> {
    const result = await this.pool.query<SourceRow>(
      `
        SELECT id, source_key, name, source_type, feed_url, enabled, quality_rating, created_at, updated_at
        FROM sources
        WHERE id = $1
      `,
      [id.trim()]
    );

    return result.rows[0] ? rowToSource(result.rows[0]) : null;
  }

  async listSources(): Promise<SourceRecord[]> {
    const result = await this.pool.query<SourceRow>(
      `
        SELECT id, source_key, name, source_type, feed_url, enabled, quality_rating, created_at, updated_at
        FROM sources
        ORDER BY name ASC, id ASC
      `
    );

    return result.rows.map(rowToSource);
  }

  async listEnabledSources(): Promise<SourceRecord[]> {
    const result = await this.pool.query<SourceRow>(
      `
        SELECT id, source_key, name, source_type, feed_url, enabled, quality_rating, created_at, updated_at
        FROM sources
        WHERE enabled = true
        ORDER BY name ASC, id ASC
      `
    );

    return result.rows.map(rowToSource);
  }

  async updateSource(id: string, patch: UpdateSourcePatch): Promise<SourceRecord> {
    const existing = await this.getSource(id);

    if (!existing) {
      throw new SourceNotFoundError(id);
    }

    const updated = applySourcePatch(existing, patch);
    const result = await this.pool.query<SourceRow>(
      `
        UPDATE sources
        SET name = $2,
            feed_url = $3,
            enabled = $4,
            quality_rating = $5,
            updated_at = now()
        WHERE id = $1
        RETURNING id, source_key, name, source_type, feed_url, enabled, quality_rating, created_at, updated_at
      `,
      [updated.id, updated.name, updated.feedUrl ?? null, updated.enabled, updated.qualityRating]
    );

    return rowToSource(result.rows[0]);
  }

  async deleteSource(id: string): Promise<boolean> {
    const result = await this.pool.query(
      `
        DELETE FROM sources
        WHERE id = $1
      `,
      [id.trim()]
    );

    return (result.rowCount ?? 0) > 0;
  }
}

export class InMemoryQualitativeItemsStore implements QualitativeItemsStore {
  private readonly items = new Map<string, QualitativeItem>();

  constructor(initialItems: QualitativeItem[] = []) {
    for (const item of initialItems) {
      this.items.set(dedupMapKey(item.sourceId, item.sourceItemId), cloneItem(item));
    }
  }

  async upsertItem(input: QualitativeItemInput): Promise<QualitativeItem | null> {
    const item = normalizeQualitativeItemInput(input);
    const key = dedupMapKey(item.sourceId, item.sourceItemId);

    if (this.items.has(key)) {
      return null;
    }

    this.items.set(key, cloneItem(item));
    return cloneItem(item);
  }

  async listRecentItems(options: ListRecentQualitativeItemsOptions = {}): Promise<QualitativeItem[]> {
    const ticker = options.ticker ? normalizeTicker(options.ticker) : null;
    return [...this.items.values()]
      .filter((item) => !ticker || item.tickers.includes(ticker))
      .sort((left, right) => recencyStamp(right).localeCompare(recencyStamp(left)) || right.createdAt.localeCompare(left.createdAt))
      .slice(0, normalizeQualitativeItemsLimit(options.limit ?? 50))
      .map(cloneItem);
  }
}

export class PostgresQualitativeItemsStore implements QualitativeItemsStore {
  constructor(private readonly pool: Pool) {}

  async upsertItem(input: QualitativeItemInput): Promise<QualitativeItem | null> {
    const normalized = normalizeQualitativeItemInput(input);
    const result = await this.pool.query<QualitativeItemRow>(
      `
        INSERT INTO qualitative_items (
          id, source_id, source_item_id, link, title, excerpt, published_at, tickers, metadata
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
        ON CONFLICT (source_id, source_item_id) DO NOTHING
        RETURNING id, source_id, source_item_id, link, title, excerpt, published_at, tickers, metadata, created_at
      `,
      [
        normalized.id,
        normalized.sourceId,
        normalized.sourceItemId,
        normalized.link,
        normalized.title,
        normalized.excerpt,
        normalized.publishedAt ?? null,
        normalized.tickers,
        JSON.stringify(normalized.metadata)
      ]
    );

    return result.rows[0] ? rowToQualitativeItem(result.rows[0]) : null;
  }

  async listRecentItems(options: ListRecentQualitativeItemsOptions = {}): Promise<QualitativeItem[]> {
    const ticker = options.ticker ? normalizeTicker(options.ticker) : null;
    const result = await this.pool.query<QualitativeItemRow>(
      `
        SELECT id, source_id, source_item_id, link, title, excerpt, published_at, tickers, metadata, created_at
        FROM qualitative_items
        WHERE ($2::text IS NULL OR $2 = ANY(tickers))
        ORDER BY COALESCE(published_at, created_at) DESC, created_at DESC
        LIMIT $1
      `,
      [normalizeQualitativeItemsLimit(options.limit ?? 50), ticker]
    );

    return result.rows.map(rowToQualitativeItem);
  }
}

export async function ensureSourcesSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL("../db/bootstrap/005_sources.sql", import.meta.url), "utf8"));
}

export async function ensureQualitativeItemsSchema(pool: Pool): Promise<void> {
  await pool.query(await readFile(new URL("../db/bootstrap/006_qualitative_items.sql", import.meta.url), "utf8"));
}

export async function ensureAlpacaNewsSource(pool: Pool): Promise<SourceRecord> {
  const result = await pool.query<SourceRow>(
    `
      INSERT INTO sources (id, source_key, name, source_type, feed_url, enabled, quality_rating)
      VALUES ($1, $2, $3, 'programmatic', NULL, true, 4)
      ON CONFLICT (source_key) DO UPDATE SET
        name = EXCLUDED.name,
        source_type = EXCLUDED.source_type,
        feed_url = EXCLUDED.feed_url,
        enabled = EXCLUDED.enabled,
        quality_rating = EXCLUDED.quality_rating,
        updated_at = now()
      RETURNING id, source_key, name, source_type, feed_url, enabled, quality_rating, created_at, updated_at
    `,
    [ALPACA_NEWS_SOURCE_ID, ALPACA_NEWS_SOURCE_KEY, "Alpaca News"]
  );

  return rowToSource(result.rows[0]);
}

export async function pollQualitativeFeedsOnce(options: Omit<RssAtomIngestPollerOptions, "pollIntervalMs" | "signal"> & { signal?: AbortSignal }): Promise<PollQualitativeFeedsOnceResult> {
  const fetchFn = options.fetchFn ?? globalFetch;
  const result: PollQualitativeFeedsOnceResult = { sourcesChecked: 0, entriesSeen: 0, inserted: 0, duplicates: 0 };

  for (const source of await options.sourcesStore.listEnabledSources()) {
    if (!source.feedUrl || (source.sourceType !== "rss" && source.sourceType !== "atom")) {
      continue;
    }

    result.sourcesChecked += 1;
    const response = await fetchFn(source.feedUrl, { signal: options.signal });

    if (response.ok === false) {
      throw new Error(`fetch ${source.sourceKey} failed with status ${response.status ?? "unknown"}`);
    }

    const entries = parseRssAtomEntries(await response.text());
    result.entriesSeen += entries.length;

    for (const entry of entries) {
      const item = normalizeFeedEntry(source, entry);

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

export async function runRssAtomIngestPoller(options: RssAtomIngestPollerOptions): Promise<void> {
  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs <= 0) {
    throw new Error("QUALITATIVE_INGEST_POLL_INTERVAL_MS must be a positive integer");
  }

  while (!options.signal.aborted) {
    try {
      const result = await pollQualitativeFeedsOnce(options);

      if (result.sourcesChecked > 0) {
        options.logger?.log(`qualitative ingest checked ${result.sourcesChecked} sources; inserted ${result.inserted}, duplicates ${result.duplicates}`);
      }
    } catch (error: unknown) {
      if (options.signal.aborted || isAbortError(error)) {
        break;
      }

      options.logger?.error(error);
    }

    try {
      await delay(options.pollIntervalMs, undefined, { signal: options.signal });
    } catch (error: unknown) {
      if (isAbortError(error)) {
        break;
      }

      throw error;
    }
  }
}

function parseRssAtomEntries(xml: string): FeedEntry[] {
  const rssItems = blocks(xml, "item").map((block) => ({
    title: tagText(block, "title"),
    link: tagText(block, "link"),
    guid: tagText(block, "guid"),
    excerptSource: tagText(block, "description") ?? tagText(block, "content:encoded"),
    publishedAt: tagText(block, "pubDate") ?? tagText(block, "published") ?? tagText(block, "updated")
  }));

  const atomEntries = blocks(xml, "entry").map((block) => ({
    title: tagText(block, "title"),
    link: atomLink(block),
    guid: tagText(block, "id"),
    excerptSource: tagText(block, "summary") ?? tagText(block, "content"),
    publishedAt: tagText(block, "published") ?? tagText(block, "updated")
  }));

  return [...rssItems, ...atomEntries];
}

function normalizeFeedEntry(source: SourceRecord, entry: FeedEntry): QualitativeItemInput | null {
  const title = normalizeWhitespace(decodeXml(stripCdata(entry.title ?? "")));
  const rawLink = normalizeWhitespace(decodeXml(stripCdata(entry.link ?? "")));
  const excerpt = shortExcerpt(entry.excerptSource ?? entry.title ?? "");
  const publishedAt = parsePublishedAt(entry.publishedAt);

  if (!title || !rawLink || !excerpt) {
    return null;
  }

  const link = canonicalLink(rawLink);
  const sourceItemId = normalizeSourceItemId(entry.guid) ?? link ?? contentHash([source.sourceKey, title, publishedAt ?? "", excerpt].join("|"));

  return {
    sourceId: source.id,
    sourceItemId,
    link,
    title,
    excerpt,
    publishedAt,
    tickers: extractTickers(`${title} ${excerpt}`),
    metadata: {
      sourceKey: source.sourceKey,
      sourceType: source.sourceType,
      qualityRating: source.qualityRating
    }
  };
}

function normalizeCreateSourceInput(input: CreateSourceInput): SourceRecord {
  const sourceType = input.sourceType ?? "rss";
  validateSourceType(sourceType);

  if (sourceType !== "programmatic" && !input.feedUrl?.trim()) {
    throw new Error("feedUrl is required for RSS/Atom/X-handle sources");
  }

  const now = new Date().toISOString();
  const source: SourceRecord = {
    id: input.id ?? randomUUID(),
    sourceKey: normalizeSourceKey(input.sourceKey),
    name: normalizeRequiredString(input.name, "source name"),
    sourceType,
    enabled: input.enabled ?? false,
    qualityRating: normalizeQualityRating(input.qualityRating),
    createdAt: now,
    updatedAt: now
  };

  if (input.feedUrl?.trim()) {
    source.feedUrl = input.feedUrl.trim();
  }

  assertSourceFeedUrlInvariant(source);

  return source;
}

function applySourcePatch(source: SourceRecord, patch: UpdateSourcePatch): SourceRecord {
  const updated: SourceRecord = {
    ...source,
    updatedAt: new Date().toISOString()
  };

  if (patch.name !== undefined) {
    updated.name = normalizeRequiredString(patch.name, "source name");
  }

  if (patch.enabled !== undefined) {
    updated.enabled = patch.enabled;
  }

  if (patch.qualityRating !== undefined) {
    updated.qualityRating = normalizeQualityRating(patch.qualityRating);
  }

  if (Object.hasOwn(patch, "feedUrl")) {
    const feedUrl = normalizeOptionalFeedUrl(patch.feedUrl);

    if (feedUrl) {
      updated.feedUrl = feedUrl;
    } else {
      delete updated.feedUrl;
    }
  }

  assertSourceFeedUrlInvariant(updated);
  return updated;
}

function normalizeQualitativeItemInput(input: QualitativeItemInput): QualitativeItem {
  const publishedAt = input.publishedAt ? parsePublishedAt(input.publishedAt) : undefined;
  const item: QualitativeItem = {
    id: input.id ?? randomUUID(),
    sourceId: normalizeRequiredString(input.sourceId, "source id"),
    sourceItemId: normalizeRequiredString(input.sourceItemId, "source item id"),
    link: canonicalLink(input.link),
    title: normalizeRequiredString(input.title, "title"),
    excerpt: shortExcerpt(input.excerpt),
    tickers: [...new Set(input.tickers.map(normalizeTicker))].sort(),
    createdAt: new Date().toISOString(),
    metadata: cloneJson(input.metadata ?? {})
  };

  if (publishedAt) {
    item.publishedAt = publishedAt;
  }

  return item;
}

function shortExcerpt(value: string): string {
  const normalized = normalizeWhitespace(decodeXml(stripHtml(stripCdata(value))));

  if (normalized.length <= QUALITATIVE_EXCERPT_MAX_CHARS) {
    return normalized;
  }

  const sliced = normalized.slice(0, QUALITATIVE_EXCERPT_MAX_CHARS - 3).trimEnd();
  return `${sliced}...`;
}

export function extractTickers(value: string): string[] {
  const tickers = new Set<string>();
  const cashtagMatches = value.matchAll(/\$([A-Z]{1,5})(?![A-Z])/gu);

  for (const match of cashtagMatches) {
    tickers.add(normalizeTicker(match[1] ?? ""));
  }

  const uppercaseMatches = value.matchAll(/\b[A-Z]{2,5}\b/gu);

  for (const match of uppercaseMatches) {
    const ticker = normalizeTicker(match[0] ?? "");

    if (!TICKER_STOPWORDS.has(ticker)) {
      tickers.add(ticker);
    }
  }

  return [...tickers].filter(Boolean).sort();
}

function blocks(xml: string, tagName: string): string[] {
  return [...xml.matchAll(new RegExp(`<${escapeRegExp(tagName)}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapeRegExp(tagName)}>`, "giu"))].map(
    (match) => match[1] ?? ""
  );
}

function tagText(block: string, tagName: string): string | undefined {
  const tag = escapeRegExp(tagName);
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "iu"));
  return match?.[1];
}

function atomLink(block: string): string | undefined {
  const relAlternate = block.match(/<link\b(?=[^>]*\brel=["']alternate["'])(?=[^>]*\bhref=["']([^"']+)["'])[^>]*\/?\s*>/iu);

  if (relAlternate?.[1]) {
    return relAlternate[1];
  }

  const href = block.match(/<link\b(?=[^>]*\bhref=["']([^"']+)["'])[^>]*\/?\s*>/iu);

  if (href?.[1]) {
    return href[1];
  }

  return tagText(block, "link");
}

function canonicalLink(value: string): string {
  const trimmed = normalizeRequiredString(value, "link");

  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed;
  }
}

function normalizeSourceItemId(value: string | undefined): string | undefined {
  const normalized = normalizeWhitespace(decodeXml(stripCdata(value ?? "")));
  return normalized || undefined;
}

function parsePublishedAt(value: string | undefined): string | undefined {
  const normalized = normalizeWhitespace(decodeXml(stripCdata(value ?? "")));

  if (!normalized) {
    return undefined;
  }

  const timestamp = Date.parse(normalized);
  return Number.isNaN(timestamp) ? undefined : new Date(timestamp).toISOString();
}

function normalizeSourceKey(value: string): string {
  const normalized = value.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9-_.]*$/u.test(normalized)) {
    throw new Error("sourceKey must contain only lowercase letters, numbers, dashes, underscores, or dots");
  }

  return normalized;
}

function normalizeOptionalFeedUrl(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  const normalized = normalizeWhitespace(value);
  return normalized || undefined;
}

function normalizeTicker(value: string): string {
  return value.trim().replace(/^\$/u, "").toUpperCase();
}

function normalizeRequiredString(value: string, name: string): string {
  const normalized = normalizeWhitespace(value);

  if (!normalized) {
    throw new Error(`${name} is required`);
  }

  return normalized;
}

function normalizeQualityRating(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 5) {
    throw new Error("qualityRating must be an integer from 1 to 5");
  }

  return value;
}

function normalizeQualitativeItemsLimit(limit: number): number {
  if (!Number.isFinite(limit)) {
    return 50;
  }

  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function validateSourceType(value: string): asserts value is SourceType {
  if (!SOURCE_TYPES.includes(value as SourceType)) {
    throw new Error(`unknown source type ${value}`);
  }
}

function assertSourceFeedUrlInvariant(source: SourceRecord): void {
  if (source.sourceType !== "programmatic" && !source.feedUrl) {
    throw new Error("feedUrl is required for RSS/Atom/X-handle sources");
  }
}

function sortSources(sources: SourceRecord[]): SourceRecord[] {
  return sources.sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
}

function recencyStamp(item: QualitativeItem): string {
  return item.publishedAt ?? item.createdAt;
}

function dedupMapKey(sourceId: string, sourceItemId: string): string {
  return `${sourceId}::${sourceItemId}`;
}

function stripCdata(value: string): string {
  return value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/giu, "$1");
}

function stripHtml(value: string): string {
  return value.replace(/<script\b[\s\S]*?<\/script>/giu, " ").replace(/<style\b[\s\S]*?<\/style>/giu, " ").replace(/<[^>]+>/gu, " ");
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&apos;/gu, "'");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function cloneSource(source: SourceRecord): SourceRecord {
  return { ...source };
}

function cloneItem(item: QualitativeItem): QualitativeItem {
  return cloneJson(item);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function globalFetch(url: string, init?: { signal?: AbortSignal }): Promise<QualitativeFetchResponse> {
  return fetch(url, init);
}

type FeedEntry = {
  title?: string;
  link?: string;
  guid?: string;
  excerptSource?: string;
  publishedAt?: string;
};

export type SourceRow = {
  id: string;
  source_key: string;
  name: string;
  source_type: SourceType;
  feed_url: string | null;
  enabled: boolean;
  quality_rating: number;
  created_at: Date | string;
  updated_at: Date | string;
};

function rowToSource(row: SourceRow | undefined): SourceRecord {
  if (!row) {
    throw new Error("source query returned no rows");
  }

  validateSourceType(row.source_type);

  const source: SourceRecord = {
    id: row.id,
    sourceKey: row.source_key,
    name: row.name,
    sourceType: row.source_type,
    enabled: row.enabled,
    qualityRating: normalizeQualityRating(row.quality_rating),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at)
  };

  if (row.feed_url) {
    source.feedUrl = row.feed_url;
  }

  return source;
}

export type QualitativeItemRow = {
  id: string;
  source_id: string;
  source_item_id: string;
  link: string;
  title: string;
  excerpt: string;
  published_at: Date | string | null;
  tickers: string[];
  metadata: Record<string, unknown>;
  created_at: Date | string;
};

function rowToQualitativeItem(row: QualitativeItemRow | undefined): QualitativeItem {
  if (!row) {
    throw new Error("qualitative item query returned no rows");
  }

  const item: QualitativeItem = {
    id: row.id,
    sourceId: row.source_id,
    sourceItemId: row.source_item_id,
    link: row.link,
    title: row.title,
    excerpt: row.excerpt,
    tickers: [...row.tickers],
    metadata: cloneJson(row.metadata),
    createdAt: toIsoString(row.created_at)
  };

  if (row.published_at) {
    item.publishedAt = toIsoString(row.published_at);
  }

  return item;
}

function toIsoString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
