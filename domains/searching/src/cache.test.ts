import { afterEach, describe, expect, it, vi } from "vitest";
import { TtlCache } from "./cache.js";

describe("TtlCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a value before expiry and undefined after", () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string>(1000);
    cache.set("k", "v");

    expect(cache.get("k")).toBe("v");
    vi.advanceTimersByTime(1001);
    expect(cache.get("k")).toBeUndefined();
  });
});
