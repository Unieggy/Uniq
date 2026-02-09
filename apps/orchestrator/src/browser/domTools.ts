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
  async scanPage(isRetry = false): Promise<Region[]> {
    // 1. Clear old memory. We are looking at a new page state now.
    this.elementStore.clear();
    const regions: Region[] = [];

    // 2. Find all interactive elements (buttons, links, inputs)
    // We use a broad selector to get them in visual order
    const selector = 'button, [role="button"], a[href], input:not([type="hidden"]), textarea, select, [role="link"], [role="checkbox"], [role="radio"]';
    const elements = await this.page.locator(selector).all();

    // 3. Loop through and "Tag" them
    const seenHrefs = new Set<string>(); // Deduplicate links with same href
    for (const element of elements) {
      if (!await element.isVisible()) continue;

      let bbox = await element.boundingBox();
      if (!bbox || bbox.width < 5 || bbox.height < 5) continue;

      // 3a. Bubble-up: if this is an inert child (img, div, span), find parent <a> or <button>
      let target = element;
      let targetTag = await element.evaluate(el => el.tagName.toLowerCase());
      if (targetTag === 'img' || targetTag === 'div' || targetTag === 'span' || targetTag === 'svg') {
        const parentAnchor = await element.evaluate(el => {
          let node = el.parentElement;
          for (let i = 0; i < 3 && node; i++) {
            const tag = node.tagName.toLowerCase();
            if (tag === 'a' || tag === 'button') return true;
            node = node.parentElement;
          }
          return false;
        });
        if (parentAnchor) {
          // Use the parent anchor/button as our target instead
          const parent = element.locator('xpath=ancestor::a[1] | ancestor::button[1]').first();
          if (await parent.count() > 0) {
            target = parent;
            targetTag = await target.evaluate(el => el.tagName.toLowerCase());
            bbox = await target.boundingBox() || bbox;
          }
        }
      }

      // 3b. Get Standard Label
      let text = (await target.textContent()) || '';
      let label = (await target.getAttribute('aria-label')) ||
                  (await target.getAttribute('name')) ||
                  (await target.getAttribute('placeholder')) ||
                  text;

      // 4. IMAGE DETECTION: if still no label, check for child <img> alt text
      if (!label || label.trim().length === 0) {
        const img = target.locator('img').first();
        if (await img.count() > 0) {
          const alt = await img.getAttribute('alt');
          label = alt ? `Image: ${alt}` : "Unlabeled Image";
        }
      }

      // 5. Cleanup
      label = label.replace(/\s+/g, ' ').trim().slice(0, 100);

      if (label.length === 0) continue;

      // Extract href for link elements
      const href = await target.getAttribute('href');

      // Deduplicate: skip if we already registered a region with the same href
      if (href) {
        if (seenHrefs.has(href)) continue;
        seenHrefs.add(href);
      }

      // Derive semantic role from tag and aria attributes
      const ariaRole = await target.getAttribute('role');
      const regionRole = this.deriveRole(targetTag, ariaRole);

      const id = `element-${randomUUID().slice(0, 8)}`;
      this.elementStore.set(id, target);

      regions.push({
        id: id,
        label: label,
        role: regionRole,
        bbox: { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height },
        confidence: 1.0,
        ...(href ? { href } : {}),
      });
    }

    // 6. Fallback: if very few regions found, sweep for cursor:pointer elements
    if (regions.length < 5) {
      console.log(`[scanPage] Only ${regions.length} regions from selectors. Running cursor:pointer fallback...`);
      const pointerElements = await this.page.evaluate(`
        (() => {
          const results = [];
          const seen = new Set();
          const all = document.querySelectorAll('*');
          for (const el of all) {
            if (seen.has(el)) continue;
            const style = window.getComputedStyle(el);
            if (style.cursor !== 'pointer') continue;
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) continue;
            if (rect.top > window.innerHeight || rect.bottom < 0) continue;
            let skip = false;
            let parent = el.parentElement;
            while (parent) {
              if (seen.has(parent)) { skip = true; break; }
              parent = parent.parentElement;
            }
            if (skip) continue;
            seen.add(el);
            const tag = el.tagName.toLowerCase();
            const ariaLabel = el.getAttribute('aria-label') || '';
            const text = (el.innerText || '').slice(0, 100).trim();
            const href = el.getAttribute('href') || (el.closest('a') ? el.closest('a').href : '') || '';
            results.push({ tag, text, ariaLabel, href, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } });
            if (results.length >= 40) break;
          }
          return results;
        })()
      `) as { tag: string; text: string; ariaLabel: string; href: string; rect: { x: number; y: number; w: number; h: number } }[];

      for (const pe of pointerElements) {
        const label = (pe.ariaLabel || pe.text || `Clickable ${pe.tag}`).replace(/\s+/g, ' ').trim().slice(0, 100);
        if (!label || label.length === 0) continue;
        if (pe.href && seenHrefs.has(pe.href)) continue;
        if (pe.href) seenHrefs.add(pe.href);

        const id = `element-${randomUUID().slice(0, 8)}`;
        // Build a locator from the element's text or position
        const searchText = pe.text.slice(0, 40).replace(/"/g, '\\"');
        const locator = searchText.length > 2
          ? this.page.locator(`${pe.tag}:visible`).filter({ hasText: searchText }).first()
          : this.page.locator(`${pe.tag}[aria-label="${pe.ariaLabel.replace(/"/g, '\\"')}"]`).first();
        this.elementStore.set(id, locator);

        regions.push({
          id,
          label,
          role: this.deriveRole(pe.tag, null),
          bbox: pe.rect,
          confidence: 0.7,
          ...(pe.href ? { href: pe.href } : {}),
        });
      }
      console.log(`[scanPage] cursor:pointer fallback added ${pointerElements.length} elements. Total: ${regions.length}`);
    }

    // 7. SPA retry: if 0 regions on a real page, wait for network idle + extra time, then retry once
    if (regions.length === 0 && !isRetry) {
      const url = this.page.url();
      const isRealPage = url && !url.startsWith('about:') && url !== 'chrome://newtab/';
      if (isRealPage) {
        console.log('[scanPage] 0 regions on a real page. Waiting for network idle + 3s for SPA hydration...');
        await this.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        return this.scanPage(true);
      }
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
   * Get ALL text content (includes hidden/script text).
   * Use getVisibleText() for LLM-facing content.
   */
  async getPageText(): Promise<string> {
    return await this.page.textContent('body') || '';
  }

  /**
   * Get only visually rendered text (strips <script>, JSON blobs, hidden divs).
   * Uses innerText which respects CSS visibility — essential for SPAs like Instagram.
   */
  async getVisibleText(): Promise<string> {
    // Runs in browser context — document/window are available at runtime
    return await this.page.evaluate('document.body.innerText || ""') as string;
  }

  /**
   * Returns scroll geometry for bottom/stuck detection.
   * scrollY: how far down we've scrolled
   * scrollHeight: total document height (grows on infinite scroll)
   * viewportHeight: visible area height
   */
  async getScrollGeometry(): Promise<{ scrollY: number; scrollHeight: number; viewportHeight: number }> {
    return await this.page.evaluate('({ scrollY: window.scrollY, scrollHeight: document.body.scrollHeight, viewportHeight: window.innerHeight })') as { scrollY: number; scrollHeight: number; viewportHeight: number };
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

  private deriveRole(tag: string, ariaRole: string | null): Region['role'] {
    const t = tag.toLowerCase();
    if (t === 'a') return 'link';
    if (t === 'button') return 'button';
    if (t === 'textarea') return 'textarea';
    if (t === 'select') return 'select';
    if (t === 'input') return 'input';
    // Check aria role overrides
    const r = (ariaRole || '').toLowerCase();
    if (r === 'link') return 'link';
    if (r === 'button') return 'button';
    if (r === 'checkbox') return 'checkbox';
    if (r === 'radio') return 'radio';
    return 'other';
  }

  public setPage(page: import('playwright').Page): void {
    this.page = page;
  }


}

