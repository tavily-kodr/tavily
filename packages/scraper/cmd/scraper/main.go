package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/spf13/cobra"
	"github.com/sujal/go-scraper/internal/cache"
	"github.com/sujal/go-scraper/internal/config"
	"github.com/sujal/go-scraper/internal/fetch"
	"github.com/sujal/go-scraper/internal/orchestrator"
)

var (
	// Flags
	flagConcurrency    int
	flagOutput         string
	flagFormats        string
	flagStealth        bool
	flagFast           bool
	flagDelay          time.Duration
	flagTimeout        time.Duration
	flagUARotate       bool
	flagDepth          int
	flagPages          int
	flagRespectRobots  bool
	flagInclude        string
	flagExclude        string
	flagFollowExternal bool
	flagBrowsers       int
	flagNoDaemon       bool
	flagMaxAge         time.Duration
	flagVerbose        bool

	// _browser-daemon flags
	flagDaemonPort int
	flagDaemonIdle time.Duration
)

const banner = `
   ______            _____                                
  / ____/___        / ___/______________ _____  ___  _____
 / / __/ __ \_______\__ \/ ___/ ___/ __ ` + "`" + `/ __ \/ _ \/ ___/
/ /_/ / /_/ /_____/__/ / /__/ /  / /_/ / /_/ /  __/ /    
\____/\____/     /____/\___/_/   \__,_/ .___/\___/_/     
                                     /_/                 
       ⚡ Firecrawl-Speed Go Web Scraper Engine ⚡
`

func initLogger(verbose bool) {
	level := slog.LevelInfo
	if verbose {
		level = slog.LevelDebug
	}
	handler := slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
	})
	slog.SetDefault(slog.New(handler))
}

