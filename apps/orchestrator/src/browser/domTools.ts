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
      if (!await element.isVisible()) continue; // Skip invisible stuff

      const bbox = await element.boundingBox();
      if (!bbox || bbox.width < 5 || bbox.height < 5) continue; // Skip tiny/broken stuff

      // Generate a UNIQUE ID (This is the fix!)
      // Example: "element-a1b2-c3d4"
      const id = `element-${randomUUID().slice(0, 8)}`;

      // Save the ACTUAL browser element to our memory map
      this.elementStore.set(id, element);

      // Get a label for the AI
      const tagName = await element.evaluate(el => el.tagName.toLowerCase());
      const text = (await element.textContent()) || '';
      const label = (await element.getAttribute('aria-label')) || 
                    (await element.getAttribute('name')) || 
                    (await element.getAttribute('placeholder')) || 
                    text;

      regions.push({
        id: id, // We send this ID to the AI
        label: (label || tagName).trim().slice(0, 50),
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


}

