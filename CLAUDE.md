# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Purpose

**Rethink** — PM Career Intelligence Platform. Helps PM candidates prep for interviews by:
1. Generating grounded company briefs (pre-verified facts for 6 Indian startups)
2. Mining the candidate's real work via Story Intelligence probing
3. Running AI mock interviews (Founder Round + Discovery Round)
4. Scoring answers across an 11-dimension rubric and tracking progress over sessions

## Stack

- **Framework:** Next.js 14 (pages router) — Vercel-native
- **AI:** Groq API (`llama-3.3-70b-versatile`) via server-side proxy at `pages/api/chat.js`
- **Frontend:** React (inline styles only, no CSS framework)
- **Deploy:** Vercel

## Commands

```bash
npm install          # first-time setup
npm run dev          # dev server at http://localhost:3000
npm run build        # production build
npm start            # run production build locally
```

## Architecture

```
pages/
  index.jsx            — loads RethinkApp dynamically (ssr: false)
  api/
    chat.js            — Groq proxy; reads GROQ_API_KEY from env; never exposed to client
components/
  RethinkApp.jsx       — entire app in one file; all state in root App component
```

### Key design decisions

- **All AI calls go through `/api/chat`** — keeps `GROQ_API_KEY` server-side only.
- **`callGroq*` functions + aliases** — internal names are `callGroq/callGroqJSON/callGroqJSONCached/callGroqWithSearchJSON`; the rest of the component uses the original `callClaude*` alias names.
- **No live web search** — Groq has no server-side search tool; custom company lookup uses model training knowledge with an honest caveat badge.
- **Pre-verified company facts** (`COMPANY_FACTS` in `RethinkApp.jsx`) — hardcoded, manually QA'd data for 6 companies (Swiggy, Zepto, Razorpay, Flipkart, CRED, Meesho). These are the source of truth for the preset company briefs; Claude only organizes them, never invents.

## Environment

`.env.local` — copy from `.env.local.example`:
```
GROQ_API_KEY=gsk_...
```
On Vercel: set `GROQ_API_KEY` in Project Settings → Environment Variables.

## Context

- Owner: Ravi Kiran Kunduri — Sr. PO at Broadcom, targeting Head of PM by April 2028
- Related vault: `G:\My Drive\vault\06-Interview-Prep\`
- Top target: ServiceNow Bangalore Sr. Staff Inbound PM (fit 88/100)
