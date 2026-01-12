/**
 * Configuration management
 */

import { readFileSync } from 'fs';
import { join } from 'path';

interface Config {
  port: number;
  wsPort: number;
  startUrl: string;
  browser: {
    headless: boolean;
    width: number;
    height: number;
  };
  llm?: {
    geminiApiKey?: string;
  };
  vision?: {
    model?: string;
  };
  guardrails: {
    allowedDomains: string[];
    requireConfirmFor: string[];
  };
  storage: {
    dbPath: string;
    artifactsDir: string;
  };
}

function loadEnv(): Record<string, string> {
  try {
    const envPath = join(process.cwd(), '.env');
    const envContent = readFileSync(envPath, 'utf-8');
    const env: Record<string, string> = {};
    
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        if (key && valueParts.length > 0) {
          env[key.trim()] = valueParts.join('=').trim();
        }
      }
    }
    
    return env;
  } catch {
    return {};
  }
}

function getEnv(key: string, defaultValue: string): string {
  return process.env[key] || loadEnv()[key] || defaultValue;
}

function getEnvArray(key: string, defaultValue: string[]): string[] {
  const value = getEnv(key, defaultValue.join(','));
  return value.split(',').map(s => s.trim()).filter(Boolean);
}

export function loadConfig(): Config {
  return {
    port: parseInt(getEnv('PORT', '3001'), 10),
    wsPort: parseInt(getEnv('WS_PORT', '3002'), 10),
    startUrl: getEnv('START_URL', 'https://www.google.com'),
    browser: {
      headless: getEnv('BROWSER_HEADLESS', 'false') === 'true',
      width: parseInt(getEnv('BROWSER_WIDTH', '1280'), 10),
      height: parseInt(getEnv('BROWSER_HEIGHT', '720'), 10),
    },
    llm: {
      geminiApiKey: getEnv('GEMINI_API_KEY', 'AIzaSyDbLt0FJ6ot6PUYAHIEc_6yBcnSrl0njEA'),
    },
    vision: {
      model: getEnv('VISION_MODEL', ''),
    },
    guardrails: {
      allowedDomains: getEnvArray('ALLOWED_DOMAINS', ['example.com', 'localhost']),
      requireConfirmFor: getEnvArray('REQUIRE_CONFIRM_FOR', ['submit', 'enroll', 'pay', 'send', 'delete', 'remove']),
    },
    storage: {
      dbPath: getEnv('DB_PATH', './data/agentic-browser.db'),
      artifactsDir: getEnv('ARTIFACTS_DIR', './artifacts'),
    },
  };
}

export const config = loadConfig();

