/**
 * DOM manipulation tools using Playwright selectors
 */

import { Page,Locator } from 'playwright';
import { randomUUID}  from 'crypto';
import type { Region } from '../shared/types.js';

export interface DOMElement {
  selector: string;
  text?: string;
  role?: string;
  name?: string;
  bbox: { x: number; y: number; width: number; height: number };
}

export class DOMTools {
  constructor(private page: Page) {}
  private elementStore=new Map<String,Locator>();
  /**
   * Scans the page, saves elements to memory, and returns the list to the AI.
   */
  async scanPage(): Promise<Region[]> {
    // 1. Clear old memory. We are looking at a new page state now.
    this.elementStore.clear();
    const regions: Region[] = [];

    // 2. Find all interactive elements (buttons, links, inputs)
    // We use a broad selector to get them in visual order
    const selector = 'button, [role="button"], a[href], input:not([type="hidden"]), textarea, select, [role="link"], [role="checkbox"], [role="radio"]';
    const elements = await this.page.locator(selector).all();

    // 3. Loop through and "Tag" them
    for (const element of elements) {
      if (!await element.isVisible()) continue;

      let bbox = await element.boundingBox();
      if (!bbox || bbox.width < 5 || bbox.height < 5) continue;

      // 3. Get Standard Label
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      let text = (await element.textContent()) || '';
      let label = (await element.getAttribute('aria-label')) || 
                  (await element.getAttribute('name')) || 
                  (await element.getAttribute('placeholder')) || 
                  text;
      
      // 4. IMAGE DETECTION (The Fix)
      if (!label || label.trim().length === 0) {
        const img = element.locator('img').first();
        if (await img.count() > 0) {
          const alt = await img.getAttribute('alt');
          label = alt ? `Image: ${alt}` : "Unlabeled Image";
        }
      }

      // 5. Cleanup
      label = label.replace(/\s+/g, ' ').trim().slice(0, 100);
      
      if (label.length === 0) continue;

      const id = `element-${randomUUID().slice(0, 8)}`;
      this.elementStore.set(id, element);

      regions.push({
        id: id,
        label: label,
        bbox: { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height },
        confidence: 1.0
      });
    }

    return regions;
  }
  
  /**
   * Press a key on a specific region (ensures focus)
   */
  async pressKeyOnRegion(regionId: string, key: string): Promise<void> {
    const element = this.elementStore.get(regionId);
    if (!element) {
      // Fallback to global press if element is gone
      await this.page.keyboard.press(key);
      return;
    }
    await element.press(key);
  }


  /**
   * Click by region ID (DOM fallback)
   */
    async clickByRegionId(regionId: string): Promise<void> {
      const element= this.elementStore.get(regionId);
      if(!element){
        throw new Error(`Stale Element: the element ${regionId} is no longer available`);
      }
      await element.scrollIntoViewIfNeeded();
      await element.click();
    }


  /**
   * Click by role and name (Playwright best practice)
   */
  async clickByRole(role: 'button' | 'link' | 'textbox' | 'checkbox' | 'radio', name: string): Promise<void> {
    await this.page.getByRole(role, { name }).click();
  }

  /**
   * Fill input by role and name
   */
  async fillByRole(role: 'textbox', name: string, value: string): Promise<void> {
    await this.page.getByRole(role, { name }).fill(value);
  }

  /**
   * Fill input by region ID
   */
  async fillByRegionId(regionId: string, value: string): Promise<void> {
    const element = this.elementStore.get(regionId);
    if (!element) {
      throw new Error(`Stale Element: Region ${regionId} not found.`);
    }
    
    await element.scrollIntoViewIfNeeded();
    await element.fill(value);
  }

  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  /**
   * Get page text content for observation
   */
  async getPageText(): Promise<string> {
    return await this.page.textContent('body') || '';
  }

  getUrl(): string {
    return this.page.url();
  }
  async getTitle():Promise<string>{
    return await this.page.title();
  }
  async getPageTextSnippet(maxChars:number=450): Promise<string> {
    const text=(await this.getPageText() || '');
    const normalized=text.toLowerCase().replace(/\s+/g,' ').trim();
    return normalized.slice(0,maxChars);

  }

