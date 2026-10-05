package fetch

// Browser daemon: one headless Chrome kept alive across CLI runs. Launching Chrome and opening a
// cold first tab costs ~900ms per process; connecting to an already-running one costs ~50ms. The
// daemon is this same binary run with the hidden `_browser-daemon` command. It exits on its own
// after an idle period or when Chrome dies.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/chromedp/cdproto/browser"
	"github.com/chromedp/chromedp"
)

const (
	// DefaultDaemonIdle is how long the daemon's Chrome may sit with no open pages before exiting
	DefaultDaemonIdle = 10 * time.Minute

	daemonReadyTimeout = 8 * time.Second
	daemonProbeTimeout = 300 * time.Millisecond
	daemonLogName      = "browser-daemon.log"
)

type daemonInfo struct {
	Port    int       `json:"port"`
	PID     int       `json:"pid"`
	Started time.Time `json:"started"`
}

func daemonDir() string {
	base, err := os.UserCacheDir()
	if err != nil || base == "" {
		base = os.TempDir()
	}
	return filepath.Join(base, "go-scraper")
}

func daemonInfoPath() string { return filepath.Join(daemonDir(), "browser.json") }

func readDaemonInfo() (daemonInfo, bool) {
	var info daemonInfo
	data, err := os.ReadFile(daemonInfoPath())
	if err != nil {
		return info, false
	}
	if err := json.Unmarshal(data, &info); err != nil || info.Port == 0 {
		return info, false
	}
	return info, true
}

func writeDaemonInfo(info daemonInfo) error {
	if err := os.MkdirAll(daemonDir(), 0755); err != nil {
		return err
	}
	data, _ := json.Marshal(info)
	return os.WriteFile(daemonInfoPath(), data, 0644)
}

func daemonURL(port int) string { return fmt.Sprintf("http://127.0.0.1:%d/", port) }

