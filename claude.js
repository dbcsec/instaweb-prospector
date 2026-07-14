export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { to, subject, text, replyTo, scheduledAt } = req.body;

    if (!to || !subject || !text) {
      return res.status(400).json({ error: "Missing required fields: to, subject, text" });
    }

    const payload = {
      from: "Instaweb <hello@instaweb.agency>",
      to: [to],
      subject,
      text,
      reply_to: replyTo || "hello@instaweb.agency",
    };
    // scheduledAt accepts either natural language ("in 3 days") or ISO 8601
    if (scheduledAt) payload.scheduledAt = scheduledAt;

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data.message || "Resend API error", details: data });
    }

    return res.status(200).json({ success: true, id: data.id, scheduledAt: scheduledAt || null });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
