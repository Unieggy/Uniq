# The Story of Uniq

## About the Project

It started with a video. I watched OpenAI demo their "Atlas" agent navigating the web like a human would. Clicking through pages, filling forms, researching topics. It felt like magic. And I thought: *I want to build that myself.*

Not a wrapper around an API. Not a simple script. A real agent that can reason, plan, and act.

The original plan was to use GPT-4 as the brain. But then I stumbled upon the Gemini Hackathon with its "No Limits" theme. I had been curious about Gemini 2.5 Flash for a while. Could it handle the speed and reasoning demands of real-time browser automation? There was only one way to find out.

So I pivoted. The brain would be Gemini.

The goal was ambitious but clear: build an agent that does not just click buttons. It should **research**. It should **read**. It should scroll through articles, visit multiple sources, and synthesize information like a human researcher would.

The architecture is an Orchestrator-Worker pattern. A central Node.js orchestrator maintains session state, manages the browser via Playwright, and coordinates the agent loop. The agent follows a classic cognitive cycle:

$$
A(s_t) = \text{argmax}_a \; P(\text{success} \mid s_t, a, \pi_\theta)
$$

Where $s_t$ is the current page state (DOM regions, URL, visible text), $a$ is a candidate action (click, type, scroll), and $\pi_\theta$ represents the Gemini-powered policy that scores actions based on the current objective.

In practice, this manifests as a multi-phase loop: **OBSERVE** the page, **AUTO-RECOVER** from failed submissions, **AUTO-SCROLL** using semantic content detection, **DECIDE** the next action, **ACT** on the browser, **VERIFY** the result, and for research tasks, **SYNTHESIZE** findings into a final answer.

---

## How I Built It

The stack is TypeScript end-to-end. The orchestrator runs on Node.js with Playwright controlling a headless (or headed) Chromium browser. The frontend is a Vite-powered UI with WebSocket streaming so you can watch the agent work in real time.

The key insight was separating *planning* from *execution*. When a user submits a task like "Find the best 4K monitor under $500", the first thing the system does is call Gemini to generate a multi-step plan:

1. Navigate to Google
2. Search for "best 4K monitor under $500 reviews"
3. Visit rtings.com and scroll to read the full article
4. Navigate back and visit reddit.com/r/monitors
5. Synthesize findings

Each step becomes an "objective" that the agent pursues until completion, then moves to the next.

The DOM is scanned for interactive regions (buttons, links, inputs, textareas) using Playwright selectors with a cursor:pointer fallback for custom elements. Each region is tagged with a stable `data-agent-id` attribute directly on the DOM node, so the locator survives dynamic page changes. Regions carry semantic metadata: a human-readable label, a role (button, input, textarea, link, etc.), and optionally an href. These regions are passed to Gemini along with 4000 characters of visible page text and the current objective. Gemini returns a structured action (click region "element-abc123", type "mechanical keyboard", scroll down). The action is executed with human-like cursor physics and verified.

SQLite logs every session, every step, every decision. If something goes wrong, you can trace exactly what the agent saw and why it made that choice.

---

## The Challenges

Each bug was a lesson in how fragile browser automation really is.

### The Zombie Page

Sometimes the agent would click a link that opened a new tab. The browser would dutifully open that tab. But the agent kept operating on the original page. A ghost page. A zombie.

The fix: before every loop iteration, grab the newest page and update all references. Always track the newest tab. Never let the agent operate on a zombie.

### The Lazy Agent

When I asked the agent to research a topic, it would go to Google, type the query, see the search results, and declare: "Objective complete." That is not research. That is a Google search.

The fix was prompt engineering: explicit task classification (simple action vs. deep research vs. transactional), a "mental simulation" requirement where Gemini walks through the site in its head before generating steps, and a hard rule that search results pages are never the final answer.

### The Phantom Click

The agent would scan the page, find 144 interactive elements, and tell Gemini to click a video thumbnail. But the click would hit a completely different element — a hidden "Confirm" button inside the YouTube player.

