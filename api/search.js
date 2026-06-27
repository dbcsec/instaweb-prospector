export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Missing query" });

    if (!process.env.SERPER_API_KEY) {
      return res.status(500).json({ error: "SERPER_API_KEY not configured" });
    }

    const response = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 5 }),
    });

    const data = await response.json();
    if (data.error) {
      return res.status(400).json({ error: data.error });
    }

    // Return a condensed, useful shape: titles, snippets, links
    const results = (data.organic || []).slice(0, 5).map(r => ({
      title: r.title,
      snippet: r.snippet,
      link: r.link,
    }));

    return res.status(200).json({ results, knowledgeGraph: data.knowledgeGraph || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
