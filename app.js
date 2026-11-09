/* Overtime Bar-Bestellung – Tablet-App
 * Ablauf: Zugangscode (einmalig) -> Bar wählen -> Sortiment, Mengen eingeben -> Übersicht -> Absenden
 * Datenaustausch: Firebase (Firestore REST + anonyme Anmeldung). Keine Bestände auf dem Tablet.
 */
(function () {
  "use strict";
  const CFG = window.OT_CONFIG;
  const LS = {
    get(k, d) { try { const v = localStorage.getItem("ot_" + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("ot_" + k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem("ot_" + k); } catch (e) {} },
  };
  // Test-Umgebung (nur lokal gesetzt, im Betrieb leer)
  const TEST = LS.get("test_hosts", null);
  const IDENTITY = TEST ? `${TEST.auth}/identitytoolkit.googleapis.com/v1` : "https://identitytoolkit.googleapis.com/v1";
  const TOKEN_URL = TEST ? `${TEST.auth}/securetoken.googleapis.com/v1/token` : "https://securetoken.googleapis.com/v1/token";
  const DOCS = `${TEST ? TEST.firestore : "https://firestore.googleapis.com"}/v1/projects/${CFG.projectId}/databases/(default)/documents`;

  const $app = document.getElementById("app");
  const state = {
    view: "boot", sortiment: LS.get("sortiment", null), bar: null, cat: "Alle", search: "",
    draft: {}, // code -> {e: Flaschen/Stück, b: Kisten}
  };

  // ---------------------------------------------------------------- Hilfen
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function toast(msg, kind) {
    const t = document.getElementById("toast");
    t.textContent = msg; t.className = "toast " + (kind || "");
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add("hidden"), 3200);
  }
  function setNet(msg) {
    const n = document.getElementById("netbar");
    if (msg) { n.textContent = msg; n.classList.remove("hidden"); } else n.classList.add("hidden");
  }
  function pad(n) { return String(n).padStart(2, "0"); }
  function nowIso() { const d = new Date(); return d.toISOString(); }
  function timeText(iso) { const d = new Date(iso); return isNaN(d) ? "" : `${pad(d.getDate())}.${pad(d.getMonth() + 1)}. ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
  function newId() {
    const d = new Date(); const r = Math.random().toString(36).slice(2, 8);
    return `B-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${r}`;
  }

  // ---------------------------------------------------------------- Firestore-Werte
  function toValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === "boolean") return { booleanValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "string") return { stringValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
    const f = {}; Object.keys(v).forEach(k => f[k] = toValue(v[k])); return { mapValue: { fields: f } };
  }
  function fromValue(v) {
    if (!v) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return parseInt(v.integerValue, 10);
    if ("doubleValue" in v) return v.doubleValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromValue);
    if ("mapValue" in v) return fromFields(v.mapValue.fields);
    return null;
  }
  function toFields(o) { const f = {}; Object.keys(o).forEach(k => f[k] = toValue(o[k])); return f; }
  function fromFields(f) { const o = {}; Object.keys(f || {}).forEach(k => o[k] = fromValue(f[k])); return o; }

  // ---------------------------------------------------------------- Anmeldung (anonym, dauerhaft)
  let idToken = "", tokenExp = 0;
  async function signUpAnon() {
    const r = await fetch(`${IDENTITY}/accounts:signUp?key=${CFG.apiKey}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
    if (!r.ok) throw new Error("Anmeldung fehlgeschlagen (" + r.status + ")");
    const j = await r.json();
    LS.set("refresh", j.refreshToken); idToken = j.idToken; tokenExp = Date.now() + (parseInt(j.expiresIn, 10) - 120) * 1000;
  }
  async function getToken() {
    if (idToken && Date.now() < tokenExp) return idToken;
    const rt = LS.get("refresh", "");
    if (!rt) { await signUpAnon(); return idToken; }
    const r = await fetch(`${TOKEN_URL}?key=${CFG.apiKey}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(rt) });
    if (r.status === 400) { LS.del("refresh"); await signUpAnon(); return idToken; }
    if (!r.ok) throw new Error("Token (" + r.status + ")");
    const j = await r.json();
    LS.set("refresh", j.refresh_token || rt); idToken = j.id_token; tokenExp = Date.now() + (parseInt(j.expires_in, 10) - 120) * 1000;
    return idToken;
  }
  async function api(method, path, body) {
    const tok = await getToken();
    const r = await fetch(`${DOCS}/${path}`, { method, headers: { "Authorization": "Bearer " + tok, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (r.status === 404) return null;
    if (!r.ok) { const e = new Error("HTTP " + r.status); e.status = r.status; throw e; }
    return r.json();
  }

  // ---------------------------------------------------------------- Sortiment
  async function loadSortiment() {
    try {
      const d = await api("GET", "sortiment/aktuell");
      if (d && d.fields) {
        const neu = fromFields(d.fields);
        const changed = JSON.stringify(neu.artikel) + JSON.stringify(neu.bars) !== JSON.stringify((state.sortiment || {}).artikel) + JSON.stringify((state.sortiment || {}).bars);
        state.sortiment = neu; LS.set("sortiment", state.sortiment);
        if (changed && state.view === "order") renderList();
        if (changed && state.view === "bars") render();
      }
      setNet("");
      return true;
    } catch (e) {
      if (!navigator.onLine || !e.status) setNet("Keine Internetverbindung – es wird das zuletzt geladene Sortiment angezeigt.");
      return false;
    }
  }

  // ---------------------------------------------------------------- Postausgang (sendet auch nach Funkloch)
  function myOrders() { return LS.get("orders", []); }
  function saveOrders(list) { LS.set("orders", list.slice(-60)); updateBadge(); }
  async function flushOutbox() {
    const list = myOrders(); let changed = false;
    for (const o of list) {
      if (o.local !== "warten") continue;
      const payload = Object.assign({}, o.data, { zugangscode: LS.get("code", "") });
      try {
        await api("POST", `bestellungen?documentId=${encodeURIComponent(o.id)}`, { fields: toFields(payload) });
        o.local = "gesendet"; o.status = "gesendet"; changed = true;
      } catch (e) {
        if (e.status === 409) { o.local = "gesendet"; changed = true; continue; } // bereits angekommen
        if (e.status === 403) { o.local = "warten"; o.fehler = "code"; changed = true; showCodeProblem(); break; }
        setNet("Keine Verbindung – Bestellung wird automatisch gesendet, sobald wieder Internet da ist.");
        break;
      }
    }
    if (changed) { saveOrders(list); if (state.view === "orders") render(); }
    if (!list.some(o => o.local === "warten")) setNet("");
  }
  function showCodeProblem() {
    toast("Zugangscode ungültig – bitte neu eingeben", "err");
    state.view = "setup"; state.codeError = true; render();
  }
  async function pollStatus() {
    const list = myOrders(); let changed = false;
    for (const o of list) {
      if (o.local !== "gesendet" || ["beliefert", "storniert"].includes(o.status)) continue;
      try {
        const d = await api("GET", `status/${encodeURIComponent(o.id)}`);
        if (d && d.fields) {
          const s = fromFields(d.fields);
          if (s.status && s.status !== o.status) {
            if (o.status && s.status === "beliefert") toast(`${o.data.bar}: Bestellung von ${timeText(o.data.erstellt)} wurde beliefert`, "ok");
            o.status = s.status; o.geliefert = s.positionen || []; changed = true;
          }
        }
      } catch (e) { break; }
    }
    if (changed) { saveOrders(list); if (state.view === "orders") render(); }
  }
  function updateBadge() {
    const open = myOrders().filter(o => o.data && o.data.bar === state.bar && !["beliefert", "storniert"].includes(o.status)).length;
    const b = document.getElementById("orders-badge");
    b.textContent = open; b.classList.toggle("hidden", !open);
  }

  // ---------------------------------------------------------------- Entwurf
  function draftKey() { return "draft_" + state.bar; }
  function loadDraft() { state.draft = LS.get(draftKey(), {}); }
  function saveDraft() { LS.set(draftKey(), state.draft); }
  function articles() { return (state.sortiment && state.sortiment.artikel) || []; }
  function artByCode(c) { return articles().find(a => a.code === c); }
  function draftPositions() {
    const out = [];
    Object.keys(state.draft).forEach(code => {
      const q = state.draft[code], a = artByCode(code);
      if (!a) return;
      if (q.b > 0) out.push({ artikelcode: code, artikelname: a.name, groesse: a.groesse || "", menge: q.b, einheit: "Bund/Kiste" });
      if (q.e > 0) out.push({ artikelcode: code, artikelname: a.name, groesse: a.groesse || "", menge: q.e, einheit: "Einzeln" });
    });
    return out;
  }
  // Einheit einer bestellten Position (mit der Kartongröße zum Bestellzeitpunkt)
  function unitLabelPos(a, p) {
    if (p.einheit === "Bund/Kiste" && p.gebinde_inhalt && !(a && a.fass)) return `${(a && a.gebinde) || "Kiste"} à ${p.gebinde_inhalt}`;
    return unitLabel(a, p.einheit, p.menge);
  }
  function unitLabel(a, einheit, n) {
    if (a && a.fass) return n === 1 ? "Fass" : "Fässer";
    if (einheit === "Bund/Kiste") return `${(a && a.gebinde) || "Kiste"}${a && a.gebinde_inhalt > 1 ? " à " + a.gebinde_inhalt : ""}`;
    return n === 1 ? "Flasche" : "Flaschen";
  }

  // ---------------------------------------------------------------- Ansichten
  function render() {
    const top = document.getElementById("topbar-bar");
    top.textContent = state.bar && !["setup", "bars", "boot"].includes(state.view) ? state.bar : "";
    document.getElementById("btn-switch").classList.toggle("hidden", !state.bar || ["setup", "bars", "boot"].includes(state.view));
    document.getElementById("btn-orders").classList.toggle("hidden", !state.bar || ["setup", "bars", "boot"].includes(state.view));
    document.querySelector(".bottombar") && document.querySelector(".bottombar").remove();
    ({ boot: viewBoot, setup: viewSetup, bars: viewBars, order: viewOrder, review: viewReview, sent: viewSent, orders: viewOrders })[state.view]();
    updateBadge();
  }
  function viewBoot() { $app.innerHTML = `<div class="center"><p class="sub">App wird geladen …</p></div>`; }

  function viewSetup() {
    $app.innerHTML = `<div class="center panel">
      <h1>Einrichtung</h1>
      <p class="sub">${state.codeError ? '<span class="changed">Der Zugangscode wurde nicht akzeptiert.</span> ' : ""}Bitte den Zugangscode eingeben (steht im Lagerprogramm unter Admin / Einstellungen → Bar-Bestellungen). Das ist nur einmal pro Tablet nötig.</p>
      <label>Zugangscode</label>
      <input id="code" autocomplete="off" autocapitalize="off" value="${esc(LS.get("code", ""))}">
      <div style="height:14px"></div>
      <label>Name dieses Tablets (optional)</label>
      <input id="dev" placeholder="z. B. Tablet Fan Bar 1" value="${esc(LS.get("device", ""))}">
      <div style="height:18px"></div>
      <button id="save" class="primary" style="width:100%">Speichern</button>
    </div>`;
    document.getElementById("save").onclick = async () => {
      const code = document.getElementById("code").value.trim();
      if (code.length < 4) { toast("Bitte den Zugangscode eingeben", "err"); return; }
      LS.set("code", code); LS.set("device", document.getElementById("dev").value.trim());
      state.codeError = false;
      myOrders().forEach(o => delete o.fehler);
      state.view = state.bar ? "orders" : "bars"; render(); flushOutbox();
    };
  }

  function viewBars() {
    const bars = (state.sortiment && state.sortiment.bars) || [];
    const last = LS.get("bar", "");
    $app.innerHTML = `<div class="center" style="max-width:900px">
      <h1>Welcher Bar gehörst du an?</h1>
      <p class="sub">Bitte auswählen. Die Bestellungen werden dieser Bar zugeordnet.</p>
      ${bars.length ? `<div class="bar-grid">${bars.map(b => `<button class="bar-btn ${b === last ? "last" : ""}" data-bar="${esc(b)}">${esc(b)}</button>`).join("")}</div>`
        : `<div class="panel empty">Das Sortiment ist noch nicht verfügbar.<br>Bitte im Lagerprogramm die Verbindung zu Firebase herstellen und Internet am Tablet prüfen.<br><br><button class="secondary" id="retry">Erneut versuchen</button></div>`}
      <p style="margin-top:28px"><button class="ghost" id="setup">Einrichtung (Zugangscode)</button></p>
    </div>`;
    $app.querySelectorAll(".bar-btn").forEach(b => b.onclick = () => {
      state.bar = b.dataset.bar; LS.set("bar", state.bar); sessionStorage.setItem("ot_bar_session", state.bar);
      loadDraft(); state.view = "order"; state.cat = "Alle"; state.search = ""; render();
      loadSortiment(); // immer mit dem aktuellen Sortiment bestellen
    });
    const r = document.getElementById("retry"); if (r) r.onclick = async () => { await loadSortiment(); render(); };
    document.getElementById("setup").onclick = () => { state.view = "setup"; render(); };
  }

  function stepper(code, kind, label, value) {
    return `<div class="stepper"><span class="lbl">${esc(label)}</span><div class="row">
      <button class="minus" data-code="${esc(code)}" data-k="${kind}" data-d="-1" aria-label="weniger">−</button>
      <input inputmode="numeric" pattern="[0-9]*" data-code="${esc(code)}" data-k="${kind}" value="${value || ""}" placeholder="0">
      <button class="plus" data-code="${esc(code)}" data-k="${kind}" data-d="1" aria-label="mehr">+</button></div></div>`;
  }
  function viewOrder() {
    const arts = articles();
    const cats = ["Alle", ...Array.from(new Set(arts.map(a => a.kategorie || "Sonstiges")))];
    $app.innerHTML = `
      <div class="tools">
        <input id="search" type="search" placeholder="Artikel suchen …" value="${esc(state.search)}">
        <div class="chips">${cats.map(c => `<button class="chip ${c === state.cat ? "active" : ""}" data-cat="${esc(c)}">${esc(c)}</button>`).join("")}</div>
      </div>
      <div class="list" id="list"></div>`;
    const bb = document.createElement("div"); bb.className = "bottombar"; document.body.appendChild(bb);
    renderOrderBar();
    renderList();
    const s = document.getElementById("search");
    s.oninput = () => { state.search = s.value; renderList(); };
    $app.querySelectorAll(".chip").forEach(c => c.onclick = () => {
      state.cat = c.dataset.cat;
      $app.querySelectorAll(".chip").forEach(x => x.classList.toggle("active", x === c));
      renderList(); window.scrollTo(0, 0);
    });
  }
  function renderList() {
    const arts = articles();
    const term = state.search.trim().toLowerCase();
    const shown = arts.filter(a => (state.cat === "Alle" || (a.kategorie || "Sonstiges") === state.cat) &&
      (!term || (a.name + " " + (a.groesse || "") + " " + (a.kategorie || "")).toLowerCase().includes(term)));
    const list = document.getElementById("list");
    list.innerHTML = `${shown.map(a => {
        const q = state.draft[a.code] || {};
        const has = (q.e || 0) + (q.b || 0) > 0;
        return `<div class="item ${has ? "has" : ""}" id="it-${esc(a.code)}">
          <div class="name"><b>${esc(a.name)}</b><span>${esc(a.groesse ? a.groesse + " l" : "")}${a.kategorie ? " · " + esc(a.kategorie) : ""}</span></div>
          <div class="steppers">
            ${a.fass ? stepper(a.code, "e", "Fass", q.e) : stepper(a.code, "e", "Flaschen", q.e) + stepper(a.code, "b", unitLabel(a, "Bund/Kiste"), q.b)}
          </div></div>`;
      }).join("") || `<div class="empty">Keine Artikel gefunden.</div>`}`;
    list.querySelectorAll(".stepper button").forEach(b => b.onclick = () => changeQty(b.dataset.code, b.dataset.k, parseInt(b.dataset.d, 10)));
    list.querySelectorAll(".stepper input").forEach(i => {
      i.onfocus = () => i.select();
      i.onchange = () => setQty(i.dataset.code, i.dataset.k, parseInt(i.value || "0", 10) || 0);
    });
  }
  function renderOrderBar() {
    const bb = document.querySelector(".bottombar"); if (!bb) return;
    const n = draftPositions().length;
    bb.innerHTML = `<div class="info">${n ? `<b>${n}</b> Posten ausgewählt` : "Noch nichts ausgewählt"}</div>
      <button class="secondary" id="clear" ${n ? "" : "disabled"}>Leeren</button>
      <button class="primary" id="review" ${n ? "" : "disabled"}>Bestellung prüfen</button>`;
    document.getElementById("review").onclick = () => { state.view = "review"; render(); window.scrollTo(0, 0); };
    document.getElementById("clear").onclick = () => { if (confirm("Alle eingegebenen Mengen löschen?")) { state.draft = {}; saveDraft(); renderList(); renderOrderBar(); } };
  }
  function setQty(code, k, v) {
    const q = state.draft[code] || { e: 0, b: 0 };
    q[k] = Math.max(0, Math.min(999, v));
    if (!q.e && !q.b) delete state.draft[code]; else state.draft[code] = q;
    saveDraft();
    const item = document.getElementById("it-" + code);
    if (item) {
      item.querySelectorAll(`input[data-k="${k}"]`).forEach(i => i.value = q[k] || "");
      item.classList.toggle("has", !!(q.e || q.b));
    }
    renderOrderBar();
  }
  function changeQty(code, k, d) { const q = state.draft[code] || {}; setQty(code, k, (q[k] || 0) + d); }

  function viewReview() {
    const pos = draftPositions();
    if (!pos.length) { state.view = "order"; return render(); }
    $app.innerHTML = `<h1>Bestellung prüfen</h1>
      <p class="sub">${esc(state.bar)} · ${pos.length} Posten. Bitte prüfen und dann absenden.</p>
      <table class="sum"><thead><tr><th>Artikel</th><th>Größe</th><th style="text-align:right">Menge</th></tr></thead>
      <tbody>${pos.map(p => { const a = artByCode(p.artikelcode); return `<tr><td>${esc(p.artikelname)}</td><td>${esc(p.groesse ? p.groesse + " l" : "")}</td><td class="q">${p.menge} ${esc(unitLabel(a, p.einheit, p.menge))}</td></tr>`; }).join("")}</tbody></table>
      <h2>Bemerkung (optional)</h2>
      <textarea id="note" rows="2" placeholder="z. B. „Bitte zuerst das Bier“">${esc(state.note || "")}</textarea>`;
    const bb = document.createElement("div"); bb.className = "bottombar"; document.body.appendChild(bb);
    bb.innerHTML = `<div class="info"><b>${pos.length}</b> Posten</div>
      <button class="secondary" id="back">Zurück / ändern</button>
      <button class="primary" id="send">Bestellung absenden</button>`;
    document.getElementById("note").oninput = e => state.note = e.target.value;
    document.getElementById("back").onclick = () => { state.view = "order"; render(); };
    document.getElementById("send").onclick = sendOrder;
  }
  async function sendOrder() {
    const btn = document.getElementById("send"); btn.disabled = true; btn.textContent = "Wird gesendet …";
    const id = newId();
    const data = { format: "overtime-bar-bestellung-1", id, bar: state.bar, erstellt: nowIso(),
      geraet: LS.get("device", "") || "Tablet", bemerkung: (state.note || "").trim().slice(0, 300),
      positionen: draftPositions().map(p => {
        const a = artByCode(p.artikelcode), o = { artikelcode: p.artikelcode, artikelname: p.artikelname, menge: p.menge, einheit: p.einheit };
        if (p.einheit === "Bund/Kiste" && a && a.gebinde_inhalt) o.gebinde_inhalt = a.gebinde_inhalt; // Kartongröße zum Bestellzeitpunkt
        return o;
      }) };
    const list = myOrders(); list.push({ id, data, local: "warten", status: "" }); saveOrders(list);
    state.draft = {}; saveDraft(); state.note = "";
    await flushOutbox();
    const o = myOrders().find(x => x.id === id);
    state.lastSent = o && o.local === "gesendet" ? "ok" : "warten";
    if (state.view === "review") { state.view = "sent"; render(); }
  }
  function viewSent() {
    const ok = state.lastSent === "ok";
    $app.innerHTML = `<div class="center panel" style="text-align:center">
      <div style="font-size:64px">${ok ? "✓" : "⏳"}</div>
      <h1>${ok ? "Bestellung gesendet" : "Bestellung gespeichert"}</h1>
      <p class="sub">${ok ? "Das Lager wurde benachrichtigt. Den Stand siehst du unter „Meine Bestellungen“."
        : "Gerade keine Verbindung. Die Bestellung wird automatisch gesendet, sobald wieder Internet da ist."}</p>
      <button class="primary" id="new">Neue Bestellung</button>
      <button class="secondary" id="mine" style="margin-left:8px">Meine Bestellungen</button></div>`;
    document.getElementById("new").onclick = () => { state.view = "order"; render(); };
    document.getElementById("mine").onclick = () => { state.view = "orders"; render(); };
  }
  const STATUS_TEXT = { warten: ["Wartet auf Senden", "st-warten"], gesendet: ["Gesendet", "st-gesendet"], neu: ["Im Lager eingegangen", "st-neu"],
    "in Vorbereitung": ["Wird vorbereitet", "st-vorbereitung"], beliefert: ["Beliefert", "st-beliefert"], storniert: ["Storniert", "st-storniert"] };
  function viewOrders() {
    const list = myOrders().filter(o => o.data && o.data.bar === state.bar).slice().reverse();
    $app.innerHTML = `<h1>Meine Bestellungen</h1><p class="sub">${esc(state.bar)} · der Stand wird automatisch aktualisiert.</p>
      ${list.length ? list.map(o => {
        const key = o.local === "warten" ? (o.fehler === "code" ? "fehler" : "warten") : (o.status || "gesendet");
        const st = key === "fehler" ? ["Zugangscode ungültig", "st-fehler"] : (STATUS_TEXT[key] || [key, "st-gesendet"]);
        const del = {}, delText = {};
        (o.geliefert || []).forEach(g => { del[g.artikelcode + "|" + g.einheit] = g.geliefert; if (g.geliefert_text) delText[g.artikelcode + "|" + g.einheit] = g.geliefert_text; });
        return `<div class="order"><div class="head"><b>${timeText(o.data.erstellt)} Uhr</b><span class="status ${st[1]}">${esc(st[0])}</span>
          <span style="color:var(--muted)">${o.data.positionen.length} Posten</span></div>
          <ul>${o.data.positionen.map(p => {
            const a = artByCode(p.artikelcode); const k = p.artikelcode + "|" + p.einheit;
            if (o.status === "beliefert" && delText[k])
              return `<li>${esc(p.artikelname)}: <span class="changed">${esc(delText[k])}</span> statt ${p.menge} ${esc(unitLabelPos(a, p))}</li>`;
            const chg = o.status === "beliefert" && k in del && del[k] !== p.menge;
            return `<li>${esc(p.artikelname)}: ${chg ? `<span class="changed">${del[k]} statt ${p.menge}</span>` : p.menge} ${esc(unitLabelPos(a, p))}</li>`;
          }).join("")}</ul>${o.data.bemerkung ? `<p style="color:var(--muted);margin:8px 0 0">Bemerkung: ${esc(o.data.bemerkung)}</p>` : ""}</div>`;
      }).join("") : `<div class="panel empty">Noch keine Bestellungen von diesem Tablet.</div>`}`;
    const bb = document.createElement("div"); bb.className = "bottombar"; document.body.appendChild(bb);
    bb.innerHTML = `<button class="primary" id="new">Neue Bestellung</button>`;
    document.getElementById("new").onclick = () => { state.view = "order"; render(); };
    pollStatus();
  }

  // ---------------------------------------------------------------- Start
  document.getElementById("btn-switch").onclick = () => { state.view = "bars"; render(); };
  document.getElementById("btn-orders").onclick = () => { state.view = "orders"; render(); };
  window.addEventListener("online", () => { setNet(""); flushOutbox(); });
  window.addEventListener("offline", () => setNet("Keine Internetverbindung – Bestellungen werden zwischengespeichert."));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) { loadSortiment(); flushOutbox(); pollStatus(); } });
  window.addEventListener("focus", () => loadSortiment());

  async function start() {
    render();
    if (!LS.get("code", "")) { state.view = "setup"; render(); }
    await loadSortiment();
    if (state.view === "boot") {
      // Bei jedem App-Start Bar auswählen (innerhalb derselben Sitzung bleibt sie erhalten)
      const sessBar = sessionStorage.getItem("ot_bar_session");
      if (sessBar) { state.bar = sessBar; loadDraft(); state.view = "order"; } else state.view = "bars";
      render();
    }
    flushOutbox(); pollStatus();
    setInterval(flushOutbox, 15000);
    setInterval(pollStatus, 15000);
    setInterval(async () => { await loadSortiment(); if (state.view === "bars") render(); }, 5 * 60000);
  }
  if ("serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});
  start();
})();
