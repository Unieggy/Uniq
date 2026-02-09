/**
 * Agent controller - orchestrates the OBSERVE → DECIDE → ACT → VERIFY loop
 */

import type { Region } from '../shared/types.js';
import type { Action, Decision } from './schemas.js';
import { DecisionSchema} from './schemas.js';
import { Guardrails } from '../policy/guardrails.js';
import { Verifier } from '../verify/verifier.js';
import { DOMTools } from '../browser/domTools.js';
import { Regionizer } from '../vision/regionizer.js';
import { config } from '../config.js';
import { DatabaseManager } from '../storage/db.js';
export class AgentController {
  private stepCount = 0;
  private maxSteps = 50; // Safety limit
  private lastAction: Action | undefined;
  private postFillSubmitTries = 0;
  private consecutiveFailures = 0;
  private lastOutcome: {
    stateChanged: boolean;
    urlBefore: string;
    urlAfter: string;
    titleBefore: string;
    titleAfter: string;
    textBefore: string;
    textAfter: string;
  } | undefined;

  // Auto-scroll state
  private scrollCount = 0;
  private maxAutoScrolls = 5;
  private contentVisible = false;
  private bottomReached = false;
  private lastScrollY = 0;
  private lastScrollHeight = 0;
  private lastUrl = '';

  constructor(
    private domTools: DOMTools,
    private regionizer: Regionizer,
    private guardrails: Guardrails,
    private verifier: Verifier,
    private db:DatabaseManager

  ) {}