// daemonAlive reports whether a DevTools endpoint answers on port
func daemonAlive(port int) bool {
	c := http.Client{Timeout: daemonProbeTimeout}
	resp, err := c.Get(daemonURL(port) + "json/version")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// daemonBusy reports whether any page other than a blank tab is open in the daemon's Chrome
func daemonBusy(port int) (bool, error) {
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(daemonURL(port) + "json")
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	var targets []struct {
		Type string `json:"type"`
		URL  string `json:"url"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&targets); err != nil {
		return false, err
	}
	for _, t := range targets {
		if t.Type == "page" && t.URL != "about:blank" && t.URL != "" {
			return true, nil
		}
	}
	return false, nil
}

func freePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

// spawnDaemon starts the daemon as a detached process and returns the port it will listen on
func spawnDaemon() (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	port, err := freePort()
	if err != nil {
		return 0, err
	}
	_ = os.MkdirAll(daemonDir(), 0755)
	logFile, _ := os.OpenFile(filepath.Join(daemonDir(), daemonLogName), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)

	cmd := exec.Command(exe, "_browser-daemon", "--port", strconv.Itoa(port), "--idle", DefaultDaemonIdle.String())
	cmd.Stdout = logFile
	cmd.Stderr = logFile
	cmd.SysProcAttr = detachedProcAttr()
	if err := cmd.Start(); err != nil {
		return 0, err
	}
	// The daemon outlives this process: drop the handle instead of waiting on it
	_ = cmd.Process.Release()
	if logFile != nil {
		logFile.Close()
	}
	return port, nil
}

func waitDaemonReady(ctx context.Context, port int) error {
	deadline := time.Now().Add(daemonReadyTimeout)
	for time.Now().Before(deadline) {
		if daemonAlive(port) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return errors.New("browser daemon did not become ready")
}

// ensureDaemon returns the port of a live daemon, starting one if needed. A lock file keeps two
// CLI runs started at the same moment from both spawning a daemon.
func ensureDaemon(ctx context.Context) (int, error) {
	if info, ok := readDaemonInfo(); ok && daemonAlive(info.Port) {
		return info.Port, nil
	}

	_ = os.MkdirAll(daemonDir(), 0755)
	lock := filepath.Join(daemonDir(), "spawn.lock")
	f, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0644)
	if err == nil {
		f.Close()
		defer os.Remove(lock)
		port, err := spawnDaemon()
		if err != nil {
			return 0, err
		}
		return port, waitDaemonReady(ctx, port)
	}

	// Another run is spawning the daemon (or left a stale lock behind)
	if st, err := os.Stat(lock); err == nil && time.Since(st.ModTime()) > 15*time.Second {
		_ = os.Remove(lock)
		return ensureDaemon(ctx)
	}
	deadline := time.Now().Add(daemonReadyTimeout)
	for time.Now().Before(deadline) {
		if info, ok := readDaemonInfo(); ok && daemonAlive(info.Port) {
			return info.Port, nil
		}
		select {
		case <-ctx.Done():
			return 0, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return 0, errors.New("browser daemon did not start")
}

// connectDaemon returns a browser context inside the daemon's Chrome. Cancelling it closes only
// this process's connection and tabs; Chrome keeps running for the next run.
func connectDaemon(ctx context.Context) (context.Context, context.CancelFunc, error) {
	port, err := ensureDaemon(ctx)
	if err != nil {
		return nil, nil, err
	}
	allocCtx, cancelAlloc := chromedp.NewRemoteAllocator(context.Background(), daemonURL(port))
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	if err := chromedp.Run(browserCtx); err != nil {
		cancelBrowser()
		cancelAlloc()
		return nil, nil, fmt.Errorf("connect to browser daemon: %w", err)
	}
	return browserCtx, func() {
		cancelBrowser()
		cancelAlloc()
	}, nil
}

// RunBrowserDaemon is the body of the hidden `_browser-daemon` command: launch Chrome on port,
// publish the info file, and exit once no page has been open for idle (or Chrome dies).
func RunBrowserDaemon(port int, idle time.Duration) error {
	if port <= 0 {
		return errors.New("--port is required")
	}
	if idle <= 0 {
		idle = DefaultDaemonIdle
	}

	opts := append(chromeFlags(), chromedp.Flag("remote-debugging-port", strconv.Itoa(port)))
	allocCtx, cancelAlloc := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancelAlloc()
	browserCtx, cancelBrowser := chromedp.NewContext(allocCtx)
	defer cancelBrowser()
	if err := chromedp.Run(browserCtx); err != nil {
		return fmt.Errorf("launch chrome: %w", err)
	}

	if err := writeDaemonInfo(daemonInfo{Port: port, PID: os.Getpid(), Started: time.Now()}); err != nil {
		return err
	}
	defer os.Remove(daemonInfoPath())
	slog.Info("browser daemon ready", "port", port, "pid", os.Getpid(), "idle_exit", idle)

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM)

	lastActive := time.Now()
	failures := 0
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-sig:
			slog.Info("browser daemon stopping: signal")
			return nil
		case <-browserCtx.Done():
			slog.Info("browser daemon stopping: chrome exited")
			return nil
		case <-ticker.C:
			busy, err := daemonBusy(port)
			if err != nil {
				failures++
				if failures >= 3 {
					return fmt.Errorf("chrome unreachable: %w", err)
				}
				continue
			}
			failures = 0
			if busy {
				lastActive = time.Now()
			} else if time.Since(lastActive) > idle {
				slog.Info("browser daemon stopping: idle")
				return nil
			}
		}
	}
}

// DaemonStatus describes the running daemon, if any
func DaemonStatus() (daemonInfo, bool) {
	info, ok := readDaemonInfo()
	if !ok || !daemonAlive(info.Port) {
		return info, false
	}
	return info, true
}

// StopDaemon asks the daemon's Chrome to close, which makes the daemon exit. Falls back to
// killing the daemon process if Chrome does not go away.
func StopDaemon() error {
	info, ok := readDaemonInfo()
	if !ok {
		return errors.New("browser daemon is not running")
	}
	if !daemonAlive(info.Port) {
		_ = os.Remove(daemonInfoPath())
		return errors.New("browser daemon is not running")
	}

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	allocCtx, cancelAlloc := chromedp.NewRemoteAllocator(ctx, daemonURL(info.Port))
	defer cancelAlloc()
	tabCtx, cancelTab := chromedp.NewContext(allocCtx)
	defer cancelTab()
	_ = chromedp.Run(tabCtx, browser.Close()) // Chrome exits before answering; the error is expected

	for i := 0; i < 30; i++ {
		if !daemonAlive(info.Port) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	if p, err := os.FindProcess(info.PID); err == nil {
		_ = p.Kill()
	}
	_ = os.Remove(daemonInfoPath())
	return nil
}