  async clickSelector(selector: string): Promise<void> {
    await this.page.click(selector);
  }

    /**
   * Fill using a CSS selector string.
   * Useful when an action comes in as selector-based DOM_FILL.
   */
  async fillSelector(selector: string, value: string): Promise<void> {
    await this.page.fill(selector, value);
  }
    /**
   * Wait for the page to reach a certain load state.
   */
  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void> {
    await this.page.waitForLoadState(state);
  }
  // ... inside DOMTools class

  // In src/browser/domTools.ts inside the DOMTools class

  /**
   * HUMAN-LIKE CLICK: Moves mouse to element, hovers, then clicks.
   * Used for VISION_CLICK actions.
   */
  async cursorClick(regionId: string): Promise<void> {
    const element = this.elementStore.get(regionId);
    if (!element) throw new Error(`Stale Element: ${regionId}`);

    // 1. Ensure element is in view so coordinates are correct
    // (Crucial: Playwright's boundingBox is relative to the viewport)
    await element.scrollIntoViewIfNeeded();

    // 2. Get exact coordinates
    const box = await element.boundingBox();
    if (!box) throw new Error(`Element ${regionId} is not visible`);

    // 3. Calculate center point with tiny random variation (more human)
    const x = box.x + (box.width / 2) + (Math.random() * 2 - 1);
    const y = box.y + (box.height / 2) + (Math.random() * 2 - 1);

    // 4. Move the mouse (physics)
    // 'steps: 10' makes it glide rather than teleport
    await this.page.mouse.move(x, y, { steps: 10 });
    
    // 5. Trigger Hover state (important for menus/buttons)
    await element.hover();
    await new Promise(r => setTimeout(r, 100)); // split-second pause

    // 6. Physical Click
    await this.page.mouse.down();
    await new Promise(r => setTimeout(r, 70)); // slight hold
    await this.page.mouse.up();
  }

  /**
   * HUMAN-LIKE FILL: Clicks to focus, clears, then types.
   * Used for VISION_FILL actions.
   */
  async cursorFill(regionId: string, value: string): Promise<void> {
    // 1. Click to focus using our physics method
    await this.cursorClick(regionId);

    // 2. Clear existing text safely
    // (Command+A or Ctrl+A -> Backspace)
    const isMac = process.platform === 'darwin';
    const modifier = isMac ? 'Meta' : 'Control';
    
    await this.page.keyboard.down(modifier);
    await this.page.keyboard.press('a');
    await this.page.keyboard.up(modifier);
    await this.page.keyboard.press('Backspace');
    
    // Short pause after clearing
    await new Promise(r => setTimeout(r, 50));

    // 3. Type character by character with slight delay
    await this.page.keyboard.type(value, { delay: 50 }); 
  }

  /**
   * Wait for the page to stabilize after an action.
   * Uses navigation detection with fallback to networkidle.
   * Replaces hardcoded sleeps throughout the codebase.
   */
  async waitForStability(timeoutMs: number = 5000): Promise<void> {
    try {
      // Race: either a navigation completes, or we settle for networkidle
      await Promise.race([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: timeoutMs })
          .then(() => this.page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {})),
        this.page.waitForLoadState('networkidle', { timeout: timeoutMs }).catch(() => {}),
      ]);
    } catch {
      // If everything times out, the page is likely already stable (no navigation happened).
      // A brief pause covers minor DOM updates like modals or dropdowns.
      await new Promise(r => setTimeout(r, 300));
    }
  }

  /**
   * Scroll the page up or down by a given pixel amount.
   */
  async scroll(direction: 'up' | 'down', amount: number = 600): Promise<void> {
    const delta = direction === 'down' ? amount : -amount;
    await this.page.mouse.wheel(0, delta);
    // Wait briefly for lazy-loaded content to render
    await new Promise(r => setTimeout(r, 400));
  }

  public setPage(page: import('playwright').Page): void {
    this.page = page;
  }


}

