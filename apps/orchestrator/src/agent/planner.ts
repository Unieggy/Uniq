import {config} from '../config.js';
import { PlanSchema,PlanResult } from './schemas.js';
import { chromium } from 'playwright';
import { WebSocket } from 'ws';
// ============================================================================
// TYPES
// ============================================================================

interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

interface ScoutContext {
  query: string;
  results: SearchResult[];
}

// ============================================================================
// PRE-PLANNING SCOUT: Gather real-world context before planning
// ============================================================================
function sendScoutLog(ws: WebSocket | undefined, message: string) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'log',
      data: {
        step: 0,
        phase: 'PLANNING',
        message: message,
        timestamp: new Date().toISOString()
      }
    }));
  }
}
/**
 * Step 1: Analyze the task and determine if we need to verify URLs via search.
 * Returns a search query if verification is needed, or null if the task is simple.
 */
async function gatherContext(task: string): Promise<string | null> {
  const apiKey = config.llm?.geminiApiKey;
  if (!apiKey || apiKey.startsWith('AIzaSyDbLt')) {
    return null; // No API key, skip context gathering
  }

  const prompt = `
You are a Pre-Planning Scout. Your job is to determine if a task requires URL verification.

USER TASK: "${task}"

ANALYSIS:
1. Does this task mention a specific website, service, or platform (e.g., "Canvas", "WebReg", "Blackboard", "Netflix")?
2. Would you need to guess a URL to complete this task?
3. Is this a simple, well-known site (google.com, youtube.com, amazon.com) or something institution-specific?

RULES:
- If the task is simple navigation to a well-known site (Google, YouTube, Wikipedia, Amazon), return NULL.
- If the task mentions a specific service that could have multiple URLs (Canvas, WebReg, Blackboard, a school portal), return a SEARCH QUERY.
- If the task involves login/authentication to a specific institution, return a SEARCH QUERY to find the correct login page.

RESPOND WITH ONLY ONE OF:
1. A search query string (e.g., "UCSD WebReg login page") - if URL verification is needed
2. The word NULL (exactly) - if no verification is needed

Examples:
- "Go to Google" → NULL
- "Log into Canvas" → "Canvas LMS login page"
- "Check my UCSD grades" → "UCSD student grades portal login"
- "Search for cats on YouTube" → NULL
- "Access my company's Salesforce" → "Salesforce login page"
- "Navigate to WebReg and enroll in classes" → "UCSD WebReg class enrollment login"

YOUR RESPONSE (just the query or NULL, nothing else):
`.trim();

  try {
    const model = 'gemini-2.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1 }, // Very low temp for deterministic output
      }),
    });

    if (!res.ok) return null;

    const json = (await res.json()) as any;
    const rawText: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!rawText) return null;

    const cleaned = rawText.trim();

    // Check if Gemini said NULL
    if (cleaned.toUpperCase() === 'NULL' || cleaned.toLowerCase() === 'null') {
      console.log('[Scout] No URL verification needed for this task.');
      return null;
    }

    console.log(`[Scout] URL verification needed. Query: "${cleaned}"`);
    return cleaned;

  } catch (error) {
    console.warn('[Scout] Context gathering failed:', error);
    return null;
  }
}

/**
 * Step 2: Perform a real Google search using a VISIBLE browser.
 * Uses Playwright's native waitForSelector for reliable waiting.
 * User may need to complete CAPTCHA if Google detects automation.
 */