  /**
   * Main agent loop: OBSERVE → DECIDE → ACT → VERIFY
   */
  async runLoop(
    sessionId:string,
    task: string,
    onStep: (phase: 'OBSERVE' | 'DECIDE' | 'ACT' | 'VERIFY', message: string, action?: Action) => Promise<void>,
    opts?:{resetStepCount?:boolean}
  ): Promise<{ completed: boolean; reason: string;pendingAction?: Action ;pauseKind?:'ASK_USER'|'CONFIRM' }> {
    const reset = opts?.resetStepCount ?? true;
    if (reset) {
      this.stepCount = 0;
      this.lastAction = undefined;
      this.lastOutcome = undefined;
      this.scrollCount = 0;
      this.contentVisible = false;
      this.bottomReached = false;
      this.lastScrollY = 0;
      this.lastScrollHeight = 0;
      this.consecutiveFailures = 0;
    }

      
    while (this.stepCount < this.maxSteps) {
      this.stepCount++;
      
      // OBSERVE
      await onStep('OBSERVE', `Step ${this.stepCount}: Observing page state`);
      const regions = await this.regionizer.detectRegions();
      const observation = await this.observe(regions);
      await onStep('OBSERVE', observation);

      // ====== URL CHANGE DETECTION: reset scroll state on navigation ======
      const currentUrl = this.domTools.getUrl();
      if (currentUrl !== this.lastUrl) {
        if (this.lastUrl) {
          console.log(`[navigation] New page detected: ${currentUrl}. Resetting scroll state.`);
        }
        this.scrollCount = 0;
        this.contentVisible = false;
        this.bottomReached = false;
        this.lastScrollY = 0;
        this.lastScrollHeight = 0;
        this.consecutiveFailures = 0;
        this.lastUrl = currentUrl;
      }

      // ====== AUTO-RECOVERY: submit after fill if no state change ======
      const lastWasFill =
        this.lastAction?.type === 'VISION_FILL' || this.lastAction?.type === 'DOM_FILL';

      if (lastWasFill && this.lastOutcome && this.lastOutcome.stateChanged === false) {
        let injectedAction: Action;

        // 1st try: press Enter
        if (this.postFillSubmitTries === 0) {
          const targetRegionId=(this.lastAction as any).regionId;
          injectedAction = {
            type: 'KEY_PRESS',
            key: 'Enter',
            regionId:targetRegionId,
            description: 'Auto-submit after fill (Enter)',
          };
        }
        // 2nd try: click a likely Search/Submit button, else Enter again
        else if (this.postFillSubmitTries === 1) {
          const keywords = ['search', 'submit', 'go', 'find'];

          const candidate = regions.find(r => {
            const label = (r.label || '').toLowerCase();
            const clickable =
              r.id.startsWith('button-') ||
              r.id.startsWith('link-') ||
              r.id.startsWith('role-');
            return clickable && keywords.some(k => label.includes(k));
          });

          injectedAction = candidate
            ? {
                type: 'VISION_CLICK',
                regionId: candidate.id,
                description: `Auto-submit after fill (click "${candidate.label}")`,
              }
            : {
                type: 'KEY_PRESS',
                key: 'Enter',
                description: 'Auto-submit after fill (Enter fallback)',
              };
        }
        // 3rd+ try: ask user
        else {
          await onStep(
            'DECIDE',
            'Submission did not trigger after filling. Asking user to submit manually.'
          );
          return {
            completed: false,
            reason:
              'I filled the field but submission didn’t trigger. Please press Enter or click Search/Submit in the browser, then click Continue.',
            pauseKind: 'ASK_USER',
          };
        }

        await onStep(
          'DECIDE',
          `No state change after fill. Auto-recovery attempt ${this.postFillSubmitTries + 1}: ${injectedAction.type}`,
          injectedAction
        );

        const urlBefore = this.domTools.getUrl();
        const titleBefore = await this.domTools.getTitle();
        const textBefore = await this.domTools.getPageTextSnippet(400);

        try {
          await this.act(injectedAction);
          await onStep('ACT', `Executed auto-recovery: ${injectedAction.type}`, injectedAction);
        } catch (error) {
          await onStep(
            'ACT',
            `Auto-recovery failed: ${error instanceof Error ? error.message : String(error)}`
          );

          this.postFillSubmitTries++;

          this.lastAction = injectedAction;
          this.lastOutcome = {
            stateChanged: false,
            urlBefore,
            urlAfter: urlBefore,
            titleBefore,
            titleAfter: titleBefore,
            textBefore,
            textAfter: textBefore,
          };
          continue;
        }

        await this.domTools.waitForStability();

        const urlAfter = this.domTools.getUrl();
        const titleAfter = await this.domTools.getTitle();
        const textAfter = await this.domTools.getPageTextSnippet(400);

        const stateChanged =
          urlBefore !== urlAfter ||
          titleBefore !== titleAfter ||
          textBefore !== textAfter;

        this.lastAction = injectedAction;
        this.lastOutcome = {
          stateChanged,
          urlBefore,
          urlAfter,
          titleBefore,
          titleAfter,
          textBefore,
          textAfter,
        };

        if (stateChanged) this.postFillSubmitTries = 0;
        else this.postFillSubmitTries++;

        // Skip normal DECIDE this loop iteration
        continue;
      }
      // ====== END AUTO-RECOVERY ======

      // ====== AUTO-SCROLL: semantic content-aware scrolling ======
      if (!this.contentVisible && this.scrollCount < this.maxAutoScrolls && !this.bottomReached) {
        const visibleText = await this.domTools.getVisibleText();
        const elementLabels = regions.map(r => r.label).filter(Boolean) as string[];

        const visible = await this.checkSemanticVisibility(task, visibleText, elementLabels);

        if (visible) {
          this.contentVisible = true;
          console.log('[auto-scroll] Semantic check: target content IS visible. Handing off to LLM.');
          // Fall through to DECIDE
        } else {
          // Geometry-based bottom detection: did the scrollbar move? Did the page grow?
          const geoBefore = await this.domTools.getScrollGeometry();

          const scrollYStuck = geoBefore.scrollY === this.lastScrollY;
          const heightStuck = geoBefore.scrollHeight === this.lastScrollHeight;
          const atDocumentBottom = geoBefore.scrollY + geoBefore.viewportHeight >= geoBefore.scrollHeight - 5;

          // Guard: if scrollY is 0 and scrollHeight equals viewport, the page likely
          // uses an inner scroll container (LinkedIn, etc.) or hasn't loaded yet.
          // Don't declare bottom — let the loop scroll and re-check.
          const pageUnscrollable = geoBefore.scrollY === 0 &&
            Math.abs(geoBefore.scrollHeight - geoBefore.viewportHeight) < 10;

          if (this.scrollCount > 0 && scrollYStuck && heightStuck && !pageUnscrollable) {
            // Scroll didn't move AND page didn't grow — truly at bottom
            this.bottomReached = true;
            console.log(`[auto-scroll] Bottom of page reached (scrollY=${geoBefore.scrollY}, height=${geoBefore.scrollHeight}). No more content.`);
          } else if (this.scrollCount > 0 && atDocumentBottom && heightStuck && !pageUnscrollable) {
            // At document bottom and no new content loaded
            this.bottomReached = true;
            console.log(`[auto-scroll] At document bottom (scrollY=${geoBefore.scrollY}, height=${geoBefore.scrollHeight}). No infinite scroll detected.`);
          } else if (pageUnscrollable && this.scrollCount >= this.maxAutoScrolls) {
            // Page never became scrollable after max attempts — give up
            this.bottomReached = true;
            console.log(`[auto-scroll] Page appears unscrollable after ${this.scrollCount} attempts. Handing off to LLM.`);
          } else {
            this.scrollCount++;
            console.log(`[auto-scroll] Semantic check: target NOT visible (${this.scrollCount}/${this.maxAutoScrolls}). Scrolling down...`);
            await onStep('OBSERVE', `Auto-scroll: target content not yet visible (${this.scrollCount}/${this.maxAutoScrolls})`);

            const urlBefore = this.domTools.getUrl();
            const titleBefore = await this.domTools.getTitle();
            const textBefore = await this.domTools.getPageTextSnippet(400);

            await this.domTools.scroll('down', 600);
            await this.domTools.waitForStability();

            // Record geometry AFTER scroll for next iteration's comparison
            const geoAfter = await this.domTools.getScrollGeometry();
            this.lastScrollY = geoAfter.scrollY;
            this.lastScrollHeight = geoAfter.scrollHeight;

            const urlAfter = this.domTools.getUrl();
            const titleAfter = await this.domTools.getTitle();
            const textAfter = await this.domTools.getPageTextSnippet(400);

            this.lastAction = {
              type: 'SCROLL',
              direction: 'down',
              amount: 600,
              description: `Auto-scroll ${this.scrollCount}/${this.maxAutoScrolls}`,
            };
            this.lastOutcome = {
              stateChanged: textBefore !== textAfter || geoAfter.scrollY !== geoBefore.scrollY,
              urlBefore,
              urlAfter,
              titleBefore,
              titleAfter,
              textBefore,
              textAfter,
            };

            continue; // re-observe
          }
        }
      }
      // ====== END AUTO-SCROLL ======

      // DECIDE
      await onStep('DECIDE', `Step ${this.stepCount}: Deciding next action`);
      const decision = await this.decide(sessionId,task, regions, this.stepCount, {
        lastAction: this.lastAction,
        lastOutcome: this.lastOutcome,
      });

      const parsed= DecisionSchema.safeParse(decision);
      if(!parsed.success){
        await onStep('DECIDE', `Decision schema validation failed: ${parsed.error.message}`);
        return {completed:false, reason:`Decision schema validation failed: ${parsed.error.message}`};
      }
      const validatedDecision=parsed.data;
      await onStep('DECIDE', validatedDecision.reasoning, validatedDecision.action );

      // Check if done
      if (validatedDecision.action.type === 'DONE') {
        return { completed: true, reason: validatedDecision.action.reason || 'Task completed' };
      }
      if (validatedDecision.action.type === 'CONFIRM') {
        await onStep('DECIDE', validatedDecision.action.message, validatedDecision.action);
        return { completed: false, reason: validatedDecision.action.message,pauseKind:'CONFIRM' };
      }

      if (validatedDecision.action.type === 'ASK_USER') {
        await onStep('DECIDE', validatedDecision.action.message, validatedDecision.action);
        return { completed: false, reason: validatedDecision.action.message, pauseKind:'ASK_USER' };
      }


      // Check guardrails
      const guardrailCheck = await this.guardrails.checkAction(validatedDecision.action, regions);
      if (!guardrailCheck.allowed) {
        await onStep('DECIDE', `Guardrail blocked: ${guardrailCheck.reason}`);
        
        if (guardrailCheck.requiresConfirmation) {
          
          await onStep('DECIDE', guardrailCheck.reason || 'This action requires confirmation', validatedDecision.action);

          // Pause the loop so orchestrator can wait for user
          return { completed: false, reason: guardrailCheck.reason||'This action requires confirmation', pendingAction: validatedDecision.action, pauseKind:'CONFIRM'  };
        }
        await onStep('ACT', 'Action skipped due to guardrail');
        continue;
      }
      

      // ACT
      await onStep('ACT', `Step ${this.stepCount}: Executing action`);
      const urlBefore = this.domTools.getUrl();
      const titleBefore = await this.domTools.getTitle();
      const textBefore = await this.domTools.getPageTextSnippet(400);
      try {
        await this.act(validatedDecision.action);
        await onStep('ACT', `Executed: ${validatedDecision.action.type}`);
      } catch (error) {
        await onStep('ACT', `Action failed: ${error instanceof Error ? error.message : String(error)}`);
        // Continue to next step
        this.lastAction = validatedDecision.action;
        this.lastOutcome = {
          stateChanged: false,
          urlBefore,
          urlAfter:urlBefore,
          titleBefore,
          titleAfter:titleBefore,
          textBefore,
          textAfter:textBefore,
        };
        continue;
      }

      // VERIFY — wrapped in try-catch because navigation can destroy execution context
      let urlAfter = urlBefore;
      let titleAfter = titleBefore;
      let textAfter = textBefore;
      try {
        await onStep('VERIFY', `Step ${this.stepCount}: Verifying action result`);
        const verification = await this.verifier.verify(validatedDecision.action);
        await onStep('VERIFY', verification.message);

        // Wait for page to stabilize after action (navigation or DOM update)
        await this.domTools.waitForStability();
        urlAfter = this.domTools.getUrl();
        titleAfter = await this.domTools.getTitle();
        textAfter = await this.domTools.getPageTextSnippet(400);
      } catch (navError) {
        // Execution context destroyed by navigation — this is expected for link clicks.
        // Treat as a successful state change; the next loop iteration will re-observe.
        console.log(`[agent] Post-action context destroyed (navigation in progress). Continuing.`);
        urlAfter = this.domTools.getUrl();
      }

      const stateChanged =
        urlBefore !== urlAfter ||
        titleBefore !== titleAfter ||
        textBefore !== textAfter;

      // Store feedback for next DECIDE
      this.lastAction = validatedDecision.action;
      this.lastOutcome = {
        stateChanged,
        urlBefore,
        urlAfter,
        titleBefore,
        titleAfter,
        textBefore,
        textAfter,
      };
    }

    return { completed: false, reason: 'Max steps reached'};
  }

