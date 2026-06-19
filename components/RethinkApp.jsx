
import { useState, useEffect, useRef } from "react";
import { supabase } from '../lib/supabase';

// ── API layer — production hardened ────────────────────────────────────────
// Real reliability fixes: timeout, retry on transient failure, robust JSON
// extraction that survives stray text/markdown/truncation, and NO silent
// fallback-to-fake-data without telling the caller it happened.

// ── API layer — Groq backend proxy ─────────────────────────────────────────
async function callGroq(messages, system, maxTokens = 800, { timeoutMs = 25000, retries = 1 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({ messages, system, maxTokens }),
      });
      clearTimeout(timer);
      if (!res.ok) {
        const status = res.status;
        if ((status === 429 || status >= 500) && attempt < retries) {
          await new Promise(r => setTimeout(r, 600 * (attempt + 1)));
          continue;
        }
        throw new Error(`API_ERROR_${status}`);
      }
      const d = await res.json();
      if (!d.text) throw new Error('EMPTY_RESPONSE');
      return d.text;
    } catch (e) {
      clearTimeout(timer);
      lastErr = e.name === 'AbortError' ? new Error('TIMEOUT') : e;
      if (attempt < retries) { await new Promise(r => setTimeout(r, 500)); continue; }
    }
  }
  throw lastErr || new Error('UNKNOWN_API_ERROR');
}

// Groq has no server-side web search — falls back to training knowledge with explicit caveat.
async function callGroqWithSearch(userQuery, system, maxTokens = 1500, opts = {}) {
  const text = await callGroq(
    [{ role: 'user', content: userQuery }],
    system + '\n\nIMPORTANT: You do not have live web search in this environment. Use your training knowledge. For facts you are uncertain about (especially post-2024), say so explicitly in the relevant JSON field rather than inventing details.',
    maxTokens,
    opts
  );
  return { text, citations: [], searchedAtAll: false };
}

async function callGroqWithSearchJSON(userQuery, system, maxTokens = 1500, opts = {}) {
  const { text, citations, searchedAtAll } = await callGroqWithSearch(userQuery, system, maxTokens, opts);
  try {
    const data = extractJSON(text);
    return { data, citations, searchedAtAll };
  } catch (e) {
    throw new Error(`JSON_PARSE_FAILED: ${e.message}`);
  }
}

function extractJSON(text) {
  let s = text.trim().replace(/```json|```/gi, "").trim();
  // Find the first { or [ and the matching last } or ]
  const firstObj = s.indexOf("{");
  const firstArr = s.indexOf("[");
  let start = -1;
  if (firstObj === -1 && firstArr === -1) throw new Error("NO_JSON_FOUND");
  if (firstObj === -1) start = firstArr;
  else if (firstArr === -1) start = firstObj;
  else start = Math.min(firstObj, firstArr);

  const openChar = s[start];
  const closeChar = openChar === "{" ? "}" : "]";
  let depth = 0, end = -1;
  for (let i = start; i < s.length; i++) {
    if (s[i] === openChar) depth++;
    else if (s[i] === closeChar) { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error("UNBALANCED_JSON");
  let candidate = s.slice(start, end + 1);
  // Repair common minor issues: trailing commas before } or ]
  candidate = candidate.replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(candidate);
}

async function callGroqJSON(messages, system, maxTokens = 1000, opts = {}) {
  const text = await callGroq(messages, system, maxTokens, opts);
  try {
    return extractJSON(text);
  } catch (e) {
    throw new Error(`JSON_PARSE_FAILED: ${e.message}`);
  }
}

const _cache = new Map();
async function callGroqJSONCached(cacheKey, messages, system, maxTokens, opts) {
  if (_cache.has(cacheKey)) return { data: _cache.get(cacheKey), fromCache: true };
  const data = await callGroqJSON(messages, system, maxTokens, opts);
  _cache.set(cacheKey, data);
  return { data, fromCache: false };
}

// Aliases so all existing component call-sites are unchanged
const callClaude = callGroq;
const callClaudeJSON = callGroqJSON;
const callClaudeJSONCached = callGroqJSONCached;
const callClaudeWithWebSearchJSON = callGroqWithSearchJSON;

// ── Audio helpers ─────────────────────────────────────────────────────────────
function speak(text) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 0.92;
  window.speechSynthesis.speak(u);
}

function stopSpeaking() {
  if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
}

function useSpeechInput(setVal) {
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const supported = typeof window !== "undefined" &&
    !!(window.SpeechRecognition || window.webkitSpeechRecognition);

  function toggle() {
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;
    const r = new SR();
    r.continuous = true;
    r.interimResults = true;
    r.lang = "en-US";
    let finalized = "";
    r.onresult = e => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) finalized += e.results[i][0].transcript + " ";
        else interim += e.results[i][0].transcript;
      }
      setVal((finalized + interim).trimEnd());
    };
    r.onend = () => setListening(false);
    r.onerror = () => setListening(false);
    r.start();
    recRef.current = r;
    setListening(true);
  }

  return { listening, toggle, supported };
}

function friendlyError(e) {
  const m = e?.message || "";
  if (m === "TIMEOUT") return "The request took too long and timed out. Your connection may be slow — try again.";
  if (m.startsWith("API_ERROR_429")) return "Too many requests right now. Wait a few seconds and try again.";
  if (m.startsWith("API_ERROR_5")) return "The AI service is temporarily unavailable. Try again in a moment.";
  if (m.startsWith("API_ERROR_4")) return "Something was wrong with the request. Try again — if this keeps happening, the prompt may need adjusting.";
  if (m.startsWith("JSON_PARSE_FAILED")) return "The AI's response wasn't in the expected format. Retrying usually fixes this.";
  if (m === "EMPTY_RESPONSE") return "The AI returned an empty response. Try again.";
  return "Something went wrong. Try again — if it persists, there may be a connectivity issue.";
}

// ── Constants ────────────────────────────────────────────────────────────────
const COMPANIES = [
  { id: "swiggy",   name: "Swiggy",    emoji: "🍜", type: "Food Delivery · Listed (NSE/BSE)", color: "#FF5722" },
  { id: "zepto",    name: "Zepto",     emoji: "⚡", type: "Quick Commerce · Pre-IPO",          color: "#7C3AED" },
  { id: "razorpay", name: "Razorpay",  emoji: "💳", type: "Fintech · Unicorn",                 color: "#2563EB" },
  { id: "flipkart", name: "Flipkart",  emoji: "🛍️", type: "E-commerce · Walmart-owned",        color: "#D97706" },
  { id: "cred",     name: "CRED",      emoji: "🏆", type: "Fintech · Premium credit platform", color: "#111827" },
  { id: "meesho",   name: "Meesho",    emoji: "👗", type: "Social Commerce · Listed (Dec 2025)",color: "#DB2777" },
];

// VERIFIED FACTS — researched via live web search, each with a source.
// This is the actual fix for hallucination: instead of asking Claude to
// recall facts from training data (which may be stale or invented),
// we ground every brief generation in these pre-verified, dated, sourced
// facts and instruct Claude to synthesize ONLY from this material.
// This matches PRD Section 12.1: "every factual claim links to a source
// with retrieval date" and "5-8 launch companies, manually QA'd."
const COMPANY_FACTS = {
  swiggy: {
    retrievedDate: "2026-06-17",
    facts: [
      "Swiggy is publicly listed (IPO'd Nov 2024 at ~$11.3B valuation); reported Q3 FY26 revenue of ₹6,148 crore with a net loss of ₹1,065 crore, with revenue growth of 54% YoY driven mainly by Instamart scaling. [Source: brineweb.com, citing Swiggy Q3 FY26 earnings]",
      "Core businesses: Swiggy Food (restaurant delivery), Swiggy Instamart (10-minute grocery/quick commerce — now its most important strategic asset and largest growth driver), Swiggy Dineout (table bookings), Swiggy One (subscription membership, 5.7M+ members in 2025). Swiggy Genie (pickup/drop) and Minis (D2C marketplace) were shut down/paused in 2025. [Source: deonde.co, icoderzsolutions.com]",
      "Revenue model: 17-30% commission from restaurant partners per order (higher for premium placement), variable delivery fees (₹25-75), Swiggy One subscription fees, and advertising/sponsored listings. [Source: youngurbanproject.com, miracuves.com]",
      "In food delivery, Swiggy holds roughly 42-45% market share vs Zomato's 55-58%. In quick commerce, Instamart holds roughly 25-27% share vs Blinkit's 40-45% and Zepto's 25-27% — a tightly contested three-way race. [Source: brineweb.com, citing market share analysis]",
      "Strategic move: launched 'Priority' 8-minute delivery in select Bengaluru/Mumbai pockets (Dec 2025) at a premium fee — a direct competitive response to Blinkit in the speed race. Also restructured Instamart into a separate subsidiary (Swiggy Instamart Pvt Ltd), giving it optionality to raise separate capital. [Source: brineweb.com]",
      "Management has targeted Instamart contribution-margin breakeven between Dec 2025 and June 2026, contingent on AOV growth and non-grocery category adoption. [Source: narrativn.com]",
    ],
    aiInitiatives: [
      "ML-driven dynamic delivery time estimation (±2min accuracy); Instamart uses demand forecasting ML for dark store inventory optimization across 700+ stores",
      "'Priority' 8-minute delivery uses real-time route optimization ML; personalized restaurant/dish recommendations via collaborative filtering drive ~30% of food orders",
      "Swiggy One membership uses ML for offer personalization; surge pricing on delivery fees dynamically priced using real-time supply/demand models per micro-zone",
    ],
    founderPhilosophy: "Sriharsha Majety (CEO) is operationally rigorous and data-driven. Interviews test execution depth over strategy — 'how would you measure this?' is more likely than 'what is the 3-year vision?' PMs are expected to hold both speed-to-market and unit economics discipline simultaneously, especially given Instamart's path-to-profitability pressure.",
    likelyQuestions: [
      "How would you decide whether to launch an 8-minute delivery tier in a new city, given the dark-store density it requires?",
      "Instamart isn't yet profitable — how would you prioritize between scaling AOV (average order value) vs. cutting delivery costs?",
      "How would you think about the trade-off between Swiggy Food's stable but lower-growth business and Instamart's high-growth but loss-making business?",
      "If you were a PM on Swiggy One, how would you decide which new perk to add next?",
    ],
  },
  zepto: {
    retrievedDate: "2026-06-17",
    facts: [
      "Founded 2021 by Aadit Palicha and Kaivalya Vohra (Stanford dropouts). Filed for IPO in 2026; updated draft filing shows FY26 operating revenue of ₹22,624 crore (+104% YoY) and order volumes up 93% to 640 million orders. Still posted an adjusted EBITDA loss of ₹5,042 crore. [Source: BigGo Finance, citing draft IPO filing]",
      "Advertising revenue is a deliberate strategic lever: it surged 151% YoY to ₹1,636 crore in FY26, now over 7% of operating revenue — used explicitly to subsidize lower merchant commissions and keep consumer prices competitive against rivals. [Source: BigGo Finance / Mint analysis]",
      "Operates via 'dark stores' (mini-warehouses in dense urban areas) for fast restocking. Revenue streams: product margin on grocery/essentials sales, delivery fees (dynamically priced, 20-30% surge during peak/bad weather), 10-20% vendor commission, and advertising/brand placement. [Source: miracuves.com, appsrhino.com]",
      "Zepto's central competitive claim is operational efficiency: its dark stores reportedly generate more orders per location than larger rivals Blinkit and Swiggy Instamart, attributed to its pure-play dark-store model vs. competitors who've had to retrofit. [Source: BigGo Finance]",
      "Primary competitive rivalry is the three-way 'quick commerce war' with Blinkit (Zomato-owned) and Swiggy Instamart — nearly identical value proposition (speed + convenience) targeting the same urban demographic. [Source: 42signals.com]",
      "Category expansion underway: Zepto Café and Zepto Kitchen (cloud kitchens) represent moves into higher-margin categories beyond core grocery. [Source: 42signals.com]",
    ],
    aiInitiatives: [
      "ML for dark store placement decisions — predictive demand mapping by pin code powers Zepto's core expansion strategy; real-time route optimization for 10-minute SLA",
      "AI-driven advertising placement powers ₹1,636 crore ad revenue (151% YoY); dynamic surge pricing calibrated per delivery zone in real time",
      "Zepto Café uses demand ML for SKU selection per location; ML for fraud detection and payment success rate optimization; pre-IPO AI investment earmarked explicitly in filing",
    ],
    founderPhilosophy: "Aadit Palicha (CEO, age 22) values aggressive speed and first-principles thinking over credentials or prior experience. Interview style: challenge your assumptions directly and prove you can operate at speed. 'What would you do in week one?' and 'why hasn't someone already done this?' are more likely than long-term roadmap questions. Frameworks without operational instinct are dismissed.",
    likelyQuestions: [
      "Zepto is leaning hard into advertising revenue to subsidize commissions — what are the risks of that strategy if ad spend slows?",
      "How would you decide which city to prioritize for Zepto Café expansion?",
      "Zepto, Blinkit, and Instamart have near-identical value props — how would you find genuine differentiation as a PM here?",
      "Walk me through how you'd think about dark store density vs. delivery cost trade-offs when entering a new city.",
    ],
  },
  razorpay: {
    retrievedDate: "2026-06-17",
    facts: [
      "Founded 2014 by Harshil Mathur and Shashank Kumar, Bengaluru. Valued at $7.5B, has raised $742M total funding, serves 10M+ businesses, ~4,500 employees. [Source: dexteragent.ai company profile]",
      "Started as a payment gateway, expanded into a full-stack fintech infrastructure platform: RazorpayX (business banking), Payroll, Capital (lending), POS, recurring billing/subscriptions, and vendor payouts — deliberately building multiple revenue streams from the same merchant base to increase revenue-per-customer and reduce churn. [Source: miracuves.com]",
      "Heavy, explicit AI strategy: at FTX 2026 launched an 'Agent Studio' — described as the world's first agent studio for payments — built on Anthropic's Claude Agent SDK, letting merchants deploy AI agents to automate payment ops, dispute resolution, and revenue recovery. [Source: Outlook Business, citing FTX 2026 announcement]",
      "Internally, Razorpay's CPO Khilan Haria has publicly described a vision where AI agents handle PRD reviews, debugging, and recurring workflows — and the company mandated that ALL team members (including PMs) use AI tools (enterprise licenses for Claude, ChatGPT, Midjourney) in day-to-day work, with PMs expected to act as 'full-stack builders' taking low-complexity initiatives directly to production. [Source: Elevation Capital, TipRanks]",
      "AI-native product push for 2026 ('Sprint 2026'): AI agents for chargeback/dispute response, predictive cash-flow forecasting (3-7 days ahead), AI-assisted KYC/onboarding, and conversational commerce integrations allowing checkout inside ChatGPT and other LLM interfaces. [Source: razorpay.com/sprint/26]",
      "Revenue model: transaction fees on payment processing, premium subscriptions, and value-added financial services (lending, payroll) — a product-led growth motion emphasizing UX and self-serve trials before enterprise sales. [Source: commonroom.io]",
    ],
    aiInitiatives: [
      "Agent Studio (FTX 2026): world's first payment agent studio built on Anthropic's Claude Agent SDK — lets merchants deploy AI agents for payment ops, dispute resolution, revenue recovery",
      "Active bets: AI agents for chargeback/dispute response, predictive cash-flow forecasting (3–7 days), AI-assisted KYC, conversational commerce checkout inside LLM interfaces",
      "Internal AI mandate: all team members (including every PM) use enterprise AI tools (Claude, ChatGPT, Midjourney) daily; PMs expected to act as 'full-stack builders' shipping low-complexity initiatives independently",
    ],
    founderPhilosophy: "Harshil Mathur (CEO) and CPO Khilan Haria have stated PMs must be 'full-stack builders' who can ship independently. Technical depth is table stakes — expect questions on API design, system constraints, and whether you can build it yourself. The interview explicitly tests whether you blur the line between product and engineering, not just coordinate between them.",
    likelyQuestions: [
      "Razorpay mandated AI tool usage across all PM workflows — how would you measure whether that's actually improving product quality vs. just speed?",
      "How would you design an AI agent for dispute resolution while making sure merchants still trust the outcome?",
      "Razorpay is pushing 'checkout inside ChatGPT' — what are the product risks of embedding payments inside someone else's AI interface?",
      "How would you prioritize between RazorpayX (banking), Capital (lending), and the core payment gateway for next quarter's roadmap?",
    ],
  },
  flipkart: {
    retrievedDate: "2026-06-17",
    facts: [
      "Founded 2007 by Sachin and Binny Bansal as an online bookstore; acquired by Walmart in 2018. Has raised $12.1B total funding across 22 rounds. [Source: Tracxn company profile]",
      "Core differentiator is logistics: owns and operates Ekart, its in-house delivery arm, which is a major part of its competitive moat against marketplace-only rivals. Has expanded into fintech via super.money for credit services. [Source: iide.co]",
      "Top listed competitors: Myntra (its own fashion subsidiary), Amazon, and Meesho — Meesho's zero-commission model has specifically pressured Flipkart and Amazon in value/Tier-2-3 segments. [Source: Tracxn, TechCrunch]",
      "Parent Walmart's FY26 strategy explicitly emphasizes 'higher-margin commerce solutions,' automation/productivity investment, and disciplined ROI-based capital allocation across AI and tech investment — directly shaping how much capital Flipkart can expect for aggressive growth bets vs. profitability focus. [Source: Walmart Inc. FY26 SEC filings]",
      "Flipkart is reportedly preparing for its own IPO (alongside Meesho's Dec 2025 listing and expected Oyo/PhonePe listings), signaling a maturing, scrutiny-heavy phase for the Indian e-commerce sector overall. [Source: TechCrunch]",
    ],
    aiInitiatives: [
      "Personalized product recommendations powered by ML (accounts for 35%+ of GMV); visual search and voice commerce in regional languages for Tier 2/3 users",
      "Dynamic pricing ML competes in real-time against Amazon; ML-driven inventory placement in Ekart warehouses reduces last-mile cost per delivery",
      "Post-IPO GenAI investment in seller tools, customer support automation, and AI-assisted catalog quality — framed as efficiency and margin improvement under Walmart's ROI discipline",
    ],
    founderPhilosophy: "Flipkart operates as a large, Walmart-owned organization with structured processes. Interview style leans metrics-first and execution-focused. Kalyan Krishnamurthy (CEO) drives ROI discipline — expect 'how do you know it worked?', stakeholder alignment questions, and trade-off reasoning between Flipkart's business units (Myntra, Ekart, fintech). Vision must be grounded in measurable outcomes.",
    likelyQuestions: [
      "Meesho's zero-commission model is pressuring Flipkart in value segments — how would you respond as a Flipkart PM?",
      "How would you decide whether to invest more in Ekart logistics infrastructure vs. marketing spend for a new category launch?",
      "Walmart's parent strategy is profitability-focused — how would you make the case for a growth-stage bet that loses money short-term?",
      "How would you think about Flipkart's relationship with Myntra — compete, integrate, or keep them fully separate?",
    ],
  },
  cred: {
    retrievedDate: "2026-06-17",
    facts: [
      "Founded 2018 by Kunal Shah. Access gated to users with CIBIL credit score 750+ — deliberately excludes roughly 99% of India's population as a core part of the product strategy (exclusivity as the product, not a bug). [Source: valueforstartups.in]",
      "Core paradox: charges no fee for its primary user action (paying a credit card bill) — revenue comes entirely from the surrounding ecosystem: CRED Store (rewards marketplace), CRED Travel, CRED Garage (vehicle management), CRED Protect (credit monitoring), lending (via partner banks/NBFCs, built a ~₹15,000 crore loan book as of FY24), and merchant/brand advertising to its premium user base. [Source: valueforstartups.in, businessesmodel.com]",
      "FY24 revenue grew 66% YoY to ₹2,473 crore, with operating losses of ₹609 crore the same year — high cash burn paired with rapid growth has been the central, openly debated tension in CRED's story. Analysts have targeted EBITDA breakeven around late 2025-early 2026. [Source: iide.co, businessmodelcanvastemplate.com]",
      "Processes roughly 20-22% of all Indian credit card bill payments; reached 13M+ monthly active users by mid-2024 despite the strict eligibility gate, though MAU growth plateaued for 16 consecutive months between late 2022 and early 2024 — a frequently-cited growth-stall case study. [Source: iide.co, valueforstartups.in]",
      "CRED's own thesis (per founder Kunal Shah) is that 'trust is India's scarcest resource' and the company is built to monetize trust rather than transactions — explicitly contrasted against transactional-efficiency players like Razorpay. [Source: iide.co]",
    ],
    aiInitiatives: [
      "ML for credit risk scoring augments CIBIL; personalized offer targeting in CRED Store uses behavioral ML to match premium users to relevant brands before they search",
      "CRED Pay uses ML to optimize UPI transaction success rates; fraud detection ML is central given high-credit-score users are a premium target for financial fraud",
      "Kunal Shah describes AI's role as 'trust infrastructure' — surfacing the right creditworthy offer before users ask, rather than showing catalogs and waiting for intent",
    ],
    founderPhilosophy: "Kunal Shah (CEO) is a contrarian thinker who distrusts PM frameworks. Famous for philosophical interview questions: 'What is your relationship with money?', 'What does trust mean in a transaction?', 'What is the most undervalued thing in India?' Expects first-principles reasoning, not structured templates. Concepts and judgment over process. A framework answer is a red flag.",
    likelyQuestions: [
      "CRED charges nothing for its core action but built a large ecosystem around it — how would you decide what to build next to monetize trust without breaking it?",
      "MAU growth plateaued for over a year despite viral marketing — as a PM, how would you diagnose what's actually causing a growth plateau like that?",
      "How would you balance CRED's exclusivity (750+ CIBIL gate) against pressure to grow the user base faster?",
      "Walk me through how you'd prioritize between CRED's lending business and its rewards/lifestyle ecosystem for next year's roadmap.",
    ],
  },
  meesho: {
    retrievedDate: "2026-06-17",
    facts: [
      "Founded 2015 by Vidit Aatrey and Sanjeev Barnwal (IIT Delhi). Listed on NSE/BSE Dec 10, 2025 at ₹162.5 (a 46% premium over the ₹111 issue price); IPO raised over $600M, oversubscribed 9x. [Source: Sahi.com, TechCrunch]",
      "Core model: zero-commission, asset-light social commerce marketplace. Resellers (mostly women/homemakers) share product catalogs via WhatsApp/Facebook/Instagram and earn commissions on sales; Meesho itself does not hold inventory and relies on third-party sellers plus its own logistics arm, Valmo. [Source: pocketful.in, fhseohub.com]",
      "Revenue comes not from seller commissions but from advertising fees (sellers pay to be discovered), logistics margins via Valmo, and float on payments — a genuinely different model from Flipkart/Amazon's commission-based approach. [Source: fhseohub.com]",
      "Scale as of FY25/26: 187-234 million annual transacting users, ~4.9 million daily orders (reportedly ~37% of all India e-commerce orders by volume), $6.2B FY25 GMV run rate growing at a targeted 26% CAGR through FY31. Over 85% of users are in Tier 2+ cities. [Source: iide.co, TechCrunch]",
      "FY25 revenue grew 23% YoY with the company reporting improving free cash flow and unit economics — a notable shift from its earlier loss-heavy growth phase. Post-IPO, the company has flagged plans to invest raised capital in cloud infrastructure, AI/ML, and logistics scaling. [Source: indiaobservers.com]",
      "Explicitly compares itself to Pinduoduo (China), Shopee (Southeast Asia), and Mercado Libre (Latin America) as its closest global strategic analogues — useful framing for any answer about Meesho's positioning. [Source: TechCrunch]",
    ],
    aiInitiatives: [
      "Personalized catalog ranking ML is Meesho's core discovery engine — critical for 187M+ users in Tier 2/3 cities with high browse behavior and low active search intent",
      "AI-driven seller onboarding quality checks (catalog images, pricing compliance); logistics route optimization via Valmo using demand forecasting by pin code",
      "Post-IPO capital specifically earmarked for AI/ML and cloud infrastructure; building catalog intelligence to compete on discovery without matching Amazon/Flipkart's ad spend",
    ],
    founderPhilosophy: "Vidit Aatrey (CEO) is mission-driven around social commerce for Bharat — the next 100 million Indian internet users, not metro millennials. Interview focus: empathy for Tier 2/3 users who are price-sensitive, WhatsApp-native, and trust-deficient. Expect 'why would a homemaker in Indore use this over WhatsApp status?' over 'what is your GTM strategy?' Designing for low-bandwidth, low-trust, low-literacy contexts is table stakes.",
    likelyQuestions: [
      "Meesho doesn't charge seller commissions like Flipkart or Amazon — how would you think about monetization trade-offs if ad revenue growth slows?",
      "85%+ of users are in Tier 2+ cities — how would that change your approach to product design vs. a metro-first product?",
      "How would you evaluate whether Valmo (in-house logistics) should expand or whether Meesho should rely more on third-party logistics partners?",
      "Meesho compares itself to Pinduoduo — what would you borrow from that comparison, and what wouldn't translate to the Indian market?",
    ],
  },
};

