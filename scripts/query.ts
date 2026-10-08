/**
 * CLI Test Query Runner
 * Easily test live search queries directly from the command line
 * Usage: npx tsx scripts/query.ts "your search query"
 */

import { defaultSearchService } from '../domains/searching/src';

async function main() {
  const query = process.argv.slice(2).join(' ').trim() || 'machine learning breakthroughs';

  console.log(`\n🔍 Searching for: "${query}"...\n`);
  const startTime = Date.now();

  try {
    const response = await defaultSearchService.search(query, {
      search_depth: 'basic',
      max_results: 5,
      include_answer: true,
    });

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log(`✅ Status: ${response.status} (${response.total_found} results in ${elapsed}s)\n`);

    if (response.answer) {
      console.log('🤖 AI Grounded Answer:');
      console.log(`   ${response.answer}\n`);
    }

    console.log('📄 Search Results:');
    response.results.forEach((r, idx) => {
      console.log(`  [${idx + 1}] ${r.title}`);
      console.log(`      URL:   ${r.url}`);
      console.log(`      Score: ${r.score.toFixed(2)} | Domain: ${r.domain}`);
      if (r.content) {
        console.log(`      ${r.content.slice(0, 150)}...`);
      }
      console.log();
    });
  } catch (err: any) {
    console.error('❌ Search failed:', err.message || err);
    process.exit(1);
  }
}

main();
