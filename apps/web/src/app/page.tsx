'use client';

import React, { useState } from 'react';
import { SearchResponse, SearchResult, SearchDepth, TimeRange } from '@tavily/searching';

export default function SearchPage() {
  const [query, setQuery] = useState('');
  const [depth, setDepth] = useState<SearchDepth>('basic');
  const [maxResults, setMaxResults] = useState(10);
  const [timeRange, setTimeRange] = useState<TimeRange | ''>('');
  const [includeAnswer, setIncludeAnswer] = useState(true);
  const [includeDomains, setIncludeDomains] = useState('');
  const [excludeDomains, setExcludeDomains] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [searchResponse, setSearchResponse] = useState<SearchResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedContentUrl, setExpandedContentUrl] = useState<string | null>(null);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;

    setIsLoading(true);
    setErrorMessage(null);
    setSearchResponse(null);

    const incList = includeDomains
      .split(',')
      .map(d => d.trim())
      .filter(Boolean);
    const excList = excludeDomains
      .split(',')
      .map(d => d.trim())
      .filter(Boolean);

    try {
      const res = await fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          search_depth: depth,
          max_results: maxResults,
          include_domains: incList,
          exclude_domains: excList,
          include_answer: includeAnswer,
          time_range: timeRange || undefined,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || `Search failed with status ${res.status}`);
      }

      setSearchResponse(data);
    } catch (err: any) {
      setErrorMessage(err.message || 'An error occurred during search.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="container">
      {/* Top Header */}
      <header className="header">
        <div className="logo">
          <div className="logo-icon">T</div>
          <span>Tavily AI Search Engine</span>
        </div>
      </header>

      <main>
        {/* Search Input Box */}
        <div className="search-card">
          <form onSubmit={handleSearch}>
            <div className="search-input-group">
              <input
                type="text"
                className="search-input"
                placeholder="Ask any question or search the web..."
                value={query}
                onChange={e => setQuery(e.target.value)}
                autoFocus
              />
              <button
                type="submit"
                className="btn-primary"
                disabled={isLoading || !query.trim()}
              >
                {isLoading ? 'Searching...' : 'Search'}
              </button>
            </div>

            {/* Options & Filters Bar */}
            <div className="options-grid">
              <div className="option-group">
                <label>Depth:</label>
                <select
                  value={depth}
                  onChange={e => setDepth(e.target.value as SearchDepth)}
                >
                  <option value="basic">Basic (Fast)</option>
                  <option value="advanced">Advanced (Deep)</option>
                </select>
              </div>

              <div className="option-group">
                <label>Results:</label>
                <select
                  value={maxResults}
                  onChange={e => setMaxResults(Number(e.target.value))}
                >
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                  <option value={15}>15</option>
                  <option value={20}>20</option>
                </select>
              </div>

              <div className="option-group">
                <label>Time:</label>
                <select
                  value={timeRange}
                  onChange={e => setTimeRange(e.target.value as TimeRange | '')}
                >
                  <option value="">Any time</option>
                  <option value="day">Past 24 hours</option>
                  <option value="week">Past week</option>
                  <option value="month">Past month</option>
                  <option value="year">Past year</option>
                </select>
              </div>

              <div className="option-group">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={includeAnswer}
                    onChange={e => setIncludeAnswer(e.target.checked)}
                  />
                  AI Answer
                </label>
              </div>

              <div className="option-group" style={{ flex: '1 1 200px' }}>
                <input
                  type="text"
                  placeholder="Include domains (e.g. arxiv.org, nature.com)"
                  value={includeDomains}
                  onChange={e => setIncludeDomains(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>

              <div className="option-group" style={{ flex: '1 1 200px' }}>
                <input
                  type="text"
                  placeholder="Exclude domains (e.g. pinterest.com)"
                  value={excludeDomains}
                  onChange={e => setExcludeDomains(e.target.value)}
                  style={{ width: '100%' }}
                />
              </div>
            </div>
          </form>
        </div>

        {/* Loading Indicator */}
        {isLoading && (
          <div className="loading-box">
            <div className="spinner" />
            <p>
              {depth === 'advanced'
                ? 'Executing advanced multi-angle retrieval, deduplicating & ranking...'
                : 'Retrieving live web sources, scoring relevance & synthesizing...'}
            </p>
          </div>
        )}

        {/* Error Message */}
        {errorMessage && (
          <div style={{
            background: 'var(--rose-bg)',
            border: '1px solid rgba(244, 63, 94, 0.4)',
            color: '#fda4af',
            padding: '1rem',
            borderRadius: '8px',
            marginBottom: '1.5rem',
          }}>
            <strong>Search Error:</strong> {errorMessage}
          </div>
        )}

        {/* Search Results Display */}
        {searchResponse && (
          <div>
            {/* Grounded AI Answer */}
            {searchResponse.answer && (
              <div className="ai-answer-card">
                <div className="ai-answer-header">
                  <span>⚡</span> Grounded AI Answer
                </div>
                <div className="ai-answer-body">
                  {searchResponse.answer}
                </div>
                {searchResponse.results.length > 0 && (
                  <div className="ai-sources-list">
                    {searchResponse.results.slice(0, 5).map((src, i) => (
                      <a
                        key={src.url}
                        href={src.url}
                        target="_blank"
                        rel="noreferrer"
                        className="citation-chip"
                      >
                        <span>[{i + 1}]</span>
                        <span>{src.domain || src.title.slice(0, 20)}</span>
                      </a>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Results Meta Info */}
            <div className="results-meta">
              <span>
                Found {searchResponse.results.length} results for "{searchResponse.query}" ({searchResponse.search_depth} mode)
              </span>
              <span>
                Retrieved in {searchResponse.response_time}s
                {searchResponse.cached && ' • Cached'}
              </span>
            </div>

            {/* Results Cards List */}
            <div className="results-list">
              {searchResponse.results.map((result: SearchResult, idx: number) => (
                <article key={`${result.url}-${idx}`} className="result-card">
                  <div className="result-header">
                    <a
                      href={result.url}
                      target="_blank"
                      rel="noreferrer"
                      className="result-title"
                    >
                      {result.title}
                    </a>
                    <span className="score-badge">
                      Score: {result.score.toFixed(2)}
                    </span>
                  </div>

                  <div className="result-domain-row">
                    <span className="domain-badge">{result.domain}</span>
                    {result.published_date && (
                      <span className="published-date">
                        • {new Date(result.published_date).toLocaleDateString(undefined, {
                          year: 'numeric',
                          month: 'short',
                          day: 'numeric',
                        })}
                      </span>
                    )}
                    {result.author && (
                      <span className="published-date">• By {result.author}</span>
                    )}
                  </div>

                  <p className="result-snippet">
                    {result.content.slice(0, 320)}
                    {result.content.length > 320 ? '...' : ''}
                  </p>

                  <div className="result-footer">
                    <a
                      href={result.url}
                      target="_blank"
                      rel="noreferrer"
                      className="open-link-btn"
                    >
                      Open Source ↗
                    </a>

                    {result.content.length > 320 && (
                      <button
                        onClick={() =>
                          setExpandedContentUrl(
                            expandedContentUrl === result.url ? null : result.url
                          )
                        }
                        style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}
                      >
                        {expandedContentUrl === result.url ? 'Collapse Content' : 'View Full Content'}
                      </button>
                    )}
                  </div>

                  {expandedContentUrl === result.url && (
                    <div style={{
                      marginTop: '0.75rem',
                      padding: '0.75rem',
                      background: 'var(--bg-secondary)',
                      borderRadius: '6px',
                      fontSize: '0.85rem',
                      whiteSpace: 'pre-wrap',
                      color: '#94a3b8',
                      maxHeight: '300px',
                      overflowY: 'auto',
                    }}>
                      {result.content}
                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