async function performScout(query: string, wsClient?: WebSocket): Promise<SearchResult[]> {
  console.log(`[Scout] 🔍 Searching Google for: "${query}"`);
  sendScoutLog(wsClient, `🔍 Searching: "${query}"`);

  let browser;
  try {
    // =========================================================================
    // STEP 1: LAUNCH VISIBLE BROWSER
    // =========================================================================
    sendScoutLog(wsClient, '🌐 Opening Scout browser...');

    browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--no-default-browser-check',
      ],
    });

    const context = await browser.newContext({
      viewport: { width: 1100, height: 750 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'en-US',
    });

    const page = await context.newPage();

    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    // =========================================================================
    // STEP 2: NAVIGATE TO GOOGLE
    // =========================================================================
    const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    console.log(`[Scout] Navigating to: ${searchUrl}`);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // =========================================================================
    // STEP 3: SMART CAPTCHA DETECTION
    // Try a quick wait first. Only show CAPTCHA popup if actually detected.
    // =========================================================================
    const QUICK_TIMEOUT_MS = 10000;   // 10 seconds for normal page load
    const CAPTCHA_TIMEOUT_MS = 120000; // 2 minutes for CAPTCHA solving

    console.log('[Scout] ⏳ Waiting for search results...');
    sendScoutLog(wsClient, '⏳ Waiting for search results...');

    let searchFound = false;

    // First: try quick wait — most of the time Google loads fast with no CAPTCHA
    try {
      await page.waitForSelector('#search', { timeout: QUICK_TIMEOUT_MS, state: 'attached' });
      searchFound = true;
      console.log('[Scout] ✓ Search results loaded (no CAPTCHA).');
      sendScoutLog(wsClient, '✓ Search results loaded!');
    } catch {
      // Quick wait failed — check if there's an actual CAPTCHA
      console.log('[Scout] Search results not found in quick wait. Checking for CAPTCHA...');

      const hasCaptcha = await page.evaluate(() => {
        const captchaSelectors = [
          '#captcha-form',
          'iframe[src*="recaptcha"]',
          '.g-recaptcha',
          '#recaptcha',
          'iframe[title*="reCAPTCHA"]',
        ];
        for (const sel of captchaSelectors) {
          if (document.querySelector(sel)) return true;
        }
        // Also check for "unusual traffic" text
        const bodyText = document.body?.innerText || '';
        if (bodyText.includes('unusual traffic') || bodyText.includes('not a robot')) {
          return true;
        }
        return false;
      });

      if (hasCaptcha) {
        // REAL CAPTCHA detected — notify user
        console.log('[Scout] ⚠️ CAPTCHA detected! Waiting for user to solve...');
        sendScoutLog(wsClient, '⚠️ CAPTCHA detected! Please solve it in the browser window.');

        if (wsClient && wsClient.readyState === WebSocket.OPEN) {
          wsClient.send(JSON.stringify({
            type: 'status',
            data: {
              sessionId: 'scout',
              status: 'running',
              message: '⚠️ CAPTCHA detected in Scout browser. Please solve it now! Waiting up to 2 minutes...'
            }
          }));
        }

        try {
          await page.waitForSelector('#search', { timeout: CAPTCHA_TIMEOUT_MS, state: 'attached' });
          searchFound = true;
          console.log('[Scout] ✓ Search results loaded after CAPTCHA solve.');
          sendScoutLog(wsClient, '✓ CAPTCHA solved! Search results loaded.');
        } catch {
          console.log('[Scout] ✗ Timeout waiting for CAPTCHA solve.');
          sendScoutLog(wsClient, '✗ Timeout: CAPTCHA was not solved in time.');
          await browser.close();
          return [];
        }
      } else {
        // No CAPTCHA, page is just loading slowly — wait a bit more
        console.log('[Scout] No CAPTCHA detected. Page loading slowly, waiting...');
        sendScoutLog(wsClient, '⏳ Page loading slowly, waiting...');

        try {
          await page.waitForSelector('#search', { timeout: 30000, state: 'attached' });
          searchFound = true;
          console.log('[Scout] ✓ Search results loaded (slow page).');
          sendScoutLog(wsClient, '✓ Search results loaded!');
        } catch {
          console.log('[Scout] ✗ Timeout: Search results never appeared.');
          sendScoutLog(wsClient, '✗ Timeout: Search results did not load.');
          await browser.close();
          return [];
        }
      }
    }

    if (!searchFound) {
      await browser.close();
      return [];
    }

    // Extra wait for dynamic content to fully render
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(1000);

    // =========================================================================
    // STEP 4: SCRAPE SEARCH RESULTS
    // =========================================================================
    console.log('[Scout] Scraping search results...');

    const results: SearchResult[] = await page.evaluate(() => {
      const output: { title: string; url: string; snippet: string }[] = [];

      // Google search results are in #search container
      // Each result is typically in a div with class 'g' or similar
      // We look for links that have an h3 (title) nearby

      // Method 1: Find all anchor tags with h3 inside them (most reliable)
      const links = document.querySelectorAll('#search a[href^="http"]');

      for (const link of links) {
        const href = link.getAttribute('href') || '';

        // Skip Google internal links, ads, and YouTube videos
        if (
          href.includes('google.com') ||
          href.includes('googleadservices') ||
          href.includes('youtube.com') ||
          href.includes('webcache') ||
          href.includes('translate.google')
        ) {
          continue;
        }

        // Find h3 title - could be inside the link or nearby
        let titleEl = link.querySelector('h3');
        if (!titleEl) {
          // Check parent for h3
          const parent = link.closest('div');
          if (parent) {
            titleEl = parent.querySelector('h3');
          }
        }

        if (!titleEl) continue;

        const title = titleEl.textContent?.trim() || '';
        if (!title) continue;

        // Avoid duplicates
        if (output.some(r => r.url === href || r.title === title)) continue;

        // Get snippet (description) - look in parent container
        let snippet = '';
        const container = link.closest('div.g') || link.closest('[data-hveid]');
        if (container) {
          const snippetEl = container.querySelector('[data-sncf], .VwiC3b, [style*="-webkit-line-clamp"]');
          snippet = snippetEl?.textContent?.trim() || '';
        }

        output.push({ title, url: href, snippet });

        // Stop after 3 good results
        if (output.length >= 3) break;
      }

      return output;
    });

    // =========================================================================
    // STEP 5: CLOSE BROWSER AND RETURN RESULTS
    // =========================================================================
    await browser.close();

    if (results.length > 0) {
      const successMsg = `✓ Found ${results.length} URLs:\n${results.map((r, i) => `  [${i + 1}] ${r.title}\n      ${r.url}`).join('\n')}`;
      console.log(`[Scout] ${successMsg}`);
      sendScoutLog(wsClient, successMsg);
      return results;
    } else {
      console.log('[Scout] ⚠️ No valid URLs extracted from results');
      sendScoutLog(wsClient, '⚠️ Search loaded but no valid URLs found.');
      return [];
    }

  } catch (error) {
    const errorMsg = `✗ Scout error: ${error instanceof Error ? error.message : String(error)}`;
    console.error(`[Scout] ${errorMsg}`);
    sendScoutLog(wsClient, errorMsg);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    return [];
  }
}

