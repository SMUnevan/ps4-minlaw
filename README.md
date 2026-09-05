# Case Compass

**A responsible AI case-preparation companion for self-represented persons — with a bias-resistant role-play stress test, a cited Learning Hub, and a moderated anonymous legal forum. Available in English, 中文, Bahasa Melayu and தமிழ்.**

Built for the **SMU LIT Legal-Tech Hackathon 2026 — Problem Statement 4 (Ministry of Law)**.

> A responsible AI case-preparation companion that does not just help self-represented persons build their case — it challenges their assumptions, exposes missing evidence, and prepares them for the questions and counterarguments they may face.

## Why this exists

People preparing a small claim on their own increasingly turn to general-purpose chatbots. The risk isn't a wrong answer — it's an *unchallenged* one: omitted facts, reinforced assumptions, unverifiable claims. Case Compass focuses on **guided preparation**, not answers: it organises a dispute into facts / evidence / law, argues against the user, and then connects them to people who faced the same problem and to the concepts behind it.

## The four parts

### 1. Guided case preparation
Structured intake asks targeted follow-up questions, then produces a **Fact–Evidence–Law map** (every item tagged Supported / Uncertain / Missing) and a neutral **Case Readiness Report** — supported points, weak points, missing documents, and the counterarguments the other side is likely to make. It never predicts an outcome.

It also routes correctly: employment and salary claims are told to start at **TADM**, not the Small Claims Tribunals.

### 2. Role-play stress testing (the differentiator)
- **Opposing Party Mode** — the AI argues as the other side would.
- **Tribunal Questioning Mode** — probing questions that expose unclear facts. It explicitly does not impersonate a judge or predict a ruling.
- **Post-simulation report** — each answer is classified as *held up* / *could be stronger* / *weak*, with concrete preparation actions.

### 3. Learning Hub — bite-sized, and cited
11 short lessons across 4 tracks, each 2–4 minutes with a quick check and progress tracking. **Every lesson cites the actual statute or judgment it is based on**, with a link to the primary source, and is summarised in plain language rather than paraphrased from a secondary site. Singapore cases used include:

| Case | Used for |
|---|---|
| *Chwee Kin Keong v Digilandmall.com Pte Ltd* [2005] SGCA 2; [2005] 1 SLR(R) 502 | Unilateral mistake in online pricing — the $66 laser printer |
| *Spandeck Engineering (S) Pte Ltd v DSTA* [2007] SGCA 37; [2007] 4 SLR(R) 100 | The two-stage test for duty of care |
| *See Toh Siew Kee v Ho Ah Lam Ferrocement (Pte) Ltd* [2013] SGCA 29; [2013] 3 SLR 384 | Occupiers' liability folded into the Spandeck test |
| *Gay Choon Ing v Loh Sze Ti Terence Peter* [2009] SGCA 3; [2009] 2 SLR(R) 332 | The elements of contract formation |

