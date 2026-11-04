// Klartext — client: read files in the browser, send text or page images to /api/analyze, render the answer.
const $ = s => document.querySelector(s);
const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
const MAMMOTH = "https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js";
const MAX_IMAGES = 5, MAX_SIDE = 1700, MAX_PDF_PAGES = 15;

let items = [];          // {kind:'image'|'text', name, thumb, dataUrl?, text?}
let lastSource = "file"; // where "Add page" should go
let current = null, controller = null, timers = [];

// ---------- theme / install / sw ----------
$("#themeBtn").onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  const next = dark ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("kt-theme", next); } catch {}
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.content = next === "dark" ? "#0C0D10" : "#F6F4EF");
};
let installEvt = null;
addEventListener("beforeinstallprompt", e => { e.preventDefault(); installEvt = e; $("#installBtn").hidden = false; });
$("#installBtn").onclick = async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $("#installBtn").hidden = true; };
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

// ---------- helpers ----------
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove("show"), 2200); }
function show(id) { for (const v of ["#start", "#working", "#result"]) $(v).hidden = v !== id; $("#error").hidden = true; scrollTo({ top: 0, behavior: "smooth" }); }
function showError(msg) { $("#errorMsg").textContent = msg; $("#error").hidden = false; $("#error").scrollIntoView({ behavior: "smooth", block: "center" }); }
const loadScript = src => new Promise((ok, fail) => { const s = document.createElement("script"); s.src = src; s.onload = ok; s.onerror = () => fail(new Error("Could not load a helper library. Check your connection.")); document.head.appendChild(s); });
const dayMs = 86400000;
function daysLeft(iso) { const d = new Date(iso + "T00:00:00"); const t = new Date(); t.setHours(0, 0, 0, 0); return Math.round((d - t) / dayMs); }
function fmtDate(iso) { return new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }); }
function leftText(n) { return n < 0 ? `${-n} day${n === -1 ? "" : "s"} overdue` : n === 0 ? "due today" : n === 1 ? "1 day left" : `${n} days left`; }
async function copy(text, label = "Copied") { try { await navigator.clipboard.writeText(text); toast(label); } catch { toast("Copy not allowed here"); } }

// ---------- reading files ----------
async function fileToImage(file) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); }
  catch {
    src = await new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => fail(new Error(
      /hei[cf]/i.test(file.type + file.name) ? "This HEIC photo can't be opened in this browser. Use “Take a photo” or a JPG/PNG." : `“${file.name}” is not a readable image.`));
      i.src = URL.createObjectURL(file); });
  }
  return canvasJpeg(src, src.width, src.height);
}
function canvasJpeg(src, w, h) {
  const scale = Math.min(1, MAX_SIDE / Math.max(w, h));
  const c = document.createElement("canvas"); c.width = Math.round(w * scale); c.height = Math.round(h * scale);
  const x = c.getContext("2d"); x.fillStyle = "#fff"; x.fillRect(0, 0, c.width, c.height); x.drawImage(src, 0, 0, c.width, c.height);
  let q = 0.82, url = c.toDataURL("image/jpeg", q);
  while (url.length > 1_200_000 && q > 0.45) { q -= 0.12; url = c.toDataURL("image/jpeg", q); }
  return url;
}
let pdfjs;
async function readPdf(file) {
  pdfjs ||= await import(PDFJS);
  pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const n = Math.min(doc.numPages, MAX_PDF_PAGES);
  let text = "";
  for (let p = 1; p <= n; p++) {
    const tc = await (await doc.getPage(p)).getTextContent();
    let line = "";
    for (const it of tc.items) { line += it.str + (it.hasEOL ? "\n" : " "); }
    text += line.trim() + "\n\n";
  }
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const render = async (p, side) => {
    const page = await doc.getPage(p); const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: side / Math.max(v1.width, v1.height) });
    const c = document.createElement("canvas"); c.width = vp.width; c.height = vp.height;
    const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return c.toDataURL("image/jpeg", 0.82);
  };
  if (text.length >= 40 * n) return [{ kind: "text", name: file.name, text, thumb: await render(1, 360), label: `PDF · ${doc.numPages} page${doc.numPages > 1 ? "s" : ""}` }];
  // scanned PDF: send the pages as images
  const out = [], pages = Math.min(doc.numPages, MAX_IMAGES);
  for (let p = 1; p <= pages; p++) { const url = await render(p, MAX_SIDE); out.push({ kind: "image", name: `${file.name} p${p}`, dataUrl: url, thumb: url }); }
  if (doc.numPages > MAX_IMAGES) toast(`Scanned PDF: using the first ${MAX_IMAGES} pages`);
  return out;
}
async function readDocx(file) {
  if (!window.mammoth) await loadScript(MAMMOTH);
  const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
  return [{ kind: "text", name: file.name, text: r.value.trim(), label: "Word" }];
}
async function readTextLike(file) {
  let t = await file.text();
  if (/\.(html?|xml)$/i.test(file.name) || /html|xml/.test(file.type)) t = new DOMParser().parseFromString(t, "text/html").body?.innerText || t;
  else if (/\.rtf$/i.test(file.name)) t = t.replace(/\\par[d]?/g, "\n").replace(/\{\\\*[^}]*\}|\\[a-z]+-?\d* ?|[{}]/gi, "");
  if ((t.match(/\u0000/g) || []).length > 5) throw new Error(`“${file.name}” isn't a supported file type. Use PDF, a photo, Word or text.`);
  const ext = (file.name.split(".").pop() || "TXT").toUpperCase().slice(0, 4);
  return [{ kind: "text", name: file.name, text: t.trim(), label: ext }];
}
async function readFile(file) {
  const n = file.name.toLowerCase(), t = file.type;
  if (t === "application/pdf" || n.endsWith(".pdf")) return readPdf(file);
  if (t.startsWith("image/") || /\.(jpe?g|png|webp|heic|heif|gif|bmp)$/.test(n)) { const url = await fileToImage(file); return [{ kind: "image", name: file.name, dataUrl: url, thumb: url }]; }
  if (n.endsWith(".docx") || t.includes("wordprocessingml")) return readDocx(file);
  if (n.endsWith(".doc")) throw new Error("Old .doc files aren't supported. Save it as .docx or PDF, or take a photo of it.");
  return readTextLike(file);
}