/**
 * Format scout results for injection into the planner prompt.
 */
function formatScoutContext(scoutContext: ScoutContext | null): string {
  if (!scoutContext || scoutContext.results.length === 0) {
    return '';
  }

  const resultsText = scoutContext.results
    .map((r, i) => `[${i + 1}] "${r.title}" → ${r.url}${r.snippet ? ` (${r.snippet.slice(0, 100)}...)` : ''}`)
    .join('\n');

  return `
### VERIFIED CONTEXT FROM GOOGLE SEARCH
I searched for: "${scoutContext.query}"

TOP RESULTS:
${resultsText}

**CRITICAL**: Use the URLs from these search results. DO NOT invent or guess URLs.
If the task involves one of these sites, use the EXACT URL provided above.
`;
}

// ============================================================================
// HEURISTIC FALLBACK
// ============================================================================

function heuristicPlan(task: string): PlanResult {
  const normalized = task
    .replace(/\band then\b/gi, ' then ')
    .replace(/\bthen\b/gi, ' then ')
    .replace(/[.;]+/g, ' then ')
    .trim();

  const parts = normalized
    .split(/\bthen\b|,|\n/gi)
    .map(s => s.trim())
    .filter(Boolean);

  // Raw steps (no tags yet)
  const rawSteps = parts.length > 0 ? parts : [task];

  return {
    strategy: "System Offline: Falling back to simple heuristic parsing. Executing steps sequentially.",
    steps: rawSteps.slice(0, 10).map((stepText, index) => ({
      id: index + 1,
      title: stepText,
      description: `Action: ${stepText}`,
      needsAuth: /login|sign in|password/i.test(stepText) // Basic regex for auth detection
    }))
  };
}

