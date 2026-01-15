import {config} from '../config.js';
import { PlanSchema } from './schemas.js';
function heuristicPlan(task: string): string[] {
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
  const raw = parts.length > 0 ? parts.slice(0, 6) : [task];
  return enforceTags(task, raw);
}
function enforceTags(task: string, plan: string[]): string[] {
  const needsLogin = /sign\s*in|log\s*in|login/i.test(task.toLowerCase());

  // Tag every step if missing
  const tagged = plan.map(s => {
    const x = s.trim();
    if (x.startsWith('[HUMAN]') || x.startsWith('[AGENT]')) return x;
    return `[AGENT] ${x}`;
  });

  // Ensure human login step exists if needed
  const hasHumanLogin = tagged.some(
    s => s.startsWith('[HUMAN]') && /sign\s*in|log\s*in|login|mfa|otp|2fa/i.test(s)
  );

  if (needsLogin && !hasHumanLogin) {
    return ['[HUMAN] Sign in', ...tagged].slice(0, 6);
  }

  return tagged.slice(0, 6);
}

export async function planTaskWithGemini(task: string): Promise<string[]> {
  const apiKey = config.llm?.geminiApiKey;
  if (!apiKey || apiKey.startsWith('AIzaSyDbLt')){ 
    console.warn('Gemini API key not set or is a placeholder. Using heuristic planner.');
    return heuristicPlan(task)};

  const prompt = `
You are a PLANNER for a browser automation agent.
Your job is to break a high-level user task into a linear list of sequential steps.

USER TASK: "${task}"

RULES:
1. RESPONSE FORMAT: You must return ONLY a JSON object: { "plan": string[] }
2. STEPS: Max 6 steps. Keep them short and concise.
3. TAGS:
   - Use "[HUMAN]" for steps requiring user interaction (Login, OTP, MFA, CAPTCHA, Payment).
   - Use "[AGENT]" for steps the browser can do (Search, Click, Read, Navigate).
4. LOGIN: If the task implies a specific service (like "Order Amazon"), assume the user is NOT logged in.
   - Step 1 MUST be: "[HUMAN] Sign in and complete any MFA prompts"
   - Do NOT ask for credentials in the plan.

EXAMPLE JSON:
{
  "plan": [
    "[HUMAN] Sign in and complete any MFA prompts",
    "[AGENT] Search for 'ps5 console'",
    "[AGENT] Click the first result",
    "[AGENT] Click 'Add to Cart'"
  ]
}

Respond with the JSON now.
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
    return enforceTags(task, validated.data.plan);
  } catch(error) {
    console.error('❌ PLANNER ERROR:', error);
    return heuristicPlan(task);
  }
}

