/**
 * Master Test Runner for Tavily Searching Domain
 * Runs all unit and integration test suites for the Searching domain
 */

import { testDeduplicationService } from './deduplication.service.test';
import { testRankingService } from './ranking.service.test';
import { testSearchService } from './search.service.test';

async function runAll() {
  console.log('====================================================');
  console.log('   TAVILY SEARCHING DOMAIN - AUTOMATED TEST SUITE   ');
  console.log('====================================================\n');

  const startAll = Date.now();
  let passed = 0;
  let failed = 0;

  const suites = [
    { name: 'Deduplication Service Tests', fn: testDeduplicationService },
    { name: 'Ranking & Relevance Service Tests', fn: testRankingService },
    { name: 'Search Service & Pipeline Tests', fn: testSearchService },
  ];

  for (const suite of suites) {
    const start = Date.now();
    try {
      await suite.fn();
      const elapsed = Date.now() - start;
      console.log(`PASS: ${suite.name} (${elapsed}ms)\n`);
      passed++;
    } catch (err: any) {
      console.error(`FAIL: ${suite.name}`);
      console.error(err);
      console.log('\n');
      failed++;
    }
  }

  const totalElapsed = Date.now() - startAll;
  console.log('====================================================');
  console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed (${totalElapsed}ms)`);
  console.log('====================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

runAll().catch(err => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