The root cause was subtle. Playwright's `.all()` returns positional locators (`.nth(94)` = the 94th match). Between scan time and click time, YouTube dynamically loaded player controls, shifting every index. `.nth(94)` silently drifted to the wrong element.

The fix was identity-based locators. During scan, each element is stamped with a `data-agent-id` attribute directly on the DOM node. The stored locator uses `[data-agent-id="element-abc123"]` — an attribute selector that finds the exact same node regardless of what the page adds or removes afterwards.

### The Premature DONE

When Gemini returned a malformed response (missing `confidence` field, broken JSON), the heuristic fallback immediately returned DONE. This cascaded — every remaining objective was skipped because the agent thought the task was finished.

The fix was two-fold: auto-patch malformed responses (fill in missing `confidence` with 0.5 instead of discarding the action), and replace the instant DONE fallback with a graduated strategy (SCROLL → WAIT → then DONE). Three chances to recover instead of zero.

### The Zombie Step

The agent was too smart for its own plan. While executing step 0 ("Navigate to YouTube"), it saw the search bar, searched, and clicked the video — accomplishing steps 1, 2, and 3 in one go. But the plan controller only advanced one step. So it forced the agent to re-execute step 1 ("Type search query") on the video page.

The fix was fast-forward logic: after each objective completes, check if subsequent steps are already accomplished by the current URL. Skip them instead of re-executing. The agent should never redo work it already did.

### The SPA Graveyard

On LinkedIn and YouTube, `scanPage()` would find 0 interactive elements. The page had navigated, but React had not hydrated yet. With no elements to interact with, the agent gave up.

The fix was a retry with patience: if 0 regions are found on a real page, wait for network idle plus 3 seconds, then scan again. Heavy SPAs need time.

### The Stability Trap

`waitForStability()` waited for `networkidle` — but sites like Amazon and YouTube never go idle. Analytics pings, ad tracking, WebSocket heartbeats. The agent would stall for 5 seconds after every single action, and the function was being called twice (once in the callback, once in verify).

The fix: cap the networkidle wait at 1.5 seconds, and remove the duplicate call. The agent went from sluggish to responsive.

---

## What I Learned

Building this taught me things I could not have learned from tutorials.

**Latency is the enemy of agency.** When Gemini takes 2 seconds to respond, the agent feels sluggish. When it takes 200ms, the agent feels alive. Gemini 2.5 Flash delivered on speed in a way that made the whole system feel responsive. This matters more than I expected. An agent that thinks too slowly stops feeling like an agent.

**LLMs are lazy by default.** They will find the shortest path to something that looks like success. If you want thorough behavior, you have to demand it explicitly. You have to close every loophole in the prompt. "Research" means nothing to a model. "Visit at least 3 distinct sources and scroll to read full content" means something.

**LLMs are also fragile.** They will randomly omit a required JSON field, return broken syntax, or hallucinate an element ID. You cannot treat LLM output as reliable. You must auto-patch, validate, and have graduated fallbacks. The system should degrade gracefully, not crash.

**State management is everything.** The browser is stateful. Tabs open and close. Pages navigate. Elements appear and disappear. The DOM shifts under your feet. Positional references go stale. The agent must constantly re-observe its environment. The moment it relies on stale state, it becomes a zombie operating on ghosts.

**The agent will outrun its plan.** A smart LLM will accomplish multiple plan steps in a single execution. The orchestrator must detect this and fast-forward instead of forcing the agent to redo work. The plan is a guide, not a prison.

**The 80/20 rule is real.** Getting the basic loop working took 20% of the time. Handling edge cases (new tabs, lazy completions, network timeouts, authentication flows, SPA hydration, dynamic DOM shifts, noisy network idle) took the other 80%. The demos always look easy. The production code never is.

I am proud of what this became. A pure DOM-based agent — no vision model, no screenshots for decision-making — that navigates the real web. It can research topics across multiple sources and synthesize findings. It handles SPAs, dynamic content, multi-language queries, and authentication flows. It knows when to ask for human help and when to proceed on its own.

It is not Atlas, it is mine. And it works.

---

*Built with Gemini 2.5 Flash, Playwright, TypeScript, and too much coffee.*
