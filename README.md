# Agentic Browser

An intelligent browser automation system with LLM-powered planning, semantic content detection, vision-based interaction, and real-time WebSocket streaming.

## Architecture

```
User (Web UI) ──WebSocket──> Orchestrator ──Playwright──> Browser
                                  │
                          ┌───────┴────────┐
                          │   Agent Loop   │
                          │                │
                          │  OBSERVE       │
                          │    ↓           │
                          │  AUTO-RECOVERY │ (post-fill submit)
                          │    ↓           │
                          │  AUTO-SCROLL   │ (semantic LLM check)
                          │    ↓           │
                          │  DECIDE        │ (Gemini 2.5 Flash)
                          │    ↓           │
                          │  ACT           │ (cursor physics / DOM)
                          │    ↓           │
                          │  VERIFY        │
                          └────────────────┘
```

- **UI**: Web interface (Vite + TypeScript) with glassmorphism design and animated WebGL background
- **Orchestrator**: Node.js server controlling Playwright, running the agent loop, and managing state
- **Agent Loop**: OBSERVE → AUTO-RECOVERY → AUTO-SCROLL → DECIDE → ACT → VERIFY
- **LLM Integration**: Gemini 2.5 Flash for planning and decisions, Gemini 2.0 Flash Lite for semantic scroll checks

## Features

### Planning & Intelligence
- **Pre-Planning Scout**: Verifies URLs via Google Search before planning (handles CAPTCHA detection)
- **LLM-Powered Planning**: Gemini 2.5 Flash decomposes tasks into atomic, executable steps
- **Task Classification**: Automatically categorizes tasks as Simple Action, Deep Research, or Transactional
- **Heuristic Fallback**: Works without API keys using rule-based decision making

### Smart Scrolling
- **Semantic Auto-Scroll**: Before asking the LLM what to do, a lightweight Gemini call checks if the target content is visible on the page. If not, the system scrolls automatically without burning a full LLM decision call.
- **Synonym-Aware**: Understands that "Dining" is relevant for "Food", "Catalog" for "Classes", etc.
- **Bottom Detection**: Stops scrolling when page content stops changing
- **Scroll Status Context**: The decision LLM is told what auto-scroll already did, preventing redundant scroll actions

### Auto-Recovery
- **Post-Fill Submit**: If filling a field doesn't trigger state change, automatically tries Enter, then searches for Submit/Search buttons, then asks the user

### Browser Interaction
- **Visual Click Actions**: Human-like cursor physics with bezier curve movement for natural interactions
- **DOM-Based Region Detection**: Finds all interactive elements (buttons, links, inputs, roles)
- **DOM Fallback Mode**: Uses Playwright role/name/selector fallbacks when region IDs become stale
- **Zombie Page Fix**: Tracks newest tab across pop-ups and navigations

### Safety & Control
- **Guardrails**: Domain allowlisting, sensitive field protection (passwords, SSN, API keys), risky action confirmation
- **User Confirmation Flows**: ASK_USER (manual action needed) and CONFIRM (permission required) pause types
- **Anti-Hallucination Rules**: LLM is instructed to only use fill values explicitly stated in the task, never invent them

### Observability
- **Real-Time Streaming**: WebSocket streaming of screenshots and step logs to the UI
- **Persistent Logging**: SQLite database for sessions, steps, actions, and observations
- **DB-Backed Memory**: Short-term history (last 5 actions) fed to LLM for context awareness
- **Artifact Storage**: Screenshots and JSON trace files saved per session

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Install Playwright Chromium:**
   ```bash
   npm run playwright:install
   ```

3. **Configure environment:**
   ```bash
   cp .env .env.local
   # Edit with your settings
   ```

   Key environment variables:
   ```
   GEMINI_API_KEY=your_key_here        # Required for LLM planning and decisions
   START_URL=https://www.google.com/
   ALLOWED_DOMAINS=example.com,localhost,google.com
   BROWSER_HEADLESS=false
   PORT=3001
   ```

4. **Run development servers:**
   ```bash
   npm run dev
   ```

   This starts:
   - Orchestrator on port 3001 (HTTP + WebSocket at /ws)
   - UI dev server on port 5173 (Vite)

5. **Open the UI:**
   Navigate to `http://localhost:5173` in your browser.

## Usage

1. Enter a task in the UI (e.g., "Go to YouTube and search for OpenAI demos")
2. Click "Execute" to start
3. Watch the agent work:
   - Screenshots stream to the UI in real-time
   - Neural log shows every phase and decision
   - Auto-scroll finds content before the LLM is even called
   - If confirmation or manual action is needed, a modal appears

**Example tasks:**
- "Search for 'ChatGPT' on Google and click the first result"
- "Go to YouTube and search for OpenAI demos"
- "Find the current menu for Umi restaurant at UCSD"
- "Research the best 4K monitors under $500" (deep research — visits multiple sources)
- "Navigate to Canvas and check my grades" (triggers auth flow)

**User Confirmation:**
- **ASK_USER**: Requires manual action (e.g., login, MFA, CAPTCHA, payment)
- **CONFIRM**: Asks permission before risky actions (submit, delete, pay, enroll)

## Project Structure

```
agenticbrowser/
├── apps/
│   ├── ui/                         # Web UI (Vite + TypeScript)
│   │   ├── app.ts                  # Main UI logic, WebSocket handling
│   │   ├── api.ts                  # OrchestratorAPI WebSocket client
│   │   ├── liquidbg.ts             # WebGL animated background (FBM noise)
│   │   ├── types.ts                # Shared TypeScript interfaces
│   │   └── styles.css              # Glassmorphism styles
│   └── orchestrator/               # Node.js orchestrator
│       └── src/
│           ├── index.ts            # Main entry, session management
│           ├── server.ts           # HTTP + WebSocket server
│           ├── config.ts           # Environment configuration
│           ├── browser/
│           │   ├── playwright.ts   # Browser controller (launch, navigate)
│           │   ├── screenshot.ts   # Screenshot capture
│           │   └── domTools.ts     # DOM scanning, scrolling, cursor physics
│           ├── agent/
│           │   ├── controller.ts   # Agent loop, auto-scroll, auto-recovery
│           │   ├── planner.ts      # Pre-planning scout + Gemini task planning
│           │   └── schemas.ts      # Zod action/decision/plan schemas
│           ├── vision/
│           │   └── regionizer.ts   # DOM-based interactive element detection
│           ├── policy/
│           │   └── guardrails.ts   # Safety checks, domain allowlist
│           ├── verify/
│           │   └── verifier.ts     # Post-action verification
│           └── storage/
│               ├── db.ts           # SQLite (sessions, steps, artifacts)
│               └── trace.ts        # Screenshot/trace file management
├── data/                           # SQLite database
└── artifacts/                      # Screenshots and traces per session
```

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start both orchestrator + UI dev servers |
| `npm run dev:orchestrator` | Orchestrator only (port 3001) |
| `npm run dev:ui` | UI dev server only (port 5173) |
| `npm run build` | Build both apps for production |
| `npm run playwright:install` | Download Chromium browser |

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Browser Automation**: Playwright
- **LLM**: Gemini 2.5 Flash (planning/decisions), Gemini 2.0 Flash Lite (semantic checks)
- **Database**: SQLite via better-sqlite3
- **WebSocket**: ws
- **Validation**: Zod
- **UI Build**: Vite
- **UI Rendering**: WebGL (custom FBM noise shader)
