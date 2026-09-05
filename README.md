# Case Compass

**A responsible AI case-preparation companion for self-represented persons (SRPs), with a role-play stress-test mode and a separate Legal Literacy Hub.**

Built for the **SMU LIT Legal-Tech Hackathon 2026 — Problem Statement 4 (Ministry of Law)**.

> One-sentence pitch: A responsible AI case-preparation companion that does not just help self-represented persons build their case — it challenges their assumptions, exposes missing evidence, and prepares them for the questions and counterarguments they may face.

## Why this exists

People preparing a small claim on their own increasingly turn to general-purpose chatbots. The risk isn't a wrong answer — it's an *unchallenged* one: omitted facts, reinforced assumptions, unverifiable claims. Case Compass focuses on **guided preparation**, not answers: it organises a dispute into facts/evidence/law, then actively argues against the user (as the opposing party, or as a probing tribunal) before a real hearing does.

## Demo flow (matches the problem statement's suggested flow)

1. **Structured intake** — describe the dispute in plain language; targeted follow-up questions fill gaps (dispute type, amount, evidence, prior contact, desired outcome, timeline).
2. **Fact–Evidence–Law map** — everything is organised and tagged **Supported / Uncertain / Missing**, with legal concepts linked to a named source to verify.
3. **Case Readiness Report** — a neutral view: strengths, weaknesses, missing info, documents to gather, possible counterarguments. It never predicts a result.
4. **Stress-test** — **Opposing Party Mode** (AI argues as the other side) or **Tribunal Questioning Mode** (AI probes for gaps; explicitly does not impersonate a real judge).
5. **Post-simulation report** — which answers held up, which were weak, and what to prepare next.
6. **Legal Literacy Hub** — a separate, "Duolingo for law"-style set of short lessons, recommended based on the dispute type but always accessible standalone, so an active dispute is never trivialised.

## Responsible-AI design, and where it lives in the code

| Brief requirement | Where it's implemented |
|---|---|
| No black-box legal conclusions | `data/legal-concepts.json` — every legal point carries a `verify` field naming the source to check, and a `confidence` flag. Rendered directly in the UI under "Relevant Law & Process". |
| Confirmation-bias mitigation | `disputeTypes[].counterarguments` in the knowledge base + the entire role-play system (`src/ai/rulesEngine.js`, `src/ai/llmEngine.js`) is built to argue *against* the user, not validate them. |
| Information, not representation | Every AI system prompt (`RESPONSIBLE_AI_PREAMBLE` in `src/ai/llmEngine.js`) explicitly forbids predicting outcomes or impersonating a judge; the same disclaimer is shown in the UI (`disclaimer-footer`, per-report disclaimers, role-play mode banners). |
| Depends on user input | Stated in the landing page principles and in every generated Case Readiness Report's `disclaimer` field. |

## Architecture

Deliberately dependency-light so it's trivial to run and judge: **Node/Express backend + vanilla HTML/CSS/JS frontend**, no build step.

```
server.js                 Express app: static file serving + REST API
src/lib/caseStore.js       In-memory per-case state (fine for a hackathon demo)
src/ai/engine.js           Picks LLM vs rule-based per call, with automatic fallback
src/ai/rulesEngine.js      Fully self-contained deterministic engine (no network calls)
src/ai/llmEngine.js        Optional Claude-backed engine (used only if an API key is set)
data/legal-concepts.json   Small curated knowledge base (Singapore SCT-flavoured)
data/literacy-lessons.json Legal Literacy Hub content
public/                    Frontend (index.html, css/styles.css, js/app.js)
```

### Why a pluggable AI engine

The rule-based engine (`src/ai/rulesEngine.js`) runs the **entire product end-to-end with zero external calls** — no API key, no network dependency, no risk of a live-demo failure from rate limits or connectivity. It does real extraction (dispute type, amounts, evidence, negation-aware evidence detection, prior contact, desired outcome) from free text, not just canned responses.

If `ANTHROPIC_API_KEY` is set (see `.env.example`), `src/ai/engine.js` automatically routes every call through Claude instead, for more dynamic intake questions, case analysis, and role-play — while still grounding legal content in the same curated knowledge base to avoid hallucinated statutes. **Any LLM failure (bad JSON, network error, rate limit) transparently falls back to the rule engine for that single call**, so the app never breaks mid-demo. The running engine is shown live in the top-right badge.

## Running it

```bash
npm install
npm start
```

Then open **http://localhost:3000**. No API key or `.env` file is required — it runs fully offline out of the box.

To enable the Claude-backed engine instead, copy `.env.example` to `.env` and set `ANTHROPIC_API_KEY`.

Requires Node.js 14.18+ (tested on 14.16 and up via the `uuid` package for broad compatibility).

## Scope notes (honest about what this is)

- State is in-memory (`src/lib/caseStore.js`) — restarting the server clears active cases. A production build would swap in a real database behind the same interface.
- The legal knowledge base (`data/legal-concepts.json`) is intentionally small, general, and marked "needs verification" — it is a demonstration of the *pattern* (cite + flag uncertainty), not a legal-research product.
- Per the hackathon's judging weighting (technical feasibility 30%, relevance 25%, innovation 25%, presentation 20%), this MVP leads with the case-preparation + stress-testing workflow and treats the Literacy Hub as the secondary feature, per the brief's own suggested scoping.