async function addFiles(files, source = "file") {
  files = [...files].filter(Boolean); if (!files.length) return;
  lastSource = source; $("#error").hidden = true;
  if ($("#start").hidden) show("#start");
  const added = [];
  setTray(true, "Reading…");
  for (const f of files) {
    if (f.size > 40 * 1024 * 1024) { showError(`“${f.name}” is larger than 40 MB.`); continue; }
    try { added.push(...await readFile(f)); }
    catch (e) { console.error(e); showError(e.message || `Couldn't open “${f.name}”.`); }
  }
  for (const it of added) {
    if (it.kind === "text" && !it.text) { showError(`No text found in “${it.name}”. If it's a scan, take a photo of it instead.`); continue; }
    if (it.kind === "image" && items.filter(i => i.kind === "image").length >= MAX_IMAGES) { toast(`Max ${MAX_IMAGES} pages per document`); break; }
    items.push(it);
  }
  renderTray();
}
function setTray(on, title) { $("#dropEmpty").hidden = on; $("#tray").hidden = !on; if (title) $("#trayTitle").textContent = title; }
function renderTray() {
  if (!items.length) { setTray(false); return; }
  const pages = items.length;
  setTray(true, `${pages} ${pages === 1 ? "item" : "items"} ready`);
  $("#thumbs").innerHTML = items.map((it, i) => `<li>
    ${it.thumb ? `<img src="${it.thumb}" alt="">` : `<div class="file"><b>${esc(it.label || "FILE")}</b>${esc(it.name)}</div>`}
    <span class="n">${i + 1}</span>
    <button class="x" data-i="${i}" aria-label="Remove ${esc(it.name)}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></button></li>`).join("");
}
$("#thumbs").onclick = e => { const b = e.target.closest(".x"); if (!b) return; items.splice(+b.dataset.i, 1); renderTray(); };
$("#clearBtn").onclick = () => { items = []; renderTray(); };
$("#cameraBtn").onclick = () => $("#cameraInput").click();
$("#uploadBtn").onclick = () => $("#fileInput").click();
$("#addPageBtn").onclick = () => (lastSource === "camera" ? $("#cameraInput") : $("#fileInput")).click();
$("#cameraInput").onchange = e => { addFiles(e.target.files, "camera"); e.target.value = ""; };
$("#fileInput").onchange = e => { addFiles(e.target.files, "file"); e.target.value = ""; };

