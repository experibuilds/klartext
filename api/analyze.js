// Serverless function: German document (text or page images) → plain-English summary, actions and full translation.
// Free providers only: Groq → OpenRouter free. Nothing is stored.
const hits = new Map(); // simple per-instance rate limit
const LIMIT = 8, WINDOW_MS = 60_000;
const MAX_TEXT = 14_000, MAX_IMAGES = 5, MAX_IMAGE_CHARS = 1_400_000;

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "anon";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < WINDOW_MS);
  if (recent.length >= LIMIT) return res.status(429).json({ error: "Too many documents in a minute. Wait a moment and try again." });
  recent.push(now); hits.set(ip, recent);

  const body = req.body || {};
  const text = String(body.text || "").trim().slice(0, MAX_TEXT);
  const images = (Array.isArray(body.images) ? body.images : [])
    .filter(u => typeof u === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(u) && u.length < MAX_IMAGE_CHARS)
    .slice(0, MAX_IMAGES);
  const name = String(body.name || "document").slice(0, 120);
  if (!text && !images.length) return res.status(400).json({ error: "No readable content found in this file." });

  const providers = buildProviders(images.length > 0);
  if (!providers.length) return res.status(500).json({ error: "Server has no AI provider key" });

  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildPrompt({ today, name, text, hasImages: images.length > 0 });

  try {
    const vision = images.length > 0;
    const { out, rateLimited } = await callWithFallback(providers, prompt, images, vision ? { deadline: 32_000, callMs: 20_000 } : {});
    // Free vision quota is tiny: tell the browser to read the text itself and resend as text.
    if (!out && vision) return res.status(503).json({ code: "vision_busy", error: "Image reading is busy. Reading the text on your device instead…" });
    if (!out) return res.status(rateLimited ? 429 : 502).json({
      error: rateLimited ? "The free AI quota is busy right now. Try again in a minute." : "The AI could not read this document. Try again or use a clearer photo.",
    });
    return res.status(200).json(clean(out));
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Something went wrong while reading the document." });
  }
}

function buildPrompt({ today, name, text, hasImages }) {
  return `You help English speakers who do not speak German understand German documents (letters from authorities, tax office, health insurance, landlords, employers, banks, schools, contracts, bills).
Today is ${today}. File name: "${name}".
${hasImages ? "The document is in the attached page image(s). Read every word carefully, including small print, tables and stamps." : "The document text (extracted from the file) is below."}

Produce a result that is crystal clear and leaves no room for doubt:
- "translation": complete, faithful English translation of the whole document. Do not shorten or skip anything. Keep structure: paragraph breaks as blank lines, lists as lines starting with "- ". Keep names, numbers, IBANs, reference numbers exactly.
- "summary": 2-4 short sentences in plain English (no jargon) saying who sent it, what it is about and what it means for the reader.
- "action_required": true only if the reader must or should do something; false for purely informational documents.
- "actions": ordered steps the reader must take, most important first. Each step does ONE thing, starts with a verb, and includes the exact details from the document needed to do it (amount, IBAN, reference/Aktenzeichen, address, phone, which form, which documents to attach). Only include steps the document actually asks for; never add generic steps. If (and only if) the document itself says the reader can ignore it in some case, put that in the detail of the related step. Empty list if nothing to do.
- "deadline": the earliest date (YYYY-MM-DD) by which something must be done, or null. If the deadline is relative (e.g. "innerhalb von zwei Wochen nach Erhalt", "within one month of the date of this letter"), do NOT calculate it: set "deadline" to null and fill "deadline_relative" with {"basis":"receipt" or "document_date","days":number of days (1 week = 7, 1 month = 30)}; otherwise "deadline_relative" is null. "deadline_note": quote the deadline wording from the document in English, short.
- "urgency": "high" (deadline within 14 days, money owed, legal/penalty risk), "medium", "low", or "none" (no action).
- "consequences": what happens if the reader does nothing, only if the document says or clearly implies it; else "".
- "key_facts": up to 8 important facts as label/value pairs (e.g. Amount due, Reference number, Contact).
- "unclear": anything ambiguous, unreadable or that needs checking with the sender; else [].
When a German term matters (e.g. Säumniszuschlag, Widerspruch, Aktenzeichen), give the English meaning and the German word in parentheses once.
Never invent information. If the document is not German, still translate it into English.

Return ONLY a JSON object with exactly these keys:
{"document_type":"short English type, with German term in parentheses if useful","sender":"","document_date":"YYYY-MM-DD or null","title":"one-line English headline, max 12 words","summary":"","action_required":true,"urgency":"high|medium|low|none","deadline":"YYYY-MM-DD or null","deadline_relative":null,"deadline_note":"","actions":[{"title":"","detail":"","due":"YYYY-MM-DD or null"}],"key_facts":[{"label":"","value":""}],"consequences":"","unclear":[],"translation":""}${text ? `

Document text:
"""
${text}
"""` : ""}`;
}

// ---- provider chain ----
// Each attempt: 429 = quota used → next provider; 5xx / network / bad JSON → retry once, then next.
// Longer limits than short-text tools: a full document translation is a long answer.
const RETRIES = 1, DEADLINE_MS = 50_000, CALL_MS = 28_000, RETRY_STATUS = new Set([500, 502, 503, 504]);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function openAI(name, url, key, model, extra = {}, headers = {}) {
  return {
    name: `${name}:${model}`,
    request: (prompt, images) => [url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "User-Agent": "klartext/1.0", ...headers },
      body: JSON.stringify({
        model, temperature: 0.2, max_tokens: 8000, response_format: { type: "json_object" }, ...extra,
        messages: [{
          role: "user",
          content: images.length
            ? [{ type: "text", text: prompt }, ...images.map(u => ({ type: "image_url", image_url: { url: u } }))]
            : prompt,
        }],
      }),
    }],
    text: d => d?.choices?.[0]?.message?.content || "",
  };
}

