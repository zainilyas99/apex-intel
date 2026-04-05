// api/insights.js
// Vercel serverless function — sits on the server, keeps your API key private.
// Place this file at: /api/insights.js in your project root.
// Set ANTHROPIC_API_KEY in your Vercel environment variables (never in code).

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Basic origin check — replace with your actual deployed domain
  const allowedOrigins = [
    "http://localhost:3000",
    "https://rxaudit.vercel.app", // update this to your real Vercel URL
  ];
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Pull the API key from environment — never hardcoded
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "API key not configured on server." });
  }

  // Validate request body exists
  const { prompt, pharmacy, findings, totalRecovery, criticalCount } = req.body;
  if (!prompt || !pharmacy) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  // Rate limiting — basic in-memory (use Redis/KV for production scale)
  // Vercel functions are stateless so this resets per cold start,
  // but it still protects against rapid bursts within a single instance.
  if (!handler._calls) handler._calls = {};
  const ip = req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown";
  const now = Date.now();
  const windowMs = 60 * 1000; // 1 minute window
  const maxCalls = 10;
  handler._calls[ip] = (handler._calls[ip] || []).filter(t => now - t < windowMs);
  if (handler._calls[ip].length >= maxCalls) {
    return res.status(429).json({ error: "Too many requests. Please wait a moment." });
  }
  handler._calls[ip].push(now);

  // Build the prompt server-side so the client can't inject arbitrary instructions
  const systemPrompt = `You are a senior NHS pharmacy claims auditor in the UK. Analyse FP10 monthly submission audit findings and provide precise, actionable recommendations. Always be specific with drug names, amounts in pounds sterling, and NHS BSA submission deadlines. Write in a professional but accessible tone suitable for a busy pharmacy owner or dispensing manager.`;

  const userMessage = `Analyse these FP10 audit findings for ${pharmacy.name} (ODS: ${pharmacy.ods}, Region: ${pharmacy.region}) for February 2026.

FINDINGS:
${findings}

TOTAL POTENTIAL RECOVERY: ${totalRecovery}
CRITICAL COMPLIANCE RISKS: ${criticalCount}

Provide a structured analysis with:
1. Executive Summary (2-3 sentences)
2. Priority Actions (top 3, ordered by revenue impact, with specific £ amounts)
3. Recurring Patterns & Staff Training Needs
4. Compliance Risk Assessment
5. Month-on-Month Context

Be concise and actionable.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Anthropic API error:", err);
      return res.status(response.status).json({ error: "AI service error. Please try again." });
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "";
    return res.status(200).json({ result: text });

  } catch (err) {
    console.error("Proxy fetch error:", err);
    return res.status(500).json({ error: "Failed to reach AI service. Check your connection." });
  }
}