// drag & drop + paste
let dragDepth = 0;
addEventListener("dragenter", e => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { dragDepth++; document.body.classList.add("dragging"); } });
addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
addEventListener("dragover", e => e.preventDefault());
addEventListener("drop", e => { e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging"); if (e.dataTransfer?.files?.length) { show("#start"); addFiles(e.dataTransfer.files); } });
addEventListener("paste", e => { const f = [...(e.clipboardData?.files || [])]; if (f.length) { show("#start"); addFiles(f); } });

// ---------- analyse ----------
$("#goBtn").onclick = analyse;
$("#cancelBtn").onclick = () => { controller?.abort(); };
$("#errorBtn").onclick = () => { $("#error").hidden = true; show("#start"); renderTray(); };

function progress(step) {
  document.querySelectorAll("#progress li").forEach(li => {
    const s = +li.dataset.s; li.className = s < step ? "done" : s === step ? "active" : "";
  });
}
async function analyse() {
  if (!items.length) return;
  const images = items.filter(i => i.kind === "image").map(i => i.dataUrl);
  const original = items.filter(i => i.kind === "text").map(i => i.text).join("\n\n— — —\n\n");
  const name = items.map(i => i.name).join(", ").slice(0, 120);
  $("#scanImg").src = items.find(i => i.thumb)?.thumb || "";
  show("#working"); progress(0);
  timers.forEach(clearTimeout); timers = [setTimeout(() => progress(1), 1400), setTimeout(() => progress(2), 3800)];
  controller = new AbortController();
  const kill = setTimeout(() => controller.abort("timeout"), 75_000);
  try {
    const r = await fetch("/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
      body: JSON.stringify({ name, text: original, images }),
    });
    let data = {}; try { data = await r.json(); } catch {}
    if (!r.ok) throw new Error(data.error || (r.status === 413 ? "The document is too large. Use fewer pages." : `Server error (${r.status}). Try again.`));
    progress(3);
    await new Promise(ok => setTimeout(ok, 350));
    current = { ...data, original };
    renderResult(current);
  } catch (e) {
    show("#start"); renderTray();
    if (e.name === "AbortError" || e === "timeout") showError(controller.signal.reason === "timeout" ? "This took too long. Try again, or split the document into fewer pages." : "Cancelled.");
    else showError(e.message || "Network error. Check your connection.");
  } finally { clearTimeout(kill); timers.forEach(clearTimeout); }
}

// ---------- result ----------
const ICON_ALERT = `<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>`;
const ICON_OK = `<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>`;
const ICON_TODO = `<svg viewBox="0 0 24 24"><path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/></svg>`;

function renderResult(d) {
  const act = d.action_required;
  const urg = act ? (d.urgency === "none" ? "medium" : d.urgency) : "none";
  let head, sub;
  if (!act) { head = "No action needed"; sub = "This document is for your information. You don't have to do anything."; }
  else if (d.deadline) { const n = daysLeft(d.deadline); head = n < 0 ? "Action required — overdue" : "Action required"; sub = `By ${fmtDate(d.deadline)} · ${leftText(n)}`; }
  else { head = "Action required"; sub = "No fixed deadline is stated — handle it soon."; }
  $("#verdict").className = `verdict ${urg}`;
  $("#verdict").innerHTML = `<div class="badge">${act ? (urg === "high" ? ICON_ALERT : ICON_TODO) : ICON_OK}</div>
    <div><h2>${esc(head)}</h2><p>${esc(sub)}</p>${d.deadline_note && act ? `<p class="sub">${esc(d.deadline_note)}</p>` : ""}</div>`;

  const meta = [d.document_type, d.sender && `From ${d.sender}`, d.document_date && fmtDate(d.document_date)].filter(Boolean);
  $("#meta").innerHTML = meta.map(m => `<span>${esc(m)}</span>`).join("");
  $("#title").textContent = d.title || d.document_type || "Your document";
  $("#summary").textContent = d.summary;

  $("#actionsCount").textContent = d.actions.length ? `${d.actions.length} step${d.actions.length > 1 ? "s" : ""} · tap to tick off` : "";
  $("#actions").innerHTML = d.actions.length ? d.actions.map(a => {
    const n = a.due ? daysLeft(a.due) : null;
    return `<li><button class="tick" aria-label="Mark step done"></button><div>
      <div class="a-title">${esc(a.title)}</div>${a.detail ? `<p class="a-detail">${esc(a.detail)}</p>` : ""}
      ${a.due ? `<span class="a-due ${n <= 7 ? "soon" : ""}">Due ${esc(fmtDate(a.due))} · ${leftText(n)}</span>` : ""}</div></li>`;
  }).join("") : `<li class="no-actions" style="display:block">Nothing to do. You can file this document away.</li>`;
  $("#icsBtn").hidden = !(act && d.deadline);

  $("#consequences").hidden = !d.consequences;
  $("#consequences").innerHTML = d.consequences ? `<b>If you do nothing</b>${esc(d.consequences)}` : "";
  $("#factsCard").hidden = !d.key_facts.length;
  $("#facts").innerHTML = d.key_facts.map(f => `<button data-copy="${esc(f.value)}"><dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd></button>`).join("");
  $("#unclear").hidden = !d.unclear.length;
  $("#unclear").innerHTML = d.unclear.length ? `<b>Worth double-checking</b><ul>${d.unclear.map(u => `<li>${esc(u)}</li>`).join("")}</ul>` : "";

  $("#seg").hidden = !d.original;
  setTranslation("en");
  $("#shareBtn").hidden = !navigator.share;
  show("#result");
}
function setTranslation(v) {
  const txt = v === "de" ? current.original : current.translation;
  document.querySelectorAll("#seg button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
  const el = $("#translation");
  el.innerHTML = String(txt || "No translation returned.").split(/\n\s*\n/).map(p => `<p>${esc(p.trim())}</p>`).join("");
  el.classList.add("collapsed"); $("#moreBtn").textContent = v === "de" ? "Show full original" : "Show full translation";
  requestAnimationFrame(() => { const short = el.scrollHeight <= 240; $("#moreBtn").hidden = short; if (short) el.classList.remove("collapsed"); });
}
$("#seg").onclick = e => { const b = e.target.closest("button"); if (b) setTranslation(b.dataset.v); };
$("#moreBtn").onclick = () => { const el = $("#translation"); const c = el.classList.toggle("collapsed"); $("#moreBtn").textContent = c ? "Show more" : "Show less"; };
$("#actions").onclick = e => { const li = e.target.closest("li"); if (li && !li.classList.contains("no-actions")) li.classList.toggle("checked"); };
$("#facts").onclick = e => { const b = e.target.closest("button"); if (b) copy(b.dataset.copy, "Copied: " + b.dataset.copy.slice(0, 40)); };

function asText(d) {
  const L = [];
  L.push(d.title, [d.document_type, d.sender, d.document_date].filter(Boolean).join(" · "), "");
  L.push(d.action_required ? `ACTION REQUIRED${d.deadline ? ` by ${fmtDate(d.deadline)}` : ""}` : "No action needed", "");
  L.push("Summary:", d.summary, "");
  if (d.actions.length) { L.push("What to do:"); d.actions.forEach((a, i) => L.push(`${i + 1}. ${a.title}${a.detail ? ` — ${a.detail}` : ""}${a.due ? ` (due ${a.due})` : ""}`)); L.push(""); }
  if (d.consequences) L.push("If you do nothing: " + d.consequences, "");
  if (d.key_facts.length) { L.push("Key details:"); d.key_facts.forEach(f => L.push(`- ${f.label}: ${f.value}`)); L.push(""); }
  L.push("Full translation:", d.translation);
  return L.join("\n");
}
$("#copyBtn").onclick = () => copy(asText(current), "Copied summary and translation");
$("#shareBtn").onclick = () => navigator.share({ title: current.title, text: asText(current) }).catch(() => {});
$("#newBtn").onclick = () => { items = []; current = null; renderTray(); show("#start"); };
$("#icsBtn").onclick = () => {
  const d = current, day = d.deadline.replaceAll("-", ""), next = new Date(new Date(d.deadline + "T00:00:00Z").getTime() + dayMs).toISOString().slice(0, 10).replaceAll("-", "");
  const icsEsc = s => String(s).replace(/[\\;,]/g, m => "\\" + m).replace(/\n/g, "\\n");
  const desc = d.actions.map((a, i) => `${i + 1}. ${a.title}${a.detail ? " — " + a.detail : ""}`).join("\n");
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Klartext//EN", "BEGIN:VEVENT", `UID:${Date.now()}@klartext`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`, `DTSTART;VALUE=DATE:${day}`, `DTEND;VALUE=DATE:${next}`,
    `SUMMARY:${icsEsc("Deadline: " + d.title)}`, `DESCRIPTION:${icsEsc(desc)}`,
    "BEGIN:VALARM", "TRIGGER:-P2D", "ACTION:DISPLAY", "DESCRIPTION:Deadline in 2 days", "END:VALARM", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" })); a.download = "klartext-deadline.ics"; a.click();
};

// ---------- files shared from other apps (PWA share target) ----------
(async () => {
  if (!new URLSearchParams(location.search).has("shared") || !("caches" in window)) return;
  history.replaceState(null, "", "/");
  const c = await caches.open("kt-share"); const keys = await c.keys(); const files = [];
  for (const k of keys) { const r = await c.match(k); const b = await r.blob(); files.push(new File([b], decodeURIComponent(r.headers.get("x-name") || "shared"), { type: b.type })); await c.delete(k); }
  if (files.length) addFiles(files);
})();
