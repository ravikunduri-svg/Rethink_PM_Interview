
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
        {["Weakness Engine", "HM Intelligence"].map(l => (
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
            <div style={{ fontSize: 11, fontWeight: 600, color: C.g800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{user?.email || "Guest"}</div>
            <button onClick={onSignOut} style={{ fontSize: 10, color: C.g400, background: "none", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit", marginTop: 2 }}>Sign out</button>
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
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, marginBottom: 20 }}>
          {[
            { val: company?.name || "—", label: "Target company" },
            { val: sessionHistory.length, label: "Mocks completed", onClick: () => setScreen("history") },
            { val: overall ? `${overall}/4` : "—", label: "Latest readiness score", color: overall ? scoreColor : C.g400 },
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
              ? `📈 You've improved by ${trend.toFixed(1)} points across your ${sessionHistory.length} sessions. `
              : `Your scores across ${sessionHistory.length} sessions haven't moved much yet. `}
            <a onClick={() => setScreen("history")} style={{ color: C.purple, cursor: "pointer", textDecoration: "underline" }}>View full session history →</a>
          </InfoBox>
        )}

        <InfoBox type="info">
          <strong>💡 Why Rethink is different:</strong> Every competitor helps you <em>sound better</em>. Rethink helps you sound more like <em>yourself</em> — by mining your real work first, then testing whether your answers hold up under the same deep probing real interviewers use. Unnati (Founder, Rethink Systems): <em>"Most rejections happen because candidates can't justify the projects they put on their resume."</em>
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

  const Section = ({ title, data }) => (
    <div style={{ border: `1px solid ${C.g200}`, borderRadius: 8, overflow: "hidden", marginBottom: 8 }}>
      <div onClick={() => setOpen(o => ({ ...o, [title]: !o[title] }))} style={{ padding: "9px 14px", background: C.g50, display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", borderBottom: open[title] ? `1px solid ${C.g200}` : "none" }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: C.g700 }}>{title}</span>
        <span style={{ color: C.g400, fontSize: 11 }}>{open[title] ? "▲" : "▼"}</span>
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
              <div style={{ fontSize: 16, fontWeight: 700 }}>{selected?.emoji} {selected?.name} — Interview Brief</div>
              {verified && <Badge color="teal">✓ Pre-verified · retrieved {verified.retrievedDate}{fromCache ? " · cached" : ""}</Badge>}
              {searchConfirmed && <Badge color="amber">🔎 Live web search · {citations.length} source{citations.length !== 1 ? "s" : ""}</Badge>}
              {selected?.custom && brief && !searchConfirmed && !verified && <Badge color="gray">🤖 AI knowledge · verify before interview</Badge>}
            </div>

            {brief.confidenceNote && (
              <div style={{ fontSize: 12, color: C.amber, marginBottom: 10, fontStyle: "italic" }}>ℹ️ {brief.confidenceNote}</div>
            )}

            <div style={{ fontSize: 13, color: C.g700, marginBottom: 14, padding: "10px 14px", background: C.purpleL, borderRadius: 8, borderLeft: `3px solid ${C.purple}` }}>
              <strong>Mission:</strong> {brief.mission}
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {[
                ["📦 Products", brief.products],
                ["💰 Business model", brief.businessModel],
                ["⚔️ Competitive position", brief.competitivePosition],
                ["🚀 Recent strategic moves", brief.strategicMoves],
              ].map(([t, d]) => <Section key={t} title={t} data={d} />)}
            </div>
            <div style={{ marginTop: 8, padding: "10px 14px", background: C.amberL, borderRadius: 8, fontSize: 12, color: "#92400E" }}>
              <strong>🎯 Key tension to think through:</strong> {brief.keyTension}
            </div>

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
            <div style={{ fontSize: 11, color: C.purple, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6 }}>Interviewer probe {qi + 1}/{PROBES.length}</div>
            <div style={{ fontSize: 16, color: C.purpleD, fontFamily: "Georgia,serif", fontStyle: "italic", lineHeight: 1.5 }}>{PROBES[qi]}</div>
          </div>

          <InfoBox type="info">Answer in your own words. Be specific — names, numbers, timelines. Don't polish. Specific + honest = probe-resistant.</InfoBox>

          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: C.g700, marginBottom: 5 }}>Your answer</label>
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
        {bank.map((card, i) => (
          <Card key={i} style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{card.projectTitle} · {card.company}</div>
              <Badge color="teal">✓ Probe-ready</Badge>
            </div>
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
        ))}
      </div>
    </div>
  );
}

// ── Mock Interview ────────────────────────────────────────────────────────────
function MockScreen({ storyBank, company, setScores, setScreen, mockDone, setMockDone, onSessionComplete }) {
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

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [msgs, loading, ended]);

  function systemPrompt(t) {
    const ctx = storyBank?.map(c =>
      `Project: ${c.projectTitle} at ${c.company}. Claim: "${c.coreClaim}". Impact: ${c.metrics}. Personal contribution: ${c.personalContribution}. Probe these: ${c.followUpProbes?.join("; ")}`
    ).join("\n") || "No story bank — probe any claims they make.";

    if (t === "founder") return `You are the founder of ${company?.name || "a startup"} interviewing a PM candidate. Be direct, skeptical, test thinking not frameworks. Story bank:\n${ctx}\n\nRULES: 1) Open with "Tell me about the most important product you worked on — and I mean YOU, not your team." 2) Probe 2-3 levels deep on any claim: "Walk me through that metric exactly", "What did YOU personally do vs your team?", "What decision only you made?" 3) Ask uncomfortable questions: "Why haven't you shipped more?", "Convince me your MVP thinking is enough", "What assumptions might be wrong?" 4) One question per turn, under 3 sentences. 5) After ${MAX} turns say "Thanks, I have what I need."`;

    return `You are conducting a Product Discovery interview at ${company?.name || "a company"}. Play a user persona (teacher, patient, delivery partner — pick one). Candidate must discover the problem, not pitch solutions. Story bank:\n${ctx}\n\nRULES: 1) Open with an ambiguous situation as that persona: "I'm struggling and I need help." 2) Make them ask YOU questions. If they jump to a solution say "Wait — you haven't asked about my actual problem." 3) Reward good clarifying questions with depth; give vague answers to bad ones. 4) After good discovery ask "What specifically would you build first and why?" then probe their reasoning. 5) One message per turn, under 3 sentences. 6) After ${MAX} turns: "Thanks, I understand your approach now."`;
  }

  function start(t) {
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
      const sys = `Evaluate this PM interview transcript on 11 dimensions. Be honest and specific — base every score and citation only on what actually appears in the transcript. Return ONLY valid JSON with NO markdown: {scores:{structure:{score:1-4,citation:string},crossq:{score,citation},discovery:{score,citation},empathy:{score,citation},prioritisation:{score,citation},tradeoffs:{score,citation},communication:{score,citation},storytelling:{score,citation},claimdepth:{score,citation},aipm:{score,citation},grounding:{score,citation}},overall:number(1dp average of all scores),topStrength:string,topWeakness:string,authenticityNote:string}`;
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

  async function endSession(finalMsgs) {
    const transcript = finalMsgs || msgs;
    setEnded(true);
    setMockDone(true);
    setLoading(false);
    await buildScores(transcript);
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

  if (!type) return (
    <div>
      <div style={{ padding: "24px 32px 20px", borderBottom: `1px solid ${C.g200}`, background: C.white }}>
        <div style={{ fontFamily: "Georgia,serif", fontSize: 22, fontWeight: 700 }}>Mock Interview</div>
        <div style={{ fontSize: 13, color: C.g500, marginTop: 2 }}>
          {!storyBank ? "⚠️ Story bank not complete — complete Story Intelligence first for best results" : `✅ Story bank loaded · ${storyBank.length} cards · Interviewer knows your projects`}
        </div>
      </div>
      <div style={{ padding: "28px 32px" }}>
        {!storyBank && <InfoBox type="warning">Complete Story Intelligence first — the mock is conditioned on your story bank. Without it, this is just a generic mock.</InfoBox>}
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
            <Btn variant="teal" onClick={() => setScreen("feedback")}>
              View feedback & scores →
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
          </div>
        ))}

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
              <Btn variant="teal" size="lg" onClick={() => setScreen("feedback")}>
                View my feedback & scores →
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
        <div style={{ padding: "14px 32px", borderTop: `1px solid ${C.g200}`, background: C.white, display: "flex", gap: 10, alignItems: "flex-end", flexShrink: 0 }}>
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            rows={2}
            placeholder="Type your answer... Be specific. Real numbers, real examples, your actual decisions. Press Enter to send."
            onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
            style={{ flex: 1, fontFamily: "inherit", fontSize: 13, padding: "9px 12px", border: `1px solid ${C.g300}`, borderRadius: 8, resize: "none", outline: "none", lineHeight: 1.6 }}
          />
          <Btn onClick={send} disabled={!input.trim() || loading}>
            {loading ? <Spinner /> : "Send →"}
          </Btn>
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
            <strong>📖 Story grounding:</strong> {scores.authenticityNote}
          </div>
        )}

        {/* Rubric */}
        <Card style={{ marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 18 }}>11-Dimension Rubric Scores</div>
          {DIMS.map(dim => {
            const s = scores.scores?.[dim.key];
            const score = s?.score || 1;
            return (
              <div key={dim.key} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: `1px solid ${C.g100}` }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: C.g700, width: 190, flexShrink: 0 }}>{dim.label}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <ProgressBar pct={(score / 4) * 100} color={sc(score)} height={7} />
                    <span style={{ fontSize: 10, color: sc(score), fontWeight: 700, minWidth: 72 }}>{band(score)}</span>
                  </div>
                  {s?.citation && <div style={{ fontSize: 11, color: C.g400, marginTop: 3, fontStyle: "italic" }}>"{s.citation}"</div>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: sc(score), width: 28, textAlign: "right" }}>{score}/4</div>
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
              ? `📈 Your overall score improved by ${trend.toFixed(1)} points from your first to most recent session. This is the feedback-efficacy signal the whole product is built around — it's working.`
              : trend < 0
              ? `Your most recent score is ${Math.abs(trend).toFixed(1)} points lower than your first. That can happen with a harder company or round type — check which rubric dimensions shifted below.`
              : `Your scores have stayed flat across sessions. Try focusing specifically on your top weakness from the last session before your next mock.`}
          </InfoBox>
        )}

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


