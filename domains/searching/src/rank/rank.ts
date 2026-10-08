import { normalizeUrl } from "../dedupe/dedupe.js";
import type { FusedResult, RankCandidate, RankedResult } from "../types.js";

export const RRF_K = 60;

// Weight of fused engine agreement vs. keyword overlap in the raw score.
const RRF_WEIGHT = 0.5;
const OVERLAP_WEIGHT = 0.5;
const AUTHORITY_BOOST = 1.5;

export const STOPWORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "can",
  "do",
  "does",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "you",
  "your",
]);

// Domains treated as authoritative for definitional / how-to queries.
const AUTHORITATIVE_DOMAINS = [
  "wikipedia.org",
  "docs.python.org",
  "developer.mozilla.org",
  "learn.microsoft.com",
  "docs.oracle.com",
  "nodejs.org",
  "go.dev",
  "doc.rust-lang.org",
  "typescriptlang.org",
  "react.dev",
];

/** Lowercases, splits on non-alphanumerics and removes stopwords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

/** Sum of 1 / (k + rank) over every engine that returned the result. */
export function reciprocalRankFusion(
  engineRanks: Record<string, number>,
  k: number = RRF_K,
): number {
  let score = 0;
  for (const rank of Object.values(engineRanks)) {
    score += 1 / (k + rank);
  }
  return score;
}

/**
 * Merges candidates that share a normalized URL (keeping the first title and
 * snippet and each engine's best rank), then computes each one's RRF score.
 * Input order is preserved for the first occurrence of each URL.
 */
export function fuseResults(candidates: RankCandidate[], k: number = RRF_K): FusedResult[] {
  const byUrl = new Map<string, RankCandidate>();

  for (const c of candidates) {
    const key = normalizeUrl(c.url);
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, { ...c, engineRanks: { ...c.engineRanks } });
      continue;
    }
    for (const [engine, rank] of Object.entries(c.engineRanks)) {
      const prev = existing.engineRanks[engine];
      existing.engineRanks[engine] = prev === undefined ? rank : Math.min(prev, rank);
    }
  }

  return [...byUrl.values()].map((c) => ({
    ...c,
    rrfScore: reciprocalRankFusion(c.engineRanks, k),
  }));
}

/** Fraction (0..1) of distinct query terms that appear in `text`. */
export function keywordOverlap(queryTerms: readonly string[], text: string): number {
  const terms = new Set(queryTerms);
  if (terms.size === 0) return 0;
  const tokens = new Set(tokenize(text));
  let hits = 0;
  for (const term of terms) {
    if (tokens.has(term)) hits++;
  }
  return hits / terms.size;
}

export function isDefinitionalQuery(query: string): boolean {
  return /^\s*(what|who)\s+(is|are|was|were)\b|^\s*how\s+to\b/i.test(query);
}

export function isAuthoritativeUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith("docs.")) return true;
  return AUTHORITATIVE_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export interface RankOptions {
  // Demote results whose title contains non-Latin letters.
  englishOnly?: boolean | undefined;
}

export interface RankOutcome {
  results: RankedResult[];
  // false when no result passed the quality checks and the results are
  // returned unfiltered, ranked by engine score only.
  filtered: boolean;
}

// Multipliers applied to the raw score; soft filters demote, they never drop.
const NO_OVERLAP_PENALTY = 0.3;
const NO_CONTENT_PENALTY = 0.7;
const NON_LATIN_PENALTY = 0.3;

const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;

/**
 * Query terms worth matching on: stopwords and bare numbers/years
 * ("top 10 singer in 2026" -> ["top", "singer"]) are removed.
 */
export function meaningfulTerms(query: string): string[] {
  return tokenize(query).filter((t) => !/^\d+$/.test(t));
}

/**
 * Scores fused results by engine agreement (RRF) and keyword overlap, boosts
 * authoritative domains for definitional queries, then normalizes scores to
 * 0..1 (ties keep input order).
 *
 * Nothing is dropped. A result "passes" when it has content, a Latin title (if
 * englishOnly) and matches at least one meaningful query term. Passing results
 * come first, sorted by score; the rest follow as backfill, sorted by score and
 * flagged lowConfidence, so callers can slice to any size after ranking. If
 * nothing passes, every result is returned unfiltered (lowConfidence), ranked
 * by RRF score alone, with filtered: false. If the query has no meaningful
 * terms, the overlap check is skipped.
 */
export function rankResults(
  query: string,
  results: FusedResult[],
  options: RankOptions = {},
): RankOutcome {
  if (results.length === 0) return { results: [], filtered: true };

  const queryTerms = meaningfulTerms(query);
  const useOverlap = queryTerms.length > 0;
  const boost = isDefinitionalQuery(query);
  const maxRrf = Math.max(...results.map((r) => r.rrfScore));

  const scored = results.map((r) => {
    const hasContent = r.snippet.trim() !== "";
    // Missing content falls back to the title for matching and display.
    const content = hasContent ? r.snippet : r.title;
    const overlap = useOverlap ? keywordOverlap(queryTerms, `${r.title} ${content}`) : 1;
    const latinTitle = !options.englishOnly || !NON_LATIN_LETTER.test(r.title);
    const passes = overlap > 0 && hasContent && latinTitle;

    const rrfNorm = maxRrf > 0 ? r.rrfScore / maxRrf : 0;
    let score = RRF_WEIGHT * rrfNorm + OVERLAP_WEIGHT * overlap;
    if (overlap === 0) score *= NO_OVERLAP_PENALTY;
    if (!hasContent) score *= NO_CONTENT_PENALTY;
    if (!latinTitle) score *= NON_LATIN_PENALTY;
    if (boost && isAuthoritativeUrl(r.url)) score *= AUTHORITY_BOOST;

    return { ranked: toRanked(r, content, score), passes };
  });

  if (!scored.some((s) => s.passes)) {
    const byEngineScore = results.map((r) => ({
      ...toRanked(r, r.snippet.trim() ? r.snippet : r.title, r.rrfScore),
      lowConfidence: true,
    }));
    return {
      results: normalizeScores(byEngineScore).sort((a, b) => b.score - a.score),
      filtered: false,
    };
  }

  const normalized = normalizeScores(scored.map((s) => s.ranked));
  const strict: RankedResult[] = [];
  const weak: RankedResult[] = [];
  normalized.forEach((r, i) => (scored[i]?.passes ? strict : weak).push(r));
  strict.sort((a, b) => b.score - a.score);
  weak.sort((a, b) => b.score - a.score);

  // Keep scores non-increasing across the strict/backfill boundary.
  const floor = strict[strict.length - 1]?.score ?? 1;
  const backfill = weak.map((r) => ({
    ...r,
    score: Math.min(r.score, floor),
    lowConfidence: true,
  }));

  return { results: [...strict, ...backfill], filtered: true };
}

function toRanked(r: FusedResult, snippet: string, score: number): RankedResult {
  return {
    title: r.title,
    url: r.url,
    snippet,
    ...(r.engine !== undefined ? { engine: r.engine } : {}),
    score,
  };
}

/** Divides every score by the maximum so the top result scores 1. */
export function normalizeScores(results: RankedResult[]): RankedResult[] {
  if (results.length === 0) return [];
  const max = Math.max(...results.map((r) => r.score));
  if (max <= 0) return results.map((r) => ({ ...r, score: 0 }));
  return results.map((r) => ({ ...r, score: r.score / max }));
}