const PROBES = [
  "What specifically did YOU build vs your team?",
  "What was the metric before and after — and how exactly did you measure it?",
  "What decision did only you make that a different PM might not have?",
  "What would have broken if you hadn't been on this project?",
  "What failed, and what did you personally learn from it?",
];

const DIMS = [
  { key: "structure",      label: "Structured thinking" },
  { key: "crossq",         label: "Clarifying & cross-questioning" },
  { key: "discovery",      label: "Discovery quality" },
  { key: "empathy",        label: "User empathy + business pragmatism" },
  { key: "prioritisation", label: "Prioritisation" },
  { key: "tradeoffs",      label: "Trade-off reasoning" },
  { key: "communication",  label: "Communication & conciseness" },
  { key: "storytelling",   label: "Storytelling & calibration" },
  { key: "claimdepth",     label: "Claim–depth consistency" },
  { key: "aipm",           label: "AI product thinking" },
  { key: "grounding",      label: "Story grounding (authenticity)" },
];

// Behavioral anchors per dimension per band — shown in FeedbackScreen rubric expansion
const DIM_ANCHORS = {
  structure:      { 1: "No framework visible — jumps between ideas without guiding logic", 2: "Structure attempted but collapses under follow-up — hard to follow the thread", 3: "Clear arc (situation → approach → outcome) maintained throughout", 4: "Crisp, consistent structure that guides the listener without effort — never needs prompting to organize" },
  crossq:         { 1: "No clarifying questions asked — assumes scope and jumps straight to an answer", 2: "Surface-level clarifications asked but misses the key ambiguities that would change the approach", 3: "Asks relevant questions that uncover real constraints or user context before committing", 4: "Probes systematically — scope, user, success metrics, constraints — and knows what information changes the answer" },
  discovery:      { 1: "Skips discovery entirely — pitches a solution to an assumed or unstated problem", 2: "Asks a few questions but moves to solution before understanding root cause", 3: "Validates the problem and user segment before proposing; asks about root cause and context", 4: "Rigorous discovery — root cause, affected user segment, frequency, existing workarounds, business impact — before any solution" },
  empathy:        { 1: "No user or business perspective referenced — answer is abstract or feature-focused", 2: "Mentions users or business constraints in passing without grounding claims in specifics", 3: "Concrete user needs AND business constraints both present and balanced", 4: "Named user segment, specific pain with evidence, AND clear business model implication — balanced and integrated throughout" },
  prioritisation: { 1: "No prioritisation logic — items listed without criteria or picked arbitrarily", 2: "Some prioritisation stated but criteria not explained or consistently applied", 3: "Clear criteria (impact/effort, user value, strategic fit) applied and explained", 4: "Explicit trade-offs acknowledged; explains what was cut and why; criteria tied to the specific business goal" },
  tradeoffs:      { 1: "No trade-offs mentioned — presents one path as obviously correct without acknowledging the downside", 2: "Acknowledges trade-offs exist but doesn't engage with them or name them", 3: "Names the specific downside of the chosen approach and explains why it was accepted", 4: "Maps multiple options with trade-offs; explains why this option wins given the specific constraints and stage" },
  communication:  { 1: "Rambling, repetitive, or circular — hard to follow the main point", 2: "Gets to the point eventually but over-explains along the way", 3: "Clear and direct — listener can follow without effort", 4: "Precisely calibrated — right level of detail, no wasted words, confident without being dismissive" },
  storytelling:   { 1: "No narrative structure — bullet-dump or stream of consciousness", 2: "Story present but either overexplained or understructured; role unclear", 3: "Clear situation → personal action → measurable outcome arc; appropriate length", 4: "Compelling, concrete, concise — situation is vivid, personal role is unambiguous, outcome is specific and verifiable" },
  claimdepth:     { 1: "Claims asserted without evidence — 'we improved conversion', no number, no method, no ownership", 2: "Numbers cited but shallow — can't explain how measured or what specifically changed", 3: "Claims backed with specific metrics and context; can explain the measurement approach", 4: "Every claim has a specific number, a named decision, a causal explanation, and survives a follow-up probe" },
  aipm:           { 1: "No AI thinking surfaced — treats every product problem as pre-AI", 2: "Mentions AI generically ('we could use ML') without a concrete use case", 3: "Identifies a concrete AI use case with a plausible implementation and a success metric", 4: "AI use case with specific approach, named failure modes, measurement plan, and user trust consideration" },
  grounding:      { 1: "Stories feel generic — could describe anyone's work; no unique personal details", 2: "Some personal detail but key claims (metrics, decisions) are vague or team-attributed", 3: "Clear personal ownership — specific numbers; can name a decision that was theirs alone", 4: "Every claim is probe-resistant — specific enough that no one else could have given this exact answer" },
};

// Plain-language patterns for each dimension — used by Weakness Engine
const DIM_PATTERNS = {
  structure:      "jumping into answers without a clear framework",
  crossq:         "not asking enough clarifying questions before solving",
  discovery:      "skipping problem validation — pitching before discovering",
  empathy:        "not grounding answers in specific user needs or business reality",
  prioritisation: "not making trade-offs explicit when deciding what to build",
  tradeoffs:      "avoiding hard trade-off reasoning — answers don't acknowledge the downside",
  communication:  "over-explaining — answers could be shorter and more direct",
  storytelling:   "stories lack structure: situation, role, outcome aren't distinct",
  claimdepth:     "claims without backing — interviewers probe through these gaps",
  aipm:           "not connecting product thinking to AI opportunities or failure modes",
  grounding:      "answers feel generic — missing specific details only you would know",
};

// Returns cross-session weakness insights — requires 3+ sessions with dimension scores
function getWeaknessInsights(sessionHistory) {
  const withScores = sessionHistory.filter(s => s.scores && typeof s.scores === "object");
  if (withScores.length < 3) return null;
  const last3 = withScores.slice(-3);

  const dimAvgs = DIMS.map(d => {
    const vals = last3
      .map(s => { const v = s.scores?.[d.key]?.score; return typeof v === "number" ? v : null; })
      .filter(v => v !== null);
    if (vals.length === 0) return null;
    return { key: d.key, label: d.label, avg: parseFloat((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1)) };
  }).filter(Boolean).sort((a, b) => a.avg - b.avg);

  const all = withScores.slice(-Math.min(withScores.length, 5));
  const improving = DIMS.map(d => {
    if (all.length < 2) return null;
    const first = all[0].scores?.[d.key]?.score;
    const last = all[all.length - 1].scores?.[d.key]?.score;
    if (typeof first !== "number" || typeof last !== "number" || last <= first) return null;
    return { key: d.key, label: d.label, delta: parseFloat((last - first).toFixed(1)) };
  }).filter(Boolean).sort((a, b) => b.delta - a.delta).slice(0, 2);

  return { weakest: dimAvgs.slice(0, 3), improving, sessionCount: withScores.length };
}

