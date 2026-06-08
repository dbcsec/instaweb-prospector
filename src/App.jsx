import { useState, useEffect, useRef, useCallback } from "react";

const PIPELINE_KEY = "instaweb-pipeline-v4";
const SETTINGS_KEY = "instaweb-settings-v2";
const savePipeline = (l) => { try { localStorage.setItem(PIPELINE_KEY, JSON.stringify(l)); } catch {} };
const loadPipeline = () => { try { const r = localStorage.getItem(PIPELINE_KEY); return r ? JSON.parse(r) : []; } catch { return []; } };
const saveSettings = (s) => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {} };
const loadSettings = () => { try { const r = localStorage.getItem(SETTINGS_KEY); return r ? JSON.parse(r) : {}; } catch { return {}; } };

// ─── Claude API — calls /api/claude proxy (avoids CORS) ─────────────────────
const callClaude = async (prompt, system, maxTokens = 1000) => {
  // Use proxy endpoint in production, direct API in Claude artifact sandbox
  const url = window.location.hostname === "localhost" || window.location.hostname === ""
    ? "https://api.anthropic.com/v1/messages"
    : "/api/claude";

  const headers = { "Content-Type": "application/json" };
  // Only needed when calling Anthropic directly (localhost/artifact)
  if (url.includes("anthropic.com")) {
    headers["anthropic-version"] = "2023-06-01";
  }

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
};