func main() {
	initLogger(false)

	rootCmd := &cobra.Command{
		Use:   "go-scraper",
		Short: "High-performance web scraper & crawler built for extreme speed",
		PersistentPreRun: func(cmd *cobra.Command, args []string) {
			initLogger(flagVerbose)
			fmt.Print(banner)
		},
	}
	rootCmd.PersistentFlags().BoolVarP(&flagVerbose, "verbose", "v", false, "Debug logging, including per-phase browser timings")

	// Persistent global flags
	rootCmd.PersistentFlags().IntVarP(&flagConcurrency, "concurrency", "c", 30, "Number of concurrent workers")
	rootCmd.PersistentFlags().StringVarP(&flagOutput, "output", "o", "output", "Output directory")
	rootCmd.PersistentFlags().StringVarP(&flagFormats, "formats", "f", "markdown,json", "Comma-separated output formats: markdown,json,text,html,csv")
	rootCmd.PersistentFlags().BoolVar(&flagStealth, "stealth", true, "Enable stealth browser anti-bot bypass")
	rootCmd.PersistentFlags().BoolVar(&flagFast, "fast", false, "Ultra-fast mode: force pure HTTP engine (skip browser)")
	rootCmd.PersistentFlags().DurationVarP(&flagDelay, "delay", "d", 0, "Delay between requests per domain (default 0s for max speed)")
	rootCmd.PersistentFlags().DurationVarP(&flagTimeout, "timeout", "t", 10*time.Second, "HTTP request timeout")
	rootCmd.PersistentFlags().BoolVar(&flagUARotate, "ua-rotate", true, "Rotate realistic User-Agents")
	rootCmd.PersistentFlags().IntVar(&flagBrowsers, "browsers", 1, "Chrome instances: 1 = the shared background daemon; more adds locally launched instances (8 tabs each)")
	rootCmd.PersistentFlags().BoolVar(&flagNoDaemon, "no-daemon", false, "Launch a private Chrome that exits with this run instead of using the background daemon")
	rootCmd.PersistentFlags().DurationVar(&flagMaxAge, "max-age", 48*time.Hour, "Reuse a cached result if it is younger than this (0 = always fetch fresh)")

	// Crawl-specific flags on rootCmd so subcommands inherit or bind
	rootCmd.PersistentFlags().IntVar(&flagDepth, "depth", 3, "Max BFS crawl depth")
	rootCmd.PersistentFlags().IntVarP(&flagPages, "pages", "p", 50, "Max pages to crawl")
	rootCmd.PersistentFlags().BoolVar(&flagRespectRobots, "respect-robots", true, "Respect robots.txt directives")
	rootCmd.PersistentFlags().StringVar(&flagInclude, "include", "", "Regex pattern: only scrape matching URLs")
	rootCmd.PersistentFlags().StringVar(&flagExclude, "exclude", "", "Regex pattern: skip matching URLs")
	rootCmd.PersistentFlags().BoolVar(&flagFollowExternal, "follow-external", false, "Follow outbound links to other domains")

	buildConfig := func() orchestrator.Orchestrator {
		cfg := config.NewDefault()
		config.MergeWithEnv(&cfg)

		flags := map[string]any{
			"concurrency":     flagConcurrency,
			"output":          flagOutput,
			"formats":         flagFormats,
			"stealth":         flagStealth,
			"fast":            flagFast,
			"delay":           flagDelay,
			"timeout":         flagTimeout,
			"ua-rotate":       flagUARotate,
			"depth":           flagDepth,
			"pages":           flagPages,
			"respect-robots":  flagRespectRobots,
			"include":         flagInclude,
			"exclude":         flagExclude,
			"follow-external": flagFollowExternal,
			"browsers":        flagBrowsers,
			"no-daemon":       flagNoDaemon,
			"max-age":         flagMaxAge,
		}
		config.MergeWithFlags(&cfg, flags)
		return *orchestrator.New(cfg)
	}

	createContext := func() (context.Context, context.CancelFunc) {
		ctx, cancel := context.WithCancel(context.Background())
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, os.Interrupt, syscall.SIGTERM)
		go func() {
			<-sigChan
			slog.Warn("Termination signal received. Shutting down gracefully...")
			cancel()
		}()
		return ctx, cancel
	}

	// 1. scrape command
	scrapeCmd := &cobra.Command{
		Use:   "scrape <url1> [url2...]",
		Short: "Scrape one or more specific URLs",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			orch := buildConfig()
			defer orch.Close()

			ctx, cancel := createContext()
			defer cancel()

			return orch.RunScrape(ctx, args)
		},
	}

	// 2. crawl command
	crawlCmd := &cobra.Command{
		Use:   "crawl <startURL>",
		Short: "BFS crawl a domain starting from startURL",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			orch := buildConfig()
			defer orch.Close()

			ctx, cancel := createContext()
			defer cancel()

			return orch.RunCrawl(ctx, args[0])
		},
	}

	// 3. sitemap command
	sitemapCmd := &cobra.Command{
		Use:   "sitemap <baseURL>",
		Short: "Discover sitemaps for domain and scrape entries",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			orch := buildConfig()
			defer orch.Close()

			ctx, cancel := createContext()
			defer cancel()

			return orch.RunSitemap(ctx, args[0])
		},
	}

	// 4. discover command
	discoverCmd := &cobra.Command{
		Use:   "discover <baseURL>",
		Short: "Discover sitemap URLs without scraping (dry-run)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			orch := buildConfig()
			defer orch.Close()

			ctx, cancel := createContext()
			defer cancel()

			return orch.RunDiscover(ctx, args[0])
		},
	}

	// 5. browser command: manage the shared background Chrome
	browserCmd := &cobra.Command{
		Use:   "browser",
		Short: "Manage the background Chrome daemon (status | stop)",
	}
	browserCmd.AddCommand(
		&cobra.Command{
			Use:   "status",
			Short: "Show whether the background Chrome daemon is running",
			Run: func(cmd *cobra.Command, args []string) {
				if info, ok := fetch.DaemonStatus(); ok {
					fmt.Printf("Browser daemon running: pid %d, port %d, started %s\n", info.PID, info.Port, info.Started.Format(time.RFC3339))
				} else {
					fmt.Println("Browser daemon is not running")
				}
			},
		},
		&cobra.Command{
			Use:   "stop",
			Short: "Stop the background Chrome daemon",
			RunE: func(cmd *cobra.Command, args []string) error {
				if err := fetch.StopDaemon(); err != nil {
					return err
				}
				fmt.Println("Browser daemon stopped")
				return nil
			},
		},
	)

	// 6. cache command
	cacheCmd := &cobra.Command{
		Use:   "cache",
		Short: "Manage the result cache (clear)",
	}
	cacheCmd.AddCommand(&cobra.Command{
		Use:   "clear",
		Short: "Delete all cached scrape results",
		RunE: func(cmd *cobra.Command, args []string) error {
			n, err := cache.Clear()
			if err != nil {
				return err
			}
			fmt.Printf("Removed %d cached results\n", n)
			return nil
		},
	})

	// Hidden: the detached process that owns the shared Chrome (spawned by fetch.ensureDaemon)
	daemonCmd := &cobra.Command{
		Use:    "_browser-daemon",
		Hidden: true,
		// No banner: stdout is the daemon log file
		PersistentPreRun: func(cmd *cobra.Command, args []string) {},
		RunE: func(cmd *cobra.Command, args []string) error {
			return fetch.RunBrowserDaemon(flagDaemonPort, flagDaemonIdle)
		},
	}
	daemonCmd.Flags().IntVar(&flagDaemonPort, "port", 0, "DevTools port for Chrome")
	daemonCmd.Flags().DurationVar(&flagDaemonIdle, "idle", fetch.DefaultDaemonIdle, "Exit after this long with no open pages")

	rootCmd.AddCommand(scrapeCmd, crawlCmd, sitemapCmd, discoverCmd, browserCmd, cacheCmd, daemonCmd)

	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintf(os.Stderr, "Error: %v\n", err)
		os.Exit(1)
	}
}
