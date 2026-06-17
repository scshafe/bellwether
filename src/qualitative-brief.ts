import type { PortalQualitativeEvidence } from "./agent-team.js";
import type { ReasoningModel } from "./llm.js";
import type { QualitativeItem, QualitativeItemsStore } from "./qualitative.js";
import type { StrategyRecord } from "./strategy.js";

export type BuildQualitativeBriefInput = {
  strategy: StrategyRecord;
  tickers: string[];
  itemsStore: QualitativeItemsStore;
  model: ReasoningModel;
  limit?: number;
};

const defaultBriefItemLimit = 15;
const maxLinks = 3;
const maxQuotes = 3;
const maxSignals = 5;

export const emptyQualitativeEvidence = (): PortalQualitativeEvidence => ({ links: [], quotes: [], signals: [] });

export class QualitativeBriefService {
  async buildBrief(input: BuildQualitativeBriefInput): Promise<PortalQualitativeEvidence> {
    const items = await selectBriefItems(input.itemsStore, input.tickers, input.limit ?? defaultBriefItemLimit);

    if (items.length === 0) {
      return emptyQualitativeEvidence();
    }

    try {
      const response = await input.model.generateJson({
        schemaName: "qualitative_brief",
        systemPrompt:
          "You summarize only the supplied qualitative items. Return JSON only in the schema {\"links\":[{\"href\":string,\"title\":string,\"source\"?:string}],\"quotes\":[{\"quote\":string,\"source\":string,\"href\"?:string}],\"signals\":[{\"label\":string,\"value\":string,\"source\"?:string}]}. Include derived signals, relevant links, and 1-3 short attributed quotes copied exactly from the supplied excerpts. Never return full article text or unsupported facts.",
        userPrompt: JSON.stringify({
          strategy: {
            id: input.strategy.id,
            name: input.strategy.name,
            description: input.strategy.description
          },
          tickers: normalizedTickers(input.tickers),
          items: items.map(itemForPrompt)
        })
      });

      return validateBrief(response, items);
    } catch {
      return emptyQualitativeEvidence();
    }
  }
}

async function selectBriefItems(itemsStore: QualitativeItemsStore, tickers: string[], limit: number): Promise<QualitativeItem[]> {
  const boundedLimit = normalizeLimit(limit);
  const byId = new Map<string, QualitativeItem>();
  const symbols = normalizedTickers(tickers);

  if (symbols.length === 0) {
    for (const item of await itemsStore.listRecentItems({ limit: boundedLimit })) {
      byId.set(item.id, item);
    }
  } else {
    const perTickerLimit = Math.max(1, Math.ceil(boundedLimit / symbols.length));

    for (const ticker of symbols) {
      for (const item of await itemsStore.listRecentItems({ ticker, limit: perTickerLimit })) {
        byId.set(item.id, item);
      }
    }
  }

  return [...byId.values()]
    .sort((left, right) => qualityRating(right) - qualityRating(left) || recencyStamp(right).localeCompare(recencyStamp(left)))
    .slice(0, boundedLimit);
}

function validateBrief(value: unknown, items: QualitativeItem[]): PortalQualitativeEvidence {
  const record = objectValue(value);
  return {
    links: arrayValue(record.links).map((link) => validateLink(link, items)).filter(isDefined).slice(0, maxLinks),
    quotes: arrayValue(record.quotes).map((quote) => validateQuote(quote, items)).filter(isDefined).slice(0, maxQuotes),
    signals: arrayValue(record.signals).map((signal) => validateSignal(signal, items)).filter(isDefined).slice(0, maxSignals)
  };
}

function validateLink(value: unknown, items: QualitativeItem[]): PortalQualitativeEvidence["links"][number] | null {
  const record = objectValue(value);
  const href = optionalString(record.href);
  const item = href ? itemForHref(href, items) : null;

  if (!item) {
    return null;
  }

  return { href: item.link, title: item.title, source: sourceLabel(item) };
}

function validateQuote(value: unknown, items: QualitativeItem[]): PortalQualitativeEvidence["quotes"][number] | null {
  const record = objectValue(value);
  const quote = optionalString(record.quote);
  const source = optionalString(record.source);

  if (!quote || !source || quote.length > 240) {
    return null;
  }

  const href = optionalString(record.href);
  const hrefItem = href ? itemForHref(href, items) : null;
  const matched = (hrefItem ? [hrefItem] : items).find((item) => sourceMatches(source, item) && containsQuote(item.excerpt, quote));

  if (!matched) {
    return null;
  }

  return { quote: normalizeWhitespace(quote), source: sourceLabel(matched), href: matched.link };
}

function validateSignal(value: unknown, items: QualitativeItem[]): PortalQualitativeEvidence["signals"][number] | null {
  const record = objectValue(value);
  const label = optionalString(record.label);
  const signalValue = optionalString(record.value);
  const source = optionalString(record.source);

  if (!label || !signalValue) {
    return null;
  }

  if (source) {
    const matched = items.find((item) => sourceMatches(source, item));

    if (!matched) {
      return null;
    }

    return { label: truncate(label, 80), value: truncate(signalValue, 160), source: sourceLabel(matched) };
  }

  return { label: truncate(label, 80), value: truncate(signalValue, 160) };
}

function itemForPrompt(item: QualitativeItem): Record<string, unknown> {
  return {
    id: item.id,
    title: item.title,
    link: item.link,
    source: sourceLabel(item),
    excerpt: item.excerpt,
    tickers: item.tickers
  };
}

function itemForHref(href: string, items: QualitativeItem[]): QualitativeItem | null {
  const exact = items.find((item) => item.link === href);

  if (exact) {
    return exact;
  }

  const origin = safeOrigin(href);
  return origin ? items.find((item) => safeOrigin(item.link) === origin) ?? null : null;
}

function sourceMatches(source: string, item: QualitativeItem): boolean {
  return normalizeSource(source) === normalizeSource(sourceLabel(item));
}

function sourceLabel(item: QualitativeItem): string {
  const vendorSource = metadataString(item.metadata.vendorSource);
  const sourceKey = metadataString(item.metadata.sourceKey);
  return vendorSource ?? sourceKey ?? item.sourceId;
}

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function containsQuote(excerpt: string, quote: string): boolean {
  return normalizeWhitespace(excerpt).includes(normalizeWhitespace(quote));
}

function qualityRating(item: QualitativeItem): number {
  const value = item.metadata.qualityRating;
  return typeof value === "number" && Number.isFinite(value) ? value : 3;
}

function recencyStamp(item: QualitativeItem): string {
  return item.publishedAt ?? item.createdAt;
}

function normalizedTickers(tickers: string[]): string[] {
  return [...new Set(tickers.map((ticker) => ticker.trim().replace(/^\$/u, "").toUpperCase()).filter(Boolean))];
}

function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 25) : defaultBriefItemLimit;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? normalizeWhitespace(value) : undefined;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeSource(value: string): string {
  return value.trim().toLowerCase();
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3).trimEnd()}...`;
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
