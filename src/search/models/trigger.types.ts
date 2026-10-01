/**
 * Real-time Trigger Models and Interfaces
 */

import { SearchDepth } from './search.types';

export type TriggerFrequency = 'hourly' | 'daily' | 'interval' | 'manual';
export type TriggerStatus = 'active' | 'paused' | 'running';
export type ChangeEventType = 'NEW_RESULT' | 'REMOVED_RESULT' | 'UPDATED_RESULT';

export interface TriggerChangeEvent {
  id: string;
  triggerId: string;
  type: ChangeEventType;
  query: string;
  url: string;
  title?: string;
  details?: string;
  detected_at: string;
}

export interface SearchTrigger {
  id: string;
  query: string;
  frequency: TriggerFrequency;
  intervalMinutes: number;
  search_depth: SearchDepth;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  status: TriggerStatus;
  lastResultsCount: number;
  lastUrls: string[];
  events: TriggerChangeEvent[];
}

export interface CreateTriggerDTO {
  query: string;
  frequency?: TriggerFrequency;
  interval_minutes?: number;
  search_depth?: SearchDepth;
}
