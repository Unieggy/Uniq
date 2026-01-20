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

### INSTRUCTIONS:
1. **MENTAL SIMULATION (The Strategy)**: 
   - Before listing steps, "walk through" the website in your head.
   - Predict specific tools (e.g., "UCSD uses WebReg", "Amazon uses a Cart").
   - Anticipate "Gotchas" (e.g., "The 'Images' tab button becomes disabled when active", "Search results might be distinct from the home page").

2. **GENERATE STEPS**:
   - Create granular, atomic steps.
   - **DO NOT** assume the user needs to log in unless the task specifically requires private data (grades, shopping, settings).
   - If the task is just "Search", "Find info", or "Browse", DO NOT include a Login step.
   - **IMPORTANT**: If the user asks to "Find X and then click Y", ensure the first step is to Navigate/Search for X.

### RESPONSE FORMAT (Strict JSON):
{
  "strategy": "Your high-level analysis of the workflow and tool prediction...",
  "steps": [
    {
      "id": 1,
      "title": "Short Objective (e.g. 'Navigate to Google')",
      "description": "Detailed visual description of what to look for (e.g. 'Find the search bar center screen').",
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