function buildProviders(vision) {
  const e = process.env, list = [];
  const GROQ = "https://api.groq.com/openai/v1/chat/completions", OR = "https://openrouter.ai/api/v1/chat/completions";
  const orHeaders = { "HTTP-Referer": "https://klartext-de.vercel.app", "X-Title": "Klartext" };
  if (e.GROQ_API_KEY) {
    const models = vision ? (e.GROQ_VISION_MODELS || "qwen/qwen3.8-27b") : (e.GROQ_MODELS || "openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.8-27b");
    for (const m of models.split(",").map(s => s.trim()).filter(Boolean)) {
      const extra = m.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : m.startsWith("qwen/") ? { reasoning_format: "hidden" } : {};
      list.push(openAI("groq", GROQ, e.GROQ_API_KEY, m, extra));
    }
  }
  if (e.OPENROUTER_API_KEY) {
    const models = vision ? (e.OPENROUTER_VISION_MODELS || "google/gemma-4-31b-it:free,nvidia/nemotron-3.5-super-vl:free") : (e.OPENROUTER_MODELS || "openrouter/free");
    for (const m of models.split(",").map(s => s.trim()).filter(Boolean)) list.push(openAI("openrouter", OR, e.OPENROUTER_API_KEY, m, {}, orHeaders));
  }
  return list;
}

function parse(raw) {
  const s = String(raw).replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```json|```/g, "");
  const m = s.match(/\{[\s\S]*\}/);
  const out = JSON.parse(m ? m[0] : s);
  if (!out.translation && !out.summary) throw new Error("empty output");
  return out;
}

async function callWithFallback(providers, prompt, images, { deadline = DEADLINE_MS, callMs = CALL_MS } = {}) {
  const end = Date.now() + deadline;
  let rateLimited = false;
  for (const p of providers) {
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      const left = end - Date.now();
      if (left < 3000) return { out: null, rateLimited };
      try {
        const [url, init] = p.request(prompt, images);
        const r = await fetch(url, { ...init, signal: AbortSignal.timeout(Math.min(callMs, left)) });
        if (r.ok) {
          try { const out = parse(p.text(await r.json())); console.log("served by", p.name); return { out: { ...out, _model: p.name } }; }
          catch (e) { console.error("Bad model output", p.name, e.message); }
        } else {
          console.error("Model error", p.name, r.status, (await r.text()).slice(0, 200));
          if (r.status === 429) { rateLimited = true; break; }
          if (!RETRY_STATUS.has(r.status)) break;
        }
      } catch (e) {
        console.error("Model fetch failed", p.name, e.name);
      }
      if (attempt < RETRIES) await sleep(300 + Math.random() * 300);
    }
  }
  return { out: null, rateLimited };
}

// ---- normalise model output so the UI can trust the shape ----
const str = (v, n = 4000) => (v == null ? "" : String(v)).trim().slice(0, n);
const date = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);
function clean(o) {
  const actions = (Array.isArray(o.actions) ? o.actions : []).slice(0, 12).map(a =>
    typeof a === "string" ? { title: str(a, 300), detail: "", due: null } : { title: str(a.title, 300), detail: str(a.detail, 1200), due: date(a.due) }
  ).filter(a => a.title);
  let deadline = date(o.deadline), note = str(o.deadline_note, 400);
  const rel = o.deadline_relative, days = Math.round(Number(rel?.days));
  if (rel && days > 0 && days < 400) {
    const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const docDate = date(o.document_date) ? new Date(o.document_date + "T00:00:00Z") : null;
    let base, how;
    if (rel.basis === "document_date" && docDate) { base = docDate; how = `${days} days after the letter date`; }
    else {
      const assumed = docDate ? new Date(docDate.getTime() + 3 * 864e5) : today;
      base = assumed > today ? assumed : today;
      how = `${days} days after you received it — estimated assuming you received it on ${base.toISOString().slice(0, 10)}${docDate && base.getTime() === today.getTime() ? " (today)" : ""}. If it arrived earlier, count from that day`;
    }
    const computed = new Date(base.getTime() + days * 864e5).toISOString().slice(0, 10);
    for (const a of actions) if (!a.due || a.due === deadline) a.due = computed;
    deadline = computed; note = `${note ? note.replace(/\.?$/, ". ") : ""}Deadline: ${how}.`;
  }
  const urgency = ["high", "medium", "low", "none"].includes(o.urgency) ? o.urgency : (actions.length ? "medium" : "none");
  return {
    document_type: str(o.document_type, 160),
    sender: str(o.sender, 200),
    document_date: date(o.document_date),
    title: str(o.title, 200),
    summary: str(o.summary, 1500),
    action_required: o.action_required === true || (o.action_required !== false && actions.length > 0),
    urgency,
    deadline,
    deadline_note: note,
    actions,
    key_facts: (Array.isArray(o.key_facts) ? o.key_facts : []).slice(0, 10)
      .map(f => ({ label: str(f?.label, 80), value: str(f?.value, 300) })).filter(f => f.label && f.value),
    consequences: str(o.consequences, 800),
    unclear: (Array.isArray(o.unclear) ? o.unclear : []).map(u => str(u, 400)).filter(Boolean).slice(0, 6),
    translation: str(o.translation, 40000),
    model: o._model,
  };
}
