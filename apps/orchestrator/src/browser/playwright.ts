/**
 * Playwright browser controller
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { config } from '../config.js';

export class BrowserController {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  public page: Page | null = null;

  async launch(): Promise<void> {
    this.browser = await chromium.launch({
      headless: config.browser.headless,
    });

    this.context = await this.browser.newContext({
      viewport: {
        width: config.browser.width,
        height: config.browser.height,
      },
    });

    this.page = await this.context.newPage();
  }

  async navigate(url: string): Promise<void> {
    if (!this.page) {
      throw new Error('Browser not launched');
    }
    await this.page.goto(url, { waitUntil: 'networkidle' });
  }

  async close(): Promise<void> {
    if (this.context) {
      await this.context.close();
    }
    if (this.browser) {
      await this.browser.close();
    }
    this.page = null;
    this.context = null;
    this.browser = null;
  }

  getCurrentUrl(): string {
    if (!this.page) {
      throw new Error('Browser not launched');
    }
    return this.page.url();
  }

  getTitle(): Promise<string> {
    if (!this.page) {
      throw new Error('Browser not launched');
    }
    return this.page.title();
  }
  public getAllPages(): import('playwright').Page[] {
    return this.context?.pages() || [];
  }
  public setPage(page: import('playwright').Page): void {
    this.page = page;
  }
}

