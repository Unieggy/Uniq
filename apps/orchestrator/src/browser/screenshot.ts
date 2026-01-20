/**
 * Screenshot capture utilities
 */

import { Page } from 'playwright';

export class ScreenshotManager {
  constructor(private page: Page) {}

  async capture(): Promise<Buffer> {
    const screenshot = await this.page.screenshot({
      fullPage: false, // Viewport only for now
      type: 'png',
    });
    return screenshot as Buffer;
  }

  async captureFullPage(): Promise<Buffer> {
    const screenshot = await this.page.screenshot({
      fullPage: true,
      type: 'png',
    });
    return screenshot as Buffer;
  }

  public setPage(page: import('playwright').Page): void {
    this.page = page;
  }
}

