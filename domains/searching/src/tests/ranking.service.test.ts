import { RankingService } from '../services/ranking.service';
import { SearchResult } from '../models/search.types';

export async function testRankingService() {
  console.log('--- Testing RankingService ---');
  const ranker = new RankingService();

  const query = 'quantum computing algorithms';

  const mockResults: SearchResult[] = [
    {
      title: 'Cooking Pasta at Home',
      url: 'https://recipes.com/pasta',
      content: 'Boil water and cook spaghetti for 10 minutes until al dente.',
      domain: 'recipes.com',
      score: 0,
      published_date: '2026-01-01',
      source: 'web',
    },
    {
      title: 'Quantum Computing Algorithms & Complexity Review',
      url: 'https://arxiv.org/abs/2609.99999',
      content: 'Comprehensive analysis of Shor algorithm, Grover search, and fault-tolerant quantum error correction circuits in 2026.',
      domain: 'arxiv.org',
      score: 0,
      published_date: new Date().toISOString(),
      source: 'web',
    },
    {
      title: 'Introduction to Modern Algorithms',
      url: 'https://mit.edu/cs/algorithms',
      content: 'Classic sorting, graph theory, and basic algorithm design principles.',
      domain: 'mit.edu',
      score: 0,
      published_date: '2024-05-10',
      source: 'web',
    },
  ];

  const ranked = ranker.rankResults(mockResults, query);

  // Top result should be the quantum computing paper on arxiv
  if (ranked[0].domain !== 'arxiv.org') {
    throw new Error(`Expected arxiv.org to rank #1, but ${ranked[0].domain} ranked #1`);
  }
  console.log('✓ Relevant result ranked higher than irrelevant result');

  // Verify scores are numbers between 0 and 1
  for (const r of ranked) {
    if (typeof r.score !== 'number' || r.score < 0 || r.score > 1) {
      throw new Error(`Invalid score ${r.score} for ${r.title}`);
    }
  }
  console.log('✓ Scores normalized appropriately: top score =', ranked[0].score, ', lowest score =', ranked[ranked.length - 1].score);

  // Verify freshness effect with time_range = 'day'
  const timeRanked = ranker.rankResults(mockResults, query, { time_range: 'day' });
  if (timeRanked[0].factors?.freshness !== 1.0) {
    throw new Error('Freshness factor for today date was not 1.0');
  }
  console.log('✓ Time range freshness filter applied successfully');
}
