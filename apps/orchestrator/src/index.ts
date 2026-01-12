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

    // Create session in database
    this.db.createSession(sessionId, task, config.startUrl);

    // Launch browser
    const browser = new BrowserController();
    await browser.launch();
    await browser.navigate(config.startUrl);

    // Create tools
    if (!browser.page) {
      throw new Error('Browser page not available');
    }

    const screenshotManager = new ScreenshotManager(browser.page);
    const domTools = new DOMTools(browser.page);
    const regionizer = new Regionizer(domTools);
    const guardrails = new Guardrails();
    const verifier = new Verifier(domTools);
    const agent = new AgentController(domTools, regionizer, guardrails, verifier);

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
    });

    // Send status
    this.sendMessage(wsClient, {
      type: 'status',
      data: {
        sessionId,
        status: 'started',
        message: 'Task started',
      },
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

    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const { regionizer, screenshotManager, wsClient, agent, task, browser } = session;
    const currenturl=session.domTools.getUrl();
    if(currenturl.includes('accounts.google.com')){
      session.paused=true;
      session.pendingAction=undefined;
      this.db.updateSessionStatus(sessionId, 'paused');
      this.sendMessage(wsClient, {
        type:'status',
        data:{
          sessionId,
          status:'paused',
          message:'Please complete the login challenge manually to continue.',
        }
      });
      return;
    }
    // Initial observation

    const regions = await regionizer.detectRegions();
    const observation = regionizer.getObservationSummary(regions);

    // Capture initial screenshot
    const screenshotBuffer = await screenshotManager.capture();
    const screenshotPath = this.traceManager.saveScreenshot(sessionId, 0, screenshotBuffer);

    // Send initial screenshot
    this.sendMessage(wsClient, {
      type: 'screenshot',
      data: {
        sessionId,
        step: 0,
        screenshotPath,
        observation,
        regions,
      },
    });

    // Run agent loop
    const result = await agent.runLoop(
      task,
      async (phase, message, action) => {
        session.stepCount++;
        const stepNumber = session.stepCount;

        // Log step
        this.db.insertStep(
          sessionId,
          stepNumber,
          phase,
          action?.type,
          action,
          message
        );

        // Send log
        this.sendMessage(wsClient, {
          type: 'log',
          data: {
            step: stepNumber,
            phase: phase as any,
            message,
            timestamp: new Date().toISOString(),
          },
        });

        // Capture screenshot after action
        if (phase === 'ACT' && action) {
          await new Promise(resolve => setTimeout(resolve, 500)); // Wait for page to update
          const screenshotBuffer = await screenshotManager.capture();
          const screenshotPath = this.traceManager.saveScreenshot(sessionId, stepNumber, screenshotBuffer);
          
          // Re-detect regions
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
        // completed or failed (no pending action)
      },
      {resetStepCount:!session.resume}
    );
    session.resume=false;

    // completed=>end session
    if(result.completed){
      this.db.updateSessionStatus(sessionId, 'completed');
      this.sendMessage(wsClient, {
        type:'status',
        data:{
          sessionId,
          status:'completed',
          message: result.reason,
        }
      });
      await browser.close();
      this.activeSessions.delete(sessionId);
      return;

    }
    const isPaused=Boolean(result.pauseKind)||Boolean(result.pendingAction);
    if (isPaused){
      session.paused = true;
      session.resume= true;
      session.pendingAction = result.pendingAction;
      this.db.updateSessionStatus(sessionId, 'paused');
      this.sendMessage(wsClient, {
        type: 'status',
        data: {
          sessionId,
          status: 'paused',
          message: result.reason,
          pendingAction: result.pendingAction,
          pauseKind: result.pauseKind
        },
      });
      return;
    }
    this.db.updateSessionStatus(sessionId, 'error');

    this.sendMessage(wsClient, {
      type: 'status',
      data: {
        sessionId,
        status: 'error',
        message: result.reason,
      },
    });

    // Cleanup
    await browser.close();
    this.activeSessions.delete(sessionId);
    return;
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

