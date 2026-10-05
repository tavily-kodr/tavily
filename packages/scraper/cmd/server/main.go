// scraper-server runs the scraper as a long-lived HTTP service for the Tavily search API.
// It shares the CLI's engine (fetch pipeline, browser pool, per-domain limiter) and config:
// the same env vars the CLI honours (FAST, CONCURRENCY, TIMEOUT_SEC, …) apply here, plus
//
//	SCRAPER_PORT               listen port                    (default 8081)
//	SCRAPER_MAX_URLS           max URLs accepted per request  (default 20)
//	SCRAPER_BATCH_TIMEOUT_SEC  deadline for a whole request   (default 30)
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"github.com/sujal/go-scraper/internal/api"
	"github.com/sujal/go-scraper/internal/config"
	"github.com/sujal/go-scraper/internal/orchestrator"
)

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo})))

	cfg := config.NewDefault()
	config.MergeWithEnv(&cfg)

	port := envInt("SCRAPER_PORT", 8081)
	maxURLs := envInt("SCRAPER_MAX_URLS", 20)
	batchTimeout := time.Duration(envInt("SCRAPER_BATCH_TIMEOUT_SEC", 30)) * time.Second

	// One orchestrator for the process lifetime: the browser pool stays warm across requests
	orch := orchestrator.New(cfg)
	defer orch.Close()

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", port),
		Handler:           api.New(orch, maxURLs, batchTimeout).Handler(),
		ReadHeaderTimeout: 5 * time.Second,
		// Allow the batch to finish before the server gives up on the response
		WriteTimeout: batchTimeout + 5*time.Second,
	}

	go func() {
		slog.Info("scraper server listening", "addr", srv.Addr, "max_urls", maxURLs,
			"batch_timeout", batchTimeout, "fast_mode", cfg.FastMode, "concurrency", cfg.Concurrency)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("server failed", "err", err)
			os.Exit(1)
		}
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
	<-sig
	slog.Info("shutting down")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		slog.Error("shutdown", "err", err)
	}
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n <= 0 {
		slog.Warn("ignoring invalid env value", "key", key, "value", v, "default", def)
		return def
	}
	return n
}
