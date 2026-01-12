/**
 * Vision-based region detection
 * 
 * V1: Stub implementation that uses DOM heuristics
 * Future: Integrate with vision-capable LLM (GPT-4 Vision, Claude Vision)
 */

import type { Region } from '../shared/types.js';
import { DOMTools } from '../browser/domTools.js';
import { config } from '../config.js';

export class Regionizer {
  constructor(private domTools: DOMTools) {}

  /**
   * Detect regions on the current page
   * 
   * If LLM API key is available, could call vision model here.
   * For now, uses DOM-based heuristics as fallback.
   */
  async detectRegions(): Promise<Region[]> {
    // Check if we have vision model configured
    if (config.vision?.model && (config.llm?.geminiApiKey )) {
      // TODO: Implement real vision model integration
      // For now, fall through to DOM fallback
    }

    // DOM fallback: find clickable elements and inputs
    const clickableRegions = await this.domTools.findClickableRegions();
    const inputRegions = await this.domTools.findInputFields();
    
    return [...clickableRegions, ...inputRegions];
  }

  /**
   * Get observation summary from regions
   */
  getObservationSummary(regions: Region[]): string {
    if (regions.length === 0) {
      return 'No interactive elements detected';
    }

    const clickables = regions.filter(r => r.id.startsWith('link') || r.id.startsWith('button') || r.id.startsWith('role'));
    const inputs = regions.filter(r => r.id.startsWith('input'));

    const parts: string[] = [];
    if (clickables.length > 0) {
      parts.push(`${clickables.length} clickable element${clickables.length > 1 ? 's' : ''}`);
    }
    if (inputs.length > 0) {
      parts.push(`${inputs.length} input field${inputs.length > 1 ? 's' : ''}`);
    }

    return `Found ${parts.join(' and ')}`;
  }
}

