import { useState, useEffect, useRef, useCallback } from "react";
import { ODOT_LEADS } from "./odotLeads.js";

const PIPELINE_KEY = "instaweb-pipeline-v5";
const SETTINGS_KEY = "instaweb-settings-v3";
const savePipeline = (l) => { try { localStorage.setItem(PIPELINE_KEY, JSON.stringify(l)); } catch {} };
const loadPipeline = () => { try { const r = localStorage.getItem(PIPELINE_KEY); return r ? JSON.parse(r) : []; } catch { return []; } };
const saveSettings = (s) => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} };
const loadSettings = () => { try { const r = localStorage.getItem(SETTINGS_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; } };

// ─── Demo link builder (stateless — encodes lead data into the URL) ──────────
const buildDemoLink = (lead) => {
  const payload = {
    name: lead.name || "Your Business",
    city: lead.city || "Portland, OR",
    phone: lead.phone || "(503) 555-0142",
    niche: lead.niche || "roofing",
  };
  const json = JSON.stringify(payload);
  // base64url encode (browser-safe, no Buffer)
  const b64 = btoa(unescape(encodeURIComponent(json)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${window.location.origin}/api/demo?d=${b64}`;
};

// ─── Claude API via Vercel proxy ──────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const realWebSearch = async (query) => {
  try {
    const res = await fetch("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    if (data.error) return { results: [], knowledgeGraph: null, error: data.error };
    return data;
  } catch (e) {
    return { results: [], knowledgeGraph: null, error: e.message };
  }
};

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Safety net: only trust an email if it literally appears in the raw search text.
// This guards against the model inventing one despite instructions.
const extractRealEmail = (searchText) => {
  const matches = (searchText || "").match(EMAIL_REGEX);
  if (!matches || !matches.length) return null;
  // Filter out common false positives (image filenames, tracking pixels, etc.)
  const filtered = matches.filter(m =>
    !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(m) &&
    !/^(no-?reply|donotreply|example)@/i.test(m)
  );
  return filtered[0] || null;
};

const verifyEmailInSearchResults = (claimedEmail, searchData) => {
  if (!claimedEmail) return null;
  const allText = JSON.stringify(searchData);
  return allText.includes(claimedEmail) ? claimedEmail : null;
};

// Runs up to 3 targeted searches to find a real published contact email
const findContactEmail = async (businessName, city) => {
  const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const clean = (text) => {
    const matches = (text || "").match(EMAIL_RE) || [];
    return matches.filter(m =>
      !/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(m) &&
      !/^(no-?reply|donotreply|example|noreply|privacy|legal|sentry|wix|squarespace|wordpress|godaddy)@/i.test(m) &&
      !/@(sentry\.io|wixpress\.com|squarespace\.com|wordpress\.com|godaddy\.com|amazonaws\.com|example\.com)$/i.test(m)
    );
  };
  const pick = (emails) => {
    // Prefer personal/owner emails over generic info@
    const personal = emails.find(m => !/^(info|contact|admin|hello|mail|office|web|webmaster|billing|support)@/i.test(m));
    return personal || emails[0] || null;
  };
  try {
    // Search 1: direct email lookup
    const s1 = await realWebSearch(`"${businessName}" ${city} email`);
    const e1 = pick(clean(JSON.stringify(s1.results || [])));
    if (e1) return e1;
    // Search 2: contact page
    const s2 = await realWebSearch(`${businessName} ${city} contact email`);
    const e2 = pick(clean(JSON.stringify(s2.results || [])));
    if (e2) return e2;
    // Search 3: knowledge graph
    const kg = s1.knowledgeGraph;
    if (kg) { const e3 = pick(clean(JSON.stringify(kg))); if (e3) return e3; }
    return null;
  } catch { return null; }
};

const callClaude = async (prompt, system, maxTokens = 1000, retries = 3) => {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
    }),
  });
  const data = await res.json();
  if (data.error) {
    // Detect rate limit error and auto-retry with backoff
    const isRateLimit = /rate limit/i.test(data.error);
    if (isRateLimit && retries > 0) {
      // Parse suggested wait time if present, e.g. "try again in 9.045s"
      const waitMatch = data.error.match(/try again in ([\d.]+)s/i);
      const waitMs = waitMatch ? Math.ceil(parseFloat(waitMatch[1]) * 1000) + 500 : 4000;
      await sleep(waitMs);
      return callClaude(prompt, system, maxTokens, retries - 1);
    }
    throw new Error(data.error);
  }
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
};

const callClaudeJSON = async (prompt, system) => {
  const raw = await callClaude(prompt, system, 2000);
  const cleaned = raw.replace(/```json|```/g, "");
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch {
      // Fell through to repair below if parse fails on a malformed-but-present object
    }
  }
  // Try to repair a truncated object: take from the first { to the end,
  // then trim back to the last fully-closed field and close the braces.
  const startIdx = cleaned.indexOf("{");
  if (startIdx !== -1) {
    let candidate = cleaned.slice(startIdx);
    // Trim to the last comma before the cut-off, then close the object
    const lastComma = candidate.lastIndexOf(",");
    if (lastComma > 0) {
      candidate = candidate.slice(0, lastComma) + "}";
      try {
        return JSON.parse(candidate);
      } catch {}
    }
  }
  throw new Error(raw.trim() ? `No JSON in response: ${raw.slice(0, 150)}` : "Empty response from all AI providers — likely all rate-limited or daily caps hit");
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const scoreColor = (s) => s >= 80 ? "#D85A30" : s >= 60 ? "#EF9F27" : s >= 40 ? "#378ADD" : "#6b7280";
const scoreLabel = (s) => s >= 80 ? "🔥 Hot Target" : s >= 60 ? "⚡ Good Target" : s >= 40 ? "🔍 Possible" : "✓ Covered";
const STATUSES = ["New","Demo Built","Outreach Sent","Negotiating","Active","Closed","Lost"];
const statusStyle = {
  "New":           { bg:"rgba(107,114,128,0.15)", txt:"#9ca3af" },
  "Demo Built":    { bg:"rgba(55,138,221,0.15)",  txt:"#60a5fa" },
  "Outreach Sent": { bg:"rgba(239,159,39,0.15)",  txt:"#fbbf24" },
  "Negotiating":   { bg:"rgba(127,119,221,0.15)", txt:"#a78bfa" },
  "Active":        { bg:"rgba(16,185,129,0.18)",  txt:"#10b981" },
  "Closed":        { bg:"rgba(100,100,110,0.18)", txt:"#a0a0b0" },  // grey — one-time sale, no care plan
  "Lost":          { bg:"rgba(216,90,48,0.15)",   txt:"#f87171" },
};
const NICHES = ["Roofing","HVAC","Plumbing","Pest Control","Electrical","Landscaping","Painting","Gutters","Concrete","Windows"];
const CITIES = ["Portland OR","Beaverton OR","Hillsboro OR","Gresham OR","Lake Oswego OR","Tigard OR","Oregon City OR","Milwaukie OR","Tualatin OR","Vancouver WA"];

const SCORE_SYSTEM = `You are a web presence analyst for Instaweb, a digital agency that sells $399 websites to local trade businesses. You will be given a business name, city, industry, and REAL web search results for that business. Analyze the search results to determine their actual online presence — do not guess or invent facts not supported by the search results. RULES: Respond with ONLY a JSON object. No text before or after. No markdown. No explanation. If the search results are empty or don't clearly identify the business, set hasWebsite, hasGMB, email, etc. based on absence of evidence (do not invent a plausible business). Return exactly this structure: {"score":75,"hasWebsite":false,"websiteUrl":null,"websiteAge":null,"mobileScore":35,"googleRating":3.8,"reviewCount":12,"hasGMB":true,"socialPresence":"weak","email":null,"redFlags":["No website found","Google listing has no photos","Last review was 2 years ago"],"pitch":"Your competitors are winning jobs online while you rely on word of mouth.","summary":"This business operates purely on referrals with no web presence. A modern site would immediately differentiate them."} CRITICAL RULE FOR EMAIL: only set "email" to a value if a real, complete email address actually appears in the search results text (e.g. info@business.com). If no email appears anywhere in the provided search results, you MUST set "email": null. Never invent, guess, or pattern-match an email address. Score: start at 0, +40 no website, +20 site pre-2018, +15 no GMB, +15 mobile<50, +10 rating<3, +10 no social. Cap 100.`;

const EMAIL_SYSTEM = `You write cold outreach emails for Instaweb (instaweb.agency). Output ONLY the complete email text — no preamble, no notes. Tone: confident, peer-to-peer, not salesy. CRITICAL: you must include every section below in full — do not cut the email short.

Subject: [compelling subject line mentioning their specific business name]

[1 sentence: we already built a free personalized demo site for them, it is ready to view right now]

[1-2 sentences: name one specific weakness from their red flags, tied to their business type and city]

A custom build like this typically runs $2,500+. Because we are currently expanding our portfolio in the [City] [Niche] market, we are offering a one-time Activation Fee of just $399 — plus a $99/mo Care Plan covering hosting, security monitoring, monthly performance reports, and unlimited updates. Simple Stripe auto-pay, no invoicing hassle.

See your demo: {{DEMO_LINK}}

P.S. Ask about our AI Receptionist add-on ($149/mo) — your site captures the lead while you're on the job, the AI books the appointment automatically.

— The Instaweb Team
hello@instaweb.agency · instaweb.agency`

const BIZ_PREFIXES = ["Pacific","Cascade","Summit","Northwest","Apex","Premier","Elite","Reliable","Pro","Quality","Eagle","Sunrise","Evergreen","Sterling","Iron","Peak","Valley","Heritage","True","Precision","Cornerstone","Benchmark"];
const BIZ_SUFFIXES = {
  "Roofing":["Roofing","Roofing Co","Roof & Gutter","Roofing Solutions","Roof Specialists"],
  "HVAC":["HVAC","Heating & Cooling","Air Systems","Climate Control","Mechanical"],
  "Plumbing":["Plumbing","Plumbing & Drain","Pipe Works","Plumbing Solutions","Drain Services"],
  "Pest Control":["Pest Control","Exterminators","Pest Solutions","Bug Busters"],
  "Electrical":["Electric","Electrical","Electrical Services","Power Solutions"],
  "Landscaping":["Landscaping","Lawn & Garden","Landscape Design","Lawn Care"],
  "Painting":["Painting","Paint Co","Painters","Coatings & Finishes"],
  "Gutters":["Gutters","Gutter Solutions","Seamless Gutters","Rain Systems"],
  "Concrete":["Concrete","Concrete Works","Flatwork","Paving"],
  "Windows":["Windows","Window & Door","Glass Solutions","Window Co"],
};
const genBizName = (niche) => {
  const p = BIZ_PREFIXES[Math.floor(Math.random() * BIZ_PREFIXES.length)];
  const suffixes = BIZ_SUFFIXES[niche] || ["Services","Solutions","Co"];
  return `${p} ${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
};

export default function App() {
  const [tab, setTab] = useState("agent");
  const [pipeline, setPipeline] = useState([]);

  // Real Leads tab state
  const [realLeadsSearch, setRealLeadsSearch] = useState("");
  const [realLeadsFilter, setRealLeadsFilter] = useState("All");
  const [realLeadsSelected, setRealLeadsSelected] = useState(new Set());
  const [processingReal, setProcessingReal] = useState(false);
  const [realLeadsLog, setRealLeadsLog] = useState([]);
  const realLeadsLogEndRef = useRef(null);

  // No-email review tab state
  const [noEmailLeads, setNoEmailLeads] = useState([]);
  const [settings, setSettings] = useState({ niche:"Roofing", city:"Portland OR" });

  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [manualScoring, setManualScoring] = useState(false);
  const [manualResult, setManualResult] = useState(null);
  const [manualEmail, setManualEmail] = useState(null);
  const [manualDemoLink, setManualDemoLink] = useState(null);
  const [generatingEmail, setGeneratingEmail] = useState(false);
  const [recipientEmail, setRecipientEmail] = useState("");
  const [sendingEmail, setSendingEmail] = useState(false);
  const [sendStatus, setSendStatus] = useState(null);
  const [manualWasSent, setManualWasSent] = useState(false);
  const [manualSentTo, setManualSentTo] = useState("");

  const [bulkText, setBulkText] = useState("");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkLog, setBulkLog] = useState([]);
  const [bulkProgress, setBulkProgress] = useState({ done:0, total:0 });
  const bulkRef = useRef(false);
  const bulkLogEndRef = useRef(null);

  const [agentRunning, setAgentRunning] = useState(false);
  const [agentLog, setAgentLog] = useState([]);
  const [agentCount, setAgentCount] = useState(0);
  const [agentTarget, setAgentTarget] = useState(5);
  const agentRef = useRef(false);
  const logEndRef = useRef(null);

  const [pipelineSearch, setPipelineSearch] = useState("");
  const [pipelineFilter, setPipelineFilter] = useState("All");

  useEffect(() => {
    setPipeline(loadPipeline());
    const s = loadSettings();
    if (s.niche) setSettings(s);
  }, []);

  useEffect(() => { logEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [agentLog]);
  useEffect(() => { bulkLogEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [bulkLog]);

  const updatePipeline = useCallback((fn) => {
    setPipeline(prev => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      savePipeline(next);
      return next;
    });
  }, []);

  const addLog = (type, msg) =>
    setAgentLog(prev => [...prev, { type, msg, ts: new Date().toLocaleTimeString() }]);

  const fillEmailLink = (emailText, demoLink) =>
    (emailText || "").replace(/\{\{DEMO_LINK\}\}/g, demoLink);

  const parseEmailParts = (emailText) => {
    const text = (emailText || "").trim();
    const lines = text.split("\n");
    const subjectLineIdx = lines.findIndex(l => l.toLowerCase().startsWith("subject:"));
    if (subjectLineIdx === -1) {
      // No subject line found — use default subject, entire text as body
      return { subject: "We built a free website demo for you", body: text };
    }
    const subject = lines[subjectLineIdx].replace(/subject:\s*/i, "").trim() || "We built a free website demo for you";
    // Body is everything after the subject line, skip leading blank lines
    const bodyLines = lines.slice(subjectLineIdx + 1);
    const body = bodyLines.join("\n").trim();
    if (!body) {
      // Body came back empty — return full text as body to avoid the "Missing required fields" error
      return { subject, body: text };
    }
    return { subject, body };
  };

  const sendRealEmail = async (toEmail, emailText, businessName) => {
    const { subject, body } = parseEmailParts(emailText);

    // Guard: never send if we'd get a 400 back
    if (!toEmail?.trim()) throw new Error("No recipient email address");
    if (!subject?.trim()) throw new Error("Email subject is empty");
    if (!body?.trim()) throw new Error("Email body is empty");

    // Send the initial email immediately
    const res = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: toEmail, subject, text: body }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Send failed");

    // Fire-and-forget the 3-day follow-up via Resend's scheduling
    const followUpSubject = `Following up — ${businessName || "your new website"}`;
    const followUpBody = `Hi,\n\nJust following up on the demo site we built for ${businessName || "your business"} a few days ago.\n\nNo pressure at all — just wanted to check if you had a chance to look at it, or if you have any questions about getting it live.\n\n${body.includes("See your demo") ? body.split("See your demo")[1] ? "See your demo" + body.split("See your demo")[1].split("\n")[0] : "" : ""}\n\n— The Instaweb Team\nhello@instaweb.agency · instaweb.agency`;

    try {
      await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: toEmail, subject: followUpSubject, text: followUpBody, scheduledAt: "in 3 days" }),
      });
    } catch {
      // Follow-up scheduling failure shouldn't block the main send confirmation
    }

    return data;
  };


  // ─── Google Maps scraper (via Serper) ────────────────────────────────────────
  const scrapeGoogleMaps = async (niche, city) => {
    const queries = [
      `${niche} contractors ${city} site:google.com/maps OR site:yelp.com`,
      `${niche} company ${city} "no website" OR "see menu" email phone`,
      `"${niche}" "${city}" contractor email contact`,
    ];
    const results = [];
    for (const q of queries) {
      const data = await realWebSearch(q);
      if (data.results) {
        for (const r of data.results) {
          // Extract phone numbers and emails from snippets
          const phones = (r.snippet || "").match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || [];
          const emails = (r.snippet || "").match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
          if (r.title && (phones.length || emails.length)) {
            results.push({
              name: r.title.replace(/ - Google Maps$| \| Yelp$/i, "").trim(),
              phone: phones[0] || "",
              email: emails[0] || "",
              source: "Google Maps Scrape",
              link: r.link,
            });
          }
        }
      }
    }
    // Deduplicate by name
    const seen = new Set();
    return results.filter(r => { if (seen.has(r.name)) return false; seen.add(r.name); return true; });
  };

  // ─── Process real ODOT leads into pipeline ───────────────────────────────────
  const processRealLeads = async (leads) => {
    setProcessingReal(true);
    setRealLeadsLog([]);
    const addRL = (type, msg) => setRealLeadsLog(prev => [...prev, { type, msg, ts: new Date().toLocaleTimeString() }]);
    addRL("info", `🚀 Processing ${leads.length} real leads...`);
    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i];
      addRL("search", `[${i+1}/${leads.length}] Scoring: "${lead.name}" (${lead.city})...`);
      try {
        const searchData = await realWebSearch(`${lead.name} ${lead.city} website`);
        const searchContext = JSON.stringify(searchData.results || []);
        const scoreData = await callClaudeJSON(
          `Business name: "${lead.name}"\nCity: ${lead.city}\nIndustry: ${lead.niche}\n\nReal web search results:\n${searchContext}\n\nAnalyze and return the JSON object.`,
          SCORE_SYSTEM
        );
        const score = scoreData.score || 0;
        addRL(score >= 50 ? "hit" : "miss", `  ↳ Score: ${score} ${scoreLabel(score)} | Website: ${scoreData.hasWebsite ? "Yes" : "❌ None"}`);

        // Use known email first, fall back to search
        let contactEmail = lead.email || "";
        if (!contactEmail) {
          addRL("info", `  ↳ Searching for contact email...`);
          contactEmail = await findContactEmail(lead.name, lead.city) || "";
          if (contactEmail) addRL("hit", `  ↳ 📧 Found: ${contactEmail}`);
          else addRL("miss", `  ↳ No public email found`);
        } else {
          addRL("hit", `  ↳ 📧 Email from ODOT records: ${contactEmail}`);
        }

        const demoLink = buildDemoLink({ name: lead.name, city: lead.city, phone: lead.phone || "", niche: lead.niche || settings.niche });
        const rawEmail = await callClaude(
          `Business: ${lead.name}\nCity: ${lead.city}\nNiche: ${lead.niche}\nRed flags: ${(scoreData.redFlags||[]).join(", ")}\nPitch: ${scoreData.pitch}`,
          EMAIL_SYSTEM, 800
        );
        const emailText = fillEmailLink(rawEmail, demoLink);

        // Auto-send if email found
        let sentStatus = null;
        if (contactEmail && emailText) {
          addRL("info", `  ↳ 📤 Sending email pitch to ${contactEmail}...`);
          try {
            await sendRealEmail(contactEmail, emailText, lead.name);
            sentStatus = "sent";
            addRL("success", `  ↳ ✅ Email pitch sent · follow-up in 3 days`);
          } catch(e) {
            addRL("warn", `  ↳ ❌ Send failed: ${e.message}`);
          }
        }

        // Move to no-email list if no email found
        if (!contactEmail) {
          setNoEmailLeads(prev => [...prev, { ...lead, score, needsEmailReview: true }]);
          addRL("warn", `  ↳ Moved to "Needs Email Review" tab`);
        } else {
          updatePipeline(prev => [{
            id: Date.now() + Math.random(),
            name: lead.name, city: lead.city, niche: lead.niche || settings.niche,
            phone: lead.phone || "", score,
            hasWebsite: scoreData.hasWebsite, websiteUrl: scoreData.websiteUrl,
            googleRating: scoreData.googleRating, reviewCount: scoreData.reviewCount,
            redFlags: scoreData.redFlags || [], pitch: scoreData.pitch, summary: scoreData.summary,
            email: emailText, demoLink, recipientEmail: contactEmail,
            _sendStatus: sentStatus === "sent" ? `✅ Email pitch sent to ${contactEmail} · follow-up in 3 days` : null,
            status: sentStatus === "sent" ? "Outreach Sent" : "Demo Built",
            source: lead.source || "ODOT", addedAt: new Date().toISOString(),
          }, ...prev]);
        }
        addRL("success", `  ✅ Done (${i+1}/${leads.length})`);
        await new Promise(r => setTimeout(r, 2500));
      } catch(e) {
        addRL("warn", `  ↳ Error: ${e.message}`);
      }
    }
    setProcessingReal(false);
    addRL("success", `🎯 Complete! Check Pipeline and "Needs Email Review" tabs.`);
  };

  // ─── Agent ─────────────────────────────────────────────────────────────────
  const runAgent = async () => {
    if (agentRunning) { agentRef.current = false; setAgentRunning(false); addLog("warn","Stopped."); return; }
    agentRef.current = true;
    setAgentRunning(true);
    setAgentLog([]);
    setAgentCount(0);
    addLog("info", `🤖 Agent started — hunting ${agentTarget} ${settings.niche} leads in ${settings.city}`);

    let found = 0, attempts = 0;
    while (agentRef.current && found < agentTarget && attempts < agentTarget * 5) {
      attempts++;
      const bizName = genBizName(settings.niche);
      addLog("search", `[${attempts}] Analyzing: "${bizName}"...`);
      try {
        const scoreData = await callClaudeJSON(
          `Business name: "${bizName}"\nCity: ${settings.city}\nIndustry: ${settings.niche}\n\nAnalyze their likely web presence and return the JSON object.`,
          SCORE_SYSTEM
        );
        const score = scoreData.score || 0;
        addLog(score >= 60 ? "hit" : "miss",
          `  ↳ Score: ${score} ${scoreLabel(score)} | Website: ${scoreData.hasWebsite ? "Yes" : "❌ None"}`
        );
        if (score < 50) { addLog("miss","  ↳ Below threshold, skipping."); continue; }

        const lead = { name: bizName, city: settings.city, niche: settings.niche, phone: "" };
        const demoLink = buildDemoLink(lead);

        // Search for real contact email before building anything
        addLog("info","  ↳ Searching for contact email...");
        const foundEmail = await findContactEmail(bizName, settings.city);
        if (foundEmail) {
          addLog("hit", `  ↳ 📧 Found: ${foundEmail}`);
        } else {
          addLog("miss","  ↳ No public email found — will need manual entry to send");
        }

        addLog("info","  ↳ Writing personalized outreach email...");
        const rawEmail = await callClaude(
          `Business: ${bizName}\nCity: ${settings.city}\nNiche: ${settings.niche}\nRed flags: ${(scoreData.redFlags||[]).join(", ")}\nPitch: ${scoreData.pitch}`,
          EMAIL_SYSTEM, 800
        );
        const emailText = fillEmailLink(rawEmail, demoLink);

        // Auto-send if we found a real email
        let sentStatus = null;
        if (foundEmail && emailText) {
          addLog("info", `  ↳ 📤 Sending email pitch to ${foundEmail}...`);
          try {
            await sendRealEmail(foundEmail, emailText, bizName);
            sentStatus = "sent";
            addLog("success", `  ↳ ✅ Email pitch sent · follow-up scheduled in 3 days`);
          } catch(sendErr) {
            sentStatus = "failed";
            addLog("warn", `  ↳ ❌ Send failed: ${sendErr.message}`);
          }
        }

        updatePipeline(prev => [{
          id: Date.now() + Math.random(),
          ...lead, score, hasWebsite: scoreData.hasWebsite, websiteUrl: scoreData.websiteUrl,
          googleRating: scoreData.googleRating, reviewCount: scoreData.reviewCount,
          redFlags: scoreData.redFlags || [], pitch: scoreData.pitch, summary: scoreData.summary,
          email: emailText, demoLink,
          recipientEmail: foundEmail || "",
          _sendStatus: sentStatus === "sent" ? "✅ Email pitch sent · follow-up in 3 days" : null,
          status: sentStatus === "sent" ? "Outreach Sent" : "Demo Built",
          source: "Agent", addedAt: new Date().toISOString(),
        }, ...prev]);
        found++;
        setAgentCount(found);
        addLog("success", `  ✅ Pipeline updated (${found}/${agentTarget}) — "${bizName}"${foundEmail ? (sentStatus === "sent" ? " · emailed" : " · 📧 has email, send from pipeline") : ""}`);
        await new Promise(r => setTimeout(r, 2500));
      } catch(e) {
        addLog("warn", `  ↳ Error: ${e.message}`);
      }
    }
    agentRef.current = false;
    setAgentRunning(false);
    addLog(found >= agentTarget ? "success" : "warn",
      found >= agentTarget ? `🎯 Done! ${found} leads with live demos added.` : `Stopped. Found ${found}/${agentTarget}.`
    );
  };

  // ─── Manual ────────────────────────────────────────────────────────────────
  const scoreManual = async () => {
    if (!manualName.trim()) return;
    setManualScoring(true); setManualResult(null); setManualEmail(null); setManualDemoLink(null);
    setManualWasSent(false); setManualSentTo(""); setSendStatus(null); setRecipientEmail("");
    try {
      const searchData = await realWebSearch(`${manualName} ${settings.city} contact email website`);
      const searchContext = JSON.stringify(searchData.results || []);
      const data = await callClaudeJSON(
        `Business name: "${manualName}"\nCity: ${settings.city}\nIndustry: ${settings.niche}\n\nReal web search results for this business:\n${searchContext}\n\nAnalyze these REAL search results and return the JSON object. Remember: only include an email if it literally appears in the search results above.`,
        SCORE_SYSTEM
      );
      // Defense in depth: verify any claimed email actually appears in the raw search data
      const verifiedEmail = verifyEmailInSearchResults(data.email, searchData);
      setManualResult({ ...data, email: verifiedEmail, name: manualName, city: settings.city, niche: settings.niche, phone: manualPhone });
      if (verifiedEmail) setRecipientEmail(verifiedEmail);
    } catch(e) { alert("Scoring failed: " + e.message); }
    setManualScoring(false);
  };

  const generateManualEmail = async () => {
    if (!manualResult) return;
    setGeneratingEmail(true);
    try {
      const lead = { name: manualResult.name, city: manualResult.city, niche: manualResult.niche, phone: manualResult.phone };
      const demoLink = buildDemoLink(lead);
      setManualDemoLink(demoLink);
      const rawEmail = await callClaude(
        `Business: ${manualResult.name}\nCity: ${manualResult.city}\nNiche: ${manualResult.niche}\nRed flags: ${(manualResult.redFlags||[]).join(", ")}\nPitch: ${manualResult.pitch}`,
        EMAIL_SYSTEM, 800
      );
      setManualEmail(fillEmailLink(rawEmail, demoLink));
    } catch(e) { alert("Email generation failed: " + e.message); }
    setGeneratingEmail(false);
  };

  const addManualToPipeline = () => {
    if (!manualResult) return;
    updatePipeline(prev => [{
      id: Date.now(), ...manualResult,
      email: manualEmail || null, demoLink: manualDemoLink || buildDemoLink(manualResult),
      status: manualWasSent ? "Outreach Sent" : (manualDemoLink ? "Demo Built" : "New"),
      recipientEmail: manualSentTo || "",
      source:"Manual",
      addedAt: new Date().toISOString(),
    }, ...prev]);
    setManualResult(null); setManualEmail(null); setManualDemoLink(null);
    setManualName(""); setManualPhone(""); setManualWasSent(false); setManualSentTo("");
    setRecipientEmail(""); setSendStatus(null);
    setTab("pipeline");
  };

  // ─── Bulk Import ───────────────────────────────────────────────────────────
  const runBulkImport = async () => {
    const names = bulkText.split("\n").map(l => l.trim().replace(/^[-•*\d.]+\s*/, "").trim()).filter(l => l.length > 1);
    if (!names.length) return;
    if (bulkRunning) { bulkRef.current = false; setBulkRunning(false); return; }

    bulkRef.current = true;
    setBulkRunning(true);
    setBulkLog([]);
    setBulkProgress({ done:0, total: names.length });
    const addBulkLog = (type, msg) => setBulkLog(prev => [...prev, { type, msg, ts: new Date().toLocaleTimeString() }]);
    addBulkLog("info", `📋 Bulk import started — ${names.length} businesses queued`);

    for (let i = 0; i < names.length; i++) {
      if (!bulkRef.current) { addBulkLog("warn","Stopped."); break; }
      const name = names[i];
      addBulkLog("search", `[${i+1}/${names.length}] Scoring: "${name}"...`);
      try {
        const searchData = await realWebSearch(`${name} ${settings.city} contact email website`);
        const searchContext = JSON.stringify(searchData.results || []);
        const scoreData = await callClaudeJSON(
          `Business name: "${name}"\nCity: ${settings.city}\nIndustry: ${settings.niche}\n\nReal web search results for this business:\n${searchContext}\n\nAnalyze these REAL search results and return the JSON object. Remember: only include an email if it literally appears in the search results above.`,
          SCORE_SYSTEM
        );
        const verifiedEmail = verifyEmailInSearchResults(scoreData.email, searchData);
        scoreData.email = verifiedEmail;
        const score = scoreData.score || 0;
        addBulkLog(score >= 60 ? "hit" : "miss", `  ↳ Score: ${score} ${scoreLabel(score)}${verifiedEmail ? ` | 📧 ${verifiedEmail}` : ""}`);

        const lead = { name, city: settings.city, niche: settings.niche, phone: "", email: verifiedEmail };
        const demoLink = buildDemoLink(lead);
        addBulkLog("info","  ↳ Building demo & writing email...");
        const rawEmail = await callClaude(
          `Business: ${name}\nCity: ${settings.city}\nNiche: ${settings.niche}\nRed flags: ${(scoreData.redFlags||[]).join(", ")}\nPitch: ${scoreData.pitch}`,
          EMAIL_SYSTEM, 800
        );
        const emailText = fillEmailLink(rawEmail, demoLink);

        updatePipeline(prev => [{
          id: Date.now() + Math.random(), ...lead, score, hasWebsite: scoreData.hasWebsite,
          websiteUrl: scoreData.websiteUrl, googleRating: scoreData.googleRating, reviewCount: scoreData.reviewCount,
          redFlags: scoreData.redFlags || [], pitch: scoreData.pitch, summary: scoreData.summary,
          email: emailText, demoLink, status: "Demo Built", source: "Bulk", addedAt: new Date().toISOString(),
        }, ...prev]);
        setBulkProgress({ done: i+1, total: names.length });
        addBulkLog("success", `  ✅ Added with live demo! — "${name}"`);
        await new Promise(r => setTimeout(r, 2500));
      } catch(e) {
        addBulkLog("warn", `  ↳ Error scoring "${name}": ${e.message}`);
        setBulkProgress(p => ({...p, done: i+1}));
      }
    }
    bulkRef.current = false;
    setBulkRunning(false);
    addBulkLog("success", `🎯 Bulk import complete!`);
  };

  // ─── Computed ─────────────────────────────────────────────────────────────
  const filteredPipeline = pipeline.filter(l => {
    const s = pipelineSearch.toLowerCase();
    return (!s || l.name.toLowerCase().includes(s) || l.city.toLowerCase().includes(s))
      && (pipelineFilter === "All" || l.status === pipelineFilter);
  });
  const activeCount = pipeline.filter(l => l.status==="Active").length;
  const closedCount = pipeline.filter(l => l.status==="Closed").length;
  const totalSold = activeCount + closedCount;
  const hotCount = pipeline.filter(l => l.score >= 80).length;
  const demoCount = pipeline.filter(l => l.demoLink).length;
  const projMRR = activeCount * 99 + Math.floor(activeCount * 0.4) * 149;
  const totalOneTimeRevenue = totalSold * 399;

  // ─── Styles ────────────────────────────────────────────────────────────────
  const C = { bg:"#0d0d0f", surf:"#16161a", surf2:"#1c1c22", border:"rgba(255,255,255,0.07)", border2:"rgba(255,255,255,0.12)", text:"#f0ede8", muted:"#6b7280", accent:"#1D9E75", accentDim:"rgba(29,158,117,0.12)" };
  const s = {
    wrap:  { minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'DM Sans',sans-serif" },
    inner: { maxWidth:920, margin:"0 auto", padding:"1.5rem 1.25rem" },
    hdr:   { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"1.75rem", paddingBottom:"1rem", borderBottom:`0.5px solid ${C.border}` },
    wm:    { fontFamily:"'DM Serif Display',serif", fontSize:22, letterSpacing:-0.5 },
    tabs:  { display:"flex", gap:2, background:C.surf, borderRadius:12, padding:3, marginBottom:"1.5rem", border:`0.5px solid ${C.border}`, flexWrap:"wrap" },
    tab:   (a) => ({ flex:"1 0 auto", minWidth:90, padding:"9px 6px", fontSize:12, fontWeight:500, border:"none", borderRadius:10, cursor:"pointer", background:a?C.surf2:"transparent", color:a?C.text:C.muted, transition:"all 0.15s" }),
    card:  { background:C.surf, border:`0.5px solid ${C.border}`, borderRadius:14, padding:"1.25rem", marginBottom:12 },
    card2: { background:C.surf2, border:`0.5px solid ${C.border}`, borderRadius:10, padding:"1rem 1.1rem" },
    lbl:   { fontSize:11, fontWeight:500, textTransform:"uppercase", letterSpacing:"0.07em", color:C.muted, marginBottom:6, display:"block" },
    inp:   { width:"100%", fontSize:14, padding:"9px 12px", border:`0.5px solid ${C.border2}`, borderRadius:8, background:C.surf2, color:C.text, outline:"none" },
    sel:   { width:"100%", fontSize:14, padding:"9px 12px", border:`0.5px solid ${C.border2}`, borderRadius:8, background:C.surf2, color:C.text, outline:"none" },
    btn:   (col=C.accent,dis=false) => ({ display:"inline-flex", alignItems:"center", gap:7, fontSize:13, fontWeight:500, color:"#fff", background:dis?"#374151":col, border:"none", borderRadius:8, padding:"10px 18px", cursor:dis?"not-allowed":"pointer", opacity:dis?0.6:1, whiteSpace:"nowrap" }),
    ghost: { display:"inline-flex", alignItems:"center", gap:6, fontSize:12, fontWeight:500, color:C.muted, background:C.surf2, border:`0.5px solid ${C.border2}`, borderRadius:7, padding:"7px 13px", cursor:"pointer" },
    g2:    { display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 },
    g3:    { display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 },
    mc:    { background:C.surf2, borderRadius:10, padding:"14px 16px", border:`0.5px solid ${C.border}` },
    badge: (st) => ({ fontSize:11, fontWeight:500, padding:"3px 9px", borderRadius:20, background:(statusStyle[st]||statusStyle.New).bg, color:(statusStyle[st]||statusStyle.New).txt, whiteSpace:"nowrap" }),
    log:   (t) => { const c={hit:"#34d399",miss:"#6b7280",success:"#34d399",warn:"#fbbf24",info:"#60a5fa",search:"#a78bfa"}; return { fontSize:12, padding:"2px 0", color:c[t]||C.muted, lineHeight:1.6, fontFamily:"monospace" }; },
  };

  return (
    <div style={s.wrap}>
      <div style={s.inner}>
        <div style={s.hdr}>
          <div>
            <span style={s.wm}>insta<span style={{fontStyle:"italic",color:C.muted}}>web</span></span>
            <span style={{fontSize:12,color:C.muted,marginLeft:10}}>Prospector AI</span>
          </div>
          <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:12,color:C.muted}}>{pipeline.length} leads · {demoCount} demos · ${projMRR.toLocaleString()}/mo</span>
            <span style={{fontSize:11,fontWeight:500,color:agentRunning?"#34d399":C.muted,background:agentRunning?"rgba(52,211,153,0.1)":"rgba(107,114,128,0.1)",padding:"3px 10px",borderRadius:20}}>
              {agentRunning?"🤖 Running":"Ready"}
            </span>
          </div>
        </div>

        <div style={{...s.card,padding:"0.9rem 1.1rem",marginBottom:"1rem"}}>
          <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:12,color:C.muted,whiteSpace:"nowrap"}}>Target:</span>
            <select style={{...s.sel,width:"auto",flex:1,minWidth:120}} value={settings.niche} onChange={e=>{const n={...settings,niche:e.target.value};setSettings(n);saveSettings(n);}}>
              {NICHES.map(n=><option key={n}>{n}</option>)}
            </select>
            <select style={{...s.sel,width:"auto",flex:1,minWidth:140}} value={settings.city} onChange={e=>{const n={...settings,city:e.target.value};setSettings(n);saveSettings(n);}}>
              {CITIES.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div style={s.tabs}>
          {[["agent","🤖 Agent"],["realleads",`📋 Real Leads (${ODOT_LEADS.length})`],["manual","🎯 Manual"],["bulk","📝 Bulk"],["pipeline",`📊 Pipeline (${pipeline.length})`],["noemail",`⚠️ Needs Email (${noEmailLeads.length})`]].map(([id,label])=>(
            <button key={id} style={s.tab(tab===id)} onClick={()=>setTab(id)}>{label}</button>
          ))}
        </div>

        {tab==="agent" && (
          <div>
            <div style={s.card}>
              <div style={{fontSize:16,fontWeight:500,fontFamily:"'DM Serif Display',serif",marginBottom:6}}>Autonomous Prospecting Agent</div>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.7,marginBottom:"1rem"}}>
                Generates business names, scores web presence, builds a real live demo site, writes a personalized email with the demo link, and queues it all in your pipeline.
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:"1rem",flexWrap:"wrap"}}>
                <span style={{fontSize:12,color:C.muted}}>Find:</span>
                {[3,5,10,20].map(n=>(
                  <button key={n} style={{...s.ghost,background:agentTarget===n?C.accentDim:C.surf2,color:agentTarget===n?C.accent:C.muted,border:`0.5px solid ${agentTarget===n?C.accent:C.border2}`}} onClick={()=>setAgentTarget(n)}>{n} leads</button>
                ))}
                <div style={{flex:1}}/>
                <button style={s.btn(agentRunning?"#D85A30":C.accent)} onClick={runAgent}>
                  {agentRunning?`⏹ Stop (${agentCount}/${agentTarget})`:`🤖 Run Agent`}
                </button>
              </div>
              {agentRunning && (
                <div style={{marginBottom:"1rem"}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:C.muted,marginBottom:5}}><span>Progress</span><span>{agentCount}/{agentTarget}</span></div>
                  <div style={{height:4,background:C.surf2,borderRadius:2}}><div style={{height:"100%",background:C.accent,borderRadius:2,width:`${Math.min(100,(agentCount/agentTarget)*100)}%`,transition:"width 0.5s"}}/></div>
                </div>
              )}
              <div style={{background:C.surf2,borderRadius:10,padding:"1rem",minHeight:160,maxHeight:320,overflowY:"auto",border:`0.5px solid ${C.border}`}}>
                {agentLog.length===0
                  ? <div style={{color:C.muted,fontSize:13,textAlign:"center",paddingTop:"2rem"}}>Agent log will appear here...<br/><span style={{fontSize:12}}>Set to find {agentTarget} {settings.niche} leads in {settings.city}</span></div>
                  : agentLog.map((e,i)=><div key={i} style={s.log(e.type)}><span style={{color:"#374151",marginRight:8}}>{e.ts}</span>{e.msg}</div>)
                }
                <div ref={logEndRef}/>
              </div>
            </div>
          </div>
        )}

        {tab==="manual" && (
          <div>
            <div style={s.card}>
              <div style={{fontSize:13,color:C.muted,marginBottom:"1rem",lineHeight:1.6}}>
                Paste a business name. AI scores their web presence, builds a real demo site, and writes a cold email with the live link.
              </div>
              <div style={s.g2}>
                <div><label style={s.lbl}>Business Name</label><input style={s.inp} placeholder="e.g. Ridgeline Roofing Co." value={manualName} onChange={e=>setManualName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&scoreManual()}/></div>
                <div><label style={s.lbl}>Phone (optional)</label><input style={s.inp} placeholder="(503) 555-0100" value={manualPhone} onChange={e=>setManualPhone(e.target.value)}/></div>
              </div>
              <div style={{marginTop:12}}>
                <button style={s.btn(manualScoring?"#374151":C.accent,manualScoring||!manualName.trim())} onClick={scoreManual} disabled={manualScoring||!manualName.trim()}>
                  {manualScoring?"⏳ Scoring...":"⚡ Score This Business"}
                </button>
              </div>
            </div>

            {manualResult && (
              <>
                <div style={s.card}>
                  <div style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                    <div style={{width:68,height:68,borderRadius:12,background:scoreColor(manualResult.score)+"22",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0,border:`0.5px solid ${scoreColor(manualResult.score)}44`}}>
                      <span style={{fontSize:24,fontWeight:300,fontFamily:"'DM Serif Display',serif",color:scoreColor(manualResult.score)}}>{manualResult.score}</span>
                      <span style={{fontSize:9,color:C.muted}}>SCORE</span>
                    </div>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:4}}>
                        <span style={{fontSize:17,fontWeight:500,fontFamily:"'DM Serif Display',serif"}}>{manualResult.name}</span>
                        <span style={{fontSize:11,fontWeight:500,padding:"2px 9px",borderRadius:20,background:scoreColor(manualResult.score)+"22",color:scoreColor(manualResult.score)}}>{scoreLabel(manualResult.score)}</span>
                      </div>
                      <div style={{fontSize:12,color:C.muted,marginBottom:8}}>{manualResult.niche} · {manualResult.city}</div>
                      <div style={{fontSize:13,color:C.muted,lineHeight:1.6}}>{manualResult.summary}</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
                    <button style={s.btn("#378ADD",generatingEmail)} onClick={generateManualEmail} disabled={generatingEmail}>{generatingEmail?"✍️ Building demo & email...":"✍️ Build Demo + Email"}</button>
                    <button style={s.btn(C.accent)} onClick={addManualToPipeline}>➕ Add to Pipeline</button>
                  </div>
                </div>
                {manualDemoLink && (
                  <div style={s.card}>
                    <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.07em",color:C.muted,marginBottom:10}}>Live Demo Link</div>
                    <a href={manualDemoLink} target="_blank" rel="noopener noreferrer" style={{display:"block",background:C.surf2,borderRadius:8,padding:"12px 14px",fontSize:13,color:"#60a5fa",wordBreak:"break-all",textDecoration:"none",border:`0.5px solid ${C.border}`}}>{manualDemoLink}</a>
                    <button style={{...s.ghost,marginTop:8}} onClick={()=>navigator.clipboard?.writeText(manualDemoLink)}>📋 Copy Link</button>
                  </div>
                )}
                {manualEmail && (
                  <div style={s.card}>
                    <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.07em",color:C.muted,marginBottom:10}}>Generated Outreach Email</div>
                    <div style={{background:C.surf2,borderRadius:10,padding:"1rem 1.25rem",fontSize:13,lineHeight:1.8,whiteSpace:"pre-wrap",wordBreak:"break-word",maxHeight:300,overflowY:"auto",border:`0.5px solid ${C.border}`}}>{manualEmail}</div>
                    <button style={{...s.ghost,marginTop:8}} onClick={()=>navigator.clipboard?.writeText(manualEmail)}>📋 Copy Email</button>

                    <div style={{marginTop:16,paddingTop:16,borderTop:`0.5px solid ${C.border}`}}>
                      <label style={s.lbl}>Send Real Email To</label>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                        <input style={{...s.inp,flex:1,minWidth:200}} placeholder="prospect@business.com" value={recipientEmail} onChange={e=>setRecipientEmail(e.target.value)}/>
                        <button
                          style={s.btn(sendingEmail?"#374151":"#378ADD", sendingEmail || !recipientEmail.trim())}
                          disabled={sendingEmail || !recipientEmail.trim()}
                          onClick={async () => {
                            setSendingEmail(true); setSendStatus(null);
                            try {
                              await sendRealEmail(recipientEmail.trim(), manualEmail, manualResult?.name);
                              setSendStatus({ ok: true, msg: `✅ Email pitch sent to ${recipientEmail.trim()} · follow-up scheduled in 3 days` });
                              setManualWasSent(true);
                              setManualSentTo(recipientEmail.trim());
                            } catch(e) {
                              setSendStatus({ ok: false, msg: `❌ ${e.message}` });
                            }
                            setSendingEmail(false);
                          }}
                        >
                          {sendingEmail ? "📤 Sending email pitch..." : "📤 Send Email Pitch"}
                        </button>
                      </div>
                      {sendStatus && (
                        <div style={{marginTop:8,fontSize:12,color:sendStatus.ok?"#34d399":"#f87171"}}>{sendStatus.msg}</div>
                      )}
                      <div style={{fontSize:11,color:C.muted,marginTop:6}}>Sends from hello@instaweb.agency via Resend</div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {tab==="bulk" && (
          <div>
            <div style={s.card}>
              <div style={{fontSize:16,fontWeight:500,fontFamily:"'DM Serif Display',serif",marginBottom:6}}>Bulk Import</div>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.7,marginBottom:"1rem"}}>Paste real business names — one per line — from Google Maps, Oregon CCB, or Angi.</div>
              <textarea style={{...s.inp,height:160,resize:"vertical",lineHeight:1.8}} placeholder={"Ridgeline Roofing Co\nAlpine HVAC Solutions\nFitch Plumbing & Drain"} value={bulkText} onChange={e=>setBulkText(e.target.value)}/>
              <div style={{display:"flex",alignItems:"center",gap:12,marginTop:10}}>
                <span style={{fontSize:12,color:C.muted}}>{bulkText.trim() ? `${bulkText.split("\n").filter(l=>l.trim().length>1).length} queued` : "No names yet"}</span>
                <div style={{flex:1}}/>
                <button style={s.btn(bulkRunning?"#D85A30":C.accent,!bulkText.trim()&&!bulkRunning)} onClick={runBulkImport} disabled={!bulkText.trim()&&!bulkRunning}>
                  {bulkRunning ? `⏹ Stop (${bulkProgress.done}/${bulkProgress.total})` : `⚡ Score All & Import`}
                </button>
              </div>
            </div>
            {(bulkRunning || bulkProgress.total>0) && (
              <div style={s.card}>
                <div style={{height:5,background:C.surf2,borderRadius:3,marginBottom:"1rem"}}><div style={{height:"100%",background:C.accent,borderRadius:3,width:`${bulkProgress.total?Math.min(100,(bulkProgress.done/bulkProgress.total)*100):0}%`,transition:"width 0.4s"}}/></div>
                <div style={{background:C.surf2,borderRadius:10,padding:"0.9rem",maxHeight:280,overflowY:"auto",border:`0.5px solid ${C.border}`}}>
                  {bulkLog.map((e,i)=><div key={i} style={s.log(e.type)}><span style={{color:"#374151",marginRight:8}}>{e.ts}</span>{e.msg}</div>)}
                  <div ref={bulkLogEndRef}/>
                </div>
              </div>
            )}
          </div>
        )}

        {tab==="pipeline" && (
          <div>
            <div style={{...s.g3,marginBottom:12}}>
              {[["Total",pipeline.length,C.text],["🔥 Hot",hotCount,"#D85A30"],["Demos Live",demoCount,"#60a5fa"],["Active (MRR)",activeCount,"#10b981"],["Closed (one-time)",closedCount,"#34d399"],["Proj. MRR",`$${projMRR.toLocaleString()}`,C.accent]].map(([label,val,col])=>(
                <div key={label} style={s.mc}><div style={{fontSize:20,fontWeight:300,fontFamily:"'DM Serif Display',serif",color:col}}>{val}</div><div style={{fontSize:11,color:C.muted,marginTop:5}}>{label}</div></div>
              ))}
            </div>
            <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
              <input style={{...s.inp,flex:1,minWidth:160}} placeholder="Search..." value={pipelineSearch} onChange={e=>setPipelineSearch(e.target.value)}/>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                {["All",...STATUSES].map(st=>(<button key={st} style={{...s.ghost,background:pipelineFilter===st?C.accentDim:C.surf2,color:pipelineFilter===st?C.accent:C.muted,fontSize:11}} onClick={()=>setPipelineFilter(st)}>{st}</button>))}
              </div>
            </div>
            {pipeline.length===0
              ? <div style={{...s.card,textAlign:"center",padding:"3rem",color:C.muted}}><div style={{fontSize:32,marginBottom:12}}>📋</div><div style={{fontSize:15,fontWeight:500,color:C.text}}>Pipeline is empty</div></div>
              : <div style={s.card}>
                  {filteredPipeline.map((lead,i)=>(
                    <div key={lead.id} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"12px 0",borderBottom:i===filteredPipeline.length-1?"none":`0.5px solid ${C.border}`}}>
                      <div style={{width:42,height:42,borderRadius:8,background:scoreColor(lead.score)+"18",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,border:`0.5px solid ${scoreColor(lead.score)}33`}}>
                        <span style={{fontSize:15,fontWeight:500,fontFamily:"'DM Serif Display',serif",color:scoreColor(lead.score)}}>{lead.score}</span>
                      </div>
                      <div style={{flex:1,minWidth:0}}>
                        <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap",marginBottom:3}}>
                          <span style={{fontSize:14,fontWeight:500}}>{lead.name}</span>
                          <span style={s.badge(lead.status)}>{lead.status}</span>
                          {lead.demoLink && <span style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:"rgba(96,165,250,0.12)",color:"#60a5fa"}}>Demo Live</span>}
                        </div>
                        <div style={{fontSize:12,color:C.muted,marginBottom:3}}>{lead.niche} · {lead.city}</div>
                        {lead.demoLink && (
                          <a href={lead.demoLink} target="_blank" rel="noopener noreferrer" style={{fontSize:11,color:"#60a5fa",textDecoration:"none",wordBreak:"break-all"}}>{lead.demoLink}</a>
                        )}
                        {lead.email && (
                          <details style={{marginTop:6}}>
                            <summary style={{fontSize:11,color:"#a78bfa",cursor:"pointer"}}>View outreach email</summary>
                            <div style={{marginTop:6,fontSize:12,background:C.surf2,borderRadius:8,padding:"10px 12px",whiteSpace:"pre-wrap",lineHeight:1.7,color:C.muted,maxHeight:200,overflowY:"auto"}}>{lead.email}</div>
                            <div style={{marginTop:8,display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                              <input
                                style={{...s.inp,flex:1,minWidth:160,fontSize:12,padding:"6px 10px"}}
                                placeholder="prospect@email.com"
                                value={lead.recipientEmail || ""}
                                onChange={e=>updatePipeline(prev=>prev.map(l=>l.id===lead.id?{...l,recipientEmail:e.target.value}:l))}
                              />
                              <button
                                style={{...s.ghost,fontSize:11,color:"#60a5fa",opacity:lead._sending?0.6:1}}
                                disabled={lead._sending || !lead.recipientEmail?.trim()}
                                onClick={async ()=>{
                                  updatePipeline(prev=>prev.map(l=>l.id===lead.id?{...l,_sending:true,_sendStatus:"📤 Sending email pitch..."}:l));
                                  try {
                                    await sendRealEmail(lead.recipientEmail.trim(), lead.email, lead.name);
                                    updatePipeline(prev=>prev.map(l=>l.id===lead.id?{...l,_sending:false,_sendStatus:"✅ Email pitch sent · follow-up in 3 days",status: l.status==="New"||l.status==="Demo Built" ? "Outreach Sent" : l.status}:l));
                                  } catch(e) {
                                    updatePipeline(prev=>prev.map(l=>l.id===lead.id?{...l,_sending:false,_sendStatus:"❌ Send failed: "+e.message}:l));
                                  }
                                }}
                              >
                                {lead._sending ? "📤 Sending..." : "📤 Send"}
                              </button>
                              <button style={{...s.ghost,fontSize:11}} onClick={()=>navigator.clipboard?.writeText(lead.email)}>📋</button>
                              {lead._sendStatus && <span style={{fontSize:11,color:lead._sendStatus.startsWith("✅")?"#34d399":"#f87171"}}>{lead._sendStatus}</span>}
                            </div>
                          </details>
                        )}
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:5,flexShrink:0}}>
                        <select style={{fontSize:11,padding:"5px 8px",border:`0.5px solid ${C.border2}`,borderRadius:6,background:C.surf2,color:C.text}} value={lead.status} onChange={e=>updatePipeline(prev=>prev.map(l=>l.id===lead.id?{...l,status:e.target.value}:l))}>
                          {STATUSES.map(st=><option key={st}>{st}</option>)}
                        </select>
                        <button style={{...s.ghost,fontSize:11,padding:"4px 8px",color:"#f87171"}} onClick={()=>updatePipeline(prev=>prev.filter(l=>l.id!==lead.id))}>Remove</button>
                      </div>
                    </div>
                  ))}
                </div>
            }
          </div>
        )}

        {/* ─── REAL LEADS TAB ─────────────────────────────────────────── */}
        {tab==="realleads" && (
          <div>
            <div style={s.card}>
              <div style={{fontSize:16,fontWeight:500,fontFamily:"'DM Serif Display',serif",marginBottom:6}}>Real Oregon Contractor Leads</div>
              <div style={{fontSize:13,color:C.muted,marginBottom:"1rem",lineHeight:1.6}}>
                {ODOT_LEADS.length} verified contractors from ODOT prequalified list — all with real emails. Select leads to score, build demos, and auto-send outreach.
                Also search Google Maps for additional leads in any niche/city.
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:"1rem"}}>
                <input style={{...s.inp,flex:1,minWidth:160}} placeholder="Search by name, city, niche..." value={realLeadsSearch} onChange={e=>setRealLeadsSearch(e.target.value)}/>
                <select style={{...s.sel,width:"auto"}} value={realLeadsFilter} onChange={e=>setRealLeadsFilter(e.target.value)}>
                  <option value="All">All Niches</option>
                  {[...new Set(ODOT_LEADS.map(l=>l.niche))].sort().map(n=><option key={n}>{n}</option>)}
                </select>
              </div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:"1rem",alignItems:"center"}}>
                <span style={{fontSize:12,color:C.muted}}>{realLeadsSelected.size} selected</span>
                <button style={s.ghost} onClick={()=>{
                  const visible = ODOT_LEADS.filter(l=>{
                    const s2=realLeadsSearch.toLowerCase();
                    return (!s2||l.name.toLowerCase().includes(s2)||l.city.toLowerCase().includes(s2)||l.niche.toLowerCase().includes(s2))&&(realLeadsFilter==="All"||l.niche===realLeadsFilter);
                  });
                  setRealLeadsSelected(new Set(visible.map(l=>l.id)));
                }}>Select All Visible</button>
                <button style={s.ghost} onClick={()=>setRealLeadsSelected(new Set())}>Clear</button>
                <div style={{flex:1}}/>
                <button
                  style={s.btn(processingReal?"#D85A30":C.accent, realLeadsSelected.size===0&&!processingReal)}
                  disabled={realLeadsSelected.size===0&&!processingReal}
                  onClick={()=>{
                    if (processingReal) return;
                    const toProcess = ODOT_LEADS.filter(l=>realLeadsSelected.has(l.id));
                    processRealLeads(toProcess);
                  }}
                >
                  {processingReal ? "⏳ Processing..." : `⚡ Process ${realLeadsSelected.size} Selected`}
                </button>
              </div>
            </div>

            {(processingReal || realLeadsLog.length > 0) && (
              <div style={{...s.card,marginBottom:12}}>
                <div style={{background:C.surf2,borderRadius:10,padding:"0.9rem",maxHeight:220,overflowY:"auto",border:`0.5px solid ${C.border}`}}>
                  {realLeadsLog.map((e,i)=>{
                    const colors={hit:"#34d399",miss:"#6b7280",success:"#34d399",warn:"#fbbf24",info:"#60a5fa",search:"#a78bfa"};
                    return <div key={i} style={{fontSize:12,padding:"2px 0",color:colors[e.type]||C.muted,lineHeight:1.6,fontFamily:"monospace"}}><span style={{color:"#374151",marginRight:8}}>{e.ts}</span>{e.msg}</div>;
                  })}
                  <div ref={realLeadsLogEndRef}/>
                </div>
              </div>
            )}

            <div style={s.card}>
              {ODOT_LEADS.filter(l=>{
                const s2=realLeadsSearch.toLowerCase();
                return (!s2||l.name.toLowerCase().includes(s2)||l.city.toLowerCase().includes(s2)||l.niche.toLowerCase().includes(s2))&&(realLeadsFilter==="All"||l.niche===realLeadsFilter);
              }).map((lead,i,arr)=>(
                <div key={lead.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:i===arr.length-1?"none":`0.5px solid ${C.border}`}}>
                  <input type="checkbox" checked={realLeadsSelected.has(lead.id)} onChange={e=>{
                    const next=new Set(realLeadsSelected);
                    e.target.checked?next.add(lead.id):next.delete(lead.id);
                    setRealLeadsSelected(next);
                  }} style={{flexShrink:0,width:15,height:15,accentColor:C.accent}}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <span style={{fontSize:14,fontWeight:500}}>{lead.name}</span>
                      <span style={{fontSize:11,padding:"2px 7px",borderRadius:20,background:"rgba(96,165,250,0.12)",color:"#60a5fa"}}>{lead.niche}</span>
                      {lead.email && <span style={{fontSize:11,padding:"2px 7px",borderRadius:20,background:"rgba(52,211,153,0.12)",color:"#34d399"}}>📧 Email</span>}
                    </div>
                    <div style={{fontSize:12,color:C.muted,marginTop:2}}>{lead.city} · {lead.phone}</div>
                    {lead.email && <div style={{fontSize:11,color:"#60a5fa",marginTop:2}}>{lead.email}</div>}
                  </div>
                  <span style={{fontSize:11,color:C.muted,flexShrink:0}}>{lead.source}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ─── NO EMAIL REVIEW TAB ────────────────────────────────────── */}
        {tab==="noemail" && (
          <div>
            <div style={s.card}>
              <div style={{fontSize:16,fontWeight:500,fontFamily:"'DM Serif Display',serif",marginBottom:6}}>⚠️ Needs Email Review</div>
              <div style={{fontSize:13,color:C.muted,marginBottom:"1rem",lineHeight:1.6}}>
                These leads have been scored and demoed but no public email was found. Add an email manually (call them, check their website) then send from here.
              </div>
              {noEmailLeads.length === 0
                ? <div style={{textAlign:"center",padding:"2rem",color:C.muted}}>No leads awaiting email review.</div>
                : noEmailLeads.map((lead,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"12px 0",borderBottom:i===noEmailLeads.length-1?"none":`0.5px solid ${C.border}`}}>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:14,fontWeight:500,marginBottom:3}}>{lead.name}</div>
                      <div style={{fontSize:12,color:C.muted,marginBottom:6}}>{lead.niche} · {lead.city} · {lead.phone}</div>
                      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
                        <input
                          style={{...s.inp,flex:1,minWidth:180,fontSize:12,padding:"6px 10px"}}
                          placeholder="Enter email manually..."
                          value={lead._manualEmail||""}
                          onChange={e=>setNoEmailLeads(prev=>prev.map((l,j)=>j===i?{...l,_manualEmail:e.target.value}:l))}
                        />
                        <button
                          style={{...s.ghost,fontSize:11,color:"#34d399"}}
                          disabled={!lead._manualEmail?.trim()}
                          onClick={async()=>{
                            const email = lead._manualEmail.trim();
                            const demoLink = buildDemoLink({name:lead.name,city:lead.city,phone:lead.phone||"",niche:lead.niche||settings.niche});
                            // Move to pipeline with the manually entered email
                            updatePipeline(prev=>[{
                              id:Date.now()+Math.random(),
                              ...lead, email:lead.email||"", demoLink, recipientEmail:email,
                              status:"Demo Built", addedAt:new Date().toISOString(),
                            },...prev]);
                            setNoEmailLeads(prev=>prev.filter((_,j)=>j!==i));
                            setTab("pipeline");
                          }}
                        >
                          ➕ Add to Pipeline
                        </button>
                        <button
                          style={{...s.ghost,fontSize:11,color:"#f87171"}}
                          onClick={()=>setNoEmailLeads(prev=>prev.filter((_,j)=>j!==i))}
                        >
                          Discard
                        </button>
                      </div>
                    </div>
                  </div>
                ))
              }
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
