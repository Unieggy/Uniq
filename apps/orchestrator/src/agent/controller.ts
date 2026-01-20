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
import {config} from '../config.js';
import { text } from 'stream/consumers';
import { tr } from 'zod/v4/locales';
import { DatabaseManager }  from '../storage/db.js';
import { url } from 'inspector';
export class AgentController {
  private stepCount = 0;
  private maxSteps = 50; // Safety limit
  private lastAction: Action | undefined;
  private postFillSubmitTries = 0;
  private lastOutcome: {
    stateChanged: boolean;
    urlBefore: string;
    urlAfter: string;
    titleBefore: string;
    titleAfter: string;
    textBefore: string;
    textAfter: string;
  } | undefined;

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
    }

      
    while (this.stepCount < this.maxSteps) {
      this.stepCount++;
      
      // OBSERVE
      await onStep('OBSERVE', `Step ${this.stepCount}: Observing page state`);
      const regions = await this.regionizer.detectRegions();
      const observation = await this.observe(regions);
      await onStep('OBSERVE', observation);
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

        await new Promise(resolve => setTimeout(resolve, 1000));

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

      // VERIFY
      await onStep('VERIFY', `Step ${this.stepCount}: Verifying action result`);
      const verification = await this.verifier.verify(validatedDecision.action);
      await onStep('VERIFY', verification.message);

      // Wait a bit for page to settle
      await new Promise(resolve => setTimeout(resolve, 1000));
      const urlAfter = this.domTools.getUrl();
      const titleAfter = await this.domTools.getTitle();
      const textAfter = await this.domTools.getPageTextSnippet(400);

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

    // Default: done (no action found)
    return {
      action: {
        type: 'DONE',
        reason: 'No matching action found for task',
      },
      reasoning: 'Could not determine appropriate action',
      confidence: 0.3,
    };
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
    const regionchoices=regions.slice(0,40).map(r=>({id:r.id, label:r.label}));
    const url=this.domTools.getUrl();
    const pageText=await this.domTools.getPageText();
    const pageTextSnippet=pageText.slice(0,1500); // Limit to first 1500 chars
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

INTERACTIVE REGIONS (choose by id):
${JSON.stringify(regionchoices, null, 2)}

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
   - Example: { "type": "VISION_FILL", "regionId": "element-123", "value": "search term" }
3. WAIT: { "type":"WAIT", "duration"?: number, "until"?: string, "description"?: string }
4. ASK_USER: { "type":"ASK_USER", "message": string, "actionId"?: string }
5. CONFIRM: { "type":"CONFIRM", "message": string, "actionId"?: string }
6. DONE: { "type":"DONE", "reason"?: string }

- KEY_PRESS: { "type":"KEY_PRESS", "key": string, "regionId"?: string, "description"?: string }

IMPORTANT:
- The initial page starts as unsigned-in. So if the task involves personal data, accounts, or payments..etc you must first sign in.
- If this page requires credentials, login, payment, or MFA, return ASK_USER with a clear message telling the human what to do, and do NOT attempt to fill passwords.
- If you are unsure, return ASK_USER instead of guessing.
- Never repeat the exact same action if lastOutcome.stateChanged is false.
- For example, If you filled an input and stateChanged is false, try a different strategy (e.g. KEY_PRESS "Enter" or click a search/submit button) instead of filling again.
- Never use null. If a field is not needed, omit it entirely.
- If no button exists, use KEY_PRESS "Enter" with the 'regionId' of the input field you just filled.
- Review "SHORT-TERM MEMORY". If you see you just performed an action (like clicking a tab) and the URL hasn't changed, DO NOT repeat it. Try a different strategy (e.g. DOM_CLICK instead of VISION, or KEY_PRESS).
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

      case 'DONE':
        // No action needed
        break;

      default:
        throw new Error(`Unknown action type: ${(action as any).type}`);
    }
  }
  
}

