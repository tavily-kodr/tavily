'use client';

import React, { useState, useEffect } from 'react';
import { SearchResponse, SearchResult, SearchDepth, TimeRange } from '@/search/models/search.types';
import { SearchTrigger, TriggerChangeEvent } from '@/search/models/trigger.types';

export default function SearchPage() {
  const [activeTab, setActiveTab] = useState<'search' | 'triggers'>('search');

  // Search form state
  const [query, setQuery] = useState('');
  const [depth, setDepth] = useState<SearchDepth>('basic');
  const [maxResults, setMaxResults] = useState(10);
  const [timeRange, setTimeRange] = useState<TimeRange | ''>('');
  const [includeAnswer, setIncludeAnswer] = useState(true);
  const [includeDomains, setIncludeDomains] = useState('');
  const [excludeDomains, setExcludeDomains] = useState('');

  // Results & status state
  const [isLoading, setIsLoading] = useState(false);
  const [searchResponse, setSearchResponse] = useState<SearchResponse | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedContentUrl, setExpandedContentUrl] = useState<string | null>(null);

  // Triggers state
  const [triggers, setTriggers] = useState<SearchTrigger[]>([]);
  const [newTriggerQuery, setNewTriggerQuery] = useState('');
  const [newTriggerFrequency, setNewTriggerFrequency] = useState<'hourly' | 'daily' | 'interval'>('hourly');
  const [triggerEvents, setTriggerEvents] = useState<TriggerChangeEvent[]>([]);
  const [triggerLoading, setTriggerLoading] = useState(false);

  // Fetch triggers when switching to triggers tab
  useEffect(() => {
    if (activeTab === 'triggers') {
      fetchTriggers();
    }
  }, [activeTab]);

  // Connect to live SSE stream for real-time triggers
  useEffect(() => {
    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource('/api/triggers/stream');
      eventSource.addEventListener('SEARCH_UPDATE', (e: MessageEvent) => {
        try {
          const data = JSON.parse(e.data);
          if (data.changes && Array.isArray(data.changes)) {
            setTriggerEvents(prev => [...data.changes, ...prev].slice(0, 30));
          }
        } catch {
          // ignore
        }
      });
    } catch {
      // ignore
    }

    return () => {
      if (eventSource) {
        eventSource.close();
      }
    };
  }, []);

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

  const fetchTriggers = async () => {
    try {
      const res = await fetch('/api/triggers');
      const data = await res.json();
      if (data.triggers) {
        setTriggers(data.triggers);
        // Gather existing events from triggers
        const allEvts: TriggerChangeEvent[] = [];
        data.triggers.forEach((t: SearchTrigger) => {
          if (t.events) allEvts.push(...t.events);
        });
        allEvts.sort((a, b) => new Date(b.detected_at).getTime() - new Date(a.detected_at).getTime());
        setTriggerEvents(allEvts.slice(0, 30));
      }
    } catch {
      // ignore
    }
  };

  const handleCreateTrigger = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTriggerQuery.trim()) return;

    setTriggerLoading(true);
    try {
      const res = await fetch('/api/triggers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: newTriggerQuery.trim(),
          frequency: newTriggerFrequency,
          search_depth: 'basic',
        }),
      });
      if (res.ok) {
        setNewTriggerQuery('');
        await fetchTriggers();
      }
    } finally {
      setTriggerLoading(false);
    }
  };

  const handleRunTrigger = async (id: string) => {
    try {
      await fetch(`/api/triggers/${id}`, { method: 'POST' });
      await fetchTriggers();
    } catch {
      // ignore
    }
  };

  const handleDeleteTrigger = async (id: string) => {
    try {
      await fetch(`/api/triggers/${id}`, { method: 'DELETE' });
      await fetchTriggers();
    } catch {
      // ignore
    }
  };

  return (
    <div className="container">
      {/* Top Header */}
      <header className="header">
        <div className="logo">
          <div className="logo-icon">T</div>
          <span>Tavily AI Search</span>
        </div>

        <nav className="nav-tabs">
          <button
            className={`nav-tab ${activeTab === 'search' ? 'active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            Web Search
          </button>
          <button
            className={`nav-tab ${activeTab === 'triggers' ? 'active' : ''}`}
            onClick={() => setActiveTab('triggers')}
          >
            Real-Time Monitors ({triggers.length})
          </button>
        </nav>
      </header>

      {activeTab === 'search' && (
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
              </div>
            </form>
          </div>

          {/* Loading Indicator */}
          {isLoading && (
            <div className="loading-box">
              <div className="spinner" />
              <p>
                {depth === 'advanced'
                  ? 'Executing advanced multi-angle retrieval, scraping content & ranking...'
                  : 'Retrieving live web sources, extracting readable content & scoring...'}
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
                          {expandedContentUrl === result.url ? 'Collapse Content' : 'View Full Extracted Content'}
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
      )}

      {/* Real-time Triggers Tab */}
      {activeTab === 'triggers' && (
        <section>
          {/* Create Trigger Card */}
          <div className="search-card">
            <h3 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>
              Create Real-Time Search Monitor
            </h3>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
              Periodically checks the web for new articles, removed results, or content updates.
            </p>

            <form onSubmit={handleCreateTrigger} style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <input
                type="text"
                className="search-input"
                placeholder="Topic or Query to monitor (e.g. latest AI regulations)"
                value={newTriggerQuery}
                onChange={e => setNewTriggerQuery(e.target.value)}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '0.6rem 1rem',
                  flex: '1 1 300px',
                }}
              />
              <select
                value={newTriggerFrequency}
                onChange={e => setNewTriggerFrequency(e.target.value as any)}
                style={{
                  background: 'var(--bg-card)',
                  border: '1px solid var(--border)',
                  borderRadius: '8px',
                  padding: '0.6rem 1rem',
                }}
              >
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="interval">Every 15 min</option>
              </select>
              <button
                type="submit"
                className="btn-primary"
                disabled={triggerLoading || !newTriggerQuery.trim()}
              >
                {triggerLoading ? 'Creating...' : '+ Monitor Query'}
              </button>
            </form>
          </div>

          {/* Active Monitors List */}
          <div style={{ marginBottom: '2rem' }}>
            <h3 style={{ fontSize: '1rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              Active Search Monitors ({triggers.length})
            </h3>

            {triggers.length === 0 ? (
              <p style={{ fontSize: '0.9rem', color: '#64748b' }}>
                No active monitors configured yet. Create one above to track web updates.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {triggers.map(t => (
                  <div key={t.id} className="trigger-card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '1rem', color: '#60a5fa' }}>
                        {t.query}
                      </div>
                      <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '4px' }}>
                        Frequency: {t.frequency} • Last run: {t.lastRunAt ? new Date(t.lastRunAt).toLocaleTimeString() : 'Pending'} • Results tracked: {t.lastResultsCount}
                      </div>
                    </div>

                    <div style={{ display: 'flex', gap: '0.5rem' }}>
                      <button
                        className="btn-primary"
                        style={{ padding: '4px 10px', fontSize: '0.8rem' }}
                        onClick={() => handleRunTrigger(t.id)}
                      >
                        Run Now
                      </button>
                      <button
                        style={{
                          background: 'var(--rose-bg)',
                          color: 'var(--rose)',
                          border: '1px solid rgba(244, 63, 94, 0.3)',
                          padding: '4px 10px',
                          borderRadius: '6px',
                          fontSize: '0.8rem',
                        }}
                        onClick={() => handleDeleteTrigger(t.id)}
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Real-time Change Events Feed */}
          <div>
            <h3 style={{ fontSize: '1rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              Live Real-Time Change Events Feed ({triggerEvents.length})
            </h3>

            {triggerEvents.length === 0 ? (
              <p style={{ fontSize: '0.9rem', color: '#64748b' }}>
                No change events recorded yet. When a monitored search detects new or updated results, they will stream here live.
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
                {triggerEvents.map(evt => (
                  <div
                    key={evt.id}
                    style={{
                      background: 'var(--bg-card)',
                      border: '1px solid var(--border)',
                      borderRadius: '8px',
                      padding: '0.75rem 1rem',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '4px' }}>
                        <span className={`trigger-event-badge event-${evt.type}`}>
                          {evt.type.replace('_', ' ')}
                        </span>
                        <strong style={{ fontSize: '0.9rem' }}>{evt.query}</strong>
                      </div>
                      <p style={{ fontSize: '0.82rem', color: '#cbd5e1' }}>
                        {evt.details}
                      </p>
                      <a
                        href={evt.url}
                        target="_blank"
                        rel="noreferrer"
                        style={{ fontSize: '0.78rem', color: 'var(--accent)' }}
                      >
                        {evt.url}
                      </a>
                    </div>
                    <span style={{ fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                      {new Date(evt.detected_at).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
