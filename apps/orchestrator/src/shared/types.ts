/**
 * Shared types for orchestrator
 */

export interface Region {
  id: string;
  label: string;
  bbox: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
  confidence: number;
}

export interface StepLog {
  step: number;
  phase: 'OBSERVE' | 'DECIDE' | 'ACT' | 'VERIFY' | 'NAVIGATE' | 'PLANNING';
  message: string;
  timestamp: string;
  error?: string;
}

export interface ScreenshotUpdate {
  sessionId: string;
  step: number;
  screenshotPath: string;
  observation?: string;
  regions?: Region[];
}

export interface TaskRequest {
  task: string;
  sessionId?: string;
}

/** matches index.ts: message.type === 'stop' and message.data.sessionId */
export interface StopRequest {
  sessionId: string;
}

export interface TaskResponse {
  sessionId: string;
  status: 'started' | 'running' | 'paused' | 'completed' | 'error' | 'stopped';
  message?: string;
  pendingAction?: any;
  pauseKind?: 'ASK_USER' | 'CONFIRM';
}

export interface UserConfirmation {
  sessionId: string;
  approved: boolean;
  actionId?: string;
}

export interface WebSocketMessage {
  type: 'task' | 'stop' | 'screenshot' | 'log' | 'confirmation' | 'status' | 'error';
  data:
    | TaskRequest
    | StopRequest
    | ScreenshotUpdate
    | StepLog
    | UserConfirmation
    | TaskResponse
    | { message: string };
}