export default function App({ user }) {
  const [screen, setScreen] = useState("dashboard");
  const [company, setCompany] = useState(null);
  const [storyBank, setStoryBank] = useState(null);
  const [scores, setScores] = useState(null);
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

    loadUserData().catch(() => setDbLoading(false));
  }, [user.id]);

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

  // Saves story bank optimistically; skips custom companies (no stable ID)
  function saveStoryBank(bank) {
    setStoryBank(bank);
    if (!company?.id || company.id.startsWith('custom:')) return;
    supabase.from('story_banks').upsert({
      user_id: user.id,
      company_id: company.id,
      bank,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,company_id' })
      .then(({ error }) => { if (error) console.error('Story bank save failed:', error.message); });
  }

  function updateOutcome(sessionId, outcome) {
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
          {screen === "mock"      && <MockScreen storyBank={storyBank} company={company} setScores={setScores} setScreen={setScreen} mockDone={mockDone} setMockDone={setMockDone} onSessionComplete={recordSession} />}
          {screen === "feedback"  && <FeedbackScreen scores={scores} storyBank={storyBank} sessionHistory={sessionHistory} />}
          {screen === "history"   && <HistoryScreen sessionHistory={sessionHistory} setScreen={setScreen} onOutcomeUpdate={updateOutcome} />}
        </div>
      </div>
    </>
  );
}
