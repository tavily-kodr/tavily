import { TriggerService } from '../services/trigger.service';
import { SearchService } from '../services/search.service';
import { SearchProvider } from '../providers/search-provider.interface';
import { SearchOptions, SearchProviderResult } from '../models/search.types';

// Mock Provider for deterministic trigger testing
class MockTriggerSearchProvider implements SearchProvider {
  readonly name = 'MockTriggerProvider';
  private runIndex = 0;

  async search(query: string, options: SearchOptions): Promise<SearchProviderResult[]> {
    this.runIndex++;
    if (this.runIndex === 1) {
      // First baseline run
      return [
        {
          title: 'AI Act Passed in Europe',
          url: 'https://news.eu/ai-act',
          snippet: 'Initial approval of the European artificial intelligence regulations.',
        },
        {
          title: 'US Guidelines for Frontier Models',
          url: 'https://whitehouse.gov/ai-order',
          snippet: 'Executive order details regarding safety evaluations.',
        },
      ];
    } else {
      // Second run: 1 updated title/content, 1 new result, 1 removed result
      return [
        {
          title: 'AI Act Formally Enacted into Law', // UPDATED
          url: 'https://news.eu/ai-act',
          snippet: 'European AI regulations have formally been enacted and are now active.',
        },
        {
          title: 'New Global Safety Standards Summit Announced', // NEW
          url: 'https://globalsafety.org/summit',
          snippet: 'International delegates convene to discuss safety guidelines.',
        },
      ];
    }
  }
}

export async function testTriggerService() {
  console.log('--- Testing TriggerService ---');

  const mockProvider = new MockTriggerSearchProvider();
  const searchService = new SearchService({ provider: mockProvider });
  const triggerService = new TriggerService(searchService);

  // 1. Create Trigger
  const trigger = triggerService.createTrigger({
    query: 'AI regulations',
    frequency: 'hourly',
  });

  if (!trigger.id || trigger.query !== 'AI regulations') {
    throw new Error('Trigger creation failed');
  }
  console.log('✓ Trigger created with ID:', trigger.id);

  // 2. Initial Execution (Baseline)
  const initialRun = await triggerService.executeTrigger(trigger.id);
  if (initialRun.trigger.lastResultsCount !== 2) {
    throw new Error(`Expected 2 baseline results, got ${initialRun.trigger.lastResultsCount}`);
  }
  console.log('✓ Baseline execution completed, captured initial results');

  // 3. Second Execution (Detect Changes)
  const secondRun = await triggerService.executeTrigger(trigger.id);
  const changes = secondRun.changes;

  const newResultEvent = changes.find(c => c.type === 'NEW_RESULT');
  const updatedResultEvent = changes.find(c => c.type === 'UPDATED_RESULT');
  const removedResultEvent = changes.find(c => c.type === 'REMOVED_RESULT');

  if (!newResultEvent) {
    throw new Error('Expected NEW_RESULT event was not detected');
  }
  if (!updatedResultEvent) {
    throw new Error('Expected UPDATED_RESULT event was not detected');
  }
  if (!removedResultEvent) {
    throw new Error('Expected REMOVED_RESULT event was not detected');
  }

  console.log('✓ NEW_RESULT detected for:', newResultEvent.url);
  console.log('✓ UPDATED_RESULT detected for:', updatedResultEvent.url);
  console.log('✓ REMOVED_RESULT detected for:', removedResultEvent.url);
}
