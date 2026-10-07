import { describe, expect, it } from "vitest";
import {
  filterBlockedDomains,
  filterAdultResults,
  filterIncludeDomains,
  hasNonLatinLetters,
} from "./filters.js";
import type { SearchResult } from "./types.js";

function result(url: string, title = "Title", snippet = "content"): SearchResult {
  return { title, url, snippet };
}

describe("filterBlockedDomains", () => {
  it("returns an empty array for empty results", () => {
    expect(filterBlockedDomains([], ["bad.com"])).toEqual([]);
  });

  it("drops the domain and its subdomains but not lookalikes", () => {
    const out = filterBlockedDomains(
      [
        result("https://bad.com/x"),
        result("https://www.bad.com"),
        result("https://notbad.com"),
        result("https://good.com"),
      ],
      [" Bad.com "],
    );
    expect(out.map((r) => r.url)).toEqual(["https://notbad.com", "https://good.com"]);
  });

  it("keeps everything when the list is empty", () => {
    const input = [result("https://a.com")];
    expect(filterBlockedDomains(input, [])).toBe(input);
  });

  it("drops results with unparseable URLs", () => {
    expect(filterBlockedDomains([result("not a url")], ["bad.com"])).toEqual([]);
  });
});

describe("filterIncludeDomains", () => {
  it("returns an empty array for empty results", () => {
    expect(filterIncludeDomains([], ["a.com"])).toEqual([]);
  });

  it("keeps only listed domains and their subdomains", () => {
    const out = filterIncludeDomains(
      [result("https://docs.a.com"), result("https://b.com"), result("https://a.com")],
      ["a.com"],
    );
    expect(out.map((r) => r.url)).toEqual(["https://docs.a.com", "https://a.com"]);
  });

  it("keeps everything when the list is empty", () => {
    const input = [result("https://a.com"), result("https://b.com")];
    expect(filterIncludeDomains(input, [])).toBe(input);
  });
});

describe("filterAdultResults", () => {
  it("returns an empty array for empty results", () => {
    expect(filterAdultResults([])).toEqual([]);
  });

  it("drops hostnames with adult keywords and keeps the rest", () => {
    const out = filterAdultResults([
      result("https://best-porn-site.com"),
      result("https://xxx-cams.net/x"),
      result("https://sussex.ac.uk"),
      result("https://example.com"),
    ]);
    expect(out.map((r) => r.url)).toEqual(["https://sussex.ac.uk", "https://example.com"]);
  });
});

describe("hasNonLatinLetters", () => {
  it("treats accented Latin letters as Latin", () => {
    expect(hasNonLatinLetters("Café résumé")).toBe(false);
    expect(hasNonLatinLetters("Ελληνικά")).toBe(true);
    expect(hasNonLatinLetters("パイソン入門")).toBe(true);
  });
});