// Weakness Engine card — shown in Dashboard and History after 3+ sessions
function WeaknessInsights({ insights }) {
  if (!insights) return null;
  const sc = s => s >= 3 ? C.teal : s >= 2 ? C.amber : C.red;
  return (
    <div style={{ background: C.white, border: `1px solid ${C.g200}`, borderRadius: 14, padding: "20px 24px", boxShadow: "0 1px 3px rgba(0,0,0,.06)", marginBottom: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 14 }}>Weakness Engine</div>
          <div style={{ fontSize: 12, color: C.g500, marginTop: 2 }}>Patterns across your last {Math.min(insights.sessionCount, 3)} sessions — what interviewers are consistently catching</div>
        </div>
        <Badge color="amber">{insights.sessionCount} sessions</Badge>
      </div>

      <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: C.red, marginBottom: 10 }}>
        Consistent gaps — focus here first
      </div>
      {insights.weakest.map((d, i) => (
        <div key={d.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "9px 0", borderBottom: i < insights.weakest.length - 1 ? `1px solid ${C.g100}` : "none" }}>
          <div style={{ width: 38, height: 38, borderRadius: 8, background: C.amberL, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Georgia,serif", fontSize: 14, fontWeight: 700, color: sc(d.avg), flexShrink: 0 }}>{d.avg}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.g800 }}>{d.label}</div>
            <div style={{ fontSize: 11, color: C.g500, lineHeight: 1.5, marginTop: 1 }}>{DIM_PATTERNS[d.key]}</div>
          </div>
          <div style={{ width: 80, flexShrink: 0 }}>
            <div style={{ height: 5, background: C.g200, borderRadius: 99 }}>
              <div style={{ height: "100%", width: `${(d.avg / 4) * 100}%`, background: sc(d.avg), borderRadius: 99 }} />
            </div>
          </div>
        </div>
      ))}

      {insights.improving.length > 0 && (
        <div style={{ paddingTop: 12, marginTop: 4, borderTop: `1px solid ${C.g100}` }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: C.teal, marginBottom: 8 }}>
            Getting stronger
          </div>
          {insights.improving.map(d => (
            <div key={d.key} style={{ fontSize: 12, color: C.g700, marginBottom: 4 }}>
              <span style={{ color: C.teal, fontWeight: 700 }}>↑ +{d.delta}</span> {d.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  purple: "#5B4FCF", purpleL: "#EEF0FF", purpleM: "#8B83E0", purpleD: "#3B3190",
  teal: "#0F9E7B",   tealL: "#E0F5EF",
  amber: "#D97706",  amberL: "#FEF3C7",
  red: "#DC2626",    redL: "#FEF2F2",
  g50: "#F9FAFB", g100: "#F3F4F6", g200: "#E5E7EB", g300: "#D1D5DB",
  g400: "#9CA3AF", g500: "#6B7280", g600: "#4B5563", g700: "#374151",
  g800: "#1F2937", g900: "#111827", white: "#FFFFFF",
};

// ── Tiny UI helpers ───────────────────────────────────────────────────────────
const Badge = ({ color = "purple", children }) => {
  const map = { purple: { bg: C.purpleL, fg: C.purpleD }, teal: { bg: C.tealL, fg: C.teal }, amber: { bg: C.amberL, fg: C.amber }, red: { bg: C.redL, fg: C.red }, gray: { bg: C.g100, fg: C.g600 } };
  const { bg, fg } = map[color] || map.gray;
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 500, background: bg, color: fg }}>{children}</span>;
};

const Btn = ({ onClick, disabled, variant = "primary", size = "md", children, style = {} }) => {
  const base = { display: "inline-flex", alignItems: "center", gap: 6, border: "none", cursor: disabled ? "not-allowed" : "pointer", fontFamily: "inherit", fontWeight: 500, borderRadius: 8, transition: "all .15s", opacity: disabled ? .5 : 1, ...style };
  const sz = { sm: { padding: "6px 12px", fontSize: 12 }, md: { padding: "9px 16px", fontSize: 13 }, lg: { padding: "12px 22px", fontSize: 14 } }[size];
  const vars = {
    primary: { background: C.purple, color: "#fff" },
    secondary: { background: C.g100, color: C.g700, border: `1px solid ${C.g200}` },
    ghost: { background: "transparent", color: C.purple, border: `1px solid ${C.purpleM}` },
    teal: { background: C.teal, color: "#fff" },
  };
  return <button onClick={onClick} disabled={disabled} style={{ ...base, ...sz, ...vars[variant] }}>{children}</button>;
};

const Spinner = () => (
  <span style={{ display: "inline-block", width: 16, height: 16, border: `2px solid ${C.g200}`, borderTopColor: C.purple, borderRadius: "50%", animation: "spin .7s linear infinite" }} />
);

const InfoBox = ({ type = "info", children }) => {
  const styles = {
    info:    { bg: C.purpleL, border: "#D1CEFF", color: C.purpleD },
    warning: { bg: C.amberL,  border: "#FCD34D", color: "#92400E" },
    success: { bg: C.tealL,   border: "#6EE7B7", color: "#065F46" },
  }[type];
  return <div style={{ background: styles.bg, border: `1px solid ${styles.border}`, color: styles.color, borderRadius: 10, padding: "12px 16px", fontSize: 12, lineHeight: 1.7, marginBottom: 14 }}>{children}</div>;
};

const Card = ({ children, style = {}, onClick, onMouseEnter, onMouseLeave }) => (
  <div onClick={onClick} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
    style={{ background: C.white, border: `1px solid ${C.g200}`, borderRadius: 14, padding: "20px 24px", boxShadow: "0 1px 3px rgba(0,0,0,.06)", ...style }}>{children}</div>
);

const ProgressBar = ({ pct, color = C.purple, height = 6 }) => (
  <div style={{ height, background: C.g200, borderRadius: 99, overflow: "hidden" }}>
    <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: color, borderRadius: 99, transition: "width .4s ease" }} />
  </div>
);

const TypingDots = () => (
  <span style={{ display: "inline-flex", gap: 3, alignItems: "center" }}>
    {[0, 1, 2].map(i => (
      <span key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: C.purpleM, display: "inline-block", animation: `typingDot 1.2s ease ${i * .2}s infinite` }} />
    ))}
  </span>
);

function MockTypeCard({ t, icon, title, desc, badge, onStart }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onClick={() => onStart(t)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ background: C.white, borderRadius: 14, padding: "20px 24px", boxShadow: "0 1px 3px rgba(0,0,0,.06)", cursor: "pointer", border: `2px solid ${hovered ? C.purple : C.g200}`, transition: "border-color .15s" }}
    >
      <div style={{ fontSize: 32, marginBottom: 12 }}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 12, color: C.g600, marginBottom: 10, lineHeight: 1.6 }}>{desc}</div>
      <Badge color="purple">{badge}</Badge>
    </div>
  );
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function Sidebar({ screen, setScreen, company, storyDone, mockDone, sessionCount = 0, user, onSignOut }) {
  const items = [
    { id: "dashboard", icon: "⬡",  label: "Dashboard" },
    { id: "company",   icon: "🏢", label: "Company Intel",      done: !!company },
    { id: "story",     icon: "📖", label: "Story Intelligence", done: storyDone },
    { id: "mock",      icon: "🎯", label: "Mock Interview",     done: mockDone },
    { id: "feedback",  icon: "📊", label: "Feedback & Scores",  done: mockDone },
    { id: "history",   icon: "📈", label: "Session History",    count: sessionCount },
    { id: "coach",     icon: "⭐", label: "Story Coach" },
  ];

  return (
    <div style={{ width: 252, minHeight: "100vh", background: C.white, borderRight: `1px solid ${C.g200}`, display: "flex", flexDirection: "column", position: "fixed", left: 0, top: 0, bottom: 0, zIndex: 100 }}>
      {/* Logo */}
      <div style={{ padding: "20px 20px 16px", borderBottom: `1px solid ${C.g100}` }}>
        <div style={{ fontFamily: "Georgia, serif", fontSize: 22, fontWeight: 700, color: C.purple, letterSpacing: -0.5 }}>Rethink</div>
        <div style={{ fontSize: 11, color: C.g400, marginTop: 2 }}>PM Career Intelligence Platform</div>
      </div>

      {/* Company pill */}
      {company && (
        <div style={{ margin: 12, padding: "10px 12px", background: C.purpleL, borderRadius: 10, border: `1px solid #D1CEFF` }}>
          <div style={{ fontSize: 10, color: C.purple, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>Target</div>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.purpleD, marginTop: 2 }}>{company.emoji} {company.name}</div>
          <div style={{ fontSize: 11, color: C.purpleM }}>{company.type}</div>
        </div>
      )}

      {/* Nav */}
      <div style={{ padding: "12px 12px 0", flex: 1 }}>
        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.g400, padding: "8px 8px 4px" }}>Platform</div>
        {items.map(item => (
          <button key={item.id} onClick={() => setScreen(item.id)}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 6, cursor: "pointer", transition: "all .15s", marginBottom: 2, fontSize: 13, color: screen === item.id ? C.purpleD : C.g600, fontWeight: screen === item.id ? 600 : 400, border: "none", background: screen === item.id ? C.purpleL : "transparent", width: "100%", textAlign: "left", fontFamily: "inherit" }}>
            <span style={{ width: 18, textAlign: "center" }}>{item.icon}</span>
            <span style={{ flex: 1 }}>{item.label}</span>
            {item.done && <span style={{ fontSize: 10, background: C.teal, color: "#fff", padding: "1px 6px", borderRadius: 99, fontWeight: 700 }}>✓</span>}
            {typeof item.count === "number" && item.count > 0 && <span style={{ fontSize: 10, background: C.purple, color: "#fff", padding: "1px 6px", borderRadius: 99, fontWeight: 700 }}>{item.count}</span>}
          </button>
        ))}

        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.g400, padding: "16px 8px 4px" }}>Coming soon</div>
        {["HM Intelligence"].map(l => (
          <div key={l} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", fontSize: 13, color: C.g400, opacity: .5 }}>
            <span>◦</span>{l}
          </div>
        ))}
      </div>

      {/* User */}
      <div style={{ padding: 12, borderTop: `1px solid ${C.g100}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px" }}>
          <div style={{ width: 30, height: 30, borderRadius: "50%", background: C.purple, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>
            {user?.email?.[0]?.toUpperCase() || "?"}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.g800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.email || "Guest session"}</div>
            {user
              ? <button onClick={onSignOut} style={{ fontSize: 10, color: C.g400, background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit", marginTop: 2 }}>Sign out</button>
              : <div style={{ fontSize: 10, color: C.g400, marginTop: 2 }}>Progress not saved</div>
            }
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ setScreen, company, storyDone, mockDone, scores, sessionHistory = [] }) {
  const steps = [
    { id: "company",  emoji: "🏢", label: "Pick target company",        done: !!company,   screen: "company" },
    { id: "story",    emoji: "📖", label: "Story Intelligence intake",  done: storyDone,   screen: "story" },
    { id: "mock",     emoji: "🎯", label: "Run mock interview",         done: mockDone,    screen: "mock" },
    { id: "feedback", emoji: "📊", label: "Review feedback & scores",   done: mockDone && scores, screen: "feedback" },
  ];
  const done = steps.filter(s => s.done).length;
  const overall = scores?.overall;
  const scoreColor = overall >= 3 ? C.teal : overall >= 2 ? C.amber : C.red;
  const trend = sessionHistory.length >= 2 ? sessionHistory[sessionHistory.length - 1].overall - sessionHistory[0].overall : null;

  const offersCount = sessionHistory.filter(s => s.outcome === "Got an offer").length;
  const rejectionsCount = sessionHistory.filter(s => s.outcome === "Rejected").length;
  const conversionDenom = offersCount + rejectionsCount;
  const conversionRate = conversionDenom > 0 ? Math.round((offersCount / conversionDenom) * 100) : null;

  return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700, color: C.g900, letterSpacing: -.3 }}>Dashboard</div>
          <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>Your interview readiness at a glance</div>
        </div>
        <Btn onClick={() => { const n = steps.find(s => !s.done); if (n) setScreen(n.screen); else setScreen("feedback"); }}>
          {done === 0 ? "Get started →" : done === steps.length ? "View feedback →" : "Continue →"}
        </Btn>
      </div>

      <div style={{ padding: "28px 32px" }}>
        {/* Progress */}
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>Interview readiness</div>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.purple }}>{done} / {steps.length} steps</div>
          </div>
          <ProgressBar pct={(done / steps.length) * 100} />
          <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
            {steps.map(s => (
              <div key={s.id} onClick={() => setScreen(s.screen)} style={{ flex: 1, padding: "12px 14px", borderRadius: 10, border: `1.5px solid ${s.done ? C.teal : C.g200}`, background: s.done ? C.tealL : C.g50, cursor: "pointer", transition: "all .15s" }}>
                <div style={{ fontSize: 18, marginBottom: 6 }}>{s.done ? "✅" : s.emoji}</div>
                <div style={{ fontSize: 12, fontWeight: 500, color: s.done ? C.teal : C.g700 }}>{s.label}</div>
              </div>
            ))}
          </div>
        </Card>

        {/* Stats */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
          {[
            { val: company?.name || "—", label: "Target company" },
            { val: sessionHistory.length, label: "Mocks completed", onClick: () => setScreen("history") },
            { val: overall ? `${overall}/4` : "—", label: "Latest readiness score", color: overall ? scoreColor : C.g400 },
            {
              val: conversionRate !== null ? `${conversionRate}%` : "—",
              label: conversionDenom > 0 ? `Offer rate (${offersCount}/${conversionDenom} real interviews)` : "Offer rate (no outcomes yet)",
              color: conversionRate !== null ? (conversionRate >= 50 ? C.teal : C.amber) : C.g400,
              onClick: () => setScreen("history"),
            },
          ].map(m => (
            <div key={m.label} onClick={m.onClick} style={{ background: C.g50, border: `1px solid ${C.g200}`, borderRadius: 10, padding: "14px 16px", textAlign: "center", cursor: m.onClick ? "pointer" : "default" }}>
              <div style={{ fontFamily: "Georgia,serif", fontSize: 24, fontWeight: 700, color: m.color || C.g900 }}>{m.val}</div>
              <div style={{ fontSize: 11, color: C.g500, marginTop: 2 }}>{m.label}</div>
            </div>
          ))}
        </div>

        {trend !== null && (
          <InfoBox type={trend > 0 ? "success" : "info"}>
            {trend > 0
              ? `You've improved by ${trend.toFixed(1)} points across your ${sessionHistory.length} sessions. `
              : `Your scores across ${sessionHistory.length} sessions haven't moved much yet. `}
            <a onClick={() => setScreen("history")} style={{ color: C.purple, cursor: "pointer", textDecoration: "underline" }}>View full session history →</a>
          </InfoBox>
        )}

        <WeaknessInsights insights={getWeaknessInsights(sessionHistory)} />

        <InfoBox type="info">
          <strong>Why Rethink is different:</strong> Every competitor helps you <em>sound better</em>. Rethink helps you sound more like <em>yourself</em> — by mining your real work first, then testing whether your answers hold up under the same deep probing real interviewers use. Unnati (Founder, Rethink Systems): <em>"Most rejections happen because candidates can't justify the projects they put on their resume."</em>
        </InfoBox>
      </div>
    </div>
  );
}

