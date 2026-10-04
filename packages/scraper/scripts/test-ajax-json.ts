import { UniversalScraper } from '../src/index.js';

const years = [2010, 2011, 2012, 2013, 2014, 2015];

const scraper = new UniversalScraper({});

const targets = years.map((year) => ({
  url: `https://www.scrapethissite.com/pages/ajax-javascript/?ajax=true&year=${year}`,
  extraction: { type: 'json' as const },
}));

const result = await scraper.scrape(targets, {
  concurrency: 4,
});

console.log('total extracted:', result.items.length);
for (const year of years) {
  const count = result.items.filter(
    (item) =>
      item &&
      typeof item === 'object' &&
      'data' in item &&
      item.data &&
      typeof item.data === 'object' &&
      'year' in item.data &&
      (item.data as { year?: number }).year === year
  ).length;

  console.log(`${year} → ${count} records`);
}

console.log('\nfirst 2 items:');
console.dir(result.items.slice(0, 2), { depth: null });

console.log('\nstats:');
console.dir(result.stats, { depth: null });
