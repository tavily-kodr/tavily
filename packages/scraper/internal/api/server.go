// Package api exposes the scraper over HTTP for the Tavily search API (packages/app).
//
//	POST /scrape  {"urls": ["https://…", …]}  →  {"results": [ScrapeResult…], "took_ms": n}
//	GET  /health                              →  {"status": "ok"}
//
// Results are returned in input order. A URL that fails to scrape is reported in place with
// success=false and an error string; it never fails the whole request.
package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sujal/go-scraper/internal/orchestrator"
	"github.com/sujal/go-scraper/internal/types"
)

const maxBodyBytes = 64 << 10 // 20 URLs is a few KB; anything near this is a mistake

type Server struct {
	orch         *orchestrator.Orchestrator
	maxURLs      int
	batchTimeout time.Duration
}

// New wires the HTTP handlers to a long-lived Orchestrator. maxURLs caps the URLs accepted per
// request; batchTimeout bounds the whole request, including the slowest URL's browser escalation.
func New(orch *orchestrator.Orchestrator, maxURLs int, batchTimeout time.Duration) *Server {
	return &Server{orch: orch, maxURLs: maxURLs, batchTimeout: batchTimeout}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.handleHealth)
	mux.HandleFunc("POST /scrape", s.handleScrape)
	return mux
}

type scrapeRequest struct {
	URLs []string `json:"urls"`
}

type scrapeResponse struct {
	Results []types.ScrapeResult `json:"results"`
	TookMs  int64                `json:"took_ms"`
}

type errorResponse struct {
	Error string `json:"error"`
}

func (s *Server) handleHealth(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) handleScrape(w http.ResponseWriter, r *http.Request) {
	start := time.Now()

	var req scrapeRequest
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: "invalid JSON body: " + err.Error()})
		return
	}

	urls, err := s.validateURLs(req.URLs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, errorResponse{Error: err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), s.batchTimeout)
	defer cancel()

	results := s.orch.ScrapeURLs(ctx, urls)

	ok := 0
	for i := range results {
		results[i].HTML = "" // never ship raw HTML over the API; text/markdown carry the content
		if results[i].Success {
			ok++
		}
	}
	slog.Info("scrape batch done", "urls", len(urls), "ok", ok, "failed", len(urls)-ok,
		"took_ms", time.Since(start).Milliseconds())

	writeJSON(w, http.StatusOK, scrapeResponse{
		Results: results,
		TookMs:  time.Since(start).Milliseconds(),
	})
}

// validateURLs rejects an empty or oversized batch and any entry that is not an absolute
// http(s) URL. Entries are trimmed; the order is preserved.
func (s *Server) validateURLs(raw []string) ([]string, error) {
	if len(raw) == 0 {
		return nil, errors.New("\"urls\" must be a non-empty array")
	}
	if len(raw) > s.maxURLs {
		return nil, fmt.Errorf("too many urls: %d (max %d)", len(raw), s.maxURLs)
	}

	urls := make([]string, 0, len(raw))
	for i, u := range raw {
		u = strings.TrimSpace(u)
		parsed, err := url.Parse(u)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
			return nil, fmt.Errorf("urls[%d] is not an absolute http(s) URL: %q", i, u)
		}
		urls = append(urls, u)
	}
	return urls, nil
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("write response", "err", err)
	}
}
