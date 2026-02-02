import {config} from '../config.js';
import { PlanSchema,PlanResult } from './schemas.js';

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

export async function planTaskWithGemini(task: string): Promise<PlanResult> {
  const apiKey = config.llm?.geminiApiKey;
  if (!apiKey || apiKey.startsWith('AIzaSyDbLt')){ 
    console.warn('Gemini API key not set or is a placeholder. Using heuristic planner.');
    return heuristicPlan(task)};

  const prompt = `
You are an expert Automation Strategist.
Your goal is to create a robust execution plan for a browser agent.

USER REQUEST: "${task}"

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
1. **MENTAL SIMULATION (The Strategy)**:
   - Before listing steps, "walk through" the website in your head.
   - Predict specific tools (e.g., "UCSD uses WebReg", "Amazon uses a Cart").
   - Anticipate "Gotchas" (e.g., "The 'Images' tab button becomes disabled when active", "Search results might be distinct from the home page").
   - For research tasks, identify which sites would have the best info (e.g., "For monitors: rtings.com, reddit.com/r/monitors, tomshardware.com").

2. **GENERATE STEPS**:
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
      "title": "Short Objective (e.g. 'Navigate to Google')",
      "description": "Detailed visual description of what to look for (e.g. 'Find the search bar center screen'). For research steps, specify: what content to look for, how far to scroll, and what info to extract.",
      "needsAuth": false
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