Statutes cited link to Singapore Statutes Online: [Small Claims Tribunals Act 1984](https://sso.agc.gov.sg/Act/SCTA1984), [Consumer Protection (Fair Trading) Act 2003](https://sso.agc.gov.sg/Act/CPFTA2003), [Limitation Act 1959](https://sso.agc.gov.sg/Act/LA1959), [Employment Act 1968](https://sso.agc.gov.sg/Act/EmA1968). Procedure is cited to the [Singapore Judiciary](https://www.judiciary.gov.sg/civil/small-claims) and [TADM](https://www.tal.sg/tadm/know-your-options).

### 4. Community Forum — anonymous, expert-answered, moderated
Members of the public ask legal questions **anonymously**; answers come from **verified legal professionals** and are published only after approval by a public legal body (the model assumes a body such as **Pro Bono SG** or **MinLaw** as moderator). Threads are public so others with the same problem can find them.

Anonymity is enforced, not just promised: `src/lib/forumStore.js` **redacts NRIC/FIN numbers, emails and phone numbers before the question is stored**, and tells the user what was removed.

> The seeded threads are clearly labelled **demonstration content** in the UI and in the data file. They are illustrative examples written for this prototype, not real advice given to real people.

### Cross-linking: the AI points you at real discussions and lessons
After the readiness report, Case Compass surfaces **"People who faced something similar"** — matched forum threads — and **"Learn the concepts behind your case"** — matched lessons, each with a visible *why this matches* reason. This is deliberately **deterministic** (`src/ai/matcher.js`): the model never invents a reference, it only ever points at content that exists.

### Languages
Full interface, intake questions, role-play, reports, legal concepts and lessons in **English, 中文, Bahasa Melayu and தமிழ்**, switchable at any time — the case map rebuilds in the new language rather than showing a stale translation. The offline rule engine classifies free text in all four languages (`data/keywords.json`), including negation ("but no receipt", "但没有收据", "ரசீது இல்லை"). English is stated in-product as the authoritative version.

## Responsible-AI design, and where it lives in the code

| Brief requirement | Implementation |
|---|---|
| No black-box legal conclusions | Every legal point in `data/legal-concepts.json` and every lesson carries `sources` (linking to SSO / eLitigation / Judiciary), a `verify` note, and a `confidence` flag rendered in the UI as *verified source* or *general principle*. |
| Confirmation-bias mitigation | Counterarguments are first-class data per dispute type; the entire role-play system exists to argue against the user. |
| Information, not representation | `RESPONSIBLE_AI_PREAMBLE` in `src/ai/llmEngine.js` forbids predicting outcomes, impersonating a judge, and inventing citations. The same limits appear in the UI disclaimers and footer. |
| User-input limitations | Stated on the landing page and in every generated report's `disclaimer`. |
| Anonymity (forum) | Server-side PII redaction before storage, plus a pending-moderation state so nothing is published as an answer without a verified professional and a moderator. |

## Architecture

Dependency-light and no build step, so it is trivial to run and to judge: **Node/Express + vanilla HTML/CSS/JS**.

```
server.js                     Express app: static serving + REST API
src/lib/i18n.js               Language resolution and content localisation
src/lib/content.js            Loads Learning Hub tracks from data/lessons/*.json
src/lib/forumStore.js         Forum state + PII redaction + moderation status
src/lib/caseStore.js          In-memory per-case state
src/ai/engine.js              Records provider output and builds deterministic maps
src/ai/rulesEngine.js         Self-contained multilingual fact-map and fallback engine
src/ai/llmEngine.js           Provider-neutral request templates, grounded in the knowledge base
src/ai/matcher.js             Deterministic case → forum thread / lesson matching
data/legal-concepts.json      Cited knowledge base (4 languages)
data/lessons/*.json           Learning Hub content, one file per track
data/forum-threads.json       Seeded demonstration threads
data/i18n.json                UI and engine strings
data/keywords.json            Multilingual keyword matching for the offline engine
scripts/smoke-test.js         65-check end-to-end API test
public/                       Frontend
```

### Bring your own AI key
Case Preparation uses a Gemini or OpenRouter key configured in the in-app **Settings** tab. The key is stored only in that browser's local storage, masked in the UI, and sent directly to the selected provider. It is never sent to or stored by the Case Compass server. The Fact–Evidence–Law map remains deterministic so it is an exact, auditable breakdown of the user's input; related threads and lessons are also deterministic, so references cannot be invented.

## Running it

```bash
npm install
npm start
```

Open **http://localhost:3000**, then configure a Gemini or OpenRouter key in **Settings** before starting Case Preparation. No API key belongs in `.env`.

Run the test suite against a running server:

```bash
npm test
```

Requires Node.js 14.18+ (`npm run dev` uses `node --watch`, which needs Node 18+).

## Scope notes (honest about what this is)

- Case and forum state is in-memory; restarting the server clears it. A production build would swap in a database behind the same interfaces.
- The knowledge base and lesson set are a curated starter set, not a legal-research product. Every entry is deliberately marked with what to verify and where.
- Forum answers are seeded demonstration content, labelled as such in the UI. The moderation and verification workflow is modelled, not connected to a real panel of lawyers.
- Non-English content is written for plain meaning and is not a certified translation; the product states in-product that English is authoritative.
- Citations were checked against primary sources in September 2026. eLitigation was under scheduled maintenance at the time of the final link check, so judgment links follow eLitigation's documented URL scheme (verified against three separately indexed judgments).
