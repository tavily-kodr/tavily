/**
 * AI Grounded Answer Generation Service
 * Synthesizes grounded answers strictly from retrieved search sources with citations
 */

import { SearchResult, SearchAnswerSource } from '../models/search.types';
import { tokenize } from '../utils/text.utils';

export interface GeneratedAnswer {
  answer: string;
  sources: SearchAnswerSource[];
}

export class AnswerService {
  private readonly apiKey?: string;
  private readonly apiBase: string;
  private readonly model: string;

  constructor() {
    this.apiKey = process.env.OPENAI_API_KEY?.trim();
    this.apiBase = process.env.OPENAI_API_BASE?.trim() || 'https://api.openai.com/v1';
    this.model = process.env.OPENAI_MODEL?.trim() || 'gpt-4o-mini';
  }

  /**
   * Generates a grounded answer based on top ranked search results
   */
  async generateAnswer(query: string, results: SearchResult[]): Promise<GeneratedAnswer | null> {
    if (!results || results.length === 0) {
      return null;
    }

    // Select top 5 sources with useful content
    const candidateSources = results
      .filter(r => r.content && r.content.trim().length > 40)
      .slice(0, 5);

    if (candidateSources.length === 0) {
      return null;
    }

    const citationSources: SearchAnswerSource[] = candidateSources.map(s => ({
      title: s.title,
      url: s.url,
    }));

    // If OpenAI API key is available, call LLM
    if (this.apiKey) {
      try {
        const llmAnswer = await this.callLlm(query, candidateSources);
        if (llmAnswer) {
          return {
            answer: llmAnswer,
            sources: citationSources,
          };
        }
      } catch {
        // Fall back to grounded extractive synthesis
      }
    }

    // Zero-config grounded extractive synthesis fallback
    const synthesis = this.generateExtractiveAnswer(query, candidateSources);
    return {
      answer: synthesis,
      sources: citationSources,
    };
  }

  /**
   * Calls OpenAI / OpenAI-compatible API to generate a strictly grounded answer
   */
  private async callLlm(query: string, sources: SearchResult[]): Promise<string | null> {
    const formattedSources = sources
      .map((s, idx) => `[Source ${idx + 1}]: "${s.title}" (${s.url})\n${s.content.slice(0, 800)}`)
      .join('\n\n');

    const systemPrompt = `You are a factual, precision search engine answering assistant.
Your task is to answer the user's query based ONLY on the provided retrieved sources.
Guidelines:
1. Ground every single claim in the provided sources.
2. Cite the sources using numerical brackets like [1], [2] corresponding to [Source 1], [Source 2].
3. Do NOT invent facts, URLs, dates, or citations.
4. If the provided sources do not contain enough information to fully answer, state what is known from the sources and note what is missing.
5. Be concise, objective, and structured.`;

    const userPrompt = `Query: "${query}"\n\nRetrieved Sources:\n${formattedSources}\n\nPlease provide a clear, grounded answer with citations.`;

    const response = await fetch(`${this.apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.2,
        max_tokens: 600,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM API returned ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();
    return content || null;
  }

  /**
   * Generates a grounded extractive synthesis when no LLM API key is present
   */
  private generateExtractiveAnswer(query: string, sources: SearchResult[]): string {
    const queryTokens = new Set(tokenize(query, true));
    const selectedSentences: Array<{ text: string; score: number; sourceIndex: number }> = [];

    sources.forEach((source, sourceIdx) => {
      // Split content into sentences
      const sentences = source.content
        .split(/(?<=[.?!])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 25 && s.length < 250);

      for (const sent of sentences) {
        const sentTokens = tokenize(sent, true);
        if (sentTokens.length === 0) continue;

        let matches = 0;
        for (const token of sentTokens) {
          if (queryTokens.has(token)) matches++;
        }

        if (matches > 0) {
          const score = matches / Math.sqrt(sentTokens.length);
          selectedSentences.push({
            text: sent,
            score,
            sourceIndex: sourceIdx + 1,
          });
        }
      }
    });

    // Sort by relevance to query
    selectedSentences.sort((a, b) => b.score - a.score);

    // Pick top 3-4 non-redundant sentences
    const picked: Array<{ text: string; sourceIndex: number }> = [];
    for (const item of selectedSentences) {
      if (picked.length >= 4) break;
      const isRedundant = picked.some(p => p.text.toLowerCase().includes(item.text.toLowerCase()) || item.text.toLowerCase().includes(p.text.toLowerCase()));
      if (!isRedundant) {
        picked.push({ text: item.text, sourceIndex: item.sourceIndex });
      }
    }

    if (picked.length === 0) {
      const top = sources[0];
      return `According to ${top.title} ([1]), recent findings indicate: ${top.content.slice(0, 250)}...`;
    }

    // Format with citations
    const formatted = picked.map(p => `${p.text} [${p.sourceIndex}]`).join(' ');
    return `Based on retrieved sources: ${formatted}`;
  }
}
