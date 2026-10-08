/**
 * Ranking and Scoring Models
 */

import { SearchResult } from "./search.types";

export interface RankingFactors {
  queryRelevance: number;
  titleRelevance: number;
  contentRelevance: number;
  sourceQuality: number;
  freshness: number;
  contentQuality: number;
  finalScore: number;
}

export interface ScoredResult extends SearchResult {
  factors?: RankingFactors;
}
