import { describe, expect, it } from "vitest";
import {
  fuseResults,
  isAuthoritativeUrl,
  isDefinitionalQuery,
  keywordOverlap,
  meaningfulTerms,
  normalizeScores,
  rankResults,
  reciprocalRankFusion,
  tokenize,
} from "./rank.js";
import type { FusedResult, RankCandidate } from "./types.js";

function candidate(
  url: string,
  engineRanks: Record<string, number>,
  title = "python",
  snippet = "python",
): RankCandidate {
  return { title, url, snippet, engineRanks };
}

function fused(url: string, rrfScore: number, title = "python", snippet = "python"): FusedResult {
  return { title, url, snippet, engineRanks: {}, rrfScore };
}

describe("tokenize", () => {
  it("lowercases, splits on punctuation and strips stopwords", () => {
    expect(tokenize("What is the Python-language?")).toEqual(["python", "language"]);
  });

  it("returns an empty array for empty or stopword-only text", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("what is it")).toEqual([]);
  });
});

describe("reciprocalRankFusion", () => {
  it("sums 1/(k+rank) over engines with k=60 by default", () => {
    expect(reciprocalRankFusion({ bing: 1 })).toBeCloseTo(1 / 61);
    expect(reciprocalRankFusion({ bing: 1, brave: 3 })).toBeCloseTo(1 / 61 + 1 / 63);
  });

  it("returns 0 when no engine returned the result", () => {
    expect(reciprocalRankFusion({})).toBe(0);
  });
});

describe("fuseResults", () => {
  it("returns an empty array for no candidates", () => {
    expect(fuseResults([])).toEqual([]);
  });

  it("merges duplicate URLs and scores multi-engine results higher", () => {
    const out = fuseResults([
      candidate("https://a.com/", { bing: 1 }),
      candidate("https://b.com", { bing: 2 }),
      candidate("http://a.com", { brave: 2 }),
    ]);

    expect(out.map((r) => r.url)).toEqual(["https://a.com/", "https://b.com"]);
    expect(out[0]?.engineRanks).toEqual({ bing: 1, brave: 2 });
    expect(out[0]!.rrfScore).toBeGreaterThan(out[1]!.rrfScore);
  });

  it("keeps each engine's best rank when merging", () => {
    const out = fuseResults([
      candidate("https://a.com", { bing: 4 }),
      candidate("https://a.com", { bing: 2 }),
    ]);
    expect(out[0]?.engineRanks).toEqual({ bing: 2 });
  });
});

describe("keywordOverlap", () => {
  it("returns the fraction of distinct query terms found", () => {
    expect(keywordOverlap(["python", "language"], "Python is a language")).toBe(1);
    expect(keywordOverlap(["python", "snake"], "Python programming")).toBe(0.5);
    expect(keywordOverlap(["python"], "Java programming")).toBe(0);
  });

  it("returns 0 for no query terms", () => {
    expect(keywordOverlap([], "anything")).toBe(0);
  });
});

describe("isDefinitionalQuery / isAuthoritativeUrl", () => {
  it("detects what is / who is / how to queries", () => {
    expect(isDefinitionalQuery("what is python")).toBe(true);
    expect(isDefinitionalQuery("Who was Ada Lovelace")).toBe(true);
    expect(isDefinitionalQuery("how to install node")).toBe(true);
    expect(isDefinitionalQuery("python tutorial")).toBe(false);
    expect(isDefinitionalQuery("somewhat isolated")).toBe(false);
  });

  it("recognizes wikipedia and official docs domains", () => {
    expect(isAuthoritativeUrl("https://en.wikipedia.org/wiki/Python")).toBe(true);
    expect(isAuthoritativeUrl("https://docs.python.org/3/")).toBe(true);
    expect(isAuthoritativeUrl("https://docs.example.com/x")).toBe(true);
    expect(isAuthoritativeUrl("https://notwikipedia.org")).toBe(false);
    expect(isAuthoritativeUrl("not a url")).toBe(false);
  });
});

describe("normalizeScores", () => {
  it("returns an empty array for empty input", () => {
    expect(normalizeScores([])).toEqual([]);
  });

  it("scales so the max is 1", () => {
    const out = normalizeScores([
      { title: "a", url: "https://a.com", snippet: "", score: 2 },
      { title: "b", url: "https://b.com", snippet: "", score: 1 },
    ]);
    expect(out.map((r) => r.score)).toEqual([1, 0.5]);
  });

  it("maps all-zero scores to 0 without dividing by zero", () => {
    const out = normalizeScores([{ title: "a", url: "https://a.com", snippet: "", score: 0 }]);
    expect(out[0]?.score).toBe(0);
  });
});

