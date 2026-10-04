import { describe, expect, it } from 'vitest';
import { UniversalScraper, extractHtml, extractNextLink, loadHtml } from '../src/index.js';

const rule = {
  type: 'html' as const,
  selector: '.product',
  fields: { title: { selector: '.title' }, price: { selector: '.price' }, url: { selector: 'a', attribute: 'href' } },
};

/** Deliberately broken markup: unclosed tags, stray close tags, uppercase, entities, table without tbody. */
const messy = `<HTML><BODY><DIV class=wrap><P>Intro <b>bold<i>both</b> italic?</i></P><P>Second
<TABLE><TR><TD class="product"><span class="title">A &amp; B</span><span class="price">1</span><a href="/a">a</a>
<TD class="product"><span class="title">C&nbsp;D</span><span class="price">2</span><a href="/b">b</a></TR></TABLE></div></div>
<ul><li class="product"><span class="title">E</span><span class="price">3</span><a href="/c">c</a>
<li class="product"><span class="title">F</span><span class="price">4</span><a href="/d">d</a></ul>
<a REL="Next" HREF="/2?a=1&amp;b=2">next</a><p>trailing</BODY></HTML>`;

describe('HTML parser backends', () => {
  it('extract identical items and next links from messy markup', () => {
    const parse5 = loadHtml(messy);
    const htmlparser2 = loadHtml(messy, 'htmlparser2');
    expect(extractHtml(htmlparser2, rule)).toEqual(extractHtml(parse5, rule));
    expect(extractHtml(parse5, rule)).toHaveLength(4);
    expect(extractNextLink(htmlparser2)).toBe('/2?a=1&b=2');
    expect(extractNextLink(parse5)).toBe('/2?a=1&b=2');
  });

  it('differ on implied HTML5 elements, which is why parse5 stays the default', () => {
    const html = '<table><tr><td>x</td></tr></table>';
    expect(loadHtml(html)('table > tbody > tr').length).toBe(1);
    expect(loadHtml(html, 'htmlparser2')('table > tbody > tr').length).toBe(0);
    expect(loadHtml(html, 'htmlparser2')('table tr').length).toBe(1);
  });

  it('is selectable on the scraper', async () => {
    const fetchImpl = async (): Promise<Response> => new Response(messy, { headers: { 'content-type': 'text/html' } });
    const scraper = new UniversalScraper({ http: { fetchImpl }, htmlParser: 'htmlparser2' });
    const result = await scraper.scrape([{ url: 'https://example.test/x', extraction: rule }]);
    expect(result.items.map((i) => (i.data as { title: string }).title)).toEqual(['A & B', 'C\u00a0D', 'E', 'F']);
  });
});
