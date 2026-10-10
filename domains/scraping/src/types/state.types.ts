export type CrawlItemState =
  | "DISCOVERED"
  | "QUEUED"
  | "FETCHING"
  | "EXTRACTING"
  | "COMPLETED"
  | "RETRYABLE_FAILURE"
  | "PERMANENT_FAILURE";

export interface CrawlProgress {
  discovered: number;
  queued: number;
  inProgress: number;
  completed: number;
  failed: number;
  bytesFetched: number;
  durationMs: number;
}
