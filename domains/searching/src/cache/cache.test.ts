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

  it("evicts the least recently used entry beyond maxEntries", () => {
    const cache = new TtlCache<number>(60_000, { maxEntries: 2 });
    cache.set("a", 1);
    cache.set("b", 2);
    expect(cache.get("a")).toBe(1); // a is now most recently used
    cache.set("c", 3);

    expect(cache.size).toBe(2);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.get("c")).toBe(3);
  });

  it("keeps an expired entry as stale for staleMs, then drops it", () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string>(1000, { staleMs: 500 });
    cache.set("k", "v");

    vi.advanceTimersByTime(1001);
    expect(cache.get("k")).toBeUndefined();
    expect(cache.peek("k")).toEqual({ value: "v", fresh: false });
    vi.advanceTimersByTime(500);
    expect(cache.peek("k")).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it("supports a per-entry TTL", () => {
    vi.useFakeTimers();
    const cache = new TtlCache<string>(10_000);
    cache.set("short", "v", 100);

    vi.advanceTimersByTime(101);
    expect(cache.get("short")).toBeUndefined();
  });
});