  private async observe(regions: Region[]): Promise<string> {
    const pageText = await this.domTools.getPageText();
    const url = this.domTools.getUrl();

    
    return `Page: ${url}, ${regions.length} interactive regions detected, ${pageText.length} characters of text`;
  }

  /**
   * Decide next action based on task and current state
   */
  private async decide(sessionId:string,task: string, regions: Region[], step: number,feedback?:{
    lastAction?: Action;
    lastOutcome?:{
      stateChanged: boolean;
      urlBefore: string;
      urlAfter: string;
      titleBefore: string;
      titleAfter: string;
      textBefore: string;
      textAfter: string;
    };
  }): Promise<Decision> {
    const llmDecision=await this.tryGeminiDecision(sessionId,task, regions, step,feedback);
    if(llmDecision){
      this.consecutiveFailures = 0; // Valid LLM decision resets failure counter
      console.log('Gemini decision:', llmDecision.action.type, llmDecision.action);
      return llmDecision;
    }
    console.log('[agent] Gemini decision: null (falling back to heuristics)');
    if (task.toLowerCase().includes('click') && task.toLowerCase().includes('first link')) {
      const links = regions.filter(r => r.id.startsWith('link-'));
      if (links.length > 0) {
        return {
          action: {
            type: 'VISION_CLICK',
            regionId: links[0].id,
            description: 'Click first link as requested',
          },
          reasoning: `Found ${links.length} link(s), clicking the first one`,
          confidence: 0.8,
        };
      }
    }

    // If task mentions "click link" or "click button", try to find matching label
    if (task.toLowerCase().includes('click')) {
      const clickables = regions.filter(r => 
        r.id.startsWith('link-') || r.id.startsWith('button-') || r.id.startsWith('role-')
      );
      
      // Try to match task text with region labels
      const taskLower = task.toLowerCase();
      for (const region of clickables) {
        if (region.label && taskLower.includes(region.label.toLowerCase())) {
          return {
            action: {
              type: 'VISION_CLICK',
              regionId: region.id,
              description: `Click "${region.label}" as requested`,
            },
            reasoning: `Found matching element: ${region.label}`,
            confidence: 0.7,
          };
        }
      }

      // Fallback: click first clickable
      if (clickables.length > 0) {
        return {
          action: {
            type: 'VISION_CLICK',
            regionId: clickables[0].id,
            description: 'Click first available element',
          },
          reasoning: `Clicking first clickable element: ${clickables[0].label}`,
          confidence: 0.5,
        };
      }
    }

    // Check if the current step is likely already accomplished
    // Extract step objective and see if URL/page state matches
    const stepMatch = task.match(/CURRENT STEP:\s*(.+?)(?:\n|$)/i);
    const stepObjective = stepMatch ? stepMatch[1].trim().toLowerCase() : '';
    const currentUrl = this.domTools.getUrl().toLowerCase();

    if (stepObjective) {
      const alreadyDone =
        // "navigate to X" but we're already on X
        (stepObjective.includes('navigate to') && (
          (stepObjective.includes('youtube') && currentUrl.includes('youtube.com')) ||
          (stepObjective.includes('linkedin') && currentUrl.includes('linkedin.com')) ||
          (stepObjective.includes('google') && currentUrl.includes('google.com'))
        )) ||
        // "search for X" / "initiate search" but URL already has search results
        ((stepObjective.includes('search') || stepObjective.includes('initiate')) &&
          (currentUrl.includes('search') || currentUrl.includes('results') || currentUrl.includes('?q=') || currentUrl.includes('query=')));

      if (alreadyDone) {
        console.log(`[agent] Step "${stepObjective}" appears already accomplished (URL: ${currentUrl}). Skipping to DONE.`);
        this.consecutiveFailures = 0;
        return {
          action: { type: 'DONE', reason: `Step already accomplished: ${stepObjective}` },
          reasoning: `The current page URL indicates this step is already done. Advancing to next objective.`,
          confidence: 0.6,
        };
      }
    }

    // Graduated fallback: scroll → wait → DONE
    if (this.consecutiveFailures < 1) {
      this.consecutiveFailures++;
      return {
        action: { type: 'SCROLL', direction: 'down', description: 'LLM returned no action. Scrolling to reveal more content.' },
        reasoning: 'LLM returned no action. Scrolling to reveal more content.',
        confidence: 0.4,
      };
    }
    if (this.consecutiveFailures < 2) {
      this.consecutiveFailures++;
      return {
        action: { type: 'WAIT', duration: 2000, description: 'Retrying after wait for page to render.' },
        reasoning: 'Retrying after wait for page to render.',
        confidence: 0.3,
      };
    }
    this.consecutiveFailures = 0;
    return {
      action: {
        type: 'DONE',
        reason: 'No matching action found for task',
      },
      reasoning: 'Could not determine appropriate action after retries',
      confidence: 0.3,
    };
  }
  private async checkSemanticVisibility(
    task: string,
    visibleText: string,
    interactiveElements: string[],
  ): Promise<boolean> {
    const apiKey = config.llm?.geminiApiKey;
    if (!apiKey) return true; // No key → skip auto-scroll, let main LLM decide

    // Extract the current step for a focused check
    const stepMatch = task.match(/CURRENT STEP:\s*(.+?)(?:\n|$)/i);
    const objective = stepMatch ? stepMatch[1].trim() : task.slice(0, 200);

    const truncatedText = visibleText.slice(0, 2000);
    const elementsStr = interactiveElements.slice(0, 30).join(', ');

    const prompt = `You are checking whether a webpage currently shows content relevant to a task.

TASK OBJECTIVE: ${objective}

VISIBLE PAGE TEXT (truncated):
${truncatedText}

CLICKABLE ELEMENTS ON PAGE:
${elementsStr}

Does this page currently show content, links, or interactive elements that are semantically relevant to the task objective? Think broadly:
- Synonyms count (e.g., "Dining" is relevant for "Food", "Catalog" is relevant for "Classes")
- Navigation links or buttons that would lead to the target content count as relevant
- Section headers or menu items related to the objective count as relevant
- If the page is a search engine results page with links to explore, that IS relevant

Respond with ONLY the word "YES" or "NO".`.trim();

    try {
      const model = 'gemini-2.0-flash-lite';
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 8 },
        }),
      });

      if (!res.ok) {
        console.warn(`[auto-scroll] Semantic check failed (${res.status}), skipping auto-scroll.`);
        return true; // On failure, skip auto-scroll
      }

      const json = (await res.json()) as any;
      const answer: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!answer) return true;

      const result = answer.trim().toUpperCase().startsWith('YES');
      console.log(`[auto-scroll] Semantic visibility check: ${result ? 'YES' : 'NO'} (objective: "${objective.slice(0, 60)}")`);
      return result;
    } catch (err) {
      console.warn('[auto-scroll] Semantic check error:', err);
      return true; // On error, skip auto-scroll
    }
  }

  private extractFirstJsonObject(text: string): string | null{
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return text.slice(start, end + 1);
    }
    return null;
  }
  private async tryGeminiDecision(sessionId:string,task: string, regions: Region[], step: number,feedback?:{
    lastAction?: Action;
    lastOutcome?:{
      stateChanged: boolean;
      urlBefore: string;
      urlAfter: string;
      titleBefore: string;
      titleAfter: string;
      textBefore: string;
      textAfter: string;
    };
  }): Promise<Decision | null> {
    const apiKey=config.llm?.geminiApiKey;
    if (!apiKey){ 
      console.error('Gemini API key not configured');
      return null;}
    const recentHistory=this.db.getRecentHistory(sessionId,5)
    const historyText = recentHistory.length > 0 
      ? recentHistory.map(h => 
          `- Step ${h.step_number}: Tried ${h.action_type} on ${h.action_data?.regionId || 'unknown'}. Result: ${h.error ? 'Failed' : 'Executed'}`
        ).join('\n')
      : "(No history yet)";
    const regionchoices=regions.slice(0,40).map(r=>({id:r.id, role:r.role, label:r.label, ...(r.href ? {href:r.href} : {})}));
    const url=this.domTools.getUrl();
    const pageText=await this.domTools.getVisibleText();
    const pageTextSnippet=pageText.slice(0,4000); // Increased from 1500 to capture more content on large pages
    const prompt=`
You are controlling a local browser agent.

TASK:
${task}

STEP:
${step}

CURRENT URL:
${url}

SHORT-TERM MEMORY (Last 5 Actions):
${historyText}

PAGE TEXT (truncated):
${pageTextSnippet}

LAST STEP FEEDBACK (if any):
${JSON.stringify(
  feedback?.lastOutcome
    ? {
        lastAction: feedback.lastAction,
        lastOutcome: {
          stateChanged: feedback.lastOutcome.stateChanged,
          urlBefore: feedback.lastOutcome.urlBefore,
          urlAfter: feedback.lastOutcome.urlAfter,
          titleBefore: feedback.lastOutcome.titleBefore,
          titleAfter: feedback.lastOutcome.titleAfter,
        },
      }
    : { lastAction: feedback?.lastAction, lastOutcome: undefined },
  null,
  2
)}

SCROLL STATUS:
Auto-scrolled ${this.scrollCount} time(s) on this page. Target content is ${this.contentVisible ? 'VISIBLE' : 'NOT YET VISIBLE'}.${this.bottomReached ? '\nBottom of page reached — no more content below.' : ''}${this.scrollCount >= this.maxAutoScrolls ? '\nMax auto-scrolls reached.' : ''}

INTERACTIVE REGIONS (choose by id):
${JSON.stringify(regionchoices, null, 2)}

BEFORE choosing an action, you MUST perform a SITUATION ANALYSIS in your reasoning:

1. **WHERE AM I?** — Look at the CURRENT URL and PAGE TEXT. What kind of page is this? (search results, a profile page, an article, a homepage, a settings page, etc.)

2. **HOW DID I GET HERE?** — Look at SHORT-TERM MEMORY. What actions brought me to this page? If I navigated to a specific profile/page to find content, I should stay here and explore it.

3. **DOES THE STEP MAKE SENSE HERE?** — Read the CURRENT STEP literally vs. what this page actually offers:
   - If the step says "Search for X" but I'm already on a specific profile/page that likely contains X → **SCROLL to find it** instead of using a global search bar (which would navigate AWAY from this page I spent effort reaching).
   - If the step says "Find X" and I'm on a content page → SCROLL first, don't search.
   - If I'm on a search engine or homepage → then using a search bar makes sense.
   - **KEY QUESTION**: "Would clicking this element LEAVE the page I worked hard to reach?" If yes, think twice.

Your "reasoning" field MUST include this analysis (1-2 sentences). Then choose the action.

You MUST respond with ONLY valid JSON (no backticks, no extra text) matching this TypeScript shape:

{
  "action": { "type": "...", ... },
  "reasoning": string,
  "confidence": 0-1.0
}
INTELLIGENT RULES (READ CAREFULLY):
1. **CHECK IF DONE FIRST**: Before choosing an action, check if the "Current Step" is ALREADY accomplished.
   - **Google Images**: If the URL contains "udm=2" or "tbm=isch", you are ALREADY on the Images tab. DO NOT click "Images" again. Return "DONE".
   - **Tabs**: If the button for the target tab is disabled or highlighted, you are likely already there.
   
2. **SELF-CORRECTION**: 
   - Look at your HISTORY. Did you just try to "Click Images" and the URL is now different? If yes, assume it worked and move on.
   - If an action failed (Timeout/Not Enabled), it means the element is not interactive (likely because it's the active tab). Stop clicking it.

3. **USE THE ID**: Always pick the element ID (e.g., "element-123") from the list below.

Allowed action types:
1. **VISION_CLICK** / **DOM_CLICK**:
   - MUST include "regionId".
   - Example: { "type": "VISION_CLICK", "regionId": "element-123" }

2. **VISION_FILL** / **DOM_FILL**:
   - MUST include "regionId" AND "value".
   - The "value" MUST come from the TASK, CURRENT STEP, or GUIDANCE text. NEVER invent or guess fill values.
   - Example: { "type": "VISION_FILL", "regionId": "element-123", "value": "exact text from task" }
3. WAIT: { "type":"WAIT", "duration"?: number, "until"?: string, "description"?: string }
4. ASK_USER: { "type":"ASK_USER", "message": string, "actionId"?: string }
5. CONFIRM: { "type":"CONFIRM", "message": string, "actionId"?: string }
6. DONE: { "type":"DONE", "reason"?: string }
7. **SCROLL**: { "type":"SCROLL", "direction": "up" | "down", "amount"?: number, "description"?: string }
   - Scrolls the page. Default amount is 600px (~one viewport).
   - **NOTE**: The system has an auto-scroll feature that scrolls BEFORE you are called. Check the SCROLL STATUS section above.
   - If SCROLL STATUS says "Target content is VISIBLE", the content you need is already on screen — work with it.
   - If SCROLL STATUS says "Bottom of page reached", there is no more content below — do NOT scroll down further.
   - Only use SCROLL manually if you need to scroll UP, or if you need to see specific content the auto-scroll missed.

8. KEY_PRESS: { "type":"KEY_PRESS", "key": string, "regionId"?: string, "description"?: string }

IMPORTANT:
- **FILL VALUES**: Only use text that is explicitly stated in the TASK or CURRENT STEP. If the step says "Search for OpenAI demos", the fill value is "OpenAI demos". If the step does NOT mention what to type, do NOT fill anything — return ASK_USER instead.
- The initial page starts as unsigned-in. So if the task involves personal data, accounts, or payments..etc you must first sign in.
- If this page requires credentials, login, payment, or MFA, return ASK_USER with a clear message telling the human what to do, and do NOT attempt to fill passwords.
- If you are unsure, return ASK_USER instead of guessing.
- Never repeat the exact same action if lastOutcome.stateChanged is false.
- For example, If you filled an input and stateChanged is false, try a different strategy (e.g. KEY_PRESS "Enter" or click a search/submit button) instead of filling again.
- Never use null. If a field is not needed, omit it entirely.
- If no button exists, use KEY_PRESS "Enter" with the 'regionId' of the input field you just filled.
- Review "SHORT-TERM MEMORY". If you see you just performed an action (like clicking a tab) and the URL hasn't changed, DO NOT repeat it. Try a different strategy (e.g. DOM_CLICK instead of VISION, or KEY_PRESS).
- **STAY ON TASK**: Only perform actions described in the CURRENT STEP. Do not jump ahead to future steps in the plan.

DEFINITION OF DONE (Critical):
- You are NOT done until you have extracted the ACTUAL CONTENT requested by the task.
- A list of Google search results is NOT the answer. You must click into relevant pages and read the content.
- If the task asks to "find", "research", "compare", or "recommend" something, you MUST visit multiple sources and read their content before returning DONE.
- Only return DONE when you have gathered enough information to synthesize a real answer.
`.trim();
    try {
      const model='gemini-2.5-flash'; // Example model name
      const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res=await fetch(endpoint,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          contents:[
            {role:"user",parts:[{text:prompt}]},
          ],
          generationConfig:{
            temperature:0.2,
          },
        }),
      });
      if(!res.ok){
        const text=await res.text();
        console.warn(`Gemini request failed (${res.status}): ${text}`);
        if (step===1) {
          return{
            action:{type:'ASK_USER', message: `Gemini request failed (HTTP ${res.status}). Check orchestrator console for the response body.`,actionId:'gemini_fail-1'},
            reasoning:'Gemini API request failed',
            confidence:0.0,

          };

      }
        return null;
    }
      const json=(await res.json()) as any;
      const text:string|undefined=
        json?.candidates?.[0]?.content?.parts?.[0]?.text;
      if(!text){
        console.warn('Gemini response missing text');
        return null;
      }
      const cleaned=this.extractFirstJsonObject(text);
      if(!cleaned){
        console.warn('Gemini response JSON extraction failed');
        return null;
      }
      const parsed=JSON.parse(cleaned);

      // Auto-patch missing optional-ish fields before validation
      if (parsed.action && typeof parsed.confidence === 'undefined') {
        parsed.confidence = 0.5;
        console.log('[agent] Auto-patched missing confidence field with default 0.5');
      }
      if (parsed.action && typeof parsed.reasoning === 'undefined') {
        parsed.reasoning = '(no reasoning provided)';
        console.log('[agent] Auto-patched missing reasoning field');
      }

      const validated=DecisionSchema.safeParse(parsed);
      if(!validated.success){
        console.warn(`Gemini DecisionSchema validation failed: ${validated.error.message}`);
        return null;
      }
      return validated.data;

    }catch(err){
      console.warn('Gemini decision error:', err);
      return null;
    }

  }
  public async executeAction(action: Action): Promise<void> {
    await this.act(action);
  }
  /**
   * Execute an action
   */
  /**
   * Execute an action
   */
  private async act(action: Action): Promise<void> {
    switch (action.type) {
      // --- 1. HUMAN-LIKE ACTIONS (Physics) ---
      // The agent chose "VISION", so we use the cursor physics we just added.
      case 'VISION_CLICK':
        await this.domTools.cursorClick(action.regionId);
        break;

      case 'VISION_FILL':
        await this.domTools.cursorFill(action.regionId, action.value);
        break;

      // --- 2. INSTANT ACTIONS (Fallback) ---
      // The agent chose "DOM", so we use instant execution.
      // This now supports RegionID (if vision failed) OR Selectors (if regions aren't working)
      case 'DOM_CLICK':
        if (action.regionId) {
          await this.domTools.clickByRegionId(action.regionId);
        } else if (action.role && action.name) {
          await this.domTools.clickByRole(action.role, action.name);
        } else if (action.selector) {
          await this.domTools.clickSelector(action.selector);
        } else {
          throw new Error('DOM_CLICK requires regionId, role+name, or selector');
        }
        break;

      case 'DOM_FILL':
        if (action.regionId) {
          await this.domTools.fillByRegionId(action.regionId, action.value);
        } else if (action.role && action.name) {
          await this.domTools.fillByRole(action.role, action.name, action.value);
        } else if (action.selector) {
          await this.domTools.fillSelector(action.selector, action.value);
        } else {
          throw new Error('DOM_FILL requires regionId, role+name, or selector');
        }
        break;

      // --- 3. UTILITIES (Unchanged) ---
      case 'KEY_PRESS':
        if(action.regionId){
          await this.domTools.pressKeyOnRegion(action.regionId, action.key);
        }else{
          await this.domTools.pressKey(action.key);
        }
        break;
  
      case 'WAIT':
        if (action.duration) {
          await new Promise(resolve => setTimeout(resolve, action.duration));
        } else if (action.until) {
          await this.domTools.waitForLoadState(action.until as 'load' | 'domcontentloaded' | 'networkidle');
        } else {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        break;

      case 'ASK_USER':
      case 'CONFIRM':
        // These are handled by the orchestrator, not here
        throw new Error('ASK_USER and CONFIRM actions must be handled by orchestrator');

      case 'SCROLL':
        await this.domTools.scroll(action.direction, action.amount ?? 600);
        break;

      case 'DONE':
        // No action needed
        break;

      default:
        throw new Error(`Unknown action type: ${(action as any).type}`);
    }
  }
  
}

