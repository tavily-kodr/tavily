/**
 * Real-Time Search Trigger Service
 * Manages periodic search monitors, diffs results, and dispatches real-time change events
 */

import {
  SearchTrigger,
  CreateTriggerDTO,
  TriggerChangeEvent,
  ChangeEventType,
} from '../models/trigger.types';
import { SearchService } from './search.service';
import { eventBus } from './event-bus.service';
import { normalizeUrl } from '../utils/url.utils';

export class TriggerService {
  private triggers = new Map<string, SearchTrigger>();
  private urlSnapshots = new Map<string, Map<string, { title: string; contentSnippet: string }>>();
  private searchService: SearchService;
  private intervalTimer: NodeJS.Timeout | null = null;

  constructor(searchService?: SearchService) {
    this.searchService = searchService || new SearchService();
  }

  /**
   * Creates a new search monitor trigger
   */
  createTrigger(dto: CreateTriggerDTO): SearchTrigger {
    const rawQuery = (dto.query || '').trim();
    if (!rawQuery) {
      throw new Error('Query is required to create a trigger');
    }

    const id = `trg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const frequency = dto.frequency || 'hourly';

    let intervalMinutes = dto.interval_minutes || 60;
    if (frequency === 'daily') intervalMinutes = 1440;
    else if (frequency === 'hourly') intervalMinutes = 60;

    const trigger: SearchTrigger = {
      id,
      query: rawQuery,
      frequency,
      intervalMinutes,
      search_depth: dto.search_depth || 'basic',
      createdAt: new Date().toISOString(),
      status: 'active',
      lastResultsCount: 0,
      lastUrls: [],
      events: [],
    };

    this.triggers.set(id, trigger);
    this.urlSnapshots.set(id, new Map());

    return trigger;
  }

  /**
   * Lists all existing triggers
   */
  listTriggers(): SearchTrigger[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Retrieves a trigger by ID
   */
  getTrigger(id: string): SearchTrigger | undefined {
    return this.triggers.get(id);
  }

  /**
   * Deletes a trigger by ID
   */
  deleteTrigger(id: string): boolean {
    this.urlSnapshots.delete(id);
    return this.triggers.delete(id);
  }

  /**
   * Executes a trigger immediately, computes difference, and emits events
   */
  async executeTrigger(id: string): Promise<{ trigger: SearchTrigger; changes: TriggerChangeEvent[] }> {
    const trigger = this.triggers.get(id);
    if (!trigger) {
      throw new Error(`Trigger ${id} not found`);
    }

    trigger.status = 'running';

    try {
      // Execute fresh search without cache to detect true changes
      const searchRes = await this.searchService.search(trigger.query, {
        search_depth: trigger.search_depth,
        max_results: 10,
        include_answer: false,
      });

      const currentResults = searchRes.results || [];
      const currentUrlMap = new Map<string, { title: string; contentSnippet: string }>();

      for (const r of currentResults) {
        const norm = normalizeUrl(r.url);
        currentUrlMap.set(norm, {
          title: r.title,
          contentSnippet: (r.content || '').slice(0, 200),
        });
      }

      const previousSnapshot = this.urlSnapshots.get(id) || new Map();
      const detectedChanges: TriggerChangeEvent[] = [];
      const now = new Date().toISOString();

      // 1. Detect NEW_RESULT and UPDATED_RESULT
      for (const [url, currentData] of currentUrlMap.entries()) {
        const prev = previousSnapshot.get(url);
        if (!prev) {
          if (previousSnapshot.size > 0) {
            // New result appearing
            detectedChanges.push({
              id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              triggerId: id,
              type: 'NEW_RESULT',
              query: trigger.query,
              url,
              title: currentData.title,
              details: `New result found in search rankings: "${currentData.title}"`,
              detected_at: now,
            });
          }
        } else {
          // Check for updated content or title
          if (prev.title !== currentData.title || prev.contentSnippet !== currentData.contentSnippet) {
            detectedChanges.push({
              id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              triggerId: id,
              type: 'UPDATED_RESULT',
              query: trigger.query,
              url,
              title: currentData.title,
              details: `Content or title was updated: "${currentData.title}"`,
              detected_at: now,
            });
          }
        }
      }

      // 2. Detect REMOVED_RESULT
      if (previousSnapshot.size > 0) {
        for (const [url, prevData] of previousSnapshot.entries()) {
          if (!currentUrlMap.has(url)) {
            detectedChanges.push({
              id: `evt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              triggerId: id,
              type: 'REMOVED_RESULT',
              query: trigger.query,
              url,
              title: prevData.title,
              details: `Previous result is no longer in top search rankings`,
              detected_at: now,
            });
          }
        }
      }

      // Update state
      this.urlSnapshots.set(id, currentUrlMap);
      trigger.lastRunAt = now;
      trigger.status = 'active';
      trigger.lastResultsCount = currentResults.length;
      trigger.lastUrls = Array.from(currentUrlMap.keys());

      // Append events
      if (detectedChanges.length > 0) {
        trigger.events.unshift(...detectedChanges);
        // Keep max 50 events per trigger
        if (trigger.events.length > 50) {
          trigger.events = trigger.events.slice(0, 50);
        }

        // Emit real-time update event
        eventBus.emit('SEARCH_UPDATE', {
          triggerId: id,
          query: trigger.query,
          changes: detectedChanges,
          timestamp: now,
        });

        // Also emit individual events
        for (const change of detectedChanges) {
          eventBus.emit(change.type, change);
        }
      }

      return { trigger, changes: detectedChanges };
    } catch (err: any) {
      trigger.status = 'active';
      throw err;
    }
  }

  /**
   * Starts periodic polling scheduler for active triggers
   */
  startScheduler(checkIntervalMs: number = 60000): void {
    if (this.intervalTimer) return;

    this.intervalTimer = setInterval(async () => {
      const now = Date.now();
      for (const trigger of this.triggers.values()) {
        if (trigger.status !== 'active') continue;

        const lastRun = trigger.lastRunAt ? new Date(trigger.lastRunAt).getTime() : 0;
        const intervalMs = trigger.intervalMinutes * 60 * 1000;

        if (now - lastRun >= intervalMs) {
          try {
            await this.executeTrigger(trigger.id);
          } catch {
            // Continue with other triggers
          }
        }
      }
    }, checkIntervalMs);
  }

  /**
   * Stops periodic polling scheduler
   */
  stopScheduler(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }
}

// Singleton instance for the application
export const defaultTriggerService = new TriggerService();
