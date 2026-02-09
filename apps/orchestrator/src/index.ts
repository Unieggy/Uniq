/**
 * Main orchestrator entry point
 */

import { Server } from './server.js';
import { BrowserController } from './browser/playwright.js';
import { ScreenshotManager } from './browser/screenshot.js';
import { DOMTools } from './browser/domTools.js';
import { Regionizer } from './vision/regionizer.js';
import { AgentController } from './agent/controller.js';
import { Guardrails } from './policy/guardrails.js';
import { Verifier } from './verify/verifier.js';
import { DatabaseManager } from './storage/db.js';
import { TraceManager } from './storage/trace.js';
import { config } from './config.js';
import type { WebSocketMessage, TaskRequest, UserConfirmation } from './shared/types.js';
import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import { planTaskWithGemini } from './agent/planner.js';
import { PlanResult } from './agent/schemas.js';

class Orchestrator {
  private server: Server;
  private db: DatabaseManager;
  private traceManager: TraceManager;
  private activeSessions: Map<string, {
    browser: BrowserController;
    screenshotManager: ScreenshotManager;
    domTools: DOMTools;
    regionizer: Regionizer;
    agent: AgentController;
    task: string;
    stepCount: number;
    paused: boolean;
    resume?: boolean;
    pendingAction?: import('./agent/schemas.js').Action;
    wsClient?: WebSocket;
    plan: PlanResult['steps'];
    planIndex: number;
    completedSteps: string[];
    pausedForHumanObjective?: string;
    strategy:string;
    researchNotes: string[];

  }> = new Map();

  constructor() {
    this.server = new Server();
    this.db = new DatabaseManager();
    this.traceManager = new TraceManager(this.db);
    this.setupWebSocketHandlers();
  }

