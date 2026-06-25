// Stateless demo page generator.
// Lead data is base64-encoded directly into the URL query param "d" —
// no database, no storage, link never expires, works immediately after deploy.

const TEMPLATES = {
  roofing: {
    accent: "#E8510A",
    bg: "#0a0a0b", bg2: "#111114",
    tagline: "We Protect What Matters Most",
    services: ["Roof Replacement", "Roof Repair", "Storm Damage", "Gutters & Drainage"],
    icon: "🏠"
  },
  hvac: {
    accent: "#1A7FD4",
    bg: "#080d12", bg2: "#0d1520",
    tagline: "Your Home. Perfect Temperature.",
    services: ["AC Installation", "Furnace & Heating", "Heat Pumps", "Maintenance Plans"],
    icon: "❄️"
  },
  plumbing: {
    accent: "#16a34a",
    bg: "#060a08", bg2: "#0a1210",
    tagline: "We Fix It Right The First Time",
    services: ["Drain Cleaning", "Water Heaters", "Leak Repair", "24/7 Emergency"],
    icon: "🔧"
  },
  "pest control": {
    accent: "#ca8a04",
    bg: "#09080a", bg2: "#110f12",
    tagline: "Your Home. Pest Free. Guaranteed.",
    services: ["Ant & Rodent Control", "Spider & Wasp Removal", "Bed Bug Treatment", "Quarterly Plans"],
    icon: "🛡️"
  },
  default: {
    accent: "#E8510A",
    bg: "#0a0a0b", bg2: "#111114",
    tagline: "Quality Service You Can Trust",
    services: ["Free Estimates", "Licensed & Insured", "Satisfaction Guaranteed", "Local & Reliable"],
    icon: "⭐"
  }
};

function pickTemplate(niche) {
  const key = (niche || "").toLowerCase().trim();
  return TEMPLATES[key] || TEMPLATES.default;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildDemoHTML(lead) {
  const t = pickTemplate(lead.niche);
  const name = escapeHtml(lead.name || "Your Business");
  const city = escapeHtml(lead.city || "Portland, OR");
  const phone = escapeHtml(lead.phone || "(503) 555-0142");
  const phoneDigits = phone.replace(/[^0-9]/g, "");
  const nameParts = name.split(" ");
  const firstWord = nameParts[0];
  const restWords = nameParts.slice(1).join(" ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>${name} — ${city}</title>
<link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Barlow:wght@300;400;500;600;700&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{background:${t.bg};color:#f4f1ec;font-family:'Barlow',sans-serif;overflow-x:hidden;}
  nav{position:fixed;top:0;left:0;right:0;z-index:100;display:flex;align-items:center;justify-content:space-between;padding:1.25rem 4rem;background:rgba(0,0,0,0.85);backdrop-filter:blur(10px);}
  .logo{font-family:'Bebas Neue',sans-serif;font-size:24px;letter-spacing:2px;}
  .logo span{color:${t.accent};}
  .cta{background:${t.accent};color:#fff;font-size:13px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;padding:10px 20px;text-decoration:none;}
  .hero{min-height:90vh;display:flex;flex-direction:column;justify-content:center;padding:7rem 4rem 4rem;background:linear-gradient(160deg,${t.bg} 50%,${t.bg2} 100%);}
  .eyebrow{font-size:13px;font-weight:600;letter-spacing:0.2em;text-transform:uppercase;color:${t.accent};margin-bottom:1rem;}
  h1{font-family:'Bebas Neue',sans-serif;font-size:clamp(44px,8vw,100px);line-height:0.95;letter-spacing:1px;margin-bottom:1.5rem;max-width:800px;}
  h1 span{color:${t.accent};}
  .sub{font-size:18px;font-weight:300;color:rgba(244,241,236,0.6);max-width:520px;line-height:1.6;margin-bottom:2rem;}
  .btn{display:inline-block;background:${t.accent};color:#fff;font-size:14px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;padding:16px 32px;text-decoration:none;}
  .services{padding:5rem 4rem;background:${t.bg2};}
  .services h2{font-family:'Bebas Neue',sans-serif;font-size:38px;margin-bottom:2rem;}
  .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:1.5rem;}
  .card{background:${t.bg};padding:2rem;border:0.5px solid rgba(255,255,255,0.08);}
  .card-name{font-size:17px;font-weight:600;}
  .cta-strip{background:${t.accent};padding:4rem;text-align:center;}
  .cta-strip h2{font-family:'Bebas Neue',sans-serif;font-size:38px;color:#fff;margin-bottom:1rem;}
  .cta-strip a{display:inline-block;background:#fff;color:${t.accent};font-weight:700;padding:16px 36px;text-decoration:none;text-transform:uppercase;letter-spacing:0.08em;font-size:14px;margin-top:0.5rem;}
  footer{padding:2.5rem;text-align:center;color:rgba(244,241,236,0.4);font-size:13px;line-height:1.8;}
  footer a{color:${t.accent};text-decoration:none;font-weight:600;}
  .badge{position:fixed;top:80px;right:0;background:${t.accent};color:#fff;font-size:11px;font-weight:600;letter-spacing:0.1em;text-transform:uppercase;padding:8px 12px;writing-mode:vertical-rl;z-index:200;}
  @media(max-width:768px){nav,.hero,.services{padding-left:1.5rem;padding-right:1.5rem;}.grid{grid-template-columns:1fr;}}
</style>
</head>
<body>
<div class="badge">Instaweb Demo</div>
<nav>
  <div class="logo">${firstWord} <span>${restWords}</span></div>
  <a href="tel:${phoneDigits}" class="cta">Call Now</a>
</nav>
<section class="hero">
  <div class="eyebrow">${city} · Trusted Local Service</div>
  <h1>${t.icon} <span>${t.tagline}</span></h1>
  <p class="sub">${name} delivers expert service with the reliability your neighbors trust. Licensed, local, and ready to help.</p>
  <a href="tel:${phoneDigits}" class="btn">📞 ${phone}</a>
</section>
<section class="services">
  <h2>What We Do</h2>
  <div class="grid">
    ${t.services.map(s => `<div class="card"><div class="card-name">${s}</div></div>`).join("\n    ")}
  </div>
</section>
<div class="cta-strip">
  <h2>Ready to Get Started?</h2>
  <a href="tel:${phoneDigits}">📞 ${phone}</a>
</div>
<footer>This free demo was built for ${name} by <a href="https://instaweb.agency" target="_blank">Instaweb</a>. Like what you see? Let's make it real — <a href="mailto:hello@instaweb.agency">hello@instaweb.agency</a></footer>
</body>
</html>`;
}

export default function handler(req, res) {
  try {
    const { d } = req.query;
    let lead = {};
    if (d) {
      const json = Buffer.from(d, "base64url").toString("utf-8");
      lead = JSON.parse(json);
    }
    const html = buildDemoHTML(lead);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return res.status(200).send(html);
  } catch (err) {
    res.setHeader("Content-Type", "text/html");
    return res.status(200).send(`<h1>Demo Preview</h1><p>This demo link looks malformed. Generate a fresh one from the Prospector dashboard.</p><p style="color:#888;font-size:12px;">${err.message}</p>`);
  }
}