export async function planTaskWithGemini(task: string,wsClient?:WebSocket): Promise<PlanResult> {
  const apiKey = config.llm?.geminiApiKey;
  if (!apiKey || apiKey.startsWith('AIzaSyDbLt')){
    console.warn('Gemini API key not set or is a placeholder. Using heuristic planner.');
    return heuristicPlan(task);
  }

  // =========================================================================
  // PHASE 1: PRE-PLANNING SCOUT
  // =========================================================================
  
  console.log('[Planner] Starting Pre-Planning Scout phase...');
  sendScoutLog(wsClient, '🔍 Starting Pre-Planning Scout...');

  let scoutContext: null | { query: string, results: SearchResult[] } = null;

  try {
    // Step 1: Determine if we need to verify URLs
    const searchQuery = await gatherContext(task);

    // Step 2: If needed, perform the actual search
    if (searchQuery) {
      sendScoutLog(wsClient, `🔎 URL verification needed. Searching: "${searchQuery}"`);
      const searchResults = await performScout(searchQuery, wsClient);
      if (searchResults.length > 0) {
        scoutContext = {
          query: searchQuery,
          results: searchResults,
        };
      }
    } else {
      console.log('[Scout] ✓ Task uses well-known URLs. Skipping verification.');
    }
  } catch (error) {
    console.warn('[Planner] Scout phase failed, proceeding without context:', error);
  }

  // Format the scout context for injection
  const scoutContextText = formatScoutContext(scoutContext);
  sendScoutLog(wsClient, '📝 Scout phase complete. Generating final plan...');
  // =========================================================================
  // PHASE 2: GENERATE EXECUTION PLAN
  // =========================================================================

  const prompt = `
You are an expert Automation Strategist.
Your goal is to create a robust execution plan for a browser agent.

USER REQUEST: "${task}"
${scoutContextText}
### STEP 0: CLASSIFY THE TASK
Before planning, determine the task type:

**TYPE A — Simple Action** (e.g., "What is 2+2?", "Go to google.com", "Click the first link"):
- These need 1-3 steps. A search result page or a single page visit may be sufficient.

**TYPE B — Deep Research** (e.g., "Find the best 4K monitor under $500", "Compare React vs Vue", "What laptop should I buy for coding?"):
- These REQUIRE visiting multiple distinct pages (reviews, forums, comparison sites).
- A Google Search results page is NEVER the final answer for research tasks.
- You MUST include explicit steps to:
  1. Search for the topic
  2. Visit at least 2-3 credible sources (Reddit, specialized review sites, forums)
  3. Scroll down on each page to read full content (articles are long!)
  4. Synthesize findings into a final answer

**TYPE C — Transactional** (e.g., "Buy X", "Book a flight", "Sign up for Y"):
- Involves forms, carts, payments. May need authentication.

### INSTRUCTIONS:
1. **USE VERIFIED CONTEXT (If Provided)**:
   - If a "VERIFIED CONTEXT FROM GOOGLE SEARCH" section appears above, USE THOSE URLS.
   - Do NOT invent or guess URLs. If the search results show the correct login page or portal, use that exact URL.
   - Example: If search shows "UCSD WebReg → https://act.ucsd.edu/webreg2", your first step should be "Navigate to https://act.ucsd.edu/webreg2".

2. **MENTAL SIMULATION (The Strategy)**:
   - Before listing steps, "walk through" the website in your head.
   - Predict specific tools (e.g., "UCSD uses WebReg", "Amazon uses a Cart").
   - Anticipate "Gotchas" (e.g., "The 'Images' tab button becomes disabled when active", "Search results might be distinct from the home page").
   - For research tasks, identify which sites would have the best info (e.g., "For monitors: rtings.com, reddit.com/r/monitors, tomshardware.com").

3. **GENERATE STEPS**:
   - Create granular, atomic steps.
   - **DO NOT** assume the user needs to log in unless the task specifically requires private data (grades, shopping, settings).
   - If the task is just "Search", "Find info", or "Browse", DO NOT include a Login step.
   - **IMPORTANT**: If the user asks to "Find X and then click Y", ensure the first step is to Navigate/Search for X.
   - **FOR RESEARCH TASKS**: Include steps like "Visit [source] and scroll to read full content", "Navigate back and visit next source". The agent can SCROLL pages — use this!
   - **NEVER** end a research plan with just "View search results". Always include sub-page visits.

### RESPONSE FORMAT (Strict JSON):
{
  "strategy": "Your high-level analysis. State the task type (A/B/C) and your reasoning...",
  "steps": [
    {
      "id": 1,
      "title": "Short Objective (e.g. 'Navigate to WebReg')",
      "description": "Detailed visual description of what to look for (e.g. 'Find the search bar center screen').",
      "needsAuth": false,
      "targetUrl": "https://example.com/verified-url (OPTIONAL: Only include if you have a VERIFIED URL from the search results above. Do NOT guess URLs.)"
    }
  ]
}
`.trim();




  try {
    const model = 'gemini-2.5-flash';
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2 },
      }),
    });

    const json = (await res.json()) as any;
    const rawText: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!rawText) return heuristicPlan(task);

    // FIX: Use Regex to extract JSON from Markdown code blocks
    const jsonRegex = /```json\s*([\s\S]*?)\s*```/;
    const match = rawText.match(jsonRegex);
    
    // Use extracted content if found, otherwise use raw text
    const cleanText = match ? match[1] : rawText;

    // Find the start and end of the JSON object
    const start = cleanText.indexOf('{');
    const end = cleanText.lastIndexOf('}');
    
    if (start === -1 || end === -1 || end <= start) return heuristicPlan(task);

    const parsed = JSON.parse(cleanText.slice(start, end + 1));
    const validated = PlanSchema.safeParse(parsed);
    
    if (!validated.success) {
      console.warn('[Planner] Invalid JSON schema:', validated.error);
      return heuristicPlan(task);
    }

    // Apply the "[AGENT]" tags if Gemini forgot them
    return validated.data
  } catch(error) {
    console.error('❌ PLANNER ERROR:', error);
    return heuristicPlan(task);
  }
}