  setupWebSocketHandlers(): void {
    this.server.wsServer.on('connection', (ws: WebSocket) => {
      ws.on('message', async (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          
          if (message.type === 'task') {
            await this.handleTask(message.data as TaskRequest, ws);
          } else if (message.type === 'stop') {
            const sessionId = message.data.sessionId;
            // Handle stop - find and close session
            const session = this.activeSessions.get(sessionId);
            if (session) {
              await session.browser.close();
              this.db.updateSessionStatus(sessionId, 'stopped');
              this.activeSessions.delete(sessionId);
              this.sendMessage(ws, {
                type: 'status',
                data: { sessionId, status: 'stopped', message: 'Task stopped by user' },
              });
            }
          } else if (message.type === 'confirmation'){
            const confirmation = message.data as UserConfirmation;
            const sessionId = confirmation.sessionId;

            const session = this.activeSessions.get(sessionId);
            if (!session) {
              this.sendMessage(ws, {
                type: 'error',
                data: { message: `Session ${sessionId} not found` },
              });
              return;
            }

            if (!session.paused) {
              this.sendMessage(ws, {
                type: 'error',
                data: { message: `Session ${sessionId} is not paused` },
              });
              return;
            }

            // If user rejected confirmation
            if (!confirmation.approved) {
              session.paused = false;
              session.pendingAction = undefined;

              this.db.updateSessionStatus(sessionId, 'stopped');

              this.sendMessage(session.wsClient, {
                type: 'status',
                data: {
                  sessionId,
                  status: 'stopped',
                  message: 'User rejected confirmation',
                },
              });

              // cleanup
              await session.browser.close();
              this.activeSessions.delete(sessionId);
              return;
            }

            // User approved: execute the pending action
            const action = session.pendingAction;
            session.pendingAction = undefined;
            session.paused = false;

            // Optional: log to UI that we're executing the confirmed action
            this.sendMessage(session.wsClient, {
              type: 'log',
              data: {
                step: session.stepCount,
                phase: 'ACT',
                message: action
                ?'User approved. Executing confirmed action.': 'User approved. Resuming after manual confirmation.',
                timestamp: new Date().toISOString(),
              },
            });

            if(action){
              await session.agent.executeAction(action);
            }
            session.resume=true;
            // Resume agent loop from current page state
            this.runAgentLoop(sessionId).catch((error) => {
              console.error(`Agent loop error for session ${sessionId}:`, error);
              this.sendMessage(session.wsClient, {
                type: 'error',
                data: { message: error instanceof Error ? error.message : String(error) },
              });
              this.db.updateSessionStatus(sessionId, 'error');
            });
          }
        } catch (error) {
          console.error('Error handling WebSocket message:', error);
          ws.send(JSON.stringify({
            type: 'error',
            data: { message: error instanceof Error ? error.message : String(error) },
          }));
        }
      });
    });
  }

  async start(): Promise<void> {
    this.server.start();
    console.log('Orchestrator started');
  }

  async handleTask(request: TaskRequest, wsClient: WebSocket): Promise<void> {
    const sessionId = request.sessionId || randomUUID();
    
    const task = request.task;

    console.log(`Starting task for session ${sessionId}: ${task}`);

    this.sendMessage(wsClient, {
      type: 'status',
      data: {
        sessionId,
        status: 'started',
        message: 'Initializing Scout Phase',
      },
    });

    let planResult: PlanResult;
    try {
        // Pass wsClient so planner can stream logs/popups to UI
        planResult = await planTaskWithGemini(task, wsClient);
    } catch (error) {
        console.error('Planning failed:', error);
        this.sendMessage(wsClient, { type: 'error', data: { message: 'Planning failed' } });
        return;
    }

    // 3. Log the generated plan to UI
    this.sendMessage(wsClient, {
      type: 'status',
      data: {
        sessionId,
        status: 'running',
        message: 'Plan created:\n' + planResult.steps.map((step, i) => `[${i}] ${step.title}`).join('\n'),
      },
    });

    // Create session in database
    this.db.createSession(sessionId, task, config.startUrl);

    // Notify user that main browser is launching
    this.sendMessage(wsClient, {
      type: 'status',
      data: {
        sessionId,
        status: 'running',
        message: '🌐 Launching main browser...'
      }
    });

    // Launch browser
    const browser = new BrowserController();
    await browser.launch();

    this.sendMessage(wsClient, {
      type: 'status',
      data: {
        sessionId,
        status: 'running',
        message: '🌐 Navigating to start page...'
      }
    });

    await browser.navigate(config.startUrl);

    this.sendMessage(wsClient, {
      type: 'status',
      data: {
        sessionId,
        status: 'running',
        message: '✓ Browser ready. Starting agent loop...'
      }
    });

    // Create tools
    if (!browser.page) {
      throw new Error('Browser page not available');
    }

    const screenshotManager = new ScreenshotManager(browser.page);
    const domTools = new DOMTools(browser.page);
    const regionizer = new Regionizer(domTools);
    const guardrails = new Guardrails();
    const verifier = new Verifier(domTools);
    const agent = new AgentController(domTools, regionizer, guardrails, verifier,this.db);

    // Store session
    this.activeSessions.set(sessionId, {
      browser,
      screenshotManager,
      domTools,
      regionizer,
      agent,
      task,
      stepCount: 0,
      paused: false,
      pendingAction: undefined,
      wsClient,
      plan:planResult.steps,
      strategy: planResult.strategy,
      planIndex:0,
      completedSteps:[],
      pausedForHumanObjective: undefined,
      researchNotes: [],
    });

    

    // Run agent loop
    this.runAgentLoop(sessionId).catch((error) => {
      console.error(`Agent loop error for session ${sessionId}:`, error);
      this.sendMessage(wsClient, {
        type: 'error',
        data: { message: error instanceof Error ? error.message : String(error) },
      });
      this.db.updateSessionStatus(sessionId, 'error');
    });
  }

  private async runAgentLoop(sessionId: string): Promise<void> {
    const session = this.activeSessions.get(sessionId);
    const isHumanOwnedObjective = (objective: string) => objective.trim().startsWith('[HUMAN]');
    const isLoginLikeObjective = (objective: string) => /sign\s*in|login|mfa|otp|2fa/i.test(objective);


    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const { regionizer, screenshotManager, wsClient, agent, task, browser } = session;

    // ===== UNIVERSAL HUMAN-OWNED OBJECTIVE ENFORCEMENT =====
    // If we are resuming from a human-owned objective, mark it complete and advance.
    if (session.resume && session.pausedForHumanObjective) {
      const doneObj = session.pausedForHumanObjective;
      session.completedSteps.push(doneObj);
      session.planIndex++;
      session.pausedForHumanObjective = undefined;
      session.paused = false;
      session.resume = false;

      this.sendMessage(wsClient, {
        type: 'status',
        data: {
          sessionId,
          status: 'running',
          message: `Objective completed (human): ${doneObj}`,
        },
      });
    }

    // Recompute after possible advance
    const currentStep = session.plan[session.planIndex];

    // FIX: Use the 'needsAuth' boolean flag instead of Regex
    if (currentStep && currentStep.needsAuth) {
      session.paused = true;
      session.resume = true;
      session.pendingAction = undefined;
      // FIX: Store the title string, not the whole object
      session.pausedForHumanObjective = currentStep.title;

      this.db.updateSessionStatus(sessionId, 'paused');

      this.sendMessage(wsClient, {
        type: 'status',
        data: {
          sessionId,
          status: 'paused',
          pauseKind: 'ASK_USER',
          pendingAction: undefined,
          // FIX: Use title and description for the message
          message: `AUTHENTICATION REQUIRED:\n${currentStep.title}\n\n${currentStep.description}\n\nPlease complete this manually, then click Continue.`,
        },
      });

      return;
    }
    // ===== END HUMAN-OWNED ENFORCEMENT =====

    // Initial observation

    const regions = await regionizer.detectRegions();
    const observation = regionizer.getObservationSummary(regions);

    // Capture initial screenshot
    const screenshotBuffer = await screenshotManager.capture();
    const screenshotPath = this.traceManager.saveScreenshot(sessionId, session.stepCount, screenshotBuffer);

    // Send initial screenshot
    this.sendMessage(wsClient, {
      type: 'screenshot',
      data: {
        sessionId,
        step: session.stepCount,
        screenshotPath,
        observation,
        regions,
      },
    });


    // Run agent loop
        // Run objectives sequentially until pause or completion
    while (session.planIndex < session.plan.length) {
      try {
        const allPages = session.browser.getAllPages(); // Use the public method we added
        const activePage = allPages[allPages.length - 1]; // Always grab the newest tab

        if (activePage) {
          // 1. Update the Browser Controller's reference
          session.browser.setPage(activePage);

          // 2. Update the DOM Tools reference
          session.domTools.setPage(activePage);
          
          // 3. CRITICAL: Destroy and Re-create the Screenshot Manager
          // This ensures we are taking pictures of the CURRENT page, not the old one.
          session.screenshotManager = new ScreenshotManager(activePage);

          // 4. Bring tab to front
          await activePage.bringToFront();
        }
      } catch (err) {
        console.log("⚠️ Page refresh warning:", err);
      }
      const stepData = session.plan[session.planIndex];

      // ===== PRE-NAVIGATION: If step has a verified targetUrl, navigate directly =====
      if (stepData.targetUrl) {
        this.sendMessage(wsClient, {
          type: 'log',
          data: {
            step: session.stepCount,
            phase: 'NAVIGATE',
            message: `[Scout] Navigating directly to verified URL: ${stepData.targetUrl}`,
            timestamp: new Date().toISOString(),
          },
        });

        try {
          await session.browser.navigate(stepData.targetUrl);
          await session.domTools.waitForStability();
        } catch (navError) {
          console.warn(`[Scout] Direct navigation failed: ${navError}`);
          // Continue anyway, agent will handle it
        }
      }

      const notesContext = session.researchNotes.length > 0
        ? `\nRESEARCH NOTES SO FAR:\n${session.researchNotes.join('\n---\n').slice(-3000)}`
        : '';

      const objectivePrompt = `
  ORIGINAL USER TASK: ${session.task}

  STRATEGY: ${session.strategy}
  CURRENT STEP: ${stepData.title}
  GUIDANCE: ${stepData.description}
  ${stepData.targetUrl ? `TARGET URL: ${stepData.targetUrl} (You should already be on this page)` : ''}

  FULL PLAN:
  ${session.plan.map(s => `[${s.id}] ${s.title}${s.targetUrl ? ` → ${s.targetUrl}` : ''}`).join('\n')}
  ${notesContext}
        `.trim();

      const result = await agent.runLoop(
        sessionId,
        objectivePrompt,
        async (phase, message, action) => {
          session.stepCount++;
          const stepNumber = session.stepCount;

          this.db.insertStep(
            sessionId,
            stepNumber,
            phase,
            action?.type,
            action,
            message
          );

          this.sendMessage(wsClient, {
            type: 'log',
            data: {
              step: stepNumber,
              phase: phase as any,
              message,
              timestamp: new Date().toISOString(),
            },
          });

          if (phase === 'ACT' && action) {
            // Wait for page stability instead of arbitrary sleep
            await session.domTools.waitForStability();
            const screenshotBuffer = await session.screenshotManager.capture();
            const screenshotPath = this.traceManager.saveScreenshot(sessionId, stepNumber, screenshotBuffer);

            const newRegions = await regionizer.detectRegions();
            const newObservation = regionizer.getObservationSummary(newRegions);

            this.sendMessage(wsClient, {
              type: 'screenshot',
              data: {
                sessionId,
                step: stepNumber,
                screenshotPath,
                observation: newObservation,
                regions: newRegions,
              },
            });
          }
        },
        { resetStepCount: !session.resume }
      );

      session.resume = false;

      // If objective completed, advance plan
      if (result.completed) {
        // Extract page content as research note
        try {
          const pageText = await session.domTools.getVisibleText();
          const note = pageText.slice(0, 2000);
          if (note.length > 50) {
            session.researchNotes.push(`[${stepData.title}]\n${note}`);
          }
        } catch (err) {
          console.warn('[research-notes] Failed to extract page text:', err);
        }

        session.completedSteps.push(stepData.title);
        session.planIndex++;

        this.sendMessage(wsClient, {
          type: 'status',
          data: {
            sessionId,
            status: 'running',
            message: `Objective completed: ${stepData.title}`,
          },
        });

        // Move on to next objective in the same session run
        continue;
      }

      // Paused: store pending action and stop loop
      const isPaused = Boolean(result.pauseKind) || Boolean(result.pendingAction);
      if (isPaused) {
        session.paused = true;
        session.resume = true;
        session.pendingAction = result.pendingAction;
        this.db.updateSessionStatus(sessionId, 'paused');

        this.sendMessage(wsClient, {
          type: 'status',
          data: {
            sessionId,
            status: 'paused',
            message: result.reason,
            pendingAction: result.pendingAction,
            pauseKind: result.pauseKind,
          },
        });
        return;
      }

      // Error case: stop session (keep browser open for user inspection)
      this.db.updateSessionStatus(sessionId, 'error');
      this.sendMessage(wsClient, {
        type: 'status',
        data: {
          sessionId,
          status: 'error',
          message: result.reason,
        },
      });
      return;
    }

    // Synthesize research findings if notes were collected
    if (session.researchNotes.length > 0) {
      this.sendMessage(wsClient, {
        type: 'log',
        data: {
          step: session.stepCount + 1,
          phase: 'DECIDE',
          message: 'Synthesizing research findings...',
          timestamp: new Date().toISOString(),
        },
      });

      const synthesis = await this.synthesizeFindings(session.task, session.researchNotes);

      this.sendMessage(wsClient, {
        type: 'log',
        data: {
          step: session.stepCount + 1,
          phase: 'DECIDE',
          message: `RESEARCH FINDINGS:\n\n${synthesis}`,
          timestamp: new Date().toISOString(),
        },
      });
    }

    // All objectives completed — keep browser open for user to inspect results
    this.db.updateSessionStatus(sessionId, 'completed');
    this.sendMessage(wsClient, {
      type: 'status',
      data: {
        sessionId,
        status: 'completed',
        message: session.researchNotes.length > 0
          ? 'All objectives completed. Research synthesis sent above. Browser is still open — click Stop when done.'
          : 'All objectives completed. Browser is still open — click Stop when done.',
      },
    });
    return;

  }

  private async synthesizeFindings(task: string, researchNotes: string[]): Promise<string> {
    const apiKey = config.llm?.geminiApiKey;
    if (!apiKey) return 'No API key configured for synthesis.';

    const notesText = researchNotes.join('\n---\n').slice(-6000);
    const prompt = `You are a research assistant. The user asked an AI browser agent to perform the following task:

TASK: ${task}

The agent visited several pages and collected these notes:

${notesText}

Based on these research notes, provide a concise, well-organized answer to the user's original task. Include specific facts, names, numbers, and URLs where relevant. If the notes are insufficient, say what was found and what is still missing.`;

    try {
      const model = 'gemini-2.5-flash';
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
        }),
      });

      if (!res.ok) {
        console.warn(`[synthesis] Gemini request failed (${res.status})`);
        return 'Synthesis failed — could not reach LLM.';
      }

      const json = (await res.json()) as any;
      const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
      return text?.trim() || 'No synthesis generated.';
    } catch (err) {
      console.warn('[synthesis] Error:', err);
      return 'Synthesis failed due to an error.';
    }
  }

  private sendMessage(wsClient: WebSocket | undefined, message: WebSocketMessage): void {
    if (wsClient && wsClient.readyState === WebSocket.OPEN) {
      wsClient.send(JSON.stringify(message));
    } else {
      // Broadcast to all if no specific client
      this.server.broadcast(message);
    }
  }

  async stop(): Promise<void> {
    // Close all active sessions
    for (const [sessionId, session] of this.activeSessions) {
      await session.browser.close();
      this.db.updateSessionStatus(sessionId, 'stopped');
    }
    this.activeSessions.clear();
    this.db.close();
    this.server.stop();
  }
}

// Start orchestrator
const orchestrator = new Orchestrator();
orchestrator.start().catch(console.error);

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await orchestrator.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down...');
  await orchestrator.stop();
  process.exit(0);
});

