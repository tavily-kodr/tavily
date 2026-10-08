# Search quality

How results are ranked and what is known not to work well.

## Ranking

Implemented in `src/rank.ts` (pure functions, no I/O).

1. **Reciprocal rank fusion (k = 60).** Each result's score is the sum of `1 / (60 + rank)` over
   every engine that returned it, where `rank` is its 1-based position among that engine's
   results. A URL returned by several engines therefore outranks a URL returned by one, even if
   the single engine placed it first. Duplicate URLs (ignoring scheme, case and trailing slash)
   are merged, keeping each engine's best rank.
2. **Keyword overlap.** The query and each result's title + content are lowercased, split on
   non-alphanumerics and stripped of stopwords. The overlap is the fraction of distinct query
   terms found. Results with zero overlap are dropped. If the query is only stopwords, this
   filter is skipped.
3. **Combination.** Raw score = 0.5 × (RRF ÷ best RRF) + 0.5 × overlap.
4. **Authority boost.** For "what is / who is / how to" queries, wikipedia.org and official docs
   domains (`docs.*`, `developer.mozilla.org`, `docs.python.org`, ...) are multiplied by 1.5.
5. **Normalization.** Scores are divided by the maximum so the top result is `1`, then sorted
   descending. Ties keep their input order.

Before ranking, results pass `include_domains` / `exclude_domains`, and for
English searches a filter that drops empty content and non-Latin-script titles.

## Known limitations

- **DuckDuckGo is blocked from Docker IPs.** From containers on cloud or datacenter IPs DuckDuckGo
  frequently returns CAPTCHAs or errors, so it shows up in `failedEngines` (`partial: true`) and
  contributes nothing to fusion. Expect fewer engines than configured, and weaker agreement
  signals, when SearXNG runs in Docker. Other engines (Brave, Mojeek, Bing) can be rate limited
  the same way.
- **Rank positions are approximate.** SearXNG returns one merged list, not per-engine lists. An
  engine's rank is its order among the results attributed to it, so RRF is an estimate.
- **Keyword overlap is lexical.** No stemming or synonyms: "running" does not match "run", and a
  relevant result that paraphrases the query can be dropped.
- **Non-Latin filter is strict.** Any non-Latin letter in an English-search title drops the
  result, including mixed titles such as "Python (программирование)".
- **Ambiguous queries** ("jaguar", "apple") are ranked by agreement and overlap only; there is no
  intent disambiguation.
- **Partial responses are not cached**, so a flaky engine increases load and latency.
- **Cache is per process** and resets on restart.