describe("meaningfulTerms", () => {
  it("strips stopwords and bare numbers/years", () => {
    expect(meaningfulTerms("top 10 singer in 2026")).toEqual(["top", "singer"]);
  });

  it("returns nothing for a numbers/year-only query", () => {
    expect(meaningfulTerms("2026")).toEqual([]);
    expect(meaningfulTerms("10 2026")).toEqual([]);
  });

  it("keeps alphanumeric terms", () => {
    expect(meaningfulTerms("python3 top10")).toEqual(["python3", "top10"]);
  });
});

describe("rankResults", () => {
  it("returns an empty, filtered outcome for empty results", () => {
    expect(rankResults("what is python", [])).toEqual({ results: [], filtered: true });
  });

  it("ranks zero-overlap results down instead of dropping them", () => {
    const { results, filtered } = rankResults("python language", [
      fused("https://off.com", 0.03, "Cooking", "recipes"),
      fused("https://on.com", 0.02, "Python", "a language"),
    ]);
    expect(filtered).toBe(true);
    expect(results.map((r) => r.url)).toEqual(["https://on.com", "https://off.com"]);
    expect(results[1]!.score).toBeLessThan(results[0]!.score);
  });

  it("matches on any meaningful term and ignores years and numbers", () => {
    const { results, filtered } = rankResults("top 10 singer in 2026", [
      fused("https://year.com", 0.03, "Best of 2026", "10 things from 2026"),
      fused("https://singer.com", 0.02, "A singer", "famous singer"),
    ]);
    expect(filtered).toBe(true);
    expect(results[0]?.url).toBe("https://singer.com");
  });

  it("skips overlap for a numbers/year-only query", () => {
    const { results, filtered } = rankResults("2026", [
      fused("https://a.com", 0.02, "Calendar", "dates"),
      fused("https://b.com", 0.01, "Other", "stuff"),
    ]);
    expect(filtered).toBe(true);
    expect(results.map((r) => r.url)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("falls back to the title when content is missing and ranks it down", () => {
    const { results } = rankResults("python", [
      fused("https://empty.com", 0.03, "Python", ""),
      fused("https://full.com", 0.02, "Python", "python"),
    ]);
    expect(results.map((r) => r.url)).toEqual(["https://full.com", "https://empty.com"]);
    expect(results[1]?.snippet).toBe("Python");
  });

  it("ranks non-Latin titles down only for english searches", () => {
    const input = [
      fused("https://ru.com", 0.03, "Питон python", "python"),
      fused("https://en.com", 0.02, "Python", "python"),
    ];
    expect(rankResults("python", input, { englishOnly: true }).results[0]?.url).toBe(
      "https://en.com",
    );
    expect(rankResults("python", input).results[0]?.url).toBe("https://ru.com");
  });

  it("returns everything ranked by engine score with filtered:false when nothing passes", () => {
    const { results, filtered } = rankResults("singer", [
      fused("https://low.com", 0.01, "Cooking", "recipes"),
      fused("https://high.com", 0.03, "Gardening", "plants"),
    ]);
    expect(filtered).toBe(false);
    expect(results.map((r) => r.url)).toEqual(["https://high.com", "https://low.com"]);
    expect(results[0]?.score).toBe(1);
  });

  it("normalizes scores to 0..1 and sorts descending", () => {
    const { results } = rankResults("python", [
      fused("https://low.com", 0.01),
      fused("https://high.com", 0.03),
      fused("https://mid.com", 0.02),
    ]);
    expect(results.map((r) => r.url)).toEqual([
      "https://high.com",
      "https://mid.com",
      "https://low.com",
    ]);
    expect(results[0]?.score).toBe(1);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }
  });

  it("keeps input order for tied scores", () => {
    const { results } = rankResults("python", [
      fused("https://first.com", 0.02),
      fused("https://second.com", 0.02),
      fused("https://third.com", 0.02),
    ]);
    expect(results.map((r) => r.url)).toEqual([
      "https://first.com",
      "https://second.com",
      "https://third.com",
    ]);
    expect(results.every((r) => r.score === 1)).toBe(true);
  });

  it("boosts wikipedia and docs for definitional queries only", () => {
    const input = [fused("https://blog.com", 0.03), fused("https://en.wikipedia.org/wiki/P", 0.02)];
    expect(rankResults("what is python", input).results[0]?.url).toBe(
      "https://en.wikipedia.org/wiki/P",
    );
    expect(rankResults("python", input).results[0]?.url).toBe("https://blog.com");
  });

  it("does not leak ranking internals into the output", () => {
    const { results } = rankResults("python", [fused("https://a.com", 0.02)]);
    expect(results[0]).toEqual({
      title: "python",
      url: "https://a.com",
      snippet: "python",
      score: 1,
    });
  });
});
