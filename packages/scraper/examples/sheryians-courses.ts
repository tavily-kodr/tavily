/**
 * Fast, repeatable scrape of the public course list on sheryians.com.
 *
 * The site is a client-rendered app, so the HTML is an empty shell. The page
 * itself reads this public JSON endpoint, which is far cheaper than a browser.
 * Latency choices (measured, see README "Performance model"):
 *  - bare host, no `www` (the `www` host was much slower in testing)
 *  - one long-lived scraper, warmed at startup so users skip DNS + TLS
 *  - short timeout, one retry, and a deadline that returns partial results
 *  - ETag revalidation so unchanged data is answered from memory
 *
 * Run: pnpm tsx examples/sheryians-courses.ts
 */
import { z } from 'zod';
import { UniversalScraper } from '../src/index.js';

const COURSES_URL = 'https://sheryians.com/api/v3/public/courses';

const course = z.object({
  _id: z.string(),
  title: z.string(),
  price: z.number(),
  type: z.string().optional(),
  state: z.string().optional(),
});

const scraper = new UniversalScraper({
  http: { timeoutMs: 1_000, retries: 1, baseDelayMs: 50, revalidate: { maxEntries: 20 } },
});

/** Call once at boot so the first real request reuses an open connection. */
export async function warm(): Promise<number> {
  return scraper.http.warmup(COURSES_URL);
}

export async function getCourses() {
  return scraper.scrape(
    [{ url: COURSES_URL, extraction: { type: 'json', path: 'data.courses' }, schema: course }],
    { deadlineMs: 1_800, continueOnPageError: true },
  );
}

const warmMs = await warm();
console.log(`warmup: ${warmMs.toFixed(0)} ms`);
for (const run of ['first', 'second', 'third']) {
  const started = performance.now();
  const { items, stats } = await getCourses();
  console.log(`${run}: ${(performance.now() - started).toFixed(0)} ms, courses=${items.length}, truncated=${stats.truncated}, failures=${stats.failedPages}`);
}
const { items } = await getCourses();
for (const { data } of items) console.log(` - ${data.title} | ${data.price} | ${data.type ?? '?'}`);
