import { useState, useEffect, useRef, useCallback } from "react";

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
  const raw = await callClaude(prompt, system, 1000);
  const match = raw.replace(/```json|```/g, "").match(/\{[\s\S]*\}/);
  if (!match) throw new Error("No JSON in response: " + raw.slice(0, 100));
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
const NICHES = ["Roofing","HVAC","Plumbing","Pest Control","Electrical","Landscaping","Painting","Gutters","Concrete","Windows"];
const CITIES = ["Portland OR","Beaverton OR","Hillsboro OR","Gresham OR","Lake Oswego OR","Tigard OR","Oregon City OR","Milwaukie OR","Tualatin OR","Vancouver WA"];

const SCORE_SYSTEM = `You are a web presence analyst for Instaweb, a digital agency that sells $399 websites to local trade businesses. You will be given a business name, city, and industry. Using your knowledge of local business web presence patterns, estimate their online presence and return a JSON object. RULES: Respond with ONLY a JSON object. No text before or after. No markdown. No explanation. If you don't know the specific business, make a realistic estimate based on typical businesses of that type in that city. Small local trade companies typically have weak web presence. Return exactly this structure: {"score":75,"hasWebsite":false,"websiteUrl":null,"websiteAge":null,"mobileScore":35,"googleRating":3.8,"reviewCount":12,"hasGMB":true,"socialPresence":"weak","redFlags":["No website found","Google listing has no photos","Last review was 2 years ago"],"pitch":"Your competitors are winning jobs online while you rely on word of mouth.","summary":"This business operates purely on referrals with no web presence. A modern site would immediately differentiate them."} Score: start at 0, +40 no website, +20 site pre-2018, +15 no GMB, +15 mobile<50, +10 rating<3, +10 no social. Cap 100.`;

const EMAIL_SYSTEM = `You write cold outreach emails for Instaweb (instaweb.agency), a digital agency that builds $399 websites for local trades. Rules: Respond with ONLY the email text. Nothing else. Tone: confident, peer-to-peer, not salesy. Under 150 words. Structure: Subject line, then 3 short paragraphs, then a line that says exactly "See your demo: {{DEMO_LINK}}" (keep that placeholder literally as written, do not replace it), then sign-off. Format: Subject: [subject]\\n\\n[para 1: we built a free demo]\\n\\n[para 2: one specific gap referencing red flags]\\n\\n[para 3: the offer - $399 setup, $99/mo care plan, limited spots]\\n\\nSee your demo: {{DEMO_LINK}}\\n\\n— The Instaweb Team\\nhello@instaweb.agency · instaweb.agency`;

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
    const lines = (emailText || "").split("\n");
    const subjectLine = lines.find(l => l.toLowerCase().startsWith("subject:"));
    const subject = subjectLine ? subjectLine.replace(/subject:\s*/i, "").trim() : "Your new website is ready";
    const body = subjectLine
      ? emailText.slice(emailText.indexOf(subjectLine) + subjectLine.length).trim()
      : emailText;
    return { subject, body };
  };

  const sendRealEmail = async (toEmail, emailText) => {
    const { subject, body } = parseEmailParts(emailText);
    const res = await fetch("/api/send-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to: toEmail, subject, text: body }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Send failed");
    return data;
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

        addLog("info","  ↳ Building demo site & writing outreach email...");
        const rawEmail = await callClaude(
          `Business: ${bizName}\nCity: ${settings.city}\nNiche: ${settings.niche}\nRed flags: ${(scoreData.redFlags||[]).join(", ")}\nPitch: ${scoreData.pitch}`,
          EMAIL_SYSTEM, 500
        );
        const emailText = fillEmailLink(rawEmail, demoLink);

        updatePipeline(prev => [{
          id: Date.now() + Math.random(),
          ...lead, score, hasWebsite: scoreData.hasWebsite, websiteUrl: scoreData.websiteUrl,
          googleRating: scoreData.googleRating, reviewCount: scoreData.reviewCount,
          redFlags: scoreData.redFlags || [], pitch: scoreData.pitch, summary: scoreData.summary,
          email: emailText, demoLink, status: "Demo Built", source: "Agent", addedAt: new Date().toISOString(),
        }, ...prev]);
        found++;
        setAgentCount(found);
        addLog("success", `  ✅ Added with live demo! (${found}/${agentTarget}) — "${bizName}"`);
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
    try {
      const data = await callClaudeJSON(
        `Business name: "${manualName}"\nCity: ${settings.city}\nIndustry: ${settings.niche}\n\nAnalyze their likely web presence and return the JSON object.`,
        SCORE_SYSTEM
      );
      setManualResult({ ...data, name: manualName, city: settings.city, niche: settings.niche, phone: manualPhone });
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
        EMAIL_SYSTEM, 500
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
      status: manualDemoLink ? "Demo Built" : "New", source:"Manual",
      addedAt: new Date().toISOString(),
    }, ...prev]);
    setManualResult(null); setManualEmail(null); setManualDemoLink(null);
    setManualName(""); setManualPhone("");
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
        const scoreData = await callClaudeJSON(
          `Business name: "${name}"\nCity: ${settings.city}\nIndustry: ${settings.niche}\n\nAnalyze their likely web presence and return the JSON object.`,
          SCORE_SYSTEM
        );
        const score = scoreData.score || 0;
        addBulkLog(score >= 60 ? "hit" : "miss", `  ↳ Score: ${score} ${scoreLabel(score)}`);

        const lead = { name, city: settings.city, niche: settings.niche, phone: "" };
        const demoLink = buildDemoLink(lead);
        addBulkLog("info","  ↳ Building demo & writing email...");
        const rawEmail = await callClaude(
          `Business: ${name}\nCity: ${settings.city}\nNiche: ${settings.niche}\nRed flags: ${(scoreData.redFlags||[]).join(", ")}\nPitch: ${scoreData.pitch}`,
          EMAIL_SYSTEM, 500
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
  const closedCount = pipeline.filter(l => l.status==="Closed").length;
  const hotCount = pipeline.filter(l => l.score >= 80).length;
  const demoCount = pipeline.filter(l => l.demoLink).length;
  const projMRR = closedCount * 99 + Math.floor(closedCount * 0.5) * 149;

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
          {[["agent","🤖 Agent"],["manual","🎯 Manual"],["bulk","📝 Bulk"],["pipeline",`📋 Pipeline (${pipeline.length})`]].map(([id,label])=>(
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
                              await sendRealEmail(recipientEmail.trim(), manualEmail);
                              setSendStatus({ ok: true, msg: `✅ Sent to ${recipientEmail.trim()}` });
                            } catch(e) {
                              setSendStatus({ ok: false, msg: `❌ ${e.message}` });
                            }
                            setSendingEmail(false);
                          }}
                        >
                          {sendingEmail ? "📤 Sending..." : "📤 Send Real Email"}
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
              {[["Total",pipeline.length,C.text],["🔥 Hot",hotCount,"#D85A30"],["Demos Live",demoCount,"#60a5fa"],["Closed",closedCount,"#34d399"],["Proj. MRR",`$${projMRR.toLocaleString()}`,C.accent],["No Website",pipeline.filter(l=>!l.hasWebsite).length,"#fbbf24"]].map(([label,val,col])=>(
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
      </div>
    </div>
  );
}