const callClaudeJSON = async (prompt, system) => {
  const raw = await callClaude(prompt, system, 1000);
  const match = raw.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response");
  return JSON.parse(match[0]);
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const scoreColor = (s) => s >= 80 ? "#D85A30" : s >= 60 ? "#EF9F27" : s >= 40 ? "#378ADD" : "#6b7280";
const scoreLabel = (s) => s >= 80 ? "🔥 Hot Target" : s >= 60 ? "⚡ Good Target" : s >= 40 ? "🔍 Possible" : "✓ Covered";
const STATUSES = ["New","Demo Built","Outreach Sent","Negotiating","Closed","Lost"];
const statusStyle = {
  "New":           { bg:"rgba(107,114,128,0.15)", txt:"#9ca3af" },
  "Demo Built":    { bg:"rgba(55,138,221,0.15)",  txt:"#60a5fa" },
  "Outreach Sent": { bg:"rgba(239,159,39,0.15)",  txt:"#fbbf24" },
  "Negotiating":   { bg:"rgba(127,119,221,0.15)", txt:"#a78bfa" },
  "Closed":        { bg:"rgba(29,158,117,0.15)",  txt:"#34d399" },
  "Lost":          { bg:"rgba(216,90,48,0.15)",   txt:"#f87171" },
};
const NICHES = ["Roofing","HVAC","Plumbing","Electrical","Landscaping","Pest Control","Painting","Gutters","Concrete","Windows","Fencing","Flooring","Tree Service","Cleaning","Pressure Washing"];
const CITIES = ["Portland OR","Beaverton OR","Hillsboro OR","Gresham OR","Lake Oswego OR","Tigard OR","Oregon City OR","Milwaukie OR","Tualatin OR","West Linn OR","Wilsonville OR","Sherwood OR","Vancouver WA","Camas WA","Troutdale OR"];

const SCORE_SYSTEM = `You are a web presence analyst for Instaweb, a digital agency that sells $399 websites to local trade businesses.

You will be given a business name, city, and industry. Using your knowledge of local business web presence patterns, estimate their online presence and return a JSON object.

RULES:
- Respond with ONLY a JSON object. No text before or after. No markdown. No explanation.
- If you don't know the specific business, make a realistic estimate based on typical businesses of that type in that city.
- Small local trade companies in the Portland OR metro area typically have weak web presence — use that as your baseline.

Return exactly this structure:
{"score":75,"hasWebsite":false,"websiteUrl":null,"websiteAge":null,"mobileScore":35,"googleRating":3.8,"reviewCount":12,"hasGMB":true,"socialPresence":"weak","redFlags":["No website found","Google listing has no photos","Last review was 2 years ago"],"pitch":"Your competitors are winning jobs online while you rely on word of mouth — we already built your site.","summary":"This roofer operates purely on referrals with no web presence to speak of. A modern site would immediately differentiate them from competitors."}

Score calculation (start at 0, add points):
+40 if no website
+20 if website exists but was built before 2018
+15 if no Google Business Profile
+15 if mobile score under 50
+10 if Google rating under 3.0
+10 if no social media presence
Cap at 100. Minimum 30 if they have a decent modern site.`;

const EMAIL_SYSTEM = `You write cold outreach emails for Instaweb, a digital agency that builds $399 websites for local trade businesses.

Rules:
- Respond with ONLY the email text. Nothing else.
- Tone: confident, peer-to-peer, not salesy or desperate
- Keep it under 150 words total
- Structure: Subject line, then 3 short paragraphs, then CTA, then sign-off

Format:
Subject: [subject line here]

[Para 1: We already built a free demo of their site — one punchy sentence]

[Para 2: One specific thing wrong with their current online presence — reference their red flags]

[Para 3: The offer — $399 one-time setup, $99/mo care plan, spots limited]

See your site: [DEMO_LINK]

— The Instaweb Team`;

const BIZ_PREFIXES = ["Pacific","Cascade","Summit","Northwest","Apex","Premier","Elite","Reliable","Pro","Quality","Eagle","Sunrise","Evergreen","Sterling","Iron","Peak","Valley","Heritage","True","Patriot","Precision","Northwest","Cornerstone","Benchmark","Signature"];
const BIZ_SUFFIXES = {
  "Roofing":["Roofing","Roofing Co","Roof & Gutter","Roofing Solutions","Roof Specialists","Roofing & Construction"],
  "HVAC":["HVAC","Heating & Cooling","Air Systems","Climate Control","Mechanical","Comfort Systems"],
  "Plumbing":["Plumbing","Plumbing & Drain","Pipe Works","Plumbing Solutions","Plumbing Co","Drain Services"],
  "Electrical":["Electric","Electrical","Electrical Services","Electric Co","Power Solutions","Electrical Contractors"],
  "Landscaping":["Landscaping","Lawn & Garden","Landscape Design","Grounds","Outdoor Services","Lawn Care"],
  "Pest Control":["Pest Control","Exterminators","Pest Solutions","Bug Busters","Wildlife Control"],
  "Painting":["Painting","Paint Co","Painters","Painting Solutions","Coatings & Finishes"],
  "Gutters":["Gutters","Gutter Solutions","Gutter & Roof","Seamless Gutters","Rain Systems"],
  "Concrete":["Concrete","Concrete Works","Flatwork","Concrete Solutions","Paving"],
  "Windows":["Windows","Window & Door","Glass Solutions","Windows & Siding","Window Co"],
  "Fencing":["Fencing","Fence Co","Fence & Gate","Fencing Solutions","Fence Works"],
  "Flooring":["Flooring","Floors","Flooring Solutions","Hardwood & Tile","Floor Co"],
  "Tree Service":["Tree Service","Tree Works","Arborists","Tree & Lawn","Tree Removal"],
  "Cleaning":["Cleaning","Janitorial","Clean Pro","Cleaning Services","Commercial Cleaning"],
  "Pressure Washing":["Pressure Washing","Power Wash","Exterior Cleaning","Wash Pro","Soft Wash"],
};
const genBizName = (niche) => {
  const p = BIZ_PREFIXES[Math.floor(Math.random() * BIZ_PREFIXES.length)];
  const suffixes = BIZ_SUFFIXES[niche] || ["Services","Solutions","Co"];
  return `${p} ${suffixes[Math.floor(Math.random() * suffixes.length)]}`;
};

// ─── App ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState("agent");
  const [pipeline, setPipeline] = useState([]);
  const [settings, setSettings] = useState({ niche:"Roofing", city:"Portland OR" });

  const [manualName, setManualName] = useState("");
  const [manualPhone, setManualPhone] = useState("");
  const [manualScoring, setManualScoring] = useState(false);
  const [manualResult, setManualResult] = useState(null);
  const [manualEmail, setManualEmail] = useState(null);
  const [generatingEmail, setGeneratingEmail] = useState(false);

  // Bulk import state
  const [bulkText, setBulkText] = useState("");
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkLog, setBulkLog] = useState([]);
  const [bulkProgress, setBulkProgress] = useState({ done: 0, total: 0 });
  const bulkRef = useRef(false);
  const bulkLogEndRef = useRef(null);

  // CSV import state
  const [csvRows, setCsvRows] = useState([]);
  const [csvHeaders, setCsvHeaders] = useState([]);
  const [csvNameCol, setCsvNameCol] = useState("");
  const [csvPhoneCol, setCsvPhoneCol] = useState("");
  const [csvWebsiteCol, setCsvWebsiteCol] = useState("");
  const [csvFilterNoSite, setCsvFilterNoSite] = useState(true);
  const [csvRunning, setCsvRunning] = useState(false);
  const [csvLog, setCsvLog] = useState([]);
  const [csvProgress, setCsvProgress] = useState({ done:0, total:0 });
  const csvRef = useRef(false);
  const csvLogEndRef = useRef(null);

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
  useEffect(() => { csvLogEndRef.current?.scrollIntoView({ behavior:"smooth" }); }, [csvLog]);

  const updatePipeline = useCallback((fn) => {
    setPipeline(prev => {
      const next = typeof fn === "function" ? fn(prev) : fn;
      savePipeline(next);
      return next;
    });
  }, []);

  const addLog = (type, msg) =>
    setAgentLog(prev => [...prev, { type, msg, ts: new Date().toLocaleTimeString() }]);

  // ─── Agent ─────────────────────────────────────────────────────────────────
  const runAgent = async () => {
    if (agentRunning) {
      agentRef.current = false;
      setAgentRunning(false);
      addLog("warn", "Agent stopped.");
      return;
    }
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
          `  ↳ Score: ${score} ${scoreLabel(score)} | Website: ${scoreData.hasWebsite ? "Yes" : "❌ None"} | GMB: ${scoreData.hasGMB ? "Yes" : "No"}`
        );
        if (score < 50) { addLog("miss","  ↳ Below threshold, skipping."); continue; }

        addLog("info","  ↳ Writing outreach email...");
        const emailText = await callClaude(
          `Business: ${bizName}\nCity: ${settings.city}\nNiche: ${settings.niche}\nRed flags: ${(scoreData.redFlags||[]).join(", ")}\nPitch: ${scoreData.pitch}`,
          EMAIL_SYSTEM, 500
        );
        updatePipeline(prev => [{
          id: Date.now() + Math.random(),
          name: bizName, city: settings.city, niche: settings.niche, phone: "",
          score, hasWebsite: scoreData.hasWebsite, websiteUrl: scoreData.websiteUrl,
          googleRating: scoreData.googleRating, reviewCount: scoreData.reviewCount,
          redFlags: scoreData.redFlags || [], pitch: scoreData.pitch,
          summary: scoreData.summary, email: emailText,
          status: "New", source: "Agent", addedAt: new Date().toISOString(),
        }, ...prev]);
        found++;
        setAgentCount(found);
        addLog("success", `  ✅ Added to pipeline! (${found}/${agentTarget}) — "${bizName}"`);
        await new Promise(r => setTimeout(r, 800));
      } catch(e) {
        addLog("warn", `  ↳ Error: ${e.message}`);
      }
    }
    agentRef.current = false;
    setAgentRunning(false);
    addLog(found >= agentTarget ? "success" : "warn",
      found >= agentTarget ? `🎯 Done! ${found} leads added to pipeline.` : `Stopped. Found ${found}/${agentTarget} leads.`
    );
  };

  // ─── Manual ────────────────────────────────────────────────────────────────
  const scoreManual = async () => {
    if (!manualName.trim()) return;
    setManualScoring(true); setManualResult(null); setManualEmail(null);
    try {
      const data = await callClaudeJSON(
        `Business name: "${manualName}"\nCity: ${settings.city}\nIndustry: ${settings.niche}\n\nAnalyze their likely web presence and return the JSON object.`,
        SCORE_SYSTEM
      );
      setManualResult({ ...data, name: manualName, city: settings.city, niche: settings.niche, phone: manualPhone });
    } catch(e) {
      alert("Scoring failed: " + e.message);
    }
    setManualScoring(false);
  };

  const generateManualEmail = async () => {
    if (!manualResult) return;
    setGeneratingEmail(true);
    try {
      const text = await callClaude(
        `Business: ${manualResult.name}\nCity: ${manualResult.city}\nNiche: ${manualResult.niche}\nRed flags: ${(manualResult.redFlags||[]).join(", ")}\nPitch: ${manualResult.pitch}`,
        EMAIL_SYSTEM, 500
      );
      setManualEmail(text);
    } catch(e) { alert("Email generation failed: " + e.message); }
    setGeneratingEmail(false);
  };

  const addManualToPipeline = () => {
    if (!manualResult) return;
    updatePipeline(prev => [{
      id: Date.now(), ...manualResult,
      email: manualEmail || null, status:"New", source:"Manual",
      addedAt: new Date().toISOString(),
    }, ...prev]);
    setManualResult(null); setManualEmail(null);
    setManualName(""); setManualPhone("");
    setTab("pipeline");
  };

  // ─── Bulk Import ───────────────────────────────────────────────────────────
  const runBulkImport = async () => {
    const names = bulkText
      .split("\n")
      .map(l => l.trim().replace(/^[-•*\d.]+\s*/, "").trim())
      .filter(l => l.length > 1);
    if (!names.length) return;

    if (bulkRunning) {
      bulkRef.current = false;
      setBulkRunning(false);
      return;
    }

    bulkRef.current = true;
    setBulkRunning(true);
    setBulkLog([]);
    setBulkProgress({ done: 0, total: names.length });

    const addBulkLog = (type, msg) =>
      setBulkLog(prev => [...prev, { type, msg, ts: new Date().toLocaleTimeString() }]);

    addBulkLog("info", `📋 Starting bulk import — ${names.length} businesses queued`);

    for (let i = 0; i < names.length; i++) {
      if (!bulkRef.current) { addBulkLog("warn", "Stopped by user."); break; }
      const name = names[i];
      addBulkLog("search", `[${i+1}/${names.length}] Scoring: "${name}"...`);
      try {
        const scoreData = await callClaudeJSON(
          `Business name: "${name}"\nCity: ${settings.city}\nIndustry: ${settings.niche}\n\nAnalyze their likely web presence and return the JSON object.`,
          SCORE_SYSTEM
        );
        const score = scoreData.score || 0;
        addBulkLog(score >= 60 ? "hit" : "miss",
          `  ↳ Score: ${score} ${scoreLabel(score)} | Website: ${scoreData.hasWebsite ? "Yes" : "❌ None"} | GMB: ${scoreData.hasGMB ? "Yes" : "No"}`
        );

        addBulkLog("info", `  ↳ Writing outreach email...`);
        const emailText = await callClaude(
          `Business: ${name}\nCity: ${settings.city}\nNiche: ${settings.niche}\nRed flags: ${(scoreData.redFlags||[]).join(", ")}\nPitch: ${scoreData.pitch}`,
          EMAIL_SYSTEM, 500
        );

        updatePipeline(prev => [{
          id: Date.now() + Math.random(),
          name, city: settings.city, niche: settings.niche, phone: "",
          score, hasWebsite: scoreData.hasWebsite, websiteUrl: scoreData.websiteUrl,
          googleRating: scoreData.googleRating, reviewCount: scoreData.reviewCount,
          redFlags: scoreData.redFlags || [], pitch: scoreData.pitch,
          summary: scoreData.summary, email: emailText,
          status: "New", source: "Bulk", addedAt: new Date().toISOString(),
        }, ...prev]);

        setBulkProgress({ done: i + 1, total: names.length });
        addBulkLog("success", `  ✅ Added to pipeline! — "${name}"`);
        await new Promise(r => setTimeout(r, 700));
      } catch(e) {
        addBulkLog("warn", `  ↳ Error scoring "${name}": ${e.message}`);
      }
    }

    bulkRef.current = false;
    setBulkRunning(false);
    addBulkLog("success", `🎯 Bulk import complete! Check your pipeline.`);
  };

  // ─── CSV Parser ────────────────────────────────────────────────────────────
  const parseCSV = (text) => {
    const lines = text.trim().split("\n").filter(l => l.trim());
    if (!lines.length) return { headers: [], rows: [] };
    // Detect delimiter (comma or tab)
    const delim = lines[0].includes("\t") ? "\t" : ",";
    const parseRow = (line) => {
      const cols = [];
      let cur = "", inQ = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === '"' && !inQ) { inQ = true; continue; }
        if (ch === '"' && inQ && line[i+1] === '"') { cur += '"'; i++; continue; }
        if (ch === '"' && inQ) { inQ = false; continue; }
        if (ch === delim && !inQ) { cols.push(cur.trim()); cur = ""; continue; }
        cur += ch;
      }
      cols.push(cur.trim());
      return cols;
    };
    const headers = parseRow(lines[0]);
    const rows = lines.slice(1).map(l => {
      const vals = parseRow(l);
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ""; });
      return obj;
    }).filter(r => Object.values(r).some(v => v));
    return { headers, rows };
  };

  const handleCsvUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const { headers, rows } = parseCSV(ev.target.result);
      setCsvHeaders(headers);
      setCsvRows(rows);
      setCsvLog([]);
      setCsvProgress({ done:0, total:0 });
      // Auto-detect columns
      const lower = headers.map(h => h.toLowerCase());
      const nameGuess = headers[lower.findIndex(h => h.includes("name") || h.includes("title") || h.includes("business"))] || headers[0] || "";
      const phoneGuess = headers[lower.findIndex(h => h.includes("phone") || h.includes("tel") || h.includes("mobile"))] || "";
      const webGuess = headers[lower.findIndex(h => h.includes("web") || h.includes("site") || h.includes("url") || h.includes("http"))] || "";
      setCsvNameCol(nameGuess);
      setCsvPhoneCol(phoneGuess);
      setCsvWebsiteCol(webGuess);
    };
    reader.readAsText(file);
  };

  const runCsvImport = async () => {
    if (csvRunning) { csvRef.current = false; setCsvRunning(false); return; }
    if (!csvRows.length || !csvNameCol) return;

    let rows = csvRows;
    // Filter to no-website rows if option is on and column is mapped
    if (csvFilterNoSite && csvWebsiteCol) {
      rows = rows.filter(r => !r[csvWebsiteCol] || r[csvWebsiteCol].trim() === "" || r[csvWebsiteCol].toLowerCase() === "n/a");
    }
    if (!rows.length) {
      setCsvLog([{ type:"warn", msg:"No rows match the filter. Try turning off 'No website only' or check your website column mapping.", ts: new Date().toLocaleTimeString() }]);
      return;
    }

    csvRef.current = true;
    setCsvRunning(true);
    setCsvLog([]);
    setCsvProgress({ done:0, total: rows.length });

    const addCsvLog = (type, msg) =>
      setCsvLog(prev => [...prev, { type, msg, ts: new Date().toLocaleTimeString() }]);

    addCsvLog("info", `📂 CSV import started — ${rows.length} businesses queued${csvFilterNoSite && csvWebsiteCol ? " (no-website filter active)" : ""}`);

    for (let i = 0; i < rows.length; i++) {
      if (!csvRef.current) { addCsvLog("warn","Stopped by user."); break; }
      const row = rows[i];
      const name = row[csvNameCol]?.trim();
      const phone = csvPhoneCol ? (row[csvPhoneCol]?.trim() || "") : "";
      if (!name) { setCsvProgress(p=>({...p,done:i+1})); continue; }

      addCsvLog("search", `[${i+1}/${rows.length}] Scoring: "${name}"...`);
      try {
        const scoreData = await callClaudeJSON(
          `Business name: "${name}"\nCity: ${settings.city}\nIndustry: ${settings.niche}\n\nAnalyze their likely web presence and return the JSON object.`,
          SCORE_SYSTEM
        );
        const score = scoreData.score || 0;
        addCsvLog(score >= 60 ? "hit" : "miss",
          `  ↳ Score: ${score} ${scoreLabel(score)} | Website: ${scoreData.hasWebsite ? "Yes" : "❌ None"} | GMB: ${scoreData.hasGMB ? "Yes" : "No"}`
        );
        addCsvLog("info","  ↳ Writing outreach email...");
        const emailText = await callClaude(
          `Business: ${name}\nCity: ${settings.city}\nNiche: ${settings.niche}\nRed flags: ${(scoreData.redFlags||[]).join(", ")}\nPitch: ${scoreData.pitch}`,
          EMAIL_SYSTEM, 500
        );
        updatePipeline(prev => [{
          id: Date.now() + Math.random(),
          name, city: settings.city, niche: settings.niche, phone,
          score, hasWebsite: scoreData.hasWebsite, websiteUrl: scoreData.websiteUrl,
          googleRating: scoreData.googleRating, reviewCount: scoreData.reviewCount,
          redFlags: scoreData.redFlags || [], pitch: scoreData.pitch,
          summary: scoreData.summary, email: emailText,
          status: "New", source: "CSV", addedAt: new Date().toISOString(),
        }, ...prev]);
        setCsvProgress(p=>({...p, done: i+1}));
        addCsvLog("success", `  ✅ Added — "${name}"`);
        await new Promise(r => setTimeout(r, 700));
      } catch(e) {
        addCsvLog("warn", `  ↳ Error: ${e.message}`);
        setCsvProgress(p=>({...p, done: i+1}));
      }
    }
    csvRef.current = false;
    setCsvRunning(false);
    addCsvLog("success","🎯 CSV import complete! Check your pipeline.");
  };

  // ─── Computed ─────────────────────────────────────────────────────────────
  const filteredPipeline = pipeline.filter(l => {
    const s = pipelineSearch.toLowerCase();
    return (!s || l.name.toLowerCase().includes(s) || l.city.toLowerCase().includes(s))
      && (pipelineFilter === "All" || l.status === pipelineFilter);
  });
  const closedCount = pipeline.filter(l => l.status==="Closed").length;
  const hotCount = pipeline.filter(l => l.score >= 80).length;
  const projMRR = closedCount * 99 + Math.floor(closedCount * 0.5) * 149;

  // ─── Styles ────────────────────────────────────────────────────────────────
  const C = { bg:"#0d0d0f", surf:"#16161a", surf2:"#1c1c22", border:"rgba(255,255,255,0.07)", border2:"rgba(255,255,255,0.12)", text:"#f0ede8", muted:"#6b7280", accent:"#1D9E75", accentDim:"rgba(29,158,117,0.12)" };
  const s = {
    wrap:  { minHeight:"100vh", background:C.bg, color:C.text, fontFamily:"'DM Sans',sans-serif" },
    inner: { maxWidth:920, margin:"0 auto", padding:"1.5rem 1.25rem" },
    hdr:   { display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:"1.75rem", paddingBottom:"1rem", borderBottom:`0.5px solid ${C.border}` },
    wm:    { fontFamily:"'DM Serif Display',serif", fontSize:22, letterSpacing:-0.5 },
    tabs:  { display:"flex", gap:2, background:C.surf, borderRadius:12, padding:3, marginBottom:"1.5rem", border:`0.5px solid ${C.border}` },
    tab:   (a) => ({ flex:1, padding:"9px 0", fontSize:13, fontWeight:500, border:"none", borderRadius:10, cursor:"pointer", background:a?C.surf2:"transparent", color:a?C.text:C.muted, transition:"all 0.15s" }),
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
    log:   (t) => {
      const c={hit:"#34d399",miss:"#6b7280",success:"#34d399",warn:"#fbbf24",info:"#60a5fa",search:"#a78bfa"};
      return { fontSize:12, padding:"2px 0", color:c[t]||C.muted, lineHeight:1.6, fontFamily:"monospace" };
    },
  };

  return (
    <div style={s.wrap}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=DM+Sans:opsz,wght@9..40,300;9..40,400;9..40,500&display=swap" rel="stylesheet"/>
      <div style={s.inner}>

        {/* Header */}
        <div style={s.hdr}>
          <div>
            <span style={s.wm}>insta<span style={{fontStyle:"italic",color:C.muted}}>web</span></span>
            <span style={{fontSize:12,color:C.muted,marginLeft:10}}>Prospector AI</span>
          </div>
          <div style={{display:"flex",gap:12,alignItems:"center"}}>
            <span style={{fontSize:12,color:C.muted}}>{pipeline.length} leads · ${projMRR.toLocaleString()}/mo projected</span>
            <span style={{fontSize:11,fontWeight:500,color:agentRunning?"#34d399":C.muted,background:agentRunning?"rgba(52,211,153,0.1)":"rgba(107,114,128,0.1)",padding:"3px 10px",borderRadius:20}}>
              {agentRunning?"🤖 Agent Running":"Ready"}
            </span>
          </div>
        </div>

        {/* Global settings */}
        <div style={{...s.card,padding:"0.9rem 1.1rem",marginBottom:"1rem"}}>
          <div style={{display:"flex",gap:10,alignItems:"center",flexWrap:"wrap"}}>
            <span style={{fontSize:12,color:C.muted,whiteSpace:"nowrap"}}>Target:</span>
            <select style={{...s.sel,width:"auto",flex:1,minWidth:130}} value={settings.niche} onChange={e=>{const n={...settings,niche:e.target.value};setSettings(n);saveSettings(n);}}>
              {NICHES.map(n=><option key={n}>{n}</option>)}
            </select>
            <select style={{...s.sel,width:"auto",flex:1,minWidth:160}} value={settings.city} onChange={e=>{const n={...settings,city:e.target.value};setSettings(n);saveSettings(n);}}>
              {CITIES.map(c=><option key={c}>{c}</option>)}
            </select>
          </div>
        </div>

        {/* Tabs */}
        <div style={s.tabs}>
          {[["agent","🤖 Autonomous Agent"],["manual","🎯 Manual Score"],["bulk","📝 Bulk Import"],["csv","📂 CSV Import"],["pipeline",`📋 Pipeline (${pipeline.length})`]].map(([id,label])=>(
            <button key={id} style={s.tab(tab===id)} onClick={()=>setTab(id)}>{label}</button>
          ))}
        </div>

        {/* ── AGENT TAB ── */}
        {tab==="agent" && (
          <div>
            <div style={s.card}>
              <div style={{fontSize:16,fontWeight:500,fontFamily:"'DM Serif Display',serif",marginBottom:6}}>Autonomous Prospecting Agent</div>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.7,marginBottom:"1rem"}}>
                Runs completely on its own. Generates business names for your target niche, scores each one's web presence using AI, writes a personalized outreach email, and queues them in your pipeline. No typing required.
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:"1rem",flexWrap:"wrap"}}>
                <span style={{fontSize:12,color:C.muted}}>Find:</span>
                {[3,5,10,20].map(n=>(
                  <button key={n} style={{...s.ghost,background:agentTarget===n?C.accentDim:C.surf2,color:agentTarget===n?C.accent:C.muted,border:`0.5px solid ${agentTarget===n?C.accent:C.border2}`}} onClick={()=>setAgentTarget(n)}>{n} leads</button>
                ))}
                <div style={{flex:1}}/>
                <button style={s.btn(agentRunning?"#D85A30":C.accent)} onClick={runAgent}>
                  {agentRunning?`⏹ Stop (${agentCount}/${agentTarget} found)`:`🤖 Run Agent`}
                </button>
              </div>
              {agentRunning && (
                <div style={{marginBottom:"1rem"}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:C.muted,marginBottom:5}}>
                    <span>Progress</span><span>{agentCount}/{agentTarget}</span>
                  </div>
                  <div style={{height:4,background:C.surf2,borderRadius:2}}>
                    <div style={{height:"100%",background:C.accent,borderRadius:2,width:`${Math.min(100,(agentCount/agentTarget)*100)}%`,transition:"width 0.5s"}}/>
                  </div>
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

            <div style={s.card}>
              <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.07em",color:C.muted,marginBottom:12}}>How it works</div>
              <div style={s.g2}>
                {[["1. Generate","Creates realistic local business names for your niche + city"],["2. Score","AI estimates web presence quality — site age, GMB, reviews, mobile"],["3. Filter","Only keeps businesses scoring 50+ (weak enough to need you)"],["4. Email","Writes personalized cold outreach referencing their specific gaps"],["5. Queue","Adds to pipeline — you pick up and close"],["6. Repeat","Runs continuously until it hits your lead target"]].map(([t,d])=>(
                  <div key={t} style={{display:"flex",gap:10,padding:"8px 0",borderBottom:`0.5px solid ${C.border}`}}>
                    <span style={{fontSize:12,fontWeight:500,color:C.accent,minWidth:70}}>{t}</span>
                    <span style={{fontSize:12,color:C.muted,lineHeight:1.5}}>{d}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── MANUAL TAB ── */}
        {tab==="manual" && (
          <div>
            <div style={s.card}>
              <div style={{fontSize:13,color:C.muted,marginBottom:"1rem",lineHeight:1.6}}>
                Paste a business name from Oregon CCB, Google Maps, or Angi. AI scores their web presence and writes a cold email.
              </div>
              <div style={s.g2}>
                <div><label style={s.lbl}>Business Name</label>
                  <input style={s.inp} placeholder="e.g. Ridgeline Roofing Co." value={manualName} onChange={e=>setManualName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&scoreManual()}/>
                </div>
                <div><label style={s.lbl}>Phone (optional)</label>
                  <input style={s.inp} placeholder="(503) 555-0100" value={manualPhone} onChange={e=>setManualPhone(e.target.value)}/>
                </div>
              </div>
              <div style={{marginTop:12,display:"flex",gap:8}}>
                <button style={s.btn(manualScoring?"#374151":C.accent,manualScoring||!manualName.trim())} onClick={scoreManual} disabled={manualScoring||!manualName.trim()}>
                  {manualScoring?"⏳ Scoring...":"⚡ Score This Business"}
                </button>
              </div>
            </div>

            {manualScoring && (
              <div style={{...s.card,textAlign:"center",padding:"2.5rem",color:C.muted,fontSize:13,lineHeight:2.2}}>
                📊 Estimating web presence...<br/>🔍 Checking opportunity score...<br/>✍️ Preparing pitch angle...
              </div>
            )}

            {manualResult && (
              <>
                <div style={s.card}>
                  <div style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                    <div style={{width:68,height:68,borderRadius:12,background:scoreColor(manualResult.score)+"22",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0,border:`0.5px solid ${scoreColor(manualResult.score)}44`}}>
                      <span style={{fontSize:24,fontWeight:300,fontFamily:"'DM Serif Display',serif",color:scoreColor(manualResult.score)}}>{manualResult.score}</span>
                      <span style={{fontSize:9,color:C.muted,letterSpacing:"0.05em"}}>SCORE</span>
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
                  <div style={{...s.g2,marginTop:16}}>
                    <div>
                      <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.06em",color:C.muted,marginBottom:8}}>Web Signals</div>
                      {[["Website",manualResult.hasWebsite?(manualResult.websiteUrl||"Yes"):"❌ None found"],["Site Age",manualResult.websiteAge||"—"],["Mobile Score",manualResult.mobileScore!=null?`${manualResult.mobileScore}/100${manualResult.mobileScore<50?" ⚠️":""}`:"—"],["Google Rating",manualResult.googleRating?`${manualResult.googleRating}⭐ (${manualResult.reviewCount} reviews)`:"No GMB"],["Social",manualResult.socialPresence]].map(([k,v])=>(
                        <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"5px 0",borderBottom:`0.5px solid ${C.border}`,fontSize:12}}>
                          <span style={{color:C.muted}}>{k}</span><span style={{fontWeight:500,maxWidth:200,textAlign:"right",wordBreak:"break-all"}}>{v}</span>
                        </div>
                      ))}
                    </div>
                    <div>
                      <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.06em",color:C.muted,marginBottom:8}}>Red Flags 🚩</div>
                      {(manualResult.redFlags||[]).map((f,i)=>(
                        <div key={i} style={{fontSize:12,padding:"6px 10px",background:"rgba(216,90,48,0.1)",color:"#f87171",borderRadius:6,marginBottom:5,border:"0.5px solid rgba(216,90,48,0.2)"}}>{f}</div>
                      ))}
                      <div style={{marginTop:8,fontSize:12,padding:"8px 10px",background:C.accentDim,color:"#34d399",borderRadius:6,border:"0.5px solid rgba(29,158,117,0.2)",lineHeight:1.5}}>
                        💡 <strong>Pitch:</strong> {manualResult.pitch}
                      </div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
                    <button style={s.btn("#378ADD",generatingEmail)} onClick={generateManualEmail} disabled={generatingEmail}>{generatingEmail?"✍️ Writing...":"✍️ Generate Email"}</button>
                    <button style={s.btn(C.accent)} onClick={addManualToPipeline}>➕ Add to Pipeline</button>
                    <button style={s.ghost} onClick={()=>{setManualResult(null);setManualEmail(null);}}>Clear</button>
                  </div>
                </div>
                {manualEmail && (
                  <div style={s.card}>
                    <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.07em",color:C.muted,marginBottom:10}}>Generated Outreach Email</div>
                    <div style={{background:C.surf2,borderRadius:10,padding:"1rem 1.25rem",fontSize:13,lineHeight:1.8,whiteSpace:"pre-wrap",wordBreak:"break-word",maxHeight:300,overflowY:"auto",border:`0.5px solid ${C.border}`,color:C.text}}>{manualEmail}</div>
                    <div style={{display:"flex",gap:8,marginTop:10}}>
                      <button style={s.btn(C.accent)} onClick={addManualToPipeline}>➕ Add to Pipeline</button>
                      <button style={s.ghost} onClick={()=>navigator.clipboard?.writeText(manualEmail)}>📋 Copy</button>
                    </div>
                  </div>
                )}
              </>
            )}

            <div style={s.card}>
              <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.07em",color:C.muted,marginBottom:12}}>Find businesses to score</div>
              <div style={s.g3}>
                {[{name:"Oregon CCB",url:"https://www.oregon.gov/ccb/Pages/search_contractors.aspx",tip:"Licensed contractors — filter by trade + zip code"},
                  {name:"Google Maps",url:`https://www.google.com/maps/search/${encodeURIComponent(settings.niche+" "+settings.city)}`,tip:"Look for: no website button, ≤2 stars, phone-only profiles"},
                  {name:"Angi",url:`https://www.angi.com/companylist/us/or/portland/roofing-contractors.htm`,tip:"Paying $30–80/lead = no organic presence — perfect pitch"},
                ].map(src=>(
                  <a key={src.name} href={src.url} target="_blank" rel="noopener noreferrer" style={{...s.card2,display:"block",textDecoration:"none",color:C.text}}>
                    <div style={{fontSize:13,fontWeight:500,marginBottom:4,color:"#60a5fa"}}>{src.name} ↗</div>
                    <div style={{fontSize:11,color:C.muted,lineHeight:1.5}}>{src.tip}</div>
                  </a>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── BULK IMPORT TAB ── */}
        {tab==="bulk" && (
          <div>
            <div style={s.card}>
              <div style={{fontSize:16,fontWeight:500,fontFamily:"'DM Serif Display',serif",marginBottom:6}}>Bulk Import from Real Sources</div>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.7,marginBottom:"1rem"}}>
                Paste a list of real business names — one per line — copied from Oregon CCB, Google Maps, or Angi. The AI scores every single one and writes outreach emails automatically.
              </div>

              {/* Source quick links */}
              <div style={{...s.g3, marginBottom:"1rem"}}>
                {[
                  {name:"Oregon CCB",url:"https://www.oregon.gov/ccb/Pages/search_contractors.aspx",tip:"Search your niche → copy business names"},
                  {name:"Google Maps",url:`https://www.google.com/maps/search/${encodeURIComponent(settings.niche+" "+settings.city)}`,tip:"Scroll results → copy names with no website"},
                  {name:"Angi",url:"https://www.angi.com/companylist/us/or/portland/roofing-contractors.htm",tip:"Browse listings → copy names with no website URL"},
                ].map(src=>(
                  <a key={src.name} href={src.url} target="_blank" rel="noopener noreferrer" style={{...s.card2,display:"block",textDecoration:"none",color:C.text}}>
                    <div style={{fontSize:12,fontWeight:500,marginBottom:3,color:"#60a5fa"}}>{src.name} ↗</div>
                    <div style={{fontSize:11,color:C.muted,lineHeight:1.4}}>{src.tip}</div>
                  </a>
                ))}
              </div>

              <label style={s.lbl}>Paste business names — one per line</label>
              <textarea
                style={{...s.inp, height:180, resize:"vertical", lineHeight:1.8, fontFamily:"'DM Sans',sans-serif"}}
                placeholder={"Ridgeline Roofing Co\nAlpine HVAC Solutions\nFitch Plumbing & Drain\nSunrise Pest Control\nEvergreen Gutters"}
                value={bulkText}
                onChange={e=>setBulkText(e.target.value)}
              />
              <div style={{display:"flex",alignItems:"center",gap:12,marginTop:10,flexWrap:"wrap"}}>
                <span style={{fontSize:12,color:C.muted}}>
                  {bulkText.trim() ? `${bulkText.split("\n").filter(l=>l.trim().length>1).length} businesses queued` : "No names pasted yet"}
                </span>
                <div style={{flex:1}}/>
                <button
                  style={s.btn(bulkRunning?"#D85A30":C.accent, !bulkText.trim()&&!bulkRunning)}
                  onClick={runBulkImport}
                  disabled={!bulkText.trim()&&!bulkRunning}
                >
                  {bulkRunning
                    ? `⏹ Stop (${bulkProgress.done}/${bulkProgress.total} done)`
                    : `⚡ Score All & Import`}
                </button>
              </div>
            </div>

            {/* Progress bar */}
            {(bulkRunning || bulkProgress.total > 0) && (
              <div style={{...s.card, padding:"1rem 1.25rem"}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:C.muted,marginBottom:6}}>
                  <span>Progress</span>
                  <span>{bulkProgress.done}/{bulkProgress.total} scored</span>
                </div>
                <div style={{height:5,background:C.surf2,borderRadius:3,marginBottom:"1rem"}}>
                  <div style={{height:"100%",background:C.accent,borderRadius:3,width:`${bulkProgress.total?Math.min(100,(bulkProgress.done/bulkProgress.total)*100):0}%`,transition:"width 0.4s"}}/>
                </div>

                {/* Log */}
                <div style={{background:C.surf2,borderRadius:10,padding:"0.9rem",maxHeight:280,overflowY:"auto",border:`0.5px solid ${C.border}`}}>
                  {bulkLog.map((e,i)=>(
                    <div key={i} style={{fontSize:12,padding:"2px 0",color:{hit:"#34d399",miss:"#6b7280",success:"#34d399",warn:"#fbbf24",info:"#60a5fa",search:"#a78bfa"}[e.type]||C.muted,lineHeight:1.6,fontFamily:"monospace"}}>
                      <span style={{color:"#374151",marginRight:8}}>{e.ts}</span>{e.msg}
                    </div>
                  ))}
                  <div ref={bulkLogEndRef}/>
                </div>
              </div>
            )}

            {/* Instructions */}
            <div style={s.card}>
              <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.07em",color:C.muted,marginBottom:12}}>How to get real names in 5 minutes</div>
              {[
                ["Google Maps","Open the Maps link above → search your niche + city → scroll through results → copy any business names that have no website button or under 3 stars → paste here"],
                ["Oregon CCB","Open CCB link → search your trade type → filter by city/zip → copy the business names column → paste here. These are licensed contractors, many have zero web presence."],
                ["Angi / HomeAdvisor","Browse the listing page → look for profiles with no external website link → copy those business names → paste here. These businesses are paying per lead because they have no site."],
              ].map(([src, tip])=>(
                <div key={src} style={{display:"flex",gap:10,padding:"10px 0",borderBottom:`0.5px solid ${C.border}`}}>
                  <span style={{fontSize:12,fontWeight:500,color:C.accent,minWidth:100,flexShrink:0}}>{src}</span>
                  <span style={{fontSize:12,color:C.muted,lineHeight:1.6}}>{tip}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── CSV IMPORT TAB ── */}
        {tab==="csv" && (
          <div>
            <div style={s.card}>
              <div style={{fontSize:16,fontWeight:500,fontFamily:"'DM Serif Display',serif",marginBottom:6}}>CSV Import</div>
              <div style={{fontSize:13,color:C.muted,lineHeight:1.7,marginBottom:"1rem"}}>
                Export businesses from Outscraper, Google Maps, or any source as CSV. Drop the file here — the tool auto-detects columns, filters out businesses that already have websites, then scores and emails everyone remaining.
              </div>

              {/* File drop zone */}
              <label style={{display:"block",border:`1.5px dashed ${C.border2}`,borderRadius:12,padding:"2rem",textAlign:"center",cursor:"pointer",background:C.surf2,marginBottom:"1rem",transition:"border-color 0.2s"}}>
                <input type="file" accept=".csv,.tsv,.txt" style={{display:"none"}} onChange={handleCsvUpload}/>
                <div style={{fontSize:28,marginBottom:8}}>📂</div>
                <div style={{fontSize:14,fontWeight:500,marginBottom:4}}>Drop CSV file here or click to browse</div>
                <div style={{fontSize:12,color:C.muted}}>Supports CSV, TSV — from Outscraper, Google Maps export, or any spreadsheet</div>
              </label>

              {/* Column mapping — only show once file loaded */}
              {csvHeaders.length > 0 && (
                <>
                  <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.07em",color:C.muted,marginBottom:10}}>
                    Column Mapping — {csvRows.length} rows loaded
                  </div>
                  <div style={{...s.g3, marginBottom:10}}>
                    <div>
                      <label style={s.lbl}>Business Name Column *</label>
                      <select style={s.sel} value={csvNameCol} onChange={e=>setCsvNameCol(e.target.value)}>
                        <option value="">— select —</option>
                        {csvHeaders.map(h=><option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={s.lbl}>Phone Column (optional)</label>
                      <select style={s.sel} value={csvPhoneCol} onChange={e=>setCsvPhoneCol(e.target.value)}>
                        <option value="">— none —</option>
                        {csvHeaders.map(h=><option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                    <div>
                      <label style={s.lbl}>Website Column (for filtering)</label>
                      <select style={s.sel} value={csvWebsiteCol} onChange={e=>setCsvWebsiteCol(e.target.value)}>
                        <option value="">— none —</option>
                        {csvHeaders.map(h=><option key={h} value={h}>{h}</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Filter toggle */}
                  <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:C.surf2,borderRadius:8,marginBottom:14,border:`0.5px solid ${C.border}`}}>
                    <div style={{width:36,height:20,borderRadius:10,background:csvFilterNoSite?C.accent:"#374151",cursor:"pointer",position:"relative",transition:"background 0.2s",flexShrink:0}} onClick={()=>setCsvFilterNoSite(v=>!v)}>
                      <div style={{width:14,height:14,borderRadius:"50%",background:"#fff",position:"absolute",top:3,left:csvFilterNoSite?18:3,transition:"left 0.2s"}}/>
                    </div>
                    <div>
                      <div style={{fontSize:13,fontWeight:500}}>No-website filter {csvFilterNoSite?"ON":"OFF"}</div>
                      <div style={{fontSize:11,color:C.muted}}>
                        {csvFilterNoSite && csvWebsiteCol
                          ? `Will skip rows where "${csvWebsiteCol}" has a value — only imports businesses with no website`
                          : csvFilterNoSite && !csvWebsiteCol
                          ? "Map a website column above to enable filtering"
                          : "All rows will be imported regardless of website status"}
                      </div>
                    </div>
                    {csvFilterNoSite && csvWebsiteCol && (
                      <span style={{marginLeft:"auto",fontSize:12,color:"#34d399",fontWeight:500}}>
                        ~{csvRows.filter(r=>!r[csvWebsiteCol]||r[csvWebsiteCol].trim()===""||r[csvWebsiteCol].toLowerCase()==="n/a").length} will be imported
                      </span>
                    )}
                  </div>

                  {/* Preview table */}
                  <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.07em",color:C.muted,marginBottom:8}}>Preview (first 5 rows)</div>
                  <div style={{overflowX:"auto",marginBottom:14}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                      <thead>
                        <tr>
                          {csvHeaders.slice(0,6).map(h=>(
                            <th key={h} style={{textAlign:"left",padding:"6px 10px",borderBottom:`0.5px solid ${C.border}`,color:C.muted,fontWeight:500,whiteSpace:"nowrap"}}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {csvRows.slice(0,5).map((row,i)=>(
                          <tr key={i} style={{background:i%2===0?C.surf2:"transparent"}}>
                            {csvHeaders.slice(0,6).map(h=>(
                              <td key={h} style={{padding:"6px 10px",borderBottom:`0.5px solid ${C.border}`,color:C.text,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{row[h]||""}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <button
                      style={s.btn(csvRunning?"#D85A30":C.accent, !csvNameCol&&!csvRunning)}
                      onClick={runCsvImport}
                      disabled={!csvNameCol&&!csvRunning}
                    >
                      {csvRunning
                        ? `⏹ Stop (${csvProgress.done}/${csvProgress.total})`
                        : `⚡ Score & Import All`}
                    </button>
                    <button style={s.ghost} onClick={()=>{setCsvRows([]);setCsvHeaders([]);setCsvLog([]);setCsvProgress({done:0,total:0});}}>Clear file</button>
                  </div>
                </>
              )}
            </div>

            {/* Progress + log */}
            {(csvRunning || csvProgress.total > 0) && (
              <div style={s.card}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:12,color:C.muted,marginBottom:6}}>
                  <span>Progress</span><span>{csvProgress.done}/{csvProgress.total} processed</span>
                </div>
                <div style={{height:5,background:C.surf2,borderRadius:3,marginBottom:"1rem"}}>
                  <div style={{height:"100%",background:C.accent,borderRadius:3,width:`${csvProgress.total?Math.min(100,(csvProgress.done/csvProgress.total)*100):0}%`,transition:"width 0.4s"}}/>
                </div>
                <div style={{background:C.surf2,borderRadius:10,padding:"0.9rem",maxHeight:280,overflowY:"auto",border:`0.5px solid ${C.border}`}}>
                  {csvLog.map((e,i)=>(
                    <div key={i} style={{fontSize:12,padding:"2px 0",color:{hit:"#34d399",miss:"#6b7280",success:"#34d399",warn:"#fbbf24",info:"#60a5fa",search:"#a78bfa"}[e.type]||C.muted,lineHeight:1.6,fontFamily:"monospace"}}>
                      <span style={{color:"#374151",marginRight:8}}>{e.ts}</span>{e.msg}
                    </div>
                  ))}
                  <div ref={csvLogEndRef}/>
                </div>
              </div>
            )}

            {/* How to get a CSV from Outscraper free */}
            <div style={s.card}>
              <div style={{fontSize:11,fontWeight:500,textTransform:"uppercase",letterSpacing:"0.07em",color:C.muted,marginBottom:12}}>How to get a free CSV from Outscraper</div>
              {[
                ["1. Sign up","Go to outscraper.com — free account, no credit card needed"],
                ["2. Search","Google Maps Scraper → type 'roofing contractors Portland OR' → run"],
                ["3. Export","Download results as CSV (free for first 500 businesses/month)"],
                ["4. Import here","Drop the CSV in this tab — the no-website filter removes businesses that already have sites"],
                ["5. Run","Hit Score & Import — AI processes every remaining business automatically"],
              ].map(([step,tip])=>(
                <div key={step} style={{display:"flex",gap:12,padding:"8px 0",borderBottom:`0.5px solid ${C.border}`}}>
                  <span style={{fontSize:12,fontWeight:500,color:C.accent,minWidth:50,flexShrink:0}}>{step}</span>
                  <span style={{fontSize:12,color:C.muted,lineHeight:1.6}}>{tip}</span>
                </div>
              ))}
              <a href="https://outscraper.com" target="_blank" rel="noopener noreferrer" style={{display:"inline-flex",alignItems:"center",gap:6,marginTop:12,fontSize:12,fontWeight:500,color:"#60a5fa",textDecoration:"none"}}>
                Open Outscraper ↗
              </a>
            </div>
          </div>
        )}

        {/* ── PIPELINE TAB ── */}
        {tab==="pipeline" && (
          <div>
            <div style={{...s.g3,marginBottom:12}}>
              {[["Total Leads",pipeline.length,C.text],["🔥 Hot (80+)",hotCount,"#D85A30"],["Closed",closedCount,"#34d399"],["Proj. MRR",`$${projMRR.toLocaleString()}`,C.accent],["Avg Score",pipeline.length?Math.round(pipeline.reduce((a,l)=>a+l.score,0)/pipeline.length):0,C.text],["No Website",pipeline.filter(l=>!l.hasWebsite).length,"#fbbf24"]].map(([label,val,col])=>(
                <div key={label} style={s.mc}>
                  <div style={{fontSize:20,fontWeight:300,fontFamily:"'DM Serif Display',serif",color:col,lineHeight:1}}>{val}</div>
                  <div style={{fontSize:11,color:C.muted,marginTop:5}}>{label}</div>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
              <input style={{...s.inp,flex:1,minWidth:180}} placeholder="Search pipeline..." value={pipelineSearch} onChange={e=>setPipelineSearch(e.target.value)}/>
              <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                {["All",...STATUSES].map(st=>(
                  <button key={st} style={{...s.ghost,background:pipelineFilter===st?C.accentDim:C.surf2,color:pipelineFilter===st?C.accent:C.muted,border:`0.5px solid ${pipelineFilter===st?C.accent:C.border2}`,fontSize:11}} onClick={()=>setPipelineFilter(st)}>{st}</button>
                ))}
              </div>
            </div>
            {pipeline.length===0
              ? <div style={{...s.card,textAlign:"center",padding:"3rem",color:C.muted}}><div style={{fontSize:32,marginBottom:12}}>📋</div><div style={{fontSize:15,fontWeight:500,marginBottom:6,color:C.text}}>Pipeline is empty</div><div style={{fontSize:13}}>Run the agent or score a business manually</div></div>
              : <div style={s.card}>
                  {filteredPipeline.length===0
                    ? <div style={{textAlign:"center",padding:"2rem",color:C.muted,fontSize:13}}>No leads match your filter</div>
                    : filteredPipeline.map((lead,i)=>(
                        <div key={lead.id} style={{display:"flex",alignItems:"flex-start",gap:12,padding:"12px 0",borderBottom:i===filteredPipeline.length-1?"none":`0.5px solid ${C.border}`}}>
                          <div style={{width:42,height:42,borderRadius:8,background:scoreColor(lead.score)+"18",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",flexShrink:0,border:`0.5px solid ${scoreColor(lead.score)}33`}}>
                            <span style={{fontSize:15,fontWeight:500,fontFamily:"'DM Serif Display',serif",color:scoreColor(lead.score)}}>{lead.score}</span>
                          </div>
                          <div style={{flex:1,minWidth:0}}>
                            <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap",marginBottom:3}}>
                              <span style={{fontSize:14,fontWeight:500}}>{lead.name}</span>
                              <span style={s.badge(lead.status)}>{lead.status}</span>
                              {!lead.hasWebsite&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:"rgba(216,90,48,0.12)",color:"#f87171"}}>No website</span>}
                              <span style={{fontSize:10,padding:"2px 7px",borderRadius:20,background:C.surf2,color:C.muted}}>{lead.source||"Manual"}</span>
                            </div>
                            <div style={{fontSize:12,color:C.muted,marginBottom:3}}>{lead.niche} · {lead.city}{lead.phone?` · ${lead.phone}`:""}</div>
                            {lead.redFlags?.length>0&&<div style={{fontSize:11,color:C.muted}}>{lead.redFlags.slice(0,2).join(" · ")}</div>}
                            {lead.email&&(
                              <details style={{marginTop:6}}>
                                <summary style={{fontSize:11,color:"#60a5fa",cursor:"pointer"}}>View outreach email</summary>
                                <div style={{marginTop:6,fontSize:12,background:C.surf2,borderRadius:8,padding:"10px 12px",whiteSpace:"pre-wrap",lineHeight:1.7,color:C.muted,maxHeight:200,overflowY:"auto",border:`0.5px solid ${C.border}`}}>{lead.email}</div>
                                <button style={{...s.ghost,marginTop:5,fontSize:11}} onClick={()=>navigator.clipboard?.writeText(lead.email)}>📋 Copy</button>
                              </details>
                            )}
                          </div>
                          <div style={{display:"flex",flexDirection:"column",gap:5,flexShrink:0}}>
                            <select style={{fontSize:11,padding:"5px 8px",border:`0.5px solid ${C.border2}`,borderRadius:6,background:C.surf2,color:C.text,cursor:"pointer"}} value={lead.status} onChange={e=>updatePipeline(prev=>prev.map(l=>l.id===lead.id?{...l,status:e.target.value}:l))}>
                              {STATUSES.map(st=><option key={st}>{st}</option>)}
                            </select>
                            <button style={{...s.ghost,fontSize:11,padding:"4px 8px",justifyContent:"center",color:"#f87171"}} onClick={()=>updatePipeline(prev=>prev.filter(l=>l.id!==lead.id))}>Remove</button>
                          </div>
                        </div>
                      ))
                  }
                </div>
            }
            {pipeline.length>0&&(
              <div style={{display:"flex",gap:8,marginTop:8}}>
                <button style={s.ghost} onClick={()=>{
                  const csv=["Name,City,Niche,Score,Status,Has Website,Red Flags",...pipeline.map(l=>`"${l.name}","${l.city}","${l.niche}",${l.score},"${l.status}",${l.hasWebsite},"${(l.redFlags||[]).join("; ")}"`)].join("\n");
                  navigator.clipboard?.writeText(csv);
                }}>📋 Copy CSV</button>
                <button style={{...s.ghost,color:"#f87171"}} onClick={()=>{if(window.confirm("Clear entire pipeline?"))updatePipeline([]);}}>🗑 Clear All</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
