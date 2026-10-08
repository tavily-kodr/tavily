import { describe, expect, it } from "vitest";
import { deduplicateResults } from "./dedupe.js";

describe("deduplicateResults", () => {
  it("keeps the first occurrence across http/https, case and trailing slash", () => {
    const results = deduplicateResults([
      { title: "A", url: "https://Example.com/", snippet: "first" },
      { title: "B", url: "http://example.com", snippet: "second" },
      { title: "C", url: "https://other.com/page", snippet: "third" },
    ]);

    expect(results.map((r) => r.title)).toEqual(["A", "C"]);
  });
});
