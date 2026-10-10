import { logger } from "@tavily/logger";

/**
 * Headless browser renderer using Playwright for dynamic client-side SPA hydration.
 */
export async function renderWithPlaywright(url: string, timeoutMs = 15000): Promise<string | null> {
  let browser: import("playwright").Browser | null = null;
  try {
    const { chromium } = await import("playwright");

    logger.info("Launching Playwright for SPA dynamic rendering", { url, timeoutMs });

    browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    // Navigate and wait for network idle or DOM load
    await page
      .goto(url, {
        waitUntil: "networkidle",
        timeout: timeoutMs,
      })
      .catch(async () => {
        // If networkidle times out, try domcontentloaded
        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
      });

    // Wait a brief tick for react/vue container hydration
    await page.waitForTimeout(1000);

    const renderedHtml = await page.content();
    logger.info("Playwright rendered DOM successfully", {
      url,
      byteLength: renderedHtml.length,
    });

    return renderedHtml;
  } catch (err: unknown) {
    logger.warn("Playwright dynamic rendering failed or browser unavailable", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}
