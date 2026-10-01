import { RankingService } from '../services/ranking.service';
import { SearchResult } from '../models/search.types';

export async function testRankingService() {
  console.log('--- Testing RankingService ---');
  const service = new RankingService();

  const query = 'renewable clean energy solar power';

  const mockResults: SearchResult[] = [
    {
      title: 'Guide to Clean Renewable Energy and Solar Power Solutions',
      url: 'https://energy.gov/clean-energy',
      content: 'Detailed governmental research on renewable clean energy, photovoltaic solar power innovations, and wind turbines.',
      domain: 'energy.gov',
      score: 0,
      published_date: new Date(Date.now() - 86400000 * 2).toISOString(), // 2 days old
      source: 'web',
    },
    {
      title: 'Random Blog Post About Vacations',
      url: 'https://random-travel.com/vacation',
      content: 'Here is what we did on our beach holiday in Hawaii with some sunshine.',
      domain: 'random-travel.com',
      score: 0,
      published_date: '2020-01-01T00:00:00Z',
      source: 'web',
    },
    {
      title: 'Solar Power Efficiency Records Broken',
      url: 'https://nature.com/articles/solar-breakthrough',
      content: 'Scientists have achieved new efficiency benchmarks in perovskite solar cells for clean renewable energy.',
      domain: 'nature.com',
      score: 0,
      published_date: new Date(Date.now() - 86400000 * 5).toISOString(), // 5 days old
      source: 'web',
    },
  ];

  const ranked = service.rankResults(mockResults, query);

  // 1. Check that relevant results rank higher than irrelevant vacation post
  if (ranked[0].url === 'https://random-travel.com/vacation') {
    throw new Error('Irrelevant result ranked highest!');
  }
  if (ranked[2].url !== 'https://random-travel.com/vacation') {
    throw new Error('Expected irrelevant result to be ranked last!');
  }
  console.log('✓ Relevant result ranked higher than irrelevant result');

  // 2. Check authority and freshness scores
  if (ranked[0].score < 0.7) {
    throw new Error(`Expected high score (> 0.7) for high-authority highly-relevant result, got ${ranked[0].score}`);
  }
  if (ranked[2].score > 0.45) {
    throw new Error(`Expected lower score (< 0.45) for irrelevant result, got ${ranked[2].score}`);
  }
  console.log('✓ Scores normalized appropriately: top score =', ranked[0].score, ', lowest score =', ranked[2].score);

  // 3. Time filtering freshness adjustment
  const rankedWithWeekFilter = service.rankResults(mockResults, query, { time_range: 'week' });
  const vacationPost = rankedWithWeekFilter.find(r => r.url.includes('random-travel'));
  if (!vacationPost || vacationPost.factors?.freshness! > 0.3) {
    throw new Error('Freshness penalty was not applied to old post under week time_range');
  }
  console.log('✓ Time range freshness filter applied successfully');
}
