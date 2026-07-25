// Admin API — updates Vercel environment variables via Vercel API
// Protected by ADMIN_PASSWORD env var (set this in Vercel too)
// Requires VERCEL_TOKEN and VERCEL_PROJECT_ID env vars

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password, action, key, value } = req.body || {};

  // Password check
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    return res.status(500).json({ error: "ADMIN_PASSWORD not configured on server" });
  }
  if (password !== adminPassword) {
    return res.status(401).json({ error: "Invalid password" });
  }

  const vercelToken = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID; // optional

  if (!vercelToken || !projectId) {
    return res.status(500).json({ error: "VERCEL_TOKEN or VERCEL_PROJECT_ID not configured" });
  }

  // Action: list — show current env var names (not values) 
  if (action === "list") {
    const url = `https://api.vercel.com/v9/projects/${projectId}/env${teamId ? `?teamId=${teamId}` : ""}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data.error?.message || "Vercel API error" });
    // Return only names and types — never return values
    const envs = (data.envs || []).map(e => ({
      id: e.id,
      key: e.key,
      type: e.type,
      target: e.target,
      updatedAt: e.updatedAt,
    }));
    return res.status(200).json({ envs });
  }

  // Action: update — set or update an env var
  if (action === "update") {
    if (!key || !value) return res.status(400).json({ error: "key and value required" });

    // First check if it already exists
    const listUrl = `https://api.vercel.com/v9/projects/${projectId}/env${teamId ? `?teamId=${teamId}` : ""}`;
    const listResp = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${vercelToken}` },
    });
    const listData = await listResp.json();
    const existing = (listData.envs || []).find(e => e.key === key);

    let resp;
    if (existing) {
      // PATCH to update existing
      resp = await fetch(
        `https://api.vercel.com/v9/projects/${projectId}/env/${existing.id}${teamId ? `?teamId=${teamId}` : ""}`,
        {
          method: "PATCH",
          headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ value, type: "encrypted", target: ["production", "preview"] }),
        }
      );
    } else {
      // POST to create new
      resp = await fetch(
        `https://api.vercel.com/v9/projects/${projectId}/env${teamId ? `?teamId=${teamId}` : ""}`,
        {
          method: "POST",
          headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ key, value, type: "encrypted", target: ["production", "preview"] }),
        }
      );
    }
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data.error?.message || "Vercel API error" });

    // Trigger a redeploy so new keys take effect
    const deployResp = await fetch(
      `https://api.vercel.com/v13/deployments${teamId ? `?teamId=${teamId}` : ""}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "instaweb-prospector",
          target: "production",
          gitSource: { type: "github", repoId: process.env.GITHUB_REPO_ID, ref: "agency-os" },
        }),
      }
    );

    return res.status(200).json({
      success: true,
      message: `${existing ? "Updated" : "Created"} ${key} successfully. Redeploy triggered.`,
    });
  }

  return res.status(400).json({ error: "Unknown action" });
}