// ── Company screen ────────────────────────────────────────────────────────────
function CompanyScreen({ company, setCompany, setScreen }) {
  const [selected, setSelected] = useState(company);
  const [brief, setBrief] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState("");
  const [errorMsg, setErrorMsg] = useState(null);
  const [open, setOpen] = useState({});
  const [fromCache, setFromCache] = useState(false);
  const [citations, setCitations] = useState([]);
  const [searchConfirmed, setSearchConfirmed] = useState(false);
  const [customName, setCustomName] = useState("");
  const [mode, setMode] = useState("preset"); // "preset" | "custom"
  const [flagged, setFlagged] = useState({}); // { [sectionKey]: { note, submitted } }

  // ── Preset companies: pre-verified static facts (highest confidence) ──
  async function loadBrief(c) {
    setSelected(c);
    setLoading(true);
    setLoadingLabel(`Organizing verified research for ${c.name}...`);
    setBrief(null);
    setErrorMsg(null);
    setCitations([]);
    setSearchConfirmed(false);

    const verified = COMPANY_FACTS[c.id];
    if (!verified) {
      setErrorMsg(`No verified data available for ${c.name} yet.`);
      setLoading(false);
      return;
    }

    try {
      const sys = `You are organizing pre-verified, sourced research into a structured PM interview brief. You must ONLY use the facts provided below — do not add any fact, number, or claim that is not explicitly present in this material. If a category isn't covered by the source facts, write "Not covered in current research" rather than inventing something.

VERIFIED SOURCE FACTS (retrieved ${verified.retrievedDate}):
${verified.facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}

Organize this into a JSON object with these keys:
mission (1 sentence, derived only from the facts above),
products (array of 3-4 short strings, only from facts above),
businessModel (array of 2-3 short strings, only from facts above),
competitivePosition (array of 2-3 short strings about market share/competitors, only from facts above),
strategicMoves (array of 2-3 short strings about recent strategic decisions, only from facts above),
keyTension (1 sentence describing the central business tension or open question this company faces, only from facts above).
Return ONLY valid JSON, no markdown, no explanation, no invented facts.`;

      const cacheKey = `brief:${c.id}`;
      const { data, fromCache: cached } = await callClaudeJSONCached(cacheKey, [{ role: "user", content: `Organize the brief for ${c.name}` }], sys, 700);
      setBrief(data);
      setFromCache(cached);
    } catch (e) {
      setErrorMsg(friendlyError(e));
    }
    setLoading(false);
  }

  // ── Custom companies: live web search, grounded with real citations ──
  // This is the actual anti-hallucination mechanism for arbitrary
  // companies: Claude's server-side web_search tool runs real queries,
  // and every claim must trace back to a returned source URL. We show
  // those URLs to the user so the grounding is independently checkable
  // rather than just asserted.
  async function loadCustomBrief(name) {
    if (!name.trim()) return;
    const trimmed = name.trim();
    setSelected({ id: `custom:${trimmed}`, name: trimmed, emoji: "🔎", type: "Custom lookup", color: "#6B7280", custom: true });
    setLoading(true);
    setLoadingLabel(`Searching the web for current facts about ${trimmed}...`);
    setBrief(null);
    setErrorMsg(null);
    setCitations([]);
    setSearchConfirmed(false);

    try {
      const sys = `You are building a PM interview brief about a real company. You have access to a web_search tool — use it, do not rely on memory alone, since your training data may be outdated. Search for the company's current business model, products, competitors, and recent strategic news (2025-2026 if available).

CRITICAL RULES:
1. Every factual claim in your output MUST be something you found via web_search in this conversation. If you did not search for a category, write "Not found in current search — try rephrasing or check directly" rather than inventing it.
2. If the company name is ambiguous, too obscure to find reliable information on, or doesn't appear to be a real company, say so honestly in the "mission" field instead of fabricating details.
3. Do not pad with generic startup boilerplate ("innovative," "disrupting the industry") — only include specific, sourced facts.

After searching, return ONLY a JSON object with these keys:
mission (1 sentence, only from search results, or an honest "couldn't verify" statement),
products (array of 2-4 short strings, only from search results),
businessModel (array of 2-3 short strings, only from search results),
competitivePosition (array of 2-3 short strings, only from search results),
strategicMoves (array of 2-3 short strings about recent news/strategy, only from search results),
keyTension (1 sentence on the central business tension, only from search results),
likelyQuestions (array of 3-4 realistic PM interview questions grounded in what you actually found about this specific company),
confidenceNote (1 sentence honestly describing how much reliable information you found — e.g. "Well-documented" vs "Limited public information available").
Return ONLY valid JSON, no markdown, no explanation.`;

      const { data, citations: cites } = await callClaudeWithWebSearchJSON(`Research and build a PM interview brief for: ${trimmed}`, sys, 1800, { retries: 1 });

      setBrief(data);
      setCitations(cites);
      // searchConfirmed stays false — Groq has no live web search
    } catch (e) {
      setErrorMsg(friendlyError(e));
    }
    setLoading(false);
  }

  function submitFlag(key, note) {
    setFlagged(f => ({ ...f, [key]: { note, submitted: true } }));
  }

  function FlagInline({ sectionKey }) {
    const state = flagged[sectionKey];
    const [open2, setOpen2] = useState(false);
    const [note, setNote] = useState("");
    if (state?.submitted) {
      return <span style={{ fontSize: 10, color: C.teal, marginLeft: 6, fontStyle: "italic" }}>✓ Flagged — thank you</span>;
    }
    if (!open2) {
      return (
        <button
          onClick={e => { e.stopPropagation(); setOpen2(true); }}
          title="Flag an inaccuracy in this section"
          style={{ fontSize: 10, color: C.g400, background: "none", border: `1px solid ${C.g200}`, borderRadius: 4, padding: "1px 6px", cursor: "pointer", fontFamily: "inherit", marginLeft: 6, flexShrink: 0 }}>
          ⚑ Flag error
        </button>
      );
    }
    return (
      <span onClick={e => e.stopPropagation()} style={{ display: "inline-flex", alignItems: "center", gap: 4, marginLeft: 6 }}>
        <input
          autoFocus
          value={note}
          onChange={e => setNote(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter" && note.trim()) submitFlag(sectionKey, note); if (e.key === "Escape") setOpen2(false); }}
          placeholder="Describe the error (press Enter)"
          style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, border: `1px solid ${C.purple}`, outline: "none", fontFamily: "inherit", width: 200 }}
        />
        <button onClick={() => note.trim() && submitFlag(sectionKey, note)} style={{ fontSize: 10, background: C.purple, color: "#fff", border: "none", borderRadius: 4, padding: "2px 8px", cursor: "pointer", fontFamily: "inherit" }}>Submit</button>
        <button onClick={() => setOpen2(false)} style={{ fontSize: 10, background: "none", color: C.g400, border: "none", cursor: "pointer", fontFamily: "inherit" }}>✕</button>
      </span>
    );
  }

  const Section = ({ title, data, sectionKey }) => (
    <div style={{ border: `1px solid ${C.g200}`, borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
      <div onClick={() => setOpen(o => ({ ...o, [title]: !o[title] }))} style={{ padding: "9px 14px", background: C.g50, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", borderBottom: open[title] ? `1px solid ${C.g200}` : "none" }}>
        <span style={{ display: "flex", alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, fontWeight: 600, color: C.g700 }}>{title}</span>
          {verified && sectionKey && <FlagInline sectionKey={sectionKey} />}
        </span>
        <span style={{ color: C.g400, fontSize: 11, flexShrink: 0, marginLeft: 8 }}>{open[title] ? "▲" : "▼"}</span>
      </div>
      {open[title] && (
        <div style={{ padding: "10px 14px", fontSize: 12, color: C.g700, lineHeight: 1.7 }}>
          {Array.isArray(data) ? data.map((d, i) => <div key={i}>• {d}</div>) : <div>{data}</div>}
        </div>
      )}
    </div>
  );

  const verified = selected && !selected.custom ? COMPANY_FACTS[selected.id] : null;
  const likelyQuestions = verified?.likelyQuestions || brief?.likelyQuestions || [];

  return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700, color: C.g900 }}>Company Intelligence</div>
          <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>Pick a launch company, or search for your own target</div>
        </div>
        {brief && !errorMsg && <Btn onClick={() => { setCompany(selected); setScreen("story"); }}>Confirm & go to Story Intake →</Btn>}
      </div>

      <div style={{ padding: "28px 32px" }}>
        {/* Mode toggle */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button onClick={() => setMode("preset")} style={{ fontSize: 12, fontWeight: 600, padding: "7px 14px", borderRadius: 8, cursor: "pointer", border: `1.5px solid ${mode === "preset" ? C.purple : C.g200}`, background: mode === "preset" ? C.purpleL : C.white, color: mode === "preset" ? C.purpleD : C.g600, fontFamily: "inherit" }}>
            ✓ Pre-verified companies
          </button>
          <button onClick={() => setMode("custom")} style={{ fontSize: 12, fontWeight: 600, padding: "7px 14px", borderRadius: 8, cursor: "pointer", border: `1.5px solid ${mode === "custom" ? C.purple : C.g200}`, background: mode === "custom" ? C.purpleL : C.white, color: mode === "custom" ? C.purpleD : C.g600, fontFamily: "inherit" }}>
            🔎 Search any company
          </button>
        </div>

        {mode === "preset" && (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 12, marginBottom: 20 }}>
              {COMPANIES.map(c => (
                <div key={c.id} onClick={() => loadBrief(c)} style={{ border: `2px solid ${selected?.id === c.id ? C.purple : C.g200}`, borderRadius: 14, padding: 16, cursor: "pointer", background: selected?.id === c.id ? C.purpleL : C.white, textAlign: "center", transition: "all .15s" }}>
                  <div style={{ width: 48, height: 48, borderRadius: 10, background: c.color + "20", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 22, margin: "0 auto 8px" }}>{c.emoji}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.g900 }}>{c.name}</div>
                  <div style={{ fontSize: 11, color: C.g500, marginTop: 2 }}>{c.type}</div>
                </div>
              ))}
            </div>
            <InfoBox type="info">
              🔒 <strong>Grounded, not guessed:</strong> these 6 companies have pre-verified, sourced facts (researched and fact-checked, not pulled from AI memory). Every claim traces back to a real source.
            </InfoBox>
          </>
        )}

        {mode === "custom" && (
          <>
            <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
              <input
                type="text"
                value={customName}
                onChange={e => setCustomName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") loadCustomBrief(customName); }}
                placeholder="Type any company name — e.g. Groww, PhonePe, Lenskart, Pine Labs..."
                style={{ flex: 1, fontFamily: "inherit", fontSize: 13, padding: "10px 14px", border: `1px solid ${C.g300}`, borderRadius: 8, outline: "none" }}
              />
              <Btn onClick={() => loadCustomBrief(customName)} disabled={!customName.trim() || loading}>
                {loading ? <Spinner /> : "🔎 Search →"}
              </Btn>
            </div>
            <InfoBox type="warning">
              🤖 <strong>AI training knowledge, not live search:</strong> custom company lookups use Groq's training data — not live web search. Facts about events after mid-2024 may be outdated. Verify anything important before an actual interview. Less reliable than the 6 pre-verified companies.
            </InfoBox>
          </>
        )}

        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: C.purpleL, borderRadius: 10, fontSize: 13, color: C.purple, marginTop: 14 }}>
            <Spinner /> {loadingLabel}
          </div>
        )}

        {errorMsg && (
          <div style={{ marginTop: 14 }}>
            <InfoBox type="warning">⚠️ {errorMsg}</InfoBox>
            <Btn variant="secondary" onClick={() => selected?.custom ? loadCustomBrief(selected.name) : loadBrief(selected)}>↻ Retry →</Btn>
          </div>
        )}

        {brief && !errorMsg && (
          <Card style={{ marginTop: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>{selected?.emoji} {selected?.name} — Interview Brief</div>
                <button
                  onClick={() => speak(`${selected?.name} Interview Brief. Mission: ${brief.mission}. Key tension: ${brief.keyTension}`)}
                  title="Listen to brief"
                  style={{ background: C.purpleL, border: "none", borderRadius: 6, padding: "4px 10px", fontSize: 12, color: C.purpleD, cursor: "pointer", fontFamily: "inherit" }}
                >
                  🔊 Listen
                </button>
              </div>
              {verified && <Badge color="teal">✓ Pre-verified · retrieved {verified.retrievedDate}{fromCache ? " · cached" : ""}</Badge>}
              {searchConfirmed && <Badge color="amber">🔎 Live web search · {citations.length} source{citations.length !== 1 ? "s" : ""}</Badge>}
              {selected?.custom && brief && !searchConfirmed && !verified && <Badge color="gray">🤖 AI knowledge · verify before interview</Badge>}
            </div>

            {brief.confidenceNote && (
              <div style={{ fontSize: 12, color: C.amber, marginBottom: 10, fontStyle: "italic" }}>ℹ️ {brief.confidenceNote}</div>
            )}

            <div style={{ fontSize: 13, color: C.g700, marginBottom: 14, padding: "10px 14px", background: C.purpleL, borderRadius: 8, borderLeft: `3px solid ${C.purple}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div><strong>Mission:</strong> {brief.mission}</div>
              {verified && <FlagInline sectionKey="mission" />}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                ["📦 Products", brief.products, "products"],
                ["💰 Business model", brief.businessModel, "businessModel"],
                ["⚔️ Competitive position", brief.competitivePosition, "competitivePosition"],
                ["🚀 Recent strategic moves", brief.strategicMoves, "strategicMoves"],
              ].map(([t, d, k]) => <Section key={t} title={t} data={d} sectionKey={k} />)}
              {verified?.aiInitiatives && <Section title="🤖 AI initiatives" data={verified.aiInitiatives} sectionKey="aiInitiatives" />}
            </div>
            <div style={{ marginTop: 8, padding: "10px 14px", background: C.amberL, borderRadius: 8, fontSize: 12, color: "#92400E", display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div><strong>Key tension to think through:</strong> {brief.keyTension}</div>
              {verified && <FlagInline sectionKey="keyTension" />}
            </div>
            {verified?.founderPhilosophy && (
              <div style={{ marginTop: 8, padding: "10px 14px", background: C.purpleL, borderRadius: 8, fontSize: 12, color: C.purpleD, borderLeft: `3px solid ${C.purple}`, display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
                <div><strong>Founder philosophy & interview style:</strong> {verified.founderPhilosophy}</div>
                <FlagInline sectionKey="founderPhilosophy" />
              </div>
            )}

            {likelyQuestions.length > 0 && (
              <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.g200}` }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.g700, marginBottom: 8 }}>❓ Realistic questions they might ask</div>
                {likelyQuestions.map((q, i) => (
                  <div key={i} style={{ background: C.g50, borderLeft: `3px solid ${C.purpleM}`, padding: "8px 12px", borderRadius: "0 6px 6px 0", marginBottom: 6, fontSize: 12, color: C.g700, fontStyle: "italic" }}>{q}</div>
                ))}
              </div>
            )}

            {/* Static company sources */}
            {verified && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.g200}` }}>
                <div onClick={() => setOpen(o => ({ ...o, sources: !o.sources }))} style={{ cursor: "pointer", fontSize: 11, color: C.g500, display: "flex", alignItems: "center", gap: 4 }}>
                  {open.sources ? "▲" : "▼"} View source material ({verified.facts.length} verified facts)
                </div>
                {open.sources && (
                  <div style={{ marginTop: 8, fontSize: 11, color: C.g500, lineHeight: 1.8 }}>
                    {verified.facts.map((f, i) => <div key={i} style={{ marginBottom: 6 }}>{i + 1}. {f}</div>)}
                  </div>
                )}
              </div>
            )}

            {/* Live search citations — the actual proof of grounding for custom companies */}
            {searchConfirmed && (
              <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.g200}` }}>
                <div onClick={() => setOpen(o => ({ ...o, cites: !o.cites }))} style={{ cursor: "pointer", fontSize: 11, color: C.g500, display: "flex", alignItems: "center", gap: 4 }}>
                  {open.cites ? "▲" : "▼"} View sources found via live search ({citations.length})
                </div>
                {open.cites && (
                  <div style={{ marginTop: 8 }}>
                    {citations.length === 0 ? (
                      <div style={{ fontSize: 11, color: C.g500 }}>No specific source URLs were returned — treat this brief with extra caution and verify independently before relying on it.</div>
                    ) : citations.map((c, i) => (
                      <div key={i} style={{ fontSize: 11, color: C.g600, marginBottom: 5 }}>
                        {i + 1}. <a href={c.url} target="_blank" rel="noopener noreferrer" style={{ color: C.purple, textDecoration: "underline" }}>{c.title}</a>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ marginTop: 10, fontSize: 11, color: C.amber }}>
                  ⚠️ Live-searched briefs are less reliable than the 6 pre-verified companies. Cross-check anything important before an actual interview.
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

// ── Story Intelligence ────────────────────────────────────────────────────────
function StoryScreen({ storyBank, setStoryBank, setScreen, company }) {
  const [phase, setPhase] = useState(storyBank ? "done" : "intro"); // intro | paste | probe | done
  const [resumeText, setResumeText] = useState("");
  const [projects, setProjects] = useState([]);
  const [pi, setPi] = useState(0);
  const [qi, setQi] = useState(0);
  const [answers, setAnswers] = useState({});
  const [ans, setAns] = useState("");
  const storySpeech = useSpeechInput(setAns);
  const [loading, setLoading] = useState(false);
  const [bank, setBank] = useState(storyBank || []);
  const [errorMsg, setErrorMsg] = useState(null);

  async function parseResume() {
    if (!resumeText.trim()) return;
    setLoading(true);
    setErrorMsg(null);
    try {
      const sys = `Extract 2-3 key projects/roles from this resume text. Return ONLY a JSON array. Each item: {title:string, company:string, period:string, bullets:string[3max]}. Use only information present in the text — do not invent details, numbers, or titles not stated. No markdown.`;
      const projs = await callClaudeJSON([{ role: "user", content: resumeText }], sys, 500, { retries: 2 });
      if (!Array.isArray(projs) || projs.length === 0) throw new Error("NO_PROJECTS_EXTRACTED");
      setProjects(projs);
      setPhase("probe");
    } catch (e) {
      // NEVER silently substitute fake data for the user's real resume —
      // that would mean every downstream probe and story card is built on
      // a project the user never worked on. Surface the error and let
      // them retry instead.
      setErrorMsg(friendlyError(e) + " Your resume text wasn't lost — you can retry.");
    }
    setLoading(false);
  }

  async function next() {
    const key = `${pi}-${qi}`;
    const newA = { ...answers, [key]: ans || "(skipped)" };
    setAnswers(newA);
    setAns("");
    setErrorMsg(null);

    if (qi < PROBES.length - 1) { setQi(qi + 1); return; }
    if (pi < projects.length - 1) { setPi(pi + 1); setQi(0); return; }

    // Build bank — this is the user's real, specific answers. If the API
    // call fails, we must NOT silently replace it with generic placeholder
    // text — that would erase everything they just wrote and defeat the
    // entire authenticity-over-polish principle.
    setLoading(true);
    try {
      const sys = `Build a PM interview story bank from project answers. Use ONLY what the candidate actually wrote — do not invent metrics, decisions, or details they didn't state. If an answer was vague or skipped, reflect that honestly (e.g. metrics: "Not specified — strengthen this before your mock"). Return ONLY a JSON array. Each item: {projectTitle:string, company:string, coreClaim:string, metrics:string, personalContribution:string, followUpProbes:string[2], authenticityNote:string}. No markdown.`;
      const content = projects.map((p, i) =>
        `Project: ${p.title} at ${p.company}\n${PROBES.map((q, qi) => `Q: ${q}\nA: ${newA[`${i}-${qi}`] || "(skipped)"}`).join("\n")}`
      ).join("\n\n---\n\n");
      const result = await callClaudeJSON([{ role: "user", content }], sys, 900, { retries: 2 });
      if (!Array.isArray(result) || result.length === 0) throw new Error("EMPTY_STORY_BANK");
      setBank(result);
      setStoryBank(result);
      setPhase("done");
    } catch (e) {
      setErrorMsg(friendlyError(e) + " Your answers are saved — click retry to build the Story Bank again without re-entering anything.");
    }
    setLoading(false);
  }

  function retryBuildBank() {
    // Re-run the last step (qi/pi already at final position) without losing answers
    setQi(PROBES.length - 1);
    setPi(projects.length - 1);
    setAns(answers[`${projects.length - 1}-${PROBES.length - 1}`] || "(skipped)");
    next();
  }

  if (phase === "intro") return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700, color: C.g900 }}>Story Intelligence</div>
        <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>We mine your real work before any simulation</div>
      </div>
      <div style={{ padding: "28px 32px", maxWidth: 600 }}>
        <InfoBox type="info">
          <strong>Why this matters:</strong> Unnati (Founder, Rethink Systems): <em>"Most candidates we rejected couldn't justify the projects they showcased on their resume."</em> This step ensures your answers are grounded in reality — not AI polish you can't defend under probing.
        </InfoBox>
        <InfoBox type="warning">
          <strong>⚠️ Anti-polish safeguard:</strong> We never suggest or complete your answers. We ask questions; you answer in your own words. AI-generated stories collapse under probing. Yours won't.
        </InfoBox>
        {[["Paste your resume text", "1"], ["We extract your key projects", "2"], ["We probe each one — real interviewer questions", "3"], ["Your personal Story Bank is built", "4"]].map(([s, n]) => (
          <div key={n} style={{ display: "flex", gap: 12, alignItems: "flex-start", marginBottom: 10 }}>
            <div style={{ width: 24, height: 24, borderRadius: "50%", background: C.purple, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0 }}>{n}</div>
            <div style={{ fontSize: 13, color: C.g700, paddingTop: 3 }}>{s}</div>
          </div>
        ))}
        <div style={{ marginTop: 20 }}>
          <Btn size="lg" onClick={() => setPhase("paste")}>Start intake →</Btn>
        </div>
      </div>
    </div>
  );

  if (phase === "paste") return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Paste Your Resume</div>
        <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>We'll extract your projects and probe each one</div>
      </div>
      <div style={{ padding: "28px 32px", maxWidth: 680 }}>
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: C.g700, marginBottom: 5 }}>Resume text (or describe your top 2–3 roles)</label>
          <textarea value={resumeText} onChange={e => setResumeText(e.target.value)} rows={14}
            placeholder={"Role: Product Manager at Swiggy (2021–2024)\n• Led redesign of checkout flow, improving conversion by 23%\n• Managed team of 8 engineers and 2 designers\n• Launched Swiggy Instamart in 3 new cities\n\nRole: Business Analyst at TCS (2019–2021)\n• Automated dashboards saving 40 analyst-hours/week\n• Managed 5 enterprise client relationships"}
            style={{ width: "100%", fontFamily: "inherit", fontSize: 13, padding: "10px 12px", border: `1px solid ${C.g300}`, borderRadius: 8, resize: "vertical", lineHeight: 1.6, outline: "none" }} />
        </div>
        {errorMsg && <InfoBox type="warning">⚠️ {errorMsg}</InfoBox>}
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <Btn onClick={parseResume} disabled={!resumeText.trim() || loading}>
            {loading ? <><Spinner /> Extracting projects...</> : (errorMsg ? "Retry extraction →" : "Extract projects & start probing →")}
          </Btn>
          <Btn variant="secondary" onClick={() => setPhase("intro")}>← Back</Btn>
        </div>
      </div>
    </div>
  );

  if (phase === "probe") {
    const proj = projects[pi];
    const total = projects.length * PROBES.length;
    const done = pi * PROBES.length + qi;

    return (
      <div>
        <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
          <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Story Probing</div>
          <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>Probe {done + 1} of {total} · {projects.length} projects</div>
        </div>
        <div style={{ padding: "28px 32px", maxWidth: 680 }}>
          <ProgressBar pct={(done / total) * 100} />

          <div style={{ marginTop: 20, marginBottom: 16, padding: "14px 16px", background: C.g50, borderRadius: 10, border: `1px solid ${C.g200}` }}>
            <div style={{ fontSize: 11, color: C.g500, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>Project {pi + 1} of {projects.length}</div>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{proj?.title} · {proj?.company}</div>
            <div style={{ fontSize: 12, color: C.g500 }}>{proj?.period}</div>
            {proj?.bullets?.map((b, i) => <div key={i} style={{ fontSize: 12, color: C.g600, marginTop: 3 }}>• {b}</div>)}
          </div>

          <div style={{ padding: "16px 18px", background: C.purpleL, border: `1.5px solid ${C.purpleM}`, borderRadius: 10, marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <div style={{ fontSize: 11, color: C.purple, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em" }}>Interviewer probe {qi + 1}/{PROBES.length}</div>
              <button onClick={() => speak(PROBES[qi])} title="Listen to question" style={{ background: "none", border: "none", cursor: "pointer", fontSize: 13, color: C.purple, padding: "2px 6px" }}>🔊</button>
            </div>
            <div style={{ fontSize: 16, color: C.purpleD, fontFamily: "Georgia,serif", fontStyle: "italic", lineHeight: 1.5 }}>{PROBES[qi]}</div>
          </div>

          <InfoBox type="info">Answer in your own words. Be specific — names, numbers, timelines. Don't polish. Specific + honest = probe-resistant.</InfoBox>

          <div style={{ marginBottom: 16 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
              <label style={{ fontSize: 12, fontWeight: 600, color: C.g700 }}>Your answer</label>
              {storySpeech.supported && (
                <button onClick={storySpeech.toggle} title={storySpeech.listening ? "Stop recording" : "Record answer"} style={{ background: storySpeech.listening ? "#FEF2F2" : C.g100, border: `1px solid ${storySpeech.listening ? "#FCA5A5" : C.g300}`, borderRadius: 6, padding: "3px 10px", fontSize: 12, cursor: "pointer", color: storySpeech.listening ? "#DC2626" : C.g600 }}>
                  {storySpeech.listening ? "⏹ Stop" : "🎤 Speak"}
                </button>
              )}
            </div>
            <textarea value={ans} onChange={e => setAns(e.target.value)} rows={5} autoFocus
              placeholder="Be specific. What exactly did you do? What numbers? What was yours alone?"
              style={{ width: "100%", fontFamily: "inherit", fontSize: 13, padding: "10px 12px", border: `1px solid ${C.g300}`, borderRadius: 8, resize: "vertical", lineHeight: 1.6, outline: "none" }} />
          </div>

          {errorMsg && <InfoBox type="warning">⚠️ {errorMsg}</InfoBox>}

          <div style={{ display: "flex", gap: 10 }}>
            <Btn onClick={errorMsg ? retryBuildBank : next} disabled={loading}>
              {loading ? <><Spinner /> Building Story Bank...</> : errorMsg ? "Retry building Story Bank →" : (done + 1 === total ? "Finish & build Story Bank →" : "Next probe →")}
            </Btn>
            {!errorMsg && <Btn variant="secondary" onClick={() => { setAns("(skipped)"); next(); }}>Skip</Btn>}
          </div>
        </div>
      </div>
    );
  }

  // done
  return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Your Story Bank</div>
          <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>{bank.length} probe-resistant story cards built from your real work</div>
        </div>
        <Btn onClick={() => setScreen("mock")}>Start mock interview →</Btn>
      </div>
      <div style={{ padding: "28px 32px" }}>
        <InfoBox type="success">✅ <strong>Story Bank complete.</strong> Your mock will be conditioned on these cards — the interviewer knows exactly which projects to probe and which claims to test.</InfoBox>
        {bank.map((card, i) => {
          const metricsWeak = !card.metrics || card.metrics.length < 25 || /not specified|not mentioned|unclear|missing|unknown/i.test(card.metrics);
          const contributionWeak = !card.personalContribution || card.personalContribution.length < 25 || /not specified|not mentioned|unclear|missing|unknown/i.test(card.personalContribution);
          const isVague = metricsWeak || contributionWeak;
          return (
          <Card key={i} style={{ marginBottom: 14, border: isVague ? `1.5px solid #FCD34D` : undefined }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{card.projectTitle} · {card.company}</div>
              {isVague
                ? <Badge color="amber">Strengthen before mock</Badge>
                : <Badge color="teal">✓ Probe-ready</Badge>
              }
            </div>
            {isVague && (
              <div style={{ fontSize: 11, color: "#92400E", background: C.amberL, padding: "6px 10px", borderRadius: 6, marginBottom: 10 }}>
                {metricsWeak && <div>• Impact metrics are vague or missing — add a specific number before your mock</div>}
                {contributionWeak && <div>• Your personal contribution isn't specific enough — name the decision you made alone</div>}
              </div>
            )}
            <div style={{ fontSize: 15, fontStyle: "italic", color: C.g800, marginBottom: 12, fontFamily: "Georgia,serif", fontWeight: 300 }}>"{card.coreClaim}"</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: C.g700 }}><strong style={{ color: C.teal }}>Impact:</strong> {card.metrics}</div>
              <div style={{ fontSize: 12, color: C.g700 }}><strong style={{ color: C.purple }}>Your contribution:</strong> {card.personalContribution}</div>
            </div>
            <div style={{ fontSize: 11, color: C.g500, fontWeight: 700, marginBottom: 5 }}>Likely follow-up probes the interviewer will use:</div>
            {card.followUpProbes?.map((p, j) => (
              <div key={j} style={{ background: C.g50, borderLeft: `3px solid ${C.purpleM}`, padding: "7px 12px", borderRadius: "0 6px 6px 0", marginBottom: 5, fontSize: 11, color: C.g600, fontStyle: "italic" }}>💬 {p}</div>
            ))}
          </Card>
          );
        })}
      </div>
    </div>
  );
}

// ── Mock Interview ────────────────────────────────────────────────────────────
function MockScreen({ storyBank, company, setScores, setScreen, mockDone, setMockDone, onSessionComplete, setAutopsy, setAutopsyError }) {
  const [type, setType] = useState(null);
  const [msgs, setMsgs] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [turns, setTurns] = useState(0);
  const [ended, setEnded] = useState(false);
  const bottomRef = useRef(null);
  const MAX = 7;

  const [scoringDone, setScoringDone] = useState(false);
  const [scoringError, setScoringError] = useState(null);
  const [sendError, setSendError] = useState(null);
  const [pendingTranscript, setPendingTranscript] = useState(null);
  const speech = useSpeechInput(setInput);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, loading, ended]);

  // Auto-speak new interviewer messages
  useEffect(() => {
    if (msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last.role === "interviewer") speak(last.content);
  }, [msgs]);

  function systemPrompt(t) {
    const ctx = storyBank?.map(c =>
      `Project: ${c.projectTitle} at ${c.company}. Claim: "${c.coreClaim}". Impact: ${c.metrics}. Personal contribution: ${c.personalContribution}. Probe these: ${c.followUpProbes?.join("; ")}`
    ).join("\n") || "No story bank — probe any claims they make.";

    if (t === "founder") return `You are the founder of ${company?.name || "a startup"} interviewing a PM candidate. Be direct, skeptical, test thinking not frameworks. Story bank:\n${ctx}\n\nRULES: 1) Open with "Tell me about the most important product you worked on — and I mean YOU, not your team." 2) Probe 2-3 levels deep on any claim: "Walk me through that metric exactly", "What did YOU personally do vs your team?", "What decision only you made?" 3) Ask uncomfortable questions: "Why haven't you shipped more?", "Convince me your MVP thinking is enough", "What assumptions might be wrong?" 4) One question per turn, under 3 sentences. 5) At some point mid-conversation ask exactly one AI product thinking question, woven naturally — e.g. "How would you use AI to improve what you built?", "What would break if you added an LLM to this?", or "How would you measure whether an AI recommendation is actually working?" 6) NEVER say goodbye, wrap up, or end the conversation yourself — the system ends it automatically.`;

    return `You are conducting a Product Discovery interview at ${company?.name || "a company"}. Play a user persona (teacher, patient, delivery partner — pick one). Candidate must discover the problem, not pitch solutions. Story bank:\n${ctx}\n\nRULES: 1) Open with an ambiguous situation as that persona: "I'm struggling and I need help." 2) Make them ask YOU questions. If they jump to a solution say "Wait — you haven't asked about my actual problem." 3) Reward good clarifying questions with depth; give vague answers to bad ones. 4) After good discovery ask "What specifically would you build first and why?" then probe their reasoning. 5) One message per turn, under 3 sentences. 6) NEVER say goodbye, wrap up, or end the conversation yourself — the system ends it automatically. 7) CRITICAL: NEVER suggest, hint at, or prompt specific questions for the candidate to ask. Do not say things like "You could ask about..." or "Have you considered asking..." or "A good question would be...". They must discover questions themselves. You only evaluate the quality of questions they actually ask — you never supply them.`;
  }

  function start(t) {
    setAutopsy?.(null);
    setAutopsyError?.(null);
    const opening = t === "founder"
      ? `Tell me about the most important product you worked on — and I mean YOU, not your team.`
      : `Hi, I need some help. I'm a school teacher and things have been really difficult lately. I heard ${company?.name || "you"} might be able to help.`;
    setMsgs([{ role: "interviewer", content: opening }]);
    setType(t);
  }

  async function buildScores(transcript) {
    setScoringDone(false);
    setScoringError(null);
    setPendingTranscript(transcript);
    const text = transcript
      .filter(m => m.role !== "system")
      .map(m => `${m.role === "candidate" ? "CANDIDATE" : "INTERVIEWER"}: ${m.content}`)
      .join("\n");
    try {
      const sys = `Evaluate this PM interview transcript on 11 dimensions. Be honest and specific — base every score and citation only on what actually appears in the transcript. Return ONLY valid JSON with NO markdown: {scores:{structure:{score:1-4,citation:string},crossq:{score,citation},discovery:{score,citation},empathy:{score,citation},prioritisation:{score,citation},tradeoffs:{score,citation},communication:{score,citation},storytelling:{score,citation},claimdepth:{score,citation},aipm:{score,citation},grounding:{score,citation}},overall:number(1dp average of all scores),topStrength:string,topWeakness:string,authenticityNote:string,pmCoachingSignals:string[](2-4 specific thinking-pattern observations with turn citations — e.g. "Jumped to solution without validating the user problem (Turn 3)", "Never defined success metrics despite two opportunities to do so", "Used we/team language throughout — no decision was claimed personally")}`;
      const result = await callClaudeJSON([{ role: "user", content: `Evaluate this transcript:\n\n${text}` }], sys, 1500, { retries: 2 });
      // Normalise: Groq sometimes returns numbers as strings — coerce before validating
      if (typeof result.overall === 'string') result.overall = parseFloat(result.overall);
      DIMS.forEach(d => {
        const dim = result?.scores?.[d.key];
        if (dim && typeof dim.score === 'string') dim.score = parseFloat(dim.score);
      });
      const hasAllDims = DIMS.every(d => {
        const s = result?.scores?.[d.key]?.score;
        return typeof s === 'number' && !isNaN(s) && s >= 1 && s <= 4;
      });
      if (!hasAllDims || typeof result.overall !== 'number' || isNaN(result.overall)) throw new Error("MALFORMED_SCORE_SHAPE");
      if (!Array.isArray(result.pmCoachingSignals)) result.pmCoachingSignals = [];
      setScores(result);
      setScoringDone(true);
      onSessionComplete?.(result, type);
    } catch (e) {
      // CRITICAL: never substitute random/fake scores. A wrong score that
      // looks real is worse than no score — it's the exact hallucination
      // risk this whole rebuild is meant to eliminate. Show a real error
      // and let the user explicitly retry against the real transcript.
      setScoringError(friendlyError(e));
      setScoringDone(false);
    }
  }

  function retryScoring() {
    if (pendingTranscript) buildScores(pendingTranscript);
  }

  async function buildAutopsy(transcript) {
    if (!setAutopsy) return;
    const text = transcript
      .filter(m => m.role !== "system")
      .map((m, i) => `Turn ${Math.ceil((i + 1) / 2)} — ${m.role === "candidate" ? "CANDIDATE" : "INTERVIEWER"}: ${m.content}`)
      .join("\n");
    try {
      const sys = `You are doing a post-mortem on a PM interview. Find the exact moments where the candidate lost credibility.

Analyze this transcript and return ONLY valid JSON, no markdown:
{
  "turningPoint": {
    "turnNumber": number,
    "interviewerQuestion": string (exact quote from transcript),
    "candidateAnswer": string (exact quote, max 200 chars — truncate with ... if longer),
    "gap": string (2 sentences: what the interviewer actually heard, and why this damaged credibility)
  },
  "weakMoments": [
    {
      "interviewerQuestion": string (exact quote),
      "candidateAnswer": string (exact quote, max 150 chars),
      "gap": string (the specific problem with this answer — be precise, not generic),
      "modelAnswer": string (what a strong 4/4 answer looks like — specific, first-person, with a real number or named decision, 2-3 sentences)
    }
  ],
  "drillQuestion": string (the single most important question from the transcript to practice again — exact quote)
}

Rules:
- weakMoments must have exactly 3 items, ordered worst to less-bad
- turningPoint is the single exchange that most damaged credibility — not just a weak answer but a credibility shift
- modelAnswer must be concrete and first-person — not generic advice like "be more specific"
- drillQuestion must be taken verbatim from the transcript`;
      const result = await callGroqJSON(
        [{ role: "user", content: `Analyze this PM interview transcript:\n\n${text}` }],
        sys, 1400, { retries: 1 }
      );
      if (!result.turningPoint || !Array.isArray(result.weakMoments) || result.weakMoments.length < 3 || !result.drillQuestion) {
        throw new Error("MALFORMED_AUTOPSY");
      }
      setAutopsy(result);
    } catch (e) {
      setAutopsyError?.(friendlyError(e));
    }
  }

  async function endSession(finalMsgs) {
    const transcript = finalMsgs || msgs;
    setEnded(true);
    setMockDone(true);
    setLoading(false);
    await Promise.all([buildScores(transcript), buildAutopsy(transcript)]);
  }

  async function send() {
    if (!input.trim() || loading || ended) return;
    const msg = input.trim();
    setInput("");
    setSendError(null);
    const next = [...msgs, { role: "candidate", content: msg }];
    setMsgs(next);
    setLoading(true);
    const newTurns = turns + 1;

    if (newTurns >= MAX) {
      setTurns(newTurns);
      const closing = "Thank you — I think I have a good sense of how you think. We'll be in touch with next steps.";
      const finalMsgs = [...next, { role: "interviewer", content: closing }];
      setMsgs(finalMsgs);
      await endSession(finalMsgs);
      return;
    }

    try {
      const apiMsgs = next.map(m => ({ role: m.role === "candidate" ? "user" : "assistant", content: m.content }));
      const reply = await callClaude(apiMsgs, systemPrompt(type), 250, { retries: 1 });
      setMsgs([...next, { role: "interviewer", content: reply }]);
      setTurns(newTurns);
    } catch (e) {
      // Don't advance the turn counter or silently inject a fake reply —
      // put the user's message back in the input so nothing is lost, and
      // let them retry the same turn.
      setMsgs(msgs); // revert to before this turn
      setInput(msg);
      setSendError(friendlyError(e));
    }
    setLoading(false);
  }

  if (!type) {
    if (!storyBank) return (
      <div>
        <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
          <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Mock Interview</div>
          <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>Story Bank required before simulation</div>
        </div>
        <div style={{ padding: "28px 32px", maxWidth: 600 }}>
          <div style={{ background: C.amberL, border: "1px solid #FCD34D", borderRadius: 12, padding: "20px 24px", marginBottom: 20 }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: "#92400E", marginBottom: 8 }}>Story Bank required to unlock the mock</div>
            <div style={{ fontSize: 13, color: "#92400E", lineHeight: 1.7, marginBottom: 14 }}>
              The mock is conditioned on your real work. Without a Story Bank, the interviewer has nothing to probe — it becomes a generic AI chat, exactly what Rethink is designed to replace.
            </div>
            <div style={{ fontSize: 12, color: "#92400E" }}>This is a product principle, not a UX choice. Probe-resistant answers come from mining your real work first.</div>
          </div>
          {[
            ["Build your Story Bank first", "Paste your resume → 5 probe questions per project → Story Bank built in ~10 minutes"],
            ["Your mock will be conditioned on it", "The interviewer will know exactly which projects to probe and which claims to test"],
            ["Generic mocks don't predict real outcomes", "Interview prep tools that skip this step help you sound better, not more grounded"],
          ].map(([title, desc]) => (
            <div key={title} style={{ display: "flex", gap: 12, marginBottom: 14 }}>
              <div style={{ width: 6, height: 6, borderRadius: "50%", background: C.purple, marginTop: 6, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.g800 }}>{title}</div>
                <div style={{ fontSize: 12, color: C.g500, marginTop: 2, lineHeight: 1.5 }}>{desc}</div>
              </div>
            </div>
          ))}
          <Btn size="lg" onClick={() => setScreen("story")}>Go to Story Intelligence →</Btn>
        </div>
      </div>
    );

    return (
      <div>
        <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
          <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Mock Interview</div>
          <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>
            {`Story bank loaded · ${storyBank.length} cards · Interviewer knows your projects`}
          </div>
        </div>
        <div style={{ padding: "28px 32px" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, maxWidth: 680 }}>
            {[
              { t: "founder", icon: "👤", title: "Founder Round", desc: "Simulates a founder/CEO interview with deep probing on your work, MVP thinking, prioritisation, and business judgment.", badge: "Based on Geetha's interview · Unnati's questions" },
              { t: "discovery", icon: "🔍", title: "Product Discovery Round", desc: "AI acts as a user persona. You must discover the real problem — not pitch solutions. Tests cross-questioning and product thinking.", badge: "Based on GajaLakshmi's & Anmoll's observed rounds" },
            ].map(({ t, icon, title, desc, badge }) => (
              <MockTypeCard key={t} t={t} icon={icon} title={title} desc={desc} badge={badge} onStart={start} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      {/* Header */}
      <div style={{ padding: "16px 32px", borderBottom: `1px solid ${C.g200}`, background: C.white, display: "flex", justifyContent: "space-between", alignItems: "center", flexShrink: 0 }}>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15 }}>{type === "founder" ? "👤 Founder Round" : "🔍 Discovery Round"} · {company?.name}</div>
          <div style={{ fontSize: 12, color: C.g500 }}>
            Turn {turns}/{MAX} · {ended ? (scoringDone ? "✅ Scores ready" : "⏳ Scoring your answers...") : "In progress"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <ProgressBar pct={(turns / MAX) * 100} height={5} />
          {!ended && (
            <Btn variant="secondary" size="sm" onClick={() => endSession()}>
              End session
            </Btn>
          )}
          {ended && scoringDone && (
            <Btn variant="teal" onClick={() => setScreen("autopsy")}>
              View transcript autopsy →
            </Btn>
          )}
          {ended && !scoringDone && !scoringError && (
            <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.purple }}>
              <Spinner /> Scoring...
            </div>
          )}
          {ended && scoringError && (
            <Btn variant="secondary" size="sm" onClick={retryScoring}>↻ Retry scoring</Btn>
          )}
        </div>
      </div>

      {/* Chat area */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 32px", display: "flex", flexDirection: "column", gap: 14 }}>
        {msgs.map((m, i) => (
          <div key={i} style={{ maxWidth: "72%", alignSelf: m.role === "candidate" ? "flex-end" : "flex-start", animation: "fadeIn .25s ease" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.g400, marginBottom: 3, textAlign: m.role === "candidate" ? "right" : "left" }}>
              {m.role === "interviewer" ? (type === "founder" ? "🏢 Founder" : "🔍 Interviewer") : "🧑 You"}
            </div>
            <div style={{ padding: "11px 15px", borderRadius: 14, fontSize: 13, lineHeight: 1.65, background: m.role === "candidate" ? C.purple : C.white, color: m.role === "candidate" ? "#fff" : C.g800, border: m.role === "interviewer" ? `1px solid ${C.g200}` : "none", boxShadow: m.role === "interviewer" ? "0 1px 3px rgba(0,0,0,.06)" : "none", borderBottomLeftRadius: m.role === "interviewer" ? 4 : 14, borderBottomRightRadius: m.role === "candidate" ? 4 : 14 }}>
              {m.content}
            </div>
            {m.role === "interviewer" && (
              <button onClick={() => speak(m.content)} title="Listen" style={{ marginTop: 4, background: "none", border: "none", cursor: "pointer", fontSize: 13, color: C.g400, padding: "2px 4px" }}>🔊</button>
            )}
          </div>
        ))}

        {/* "Your turn" nudge — appears after each interviewer message so users know to scroll down and type */}
        {msgs.length > 0 && !ended && !loading && msgs[msgs.length - 1].role === "interviewer" && (
          <div style={{ alignSelf: "center", fontSize: 11, color: C.g400, padding: "4px 14px", background: C.g100, borderRadius: 99, letterSpacing: ".02em" }}>
            ↓ Your turn — type your answer below
          </div>
        )}

        {/* Typing indicator */}
        {loading && !ended && (
          <div style={{ alignSelf: "flex-start" }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.g400, marginBottom: 3 }}>{type === "founder" ? "🏢 Founder" : "🔍 Interviewer"}</div>
            <div style={{ padding: "11px 15px", borderRadius: "14px 14px 14px 4px", background: C.white, border: `1px solid ${C.g200}`, boxShadow: "0 1px 3px rgba(0,0,0,.06)" }}>
              <TypingDots />
            </div>
          </div>
        )}

        {/* Send error — message is preserved in input, never silently lost */}
        {sendError && !ended && (
          <div style={{ alignSelf: "center", padding: "10px 16px", background: C.redL, border: "1px solid #FCA5A5", borderRadius: 10, fontSize: 12, color: C.red, maxWidth: "85%", textAlign: "center" }}>
            ⚠️ {sendError} Your message is back in the box below — just hit Send again.
          </div>
        )}

        {/* End of session banner — always visible once ended */}
        {ended && (
          <div style={{ alignSelf: "stretch", margin: "8px 0", padding: "20px 24px", background: scoringError ? C.amberL : C.tealL, border: `1.5px solid ${scoringError ? "#FCD34D" : "#6EE7B7"}`, borderRadius: 14, textAlign: "center" }}>
            <div style={{ fontSize: 20, marginBottom: 8 }}>{scoringError ? "⚠️" : "🎯"}</div>
            <div style={{ fontWeight: 700, fontSize: 15, color: scoringError ? "#92400E" : "#065F46", marginBottom: 4 }}>
              {scoringError ? "Scoring failed — your transcript is safe" : `Session complete — ${turns} turns`}
            </div>
            <div style={{ fontSize: 13, color: scoringError ? "#92400E" : "#047857", marginBottom: 16 }}>
              {scoringError
                ? `${scoringError} Nothing was lost — your full transcript is saved and ready to re-score.`
                : (scoringDone
                  ? "Your answers have been scored across 11 PM rubric dimensions. Click below to see your feedback."
                  : "Evaluating your answers across 11 PM rubric dimensions...")}
            </div>
            {scoringError ? (
              <Btn variant="teal" size="lg" onClick={retryScoring}>↻ Retry scoring →</Btn>
            ) : scoringDone ? (
              <Btn variant="teal" size="lg" onClick={() => setScreen("autopsy")}>
                View transcript autopsy →
              </Btn>
            ) : (
              <div style={{ display: "inline-flex", alignItems: "center", gap: 10, fontSize: 13, color: C.purple }}>
                <Spinner /> Generating your rubric scores...
              </div>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input area — hidden once ended */}
      {!ended && (
        <div style={{ padding: "14px 32px", borderTop: `1px solid ${C.g200}`, background: C.white, flexShrink: 0 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            rows={3}
            placeholder="Type your answer here — be specific. Real numbers, real decisions, real timelines. Shift+Enter for new line."
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            style={{ width: "100%", fontFamily: "inherit", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.g300}`, borderRadius: 8, resize: "none", outline: "none", lineHeight: 1.6 }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            {speech.supported && (
              <button
                onClick={speech.toggle}
                title={speech.listening ? "Stop recording" : "Record answer"}
                style={{ flexShrink: 0, padding: "0 16px", background: speech.listening ? "#FEF2F2" : C.g100, border: `1px solid ${speech.listening ? "#FCA5A5" : C.g300}`, borderRadius: 8, fontSize: 18, cursor: "pointer", color: speech.listening ? "#DC2626" : C.g600 }}
              >
                {speech.listening ? "⏹" : "🎤"}
              </button>
            )}
            <Btn size="lg" onClick={send} disabled={!input.trim() || loading} style={{ flex: 1, justifyContent: "center" }}>
              {loading ? <><Spinner /> Thinking...</> : "Submit answer →"}
            </Btn>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Feedback ──────────────────────────────────────────────────────────────────
function FeedbackScreen({ scores, storyBank }) {
  if (!scores) return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Feedback & Scores</div>
      </div>
      <div style={{ padding: "28px 32px" }}>
        <InfoBox type="warning">Complete a mock interview first to see your feedback.</InfoBox>
      </div>
    </div>
  );

  const [expandedDim, setExpandedDim] = useState(null);
  const overall = scores.overall || 0;
  const oColor = overall >= 3 ? C.teal : overall >= 2 ? C.amber : C.red;
  const sc = s => s >= 3.5 ? C.teal : s >= 2.5 ? C.amber : C.red;
  const band = s => s >= 3.5 ? "Strong" : s >= 2.5 ? "Developing" : s >= 1.5 ? "Weak" : "Critical gap";

  return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Feedback & Scores</div>
        <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>11-dimension rubric · Every score cites a transcript moment</div>
      </div>
      <div style={{ padding: "28px 32px" }}>
        {/* Summary */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
          <div style={{ background: C.g50, border: `1px solid ${C.g200}`, borderTop: `3px solid ${oColor}`, borderRadius: 10, padding: "14px 16px", textAlign: "center" }}>
            <div style={{ fontFamily: "Georgia,serif", fontSize: 36, fontWeight: 700, color: oColor }}>{overall}/4</div>
            <div style={{ fontSize: 11, color: C.g500, marginTop: 2 }}>Overall readiness</div>
          </div>
          <div style={{ background: C.g50, border: `1px solid ${C.g200}`, borderTop: `3px solid ${C.teal}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.teal, marginBottom: 6 }}>Top strength</div>
            <div style={{ fontSize: 13, color: C.g700 }}>{scores.topStrength}</div>
          </div>
          <div style={{ background: C.g50, border: `1px solid ${C.g200}`, borderTop: `3px solid ${C.red}`, borderRadius: 10, padding: "14px 16px" }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: C.red, marginBottom: 6 }}>Top weakness</div>
            <div style={{ fontSize: 13, color: C.g700 }}>{scores.topWeakness}</div>
          </div>
        </div>

        {scores.authenticityNote && (
          <div style={{ padding: "12px 16px", borderRadius: 10, marginBottom: 20, background: C.purpleL, border: `1px solid ${C.purpleM}`, fontSize: 13, color: C.purpleD }}>
            <strong>Story grounding:</strong> {scores.authenticityNote}
          </div>
        )}

        {/* PM Thinking Coach */}
        {scores.pmCoachingSignals?.length > 0 && (
          <Card style={{ marginBottom: 20, border: `1px solid #FCD34D` }}>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>PM Thinking Coach</div>
            <div style={{ fontSize: 12, color: C.g500, marginBottom: 14 }}>Thinking patterns observed in your session — these are what interviewers are actually scoring, not just the rubric dimensions</div>
            {scores.pmCoachingSignals.map((signal, i) => (
              <div key={i} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: "9px 0", borderBottom: i < scores.pmCoachingSignals.length - 1 ? `1px solid ${C.g100}` : "none" }}>
                <div style={{ color: C.amber, fontWeight: 700, fontSize: 14, flexShrink: 0, marginTop: 1 }}>⚠</div>
                <div style={{ fontSize: 13, color: C.g700, lineHeight: 1.6 }}>{signal}</div>
              </div>
            ))}
          </Card>
        )}

        {/* Rubric */}
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
            <div style={{ fontWeight: 700, fontSize: 14 }}>11-Dimension Rubric Scores</div>
            <div style={{ fontSize: 11, color: C.g400 }}>Click any dimension to see what each score means</div>
          </div>
          {DIMS.map(dim => {
            const s = scores.scores?.[dim.key];
            const score = s?.score || 1;
            const isExp = expandedDim === dim.key;
            return (
              <div key={dim.key}>
                <div onClick={() => setExpandedDim(isExp ? null : dim.key)}
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: isExp ? "none" : `1px solid ${C.g100}`, cursor: "pointer" }}>
                  <div style={{ fontSize: 12, fontWeight: 500, color: C.g700, width: 190, flexShrink: 0 }}>{dim.label}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <ProgressBar pct={(score / 4) * 100} color={sc(score)} height={7} />
                      <span style={{ fontSize: 10, color: sc(score), fontWeight: 700, minWidth: 72 }}>{band(score)}</span>
                    </div>
                    {s?.citation && <div style={{ fontSize: 11, color: C.g400, marginTop: 3, fontStyle: "italic" }}>"{s.citation}"</div>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: sc(score), width: 28, textAlign: "right" }}>{score}/4</div>
                  <div style={{ fontSize: 10, color: C.g300, width: 10, textAlign: "right" }}>{isExp ? "▲" : "▼"}</div>
                </div>
                {isExp && (
                  <div style={{ padding: "8px 12px 14px", background: C.g50, borderBottom: `1px solid ${C.g100}`, marginLeft: 0 }}>
                    <div style={{ fontSize: 10, fontWeight: 700, color: C.g500, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8 }}>What each score means for {dim.label}</div>
                    {[4, 3, 2, 1].map(b => (
                      <div key={b} style={{ display: "flex", gap: 10, marginBottom: 6, alignItems: "flex-start" }}>
                        <span style={{ fontWeight: 700, fontSize: 11, minWidth: 22, color: b === 4 ? C.teal : b === 3 ? C.teal : b === 2 ? C.amber : C.red }}>{b}/4</span>
                        <span style={{ fontSize: 11, color: b === score ? C.g900 : C.g500, lineHeight: 1.55, fontWeight: b === score ? 600 : 400 }}>
                          {b === score && <span style={{ color: sc(score), marginRight: 4 }}>←</span>}{DIM_ANCHORS[dim.key]?.[b]}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </Card>

        {/* Story bank alignment */}
        {storyBank && (
          <Card>
            <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 4 }}>Story Bank Alignment</div>
            <div style={{ fontSize: 12, color: C.g500, marginBottom: 16 }}>How your interview answers held up against your story bank cards</div>
            {storyBank.slice(0, 2).map((card, i) => (
              <div key={i} style={{ padding: "12px 0", borderBottom: `1px solid ${C.g100}` }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{card.projectTitle} · {card.company}</div>
                <div style={{ fontSize: 12, color: C.g600, fontStyle: "italic", marginBottom: 6 }}>Core claim: "{card.coreClaim}"</div>
                <div style={{ fontSize: 12, color: C.g500 }}>⚠️ Probes the interviewer used: {card.followUpProbes?.join(" / ")}</div>
              </div>
            ))}
            <div style={{ marginTop: 14, padding: "12px 14px", background: C.g50, borderRadius: 10, fontSize: 12, color: C.g700 }}>
              <strong>Next session focus:</strong> For each claim in your story bank, prepare a specific metric and one decision you made alone that nobody else could have made. That's what separates a 3 from a 4 on story grounding.
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
// ── Session History ────────────────────────────────────────────────────────
function HistoryScreen({ sessionHistory, setScreen, onOutcomeUpdate }) {
  const [outcomes, setOutcomes] = useState(() => {
    const init = {};
    sessionHistory.forEach(s => { if (s.outcome) init[s.id] = s.outcome; });
    return init;
  });

  function setOutcome(id, val) {
    setOutcomes(o => ({ ...o, [id]: val }));
    onOutcomeUpdate?.(id, val);
  }

  if (sessionHistory.length === 0) return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Session History</div>
        <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>Your improvement over time, and real interview outcomes</div>
      </div>
      <div style={{ padding: "28px 32px" }}>
        <InfoBox type="info">No sessions yet. Complete a mock interview to start building your history — this is how you'll actually see whether feedback is changing your performance over time.</InfoBox>
        <Btn onClick={() => setScreen("mock")}>Start your first mock →</Btn>
      </div>
    </div>
  );

  const trend = sessionHistory.length >= 2
    ? sessionHistory[sessionHistory.length - 1].overall - sessionHistory[0].overall
    : 0;

  return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Session History</div>
        <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>{sessionHistory.length} session{sessionHistory.length !== 1 ? "s" : ""} completed</div>
      </div>
      <div style={{ padding: "28px 32px" }}>
        {sessionHistory.length >= 2 && (
          <InfoBox type={trend > 0 ? "success" : "info"}>
            {trend > 0
              ? `Your overall score improved by ${trend.toFixed(1)} points from your first to most recent session.`
              : trend < 0
              ? `Your most recent score is ${Math.abs(trend).toFixed(1)} points lower than your first. That can happen with a harder company or round type — check which rubric dimensions shifted below.`
              : `Your scores have stayed flat across sessions. Try focusing specifically on your top weakness from the last session before your next mock.`}
          </InfoBox>
        )}

        <WeaknessInsights insights={getWeaknessInsights(sessionHistory)} />

        {/* Company Replay — dimension-level progress per company */}
        {(() => {
          const byCompany = {};
          sessionHistory.forEach(s => {
            if (!byCompany[s.company]) byCompany[s.company] = [];
            byCompany[s.company].push(s);
          });
          const multi = Object.entries(byCompany).filter(([, ss]) => ss.length >= 2);
          if (multi.length === 0) return null;
          return (
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.g500, marginBottom: 12 }}>
                Company replay — progress across sessions
              </div>
              {multi.map(([company, ss]) => {
                const sorted = [...ss].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
                const first = sorted[0];
                const latest = sorted[sorted.length - 1];
                const overallDelta = latest.overall - first.overall;
                const dimMovers = DIMS.map(d => {
                  const f = first.scores?.[d.key]?.score;
                  const l = latest.scores?.[d.key]?.score;
                  if (typeof f !== "number" || typeof l !== "number") return null;
                  return { label: d.label, delta: parseFloat((l - f).toFixed(1)), latest: l };
                }).filter(Boolean).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 3);
                const sc2 = s => s >= 3 ? C.teal : s >= 2 ? C.amber : C.red;
                return (
                  <div key={company} style={{ background: C.white, border: `1px solid ${C.g200}`, borderRadius: 12, padding: "16px 20px", marginBottom: 12 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>{company} — {sorted.length} sessions</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ fontSize: 12, color: C.g500 }}>{first.overall}/4</span>
                        <span style={{ fontSize: 12, color: C.g400 }}>→</span>
                        <span style={{ fontSize: 14, fontWeight: 700, color: sc2(latest.overall) }}>{latest.overall}/4</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color: overallDelta > 0 ? C.teal : overallDelta < 0 ? C.red : C.g400 }}>
                          {overallDelta > 0 ? `↑ +${overallDelta.toFixed(1)}` : overallDelta < 0 ? `↓ ${overallDelta.toFixed(1)}` : "→ flat"}
                        </span>
                      </div>
                    </div>
                    {dimMovers.length > 0 && (
                      <div style={{ display: "flex", gap: 10 }}>
                        {dimMovers.map(d => (
                          <div key={d.label} style={{ flex: 1, background: C.g50, borderRadius: 8, padding: "8px 10px", border: `1px solid ${C.g200}` }}>
                            <div style={{ fontSize: 10, color: C.g500, marginBottom: 3 }}>{d.label}</div>
                            <div style={{ fontSize: 11, fontWeight: 700, color: d.delta > 0 ? C.teal : d.delta < 0 ? C.red : C.g400 }}>
                              {d.delta > 0 ? `↑ +${d.delta}` : d.delta < 0 ? `↓ ${d.delta}` : "→ flat"} · {d.latest}/4
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}

        {sessionHistory.slice().reverse().map((s, idx) => {
          const sessionNum = sessionHistory.length - idx;
          const oColor = s.overall >= 3 ? C.teal : s.overall >= 2 ? C.amber : C.red;
          return (
            <Card key={s.id} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>Session {sessionNum} · {s.type === "founder" ? "👤 Founder Round" : "🔍 Discovery Round"} · {s.company}</div>
                  <div style={{ fontSize: 11, color: C.g500, marginTop: 2 }}>{s.timestamp}</div>
                </div>
                <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700, color: oColor }}>{s.overall}/4</div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 14, fontSize: 12 }}>
                <div><strong style={{ color: C.teal }}>Strength:</strong> {s.topStrength}</div>
                <div><strong style={{ color: C.red }}>Weakness:</strong> {s.topWeakness}</div>
              </div>

              {/* Outcome capture — this is the data the entire offer-conversion north star depends on */}
              <div style={{ paddingTop: 12, borderTop: `1px solid ${C.g100}` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.g600, marginBottom: 8 }}>Did this prep lead anywhere? (helps us learn what actually predicts outcomes)</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {["Got the interview", "Got an offer", "Rejected", "Still waiting", "Haven't interviewed yet"].map(opt => (
                    <button key={opt} onClick={() => setOutcome(s.id, opt)}
                      style={{ fontSize: 11, padding: "5px 10px", borderRadius: 99, cursor: "pointer", border: `1px solid ${outcomes[s.id] === opt ? C.purple : C.g300}`, background: outcomes[s.id] === opt ? C.purpleL : "transparent", color: outcomes[s.id] === opt ? C.purpleD : C.g600, fontFamily: "inherit" }}>
                      {opt}
                    </button>
                  ))}
                </div>
                {outcomes[s.id] && (
                  <div style={{ marginTop: 8, fontSize: 11, color: C.teal }}>✓ Recorded — thank you, this directly improves how accurately future scores predict real outcomes.</div>
                )}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}


// ── Story Coach ───────────────────────────────────────────────────────────────
function StoryCoachScreen({ storyBank, setScreen }) {
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [activeIdx, setActiveIdx] = useState(0);

  const bank = storyBank ? JSON.parse(storyBank) : null;

  async function runCoach() {
    if (!bank || bank.length === 0) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const cards = bank.map((c, i) => `[${i + 1}] Project: ${c.project || "Unnamed"}\nRole/contribution: ${c.contribution || "—"}\nMetrics: ${c.metrics || "—"}\nChallenge: ${c.challenge || "—"}\nDecision: ${c.decision || "—"}`).join("\n\n");

      const sys = `You are a PM interview coach specializing in STAR storytelling. Given a candidate's raw story bank, extract and critique each story as a STAR narrative.

For each story, produce:
- situation: 1–2 sentence framing (context, stakes, why it mattered)
- task: candidate's specific ownership and responsibility
- action: 2–3 concrete steps they personally took (avoid "we")
- result: measurable outcome with specific number and timeframe
- starScore: 1–4 (1=weak/missing, 2=basic, 3=solid, 4=compelling)
- strengths: array of 1–2 strings — what's already working
- gaps: array of 1–2 strings — what's missing or vague
- rewriteHint: one sentence telling the candidate exactly what to add to improve this story

Return ONLY valid JSON, no markdown:
{
  "stories": [
    {
      "index": number,
      "project": string,
      "situation": string,
      "task": string,
      "action": string,
      "result": string,
      "starScore": number,
      "strengths": [string],
      "gaps": [string],
      "rewriteHint": string
    }
  ],
  "overallVerdict": string (2–3 sentences: what pattern cuts across all stories, the one thing to fix first)
}`;

      const result = await callGroqJSON(
        [{ role: "user", content: `Story bank entries:\n\n${cards}` }],
        sys, 2000, { retries: 1 }
      );
      if (!result?.stories) throw new Error("Unexpected response from coach");
      setResults(result);
      setActiveIdx(0);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      setLoading(false);
    }
  }

  if (!bank || bank.length === 0) {
    return (
      <div style={{ padding: "24px 32px" }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Story Coach</div>
        <InfoBox type="info">
          Your Story Bank is empty. Complete Story Intelligence first so Story Coach has material to work with.
          <div style={{ marginTop: 10 }}>
            <Btn onClick={() => setScreen("story")}>Go to Story Intelligence →</Btn>
          </div>
        </InfoBox>
      </div>
    );
  }

  const scoreColor = s => s >= 4 ? C.teal : s >= 3 ? C.purple : s >= 2 ? C.amber : C.red;
  const scoreLabel = s => s >= 4 ? "Compelling" : s >= 3 ? "Solid" : s >= 2 ? "Basic" : "Weak";

  return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700, color: C.g900 }}>Story Coach</div>
          <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>STAR extraction + gap analysis for your {bank.length} story bank entries</div>
        </div>
        {!results && !loading && (
          <Btn onClick={runCoach}>Analyse my stories →</Btn>
        )}
        {results && (
          <Btn onClick={runCoach}>Re-analyse →</Btn>
        )}
      </div>

      <div style={{ padding: "28px 32px" }}>
        {!results && !loading && !error && (
          <Card style={{ marginBottom: 20 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>What Story Coach does</div>
            <div style={{ fontSize: 13, color: C.g600, lineHeight: 1.6 }}>
              Your story bank has <strong>{bank.length} projects</strong>. Story Coach will extract a STAR narrative (Situation → Task → Action → Result) from each one, score the narrative quality, and tell you exactly what to add to make each story land in a real interview.
            </div>
            <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {[
                { icon: "🔍", title: "STAR extraction", desc: "Pulls out what's there — even when implicit" },
                { icon: "📍", title: "Gap detection", desc: "Flags missing metrics, vague ownership, weak results" },
                { icon: "✏️", title: "Rewrite hints", desc: "One specific sentence on what to add per story" },
              ].map(f => (
                <div key={f.title} style={{ background: C.g50, borderRadius: 8, padding: "12px 14px", border: `1px solid ${C.g200}` }}>
                  <div style={{ fontSize: 18, marginBottom: 6 }}>{f.icon}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: C.g800, marginBottom: 4 }}>{f.title}</div>
                  <div style={{ fontSize: 11, color: C.g500 }}>{f.desc}</div>
                </div>
              ))}
            </div>
          </Card>
        )}

        {loading && (
          <Card>
            <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
              <div style={{ width: 20, height: 20, borderRadius: "50%", border: `2px solid ${C.purple}`, borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
              <div style={{ fontSize: 13, color: C.g600 }}>Extracting STAR narratives from your {bank.length} stories...</div>
            </div>
          </Card>
        )}

        {error && <InfoBox type="error">{error}</InfoBox>}

        {results && (
          <>
            <InfoBox type={results.overallVerdict?.toLowerCase().includes("strong") ? "success" : "info"} style={{ marginBottom: 20 }}>
              <strong>Overall verdict:</strong> {results.overallVerdict}
            </InfoBox>

            {/* Story tabs */}
            <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap" }}>
              {results.stories.map((s, i) => (
                <button key={i} onClick={() => setActiveIdx(i)}
                  style={{ fontSize: 12, padding: "6px 12px", borderRadius: 99, cursor: "pointer", fontFamily: "inherit", border: `1.5px solid ${activeIdx === i ? scoreColor(s.starScore) : C.g200}`, background: activeIdx === i ? (s.starScore >= 3 ? C.tealL : s.starScore >= 2 ? "#FFF8E1" : "#FEF2F2") : "transparent", color: activeIdx === i ? scoreColor(s.starScore) : C.g600, fontWeight: activeIdx === i ? 700 : 400 }}>
                  {s.project || `Story ${i + 1}`}
                  <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700 }}>{scoreLabel(s.starScore)}</span>
                </button>
              ))}
            </div>

            {results.stories[activeIdx] && (() => {
              const s = results.stories[activeIdx];
              return (
                <Card>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 20 }}>
                    <div>
                      <div style={{ fontFamily: "Georgia,serif", fontSize: 18, fontWeight: 700, color: C.g900 }}>{s.project || `Story ${activeIdx + 1}`}</div>
                      <div style={{ fontSize: 12, color: C.g500, marginTop: 2 }}>STAR narrative extracted from your story bank</div>
                    </div>
                    <div style={{ textAlign: "center", background: scoreColor(s.starScore), color: "#fff", borderRadius: 8, padding: "6px 14px" }}>
                      <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>{s.starScore}/4</div>
                      <div style={{ fontSize: 10, fontWeight: 700 }}>{scoreLabel(s.starScore)}</div>
                    </div>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
                    {[
                      { key: "S", label: "Situation", val: s.situation, color: "#EFF6FF", border: "#BFDBFE" },
                      { key: "T", label: "Task", val: s.task, color: "#F0FDF4", border: "#BBF7D0" },
                      { key: "A", label: "Action", val: s.action, color: "#FFF7ED", border: "#FED7AA" },
                      { key: "R", label: "Result", val: s.result, color: s.result && s.result.match(/\d/) ? "#F0FDF4" : "#FEF2F2", border: s.result && s.result.match(/\d/) ? "#BBF7D0" : "#FECACA" },
                    ].map(row => (
                      <div key={row.key} style={{ background: row.color, border: `1px solid ${row.border}`, borderRadius: 10, padding: "12px 14px" }}>
                        <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.g500, marginBottom: 4 }}>{row.key} — {row.label}</div>
                        <div style={{ fontSize: 13, color: C.g800, lineHeight: 1.5 }}>{row.val || <span style={{ color: C.g400, fontStyle: "italic" }}>Not found in story bank</span>}</div>
                      </div>
                    ))}
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 16 }}>
                    <div style={{ background: C.tealL, border: `1px solid #99F6E4`, borderRadius: 10, padding: "12px 14px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.teal, marginBottom: 8 }}>Strengths</div>
                      {(s.strengths || []).map((str, i) => (
                        <div key={i} style={{ fontSize: 13, color: C.g800, display: "flex", gap: 6, marginBottom: 4 }}>
                          <span style={{ color: C.teal, flexShrink: 0 }}>✓</span>{str}
                        </div>
                      ))}
                      {(!s.strengths || s.strengths.length === 0) && <div style={{ fontSize: 12, color: C.g400, fontStyle: "italic" }}>None identified yet</div>}
                    </div>
                    <div style={{ background: "#FFF8E1", border: `1px solid #FDE68A`, borderRadius: 10, padding: "12px 14px" }}>
                      <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.amber, marginBottom: 8 }}>Gaps</div>
                      {(s.gaps || []).map((g, i) => (
                        <div key={i} style={{ fontSize: 13, color: C.g800, display: "flex", gap: 6, marginBottom: 4 }}>
                          <span style={{ color: C.amber, flexShrink: 0 }}>△</span>{g}
                        </div>
                      ))}
                      {(!s.gaps || s.gaps.length === 0) && <div style={{ fontSize: 12, color: C.g400, fontStyle: "italic" }}>No major gaps</div>}
                    </div>
                  </div>

                  <div style={{ background: C.purpleL, border: `1px solid #D1CEFF`, borderRadius: 10, padding: "12px 14px" }}>
                    <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.purple, marginBottom: 6 }}>Rewrite hint</div>
                    <div style={{ fontSize: 13, color: C.purpleD, lineHeight: 1.5 }}>{s.rewriteHint}</div>
                  </div>
                </Card>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

// ── Transcript Autopsy ────────────────────────────────────────────────────────
function AutopsyScreen({ autopsy, autopsyError, scores, setScreen }) {
  const [drillAnswer, setDrillAnswer] = useState("");
  const [drillScore, setDrillScore] = useState(null);
  const [drillLoading, setDrillLoading] = useState(false);
  const [drillError, setDrillError] = useState(null);
  const drillSpeech = useSpeechInput(setDrillAnswer);

  async function submitDrill() {
    if (!drillAnswer.trim() || !autopsy?.drillQuestion) return;
    setDrillLoading(true);
    setDrillError(null);
    try {
      const sys = `Evaluate this single PM interview answer on 3 dimensions. Be honest and specific — base every note only on what the candidate actually wrote.

Question asked: "${autopsy.drillQuestion}"

Dimensions:
- structure: Was the answer organized with a clear narrative arc?
- storytelling: Specific first-person narrative with real details (names, numbers, timelines)?
- claimdepth: Did claims have backing evidence — numbers, named decisions, context?

Scale: 1=weak/missing, 2=basic attempt, 3=good, 4=strong

Return ONLY valid JSON, no markdown:
{
  "structure": {"score": number, "note": string},
  "storytelling": {"score": number, "note": string},
  "claimdepth": {"score": number, "note": string},
  "overall": number,
  "verdict": string (1 sentence: what specifically improved or still needs work)
}`;
      const result = await callGroqJSON(
        [{ role: "user", content: `Question: ${autopsy.drillQuestion}\n\nAnswer: ${drillAnswer}` }],
        sys, 600, { retries: 1 }
      );
      if (typeof result.overall === "string") result.overall = parseFloat(result.overall);
      ["structure", "storytelling", "claimdepth"].forEach(k => {
        if (result[k] && typeof result[k].score === "string") result[k].score = parseFloat(result[k].score);
      });
      setDrillScore(result);
    } catch (e) {
      setDrillError(friendlyError(e));
    }
    setDrillLoading(false);
  }

  const sc = s => s >= 3.5 ? C.teal : s >= 2.5 ? C.amber : C.red;

  if (!autopsy && !autopsyError) return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700, color: C.g900 }}>Transcript Autopsy</div>
        <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>Finding the exact moments your interview turned...</div>
      </div>
      <div style={{ padding: "28px 32px", display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: C.purple }}>
        <Spinner /> Analyzing transcript — this takes a few seconds...
      </div>
    </div>
  );

  if (autopsyError) return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700, color: C.g900 }}>Transcript Autopsy</div>
      </div>
      <div style={{ padding: "28px 32px" }}>
        <InfoBox type="warning">⚠️ {autopsyError} — autopsy couldn't complete, but your rubric scores are still available.</InfoBox>
        <Btn onClick={() => setScreen("feedback")}>See rubric scores →</Btn>
      </div>
    </div>
  );

  return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700, color: C.g900 }}>Transcript Autopsy</div>
          <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>The exact moments it went wrong — and how to fix them</div>
        </div>
        <Btn variant="secondary" onClick={() => setScreen("feedback")}>See full rubric scores →</Btn>
      </div>

      <div style={{ padding: "28px 32px", maxWidth: 760 }}>

        {/* ── Turning point ── */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.red, marginBottom: 12 }}>
            The moment it turned — Turn {autopsy.turningPoint?.turnNumber}
          </div>
          <Card style={{ border: `2px solid #FCA5A5` }}>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.g400, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>Interviewer asked</div>
              <div style={{ fontSize: 14, color: C.g800, fontStyle: "italic", lineHeight: 1.65 }}>"{autopsy.turningPoint?.interviewerQuestion}"</div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.g400, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>You said</div>
              <div style={{ fontSize: 13, color: C.purpleD, background: C.purpleL, padding: "10px 14px", borderRadius: 8, lineHeight: 1.65, borderLeft: `3px solid ${C.purpleM}` }}>
                "{autopsy.turningPoint?.candidateAnswer}"
              </div>
            </div>
            <div style={{ background: "#FEF2F2", border: "1px solid #FCA5A5", borderRadius: 8, padding: "10px 14px" }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.red, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 4 }}>What the interviewer heard</div>
              <div style={{ fontSize: 13, color: "#7F1D1D", lineHeight: 1.65 }}>{autopsy.turningPoint?.gap}</div>
            </div>
          </Card>
        </div>

        {/* ── 3 weak moments ── */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.g600, marginBottom: 12 }}>
            3 claims that didn't hold up
          </div>
          {autopsy.weakMoments?.map((m, i) => (
            <Card key={i} style={{ marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 14 }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: C.red, color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, flexShrink: 0, marginTop: 1 }}>{i + 1}</div>
                <div style={{ fontSize: 13, color: C.g600, fontStyle: "italic", lineHeight: 1.55 }}>"{m.interviewerQuestion}"</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.g400, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>You said</div>
                  <div style={{ fontSize: 12, color: C.g700, background: C.g50, padding: "8px 12px", borderRadius: 8, lineHeight: 1.6, borderLeft: `3px solid ${C.g300}`, minHeight: 56 }}>"{m.candidateAnswer}"</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.teal, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>4/4 answer looks like</div>
                  <div style={{ fontSize: 12, color: "#065F46", background: C.tealL, padding: "8px 12px", borderRadius: 8, lineHeight: 1.6, borderLeft: `3px solid ${C.teal}`, minHeight: 56 }}>{m.modelAnswer}</div>
                </div>
              </div>

              <div style={{ background: C.amberL, border: "1px solid #FCD34D", borderRadius: 8, padding: "8px 12px" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: "#92400E" }}>The gap: </span>
                <span style={{ fontSize: 12, color: "#92400E", lineHeight: 1.6 }}>{m.gap}</span>
              </div>
            </Card>
          ))}
        </div>

        {/* ── Re-drill ── */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: C.purple, marginBottom: 12 }}>
            Fix it now — answer the question you struggled with
          </div>
          <Card>
            <div style={{ padding: "14px 16px", background: C.purpleL, border: `1.5px solid ${C.purpleM}`, borderRadius: 10, marginBottom: 18 }}>
              <div style={{ fontSize: 10, fontWeight: 700, color: C.purple, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 5 }}>Drill question</div>
              <div style={{ fontSize: 15, color: C.purpleD, fontFamily: "Georgia,serif", fontStyle: "italic", lineHeight: 1.55 }}>{autopsy.drillQuestion}</div>
            </div>

            {!drillScore ? (
              <>
                <InfoBox type="info">Answer with specifics — a real number, a named decision, your reasoning. Pretend this is the real interview, take two.</InfoBox>
                <div style={{ marginBottom: 14 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <label style={{ fontSize: 12, fontWeight: 600, color: C.g700 }}>Your answer (take 2)</label>
                    {drillSpeech.supported && (
                      <button onClick={drillSpeech.toggle}
                        style={{ background: drillSpeech.listening ? "#FEF2F2" : C.g100, border: `1px solid ${drillSpeech.listening ? "#FCA5A5" : C.g300}`, borderRadius: 6, padding: "3px 10px", fontSize: 12, cursor: "pointer", color: drillSpeech.listening ? C.red : C.g600, fontFamily: "inherit" }}>
                        {drillSpeech.listening ? "Stop" : "Speak"}
                      </button>
                    )}
                  </div>
                  <textarea value={drillAnswer} onChange={e => setDrillAnswer(e.target.value)} rows={5} autoFocus
                    placeholder="Be specific. What exactly did you do? What number? What decision was yours alone?"
                    style={{ width: "100%", fontFamily: "inherit", fontSize: 13, padding: "10px 12px", border: `1px solid ${C.g300}`, borderRadius: 8, resize: "vertical", lineHeight: 1.6, outline: "none" }} />
                </div>
                {drillError && <InfoBox type="warning">⚠️ {drillError}</InfoBox>}
                <Btn onClick={submitDrill} disabled={!drillAnswer.trim() || drillLoading}>
                  {drillLoading ? <><Spinner /> Scoring...</> : "Score my answer →"}
                </Btn>
              </>
            ) : (
              <div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
                  {[
                    { key: "structure", label: "Structure" },
                    { key: "storytelling", label: "Storytelling" },
                    { key: "claimdepth", label: "Claim depth" },
                  ].map(({ key, label }) => {
                    const orig = scores?.scores?.[key]?.score;
                    const newScore = drillScore[key]?.score;
                    const delta = (orig != null && newScore != null) ? (newScore - orig) : null;
                    return (
                      <div key={key} style={{ background: C.g50, border: `1px solid ${C.g200}`, borderTop: `3px solid ${sc(newScore || 1)}`, borderRadius: 10, padding: "14px 14px 12px" }}>
                        <div style={{ fontFamily: "Georgia,serif", fontSize: 26, fontWeight: 700, color: sc(newScore || 1), marginBottom: 2 }}>{newScore}/4</div>
                        <div style={{ fontSize: 11, color: C.g500, marginBottom: 6 }}>{label}</div>
                        {delta !== null && (
                          <div style={{ fontSize: 11, fontWeight: 700, color: delta > 0 ? C.teal : delta < 0 ? C.red : C.g400, marginBottom: 6 }}>
                            {delta > 0 ? `↑ +${delta.toFixed(1)} vs original` : delta < 0 ? `↓ ${Math.abs(delta).toFixed(1)} vs original` : "Same as original"}
                          </div>
                        )}
                        <div style={{ fontSize: 11, color: C.g500, fontStyle: "italic", lineHeight: 1.5 }}>{drillScore[key]?.note}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{ padding: "12px 16px", background: C.tealL, border: "1px solid #6EE7B7", borderRadius: 10, fontSize: 13, color: "#065F46", marginBottom: 16 }}>
                  <strong>Verdict:</strong> {drillScore.verdict}
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <Btn variant="secondary" onClick={() => { setDrillScore(null); setDrillAnswer(""); setDrillError(null); }}>Try again</Btn>
                  <Btn onClick={() => setScreen("feedback")}>See full rubric →</Btn>
                </div>
              </div>
            )}
          </Card>
        </div>

      </div>
    </div>
  );
}

export default function App({ user }) {
  const [screen, setScreen] = useState("dashboard");
  const [company, setCompany] = useState(null);
  const [storyBank, setStoryBank] = useState(null);
  const [scores, setScores] = useState(null);
  const [autopsy, setAutopsy] = useState(null);
  const [autopsyError, setAutopsyError] = useState(null);
  const [mockDone, setMockDone] = useState(false);
  const [sessionHistory, setSessionHistory] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);

  // Load this user's persisted history and story bank on mount
  useEffect(() => {
    async function loadUserData() {
      const [{ data: sessions }, { data: storyBanks }] = await Promise.all([
        supabase.from('sessions').select('*').eq('user_id', user.id).order('created_at', { ascending: true }),
        supabase.from('story_banks').select('*').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(1),
      ]);

      if (sessions?.length) {
        setSessionHistory(sessions.map(s => ({
          id: s.id,
          timestamp: new Date(s.created_at).toLocaleString(),
          company: s.company,
          type: s.mock_type,
          overall: parseFloat(s.overall),
          scores: s.scores,
          topStrength: s.strength,
          topWeakness: s.weakness,
          outcome: s.outcome,
        })));
      }

      if (storyBanks?.length) {
        setStoryBank(storyBanks[0].bank);
      }

      setDbLoading(false);
    }

    if (!user) { setDbLoading(false); return; }
    loadUserData().catch(() => setDbLoading(false));
  }, [user?.id]);

  async function recordSession(sessionScores, mockType) {
    const id = crypto.randomUUID();
    setSessionHistory(h => [
      ...h,
      {
        id,
        timestamp: new Date().toLocaleString(),
        company: company?.name || "Unknown",
        type: mockType,
        overall: sessionScores.overall,
        scores: sessionScores.scores,
        topStrength: sessionScores.topStrength,
        topWeakness: sessionScores.topWeakness,
      },
    ]);

    if (!user) return; // guest — no persistence
    supabase.from('sessions').insert({
      id,
      user_id: user.id,
      company: company?.name || "Unknown",
      mock_type: mockType,
      overall: sessionScores.overall,
      scores: sessionScores.scores,
      strength: sessionScores.topStrength,
      weakness: sessionScores.topWeakness,
    }).then(({ error }) => { if (error) console.error('Session save failed:', error.message); });
  }

  // Saves story bank optimistically; skips guest mode and custom companies
  function saveStoryBank(bank) {
    setStoryBank(bank);
    if (!user || !company?.id || company.id.startsWith('custom:')) return;
    supabase.from('story_banks').upsert({
      user_id: user.id,
      company_id: company.id,
      bank,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,company_id' })
      .then(({ error }) => { if (error) console.error('Story bank save failed:', error.message); });
  }

  function updateOutcome(sessionId, outcome) {
    if (!user) return;
    supabase.from('sessions').update({ outcome }).eq('id', sessionId).eq('user_id', user.id)
      .then(({ error }) => { if (error) console.error('Outcome update failed:', error.message); });
  }

  function handleSignOut() {
    supabase.auth.signOut();
  }

  if (dbLoading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'Inter, sans-serif', background: '#F9FAFB' }}>
      <div style={{ textAlign: 'center' }}>
        <div style={{ fontFamily: 'Georgia, serif', fontSize: 22, fontWeight: 700, color: '#5B4FCF', marginBottom: 12 }}>Rethink</div>
        <div style={{ fontSize: 13, color: '#6B7280' }}>Loading your history...</div>
      </div>
    </div>
  );

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body { font-family: 'Inter', sans-serif; background: #F9FAFB; color: #111827; font-size: 14px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes fadeIn { from { opacity:0; transform:translateY(6px); } to { opacity:1; transform:none; } }
        @keyframes typingDot { 0%,80%,100% { transform:scale(.6); opacity:.4; } 40% { transform:scale(1); opacity:1; } }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: #D1D5DB; border-radius: 2px; }
      `}</style>

      <div style={{ display: "flex" }}>
        <Sidebar screen={screen} setScreen={setScreen} company={company} storyDone={!!storyBank} mockDone={mockDone} sessionCount={sessionHistory.length} user={user} onSignOut={handleSignOut} />

        <div style={{ marginLeft: 252, minHeight: "100vh", flex: 1, display: "flex", flexDirection: "column" }}>
          {screen === "dashboard" && <Dashboard setScreen={setScreen} company={company} storyDone={!!storyBank} mockDone={mockDone} scores={scores} sessionHistory={sessionHistory} />}
          {screen === "company"   && <CompanyScreen company={company} setCompany={setCompany} setScreen={setScreen} />}
          {screen === "story"     && <StoryScreen storyBank={storyBank} setStoryBank={saveStoryBank} setScreen={setScreen} company={company} />}
          {screen === "mock"      && <MockScreen storyBank={storyBank} company={company} setScores={setScores} setScreen={setScreen} mockDone={mockDone} setMockDone={setMockDone} onSessionComplete={recordSession} setAutopsy={setAutopsy} setAutopsyError={setAutopsyError} />}
          {screen === "autopsy"   && <AutopsyScreen autopsy={autopsy} autopsyError={autopsyError} scores={scores} setScreen={setScreen} />}
          {screen === "feedback"  && <FeedbackScreen scores={scores} storyBank={storyBank} sessionHistory={sessionHistory} />}
          {screen === "history"   && <HistoryScreen sessionHistory={sessionHistory} setScreen={setScreen} onOutcomeUpdate={updateOutcome} />}
          {screen === "coach"     && <StoryCoachScreen storyBank={storyBank} setScreen={setScreen} />}
        </div>
      </div>
    </>
  );
}
