// aconso HR Document Box -> a folder (e.g. a Paperless consume dir).
// Logs in through the UI5 form (the direct API login needs a CSRF token the
// browser sets up), then lists + downloads documents via the REST API.
// Credentials are read from a mounted file, NOT docker env — passwords may
// contain `$`, which docker-compose mangles as variable interpolation.
import { chromium } from "playwright";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";

const HOST = process.env.HRBOX_HOST;                 // e.g. yourcompany.hr-document-box.com
if (!HOST) { console.error("HRBOX_HOST not set"); process.exit(2); }
const BASE = `https://${HOST}`;
const LOGIN_URL = `${BASE}/ui5/apps/documentboxui5/login.html`;
const OUT = "/out";
const STATE = "/state/seen.json";
const DEBUG = process.env.DEBUG === "1";

const creds = Object.fromEntries(
  readFileSync("/creds", "utf8").split("\n").filter(l => l.includes("=")).map(l => {
    const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1)];
  })
);
const USER = creds.HRBOX_USER, PASS = creds.HRBOX_PASSWORD;
if (!USER || !PASS) { console.error("HRBOX_USER / HRBOX_PASSWORD missing in /creds"); process.exit(2); }

mkdirSync(OUT, { recursive: true });
mkdirSync("/state", { recursive: true });
const seen = existsSync(STATE) ? new Set(JSON.parse(readFileSync(STATE))) : new Set();
const log = (...a) => console.log(new Date().toISOString(), ...a);

// Optional push notifications via ntfy (https://ntfy.sh or a self-hosted server).
const NTFY_URL = (process.env.NTFY_URL || "").replace(/\/$/, "");
const NTFY_TOPIC = process.env.NTFY_TOPIC || "hrbox";
const NTFY_TOKEN = process.env.NTFY_TOKEN || "";
const notify = async (ctx, title, msg, prio = "default") => {
  if (!NTFY_URL) return;
  const headers = { Title: title, Priority: prio, Tags: "briefcase" };
  if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;
  try { await ctx.post(`${NTFY_URL}/${NTFY_TOPIC}`, { headers, data: msg }); } catch {}
};

const run = async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  log("Login…");
  await page.goto(LOGIN_URL, { waitUntil: "networkidle", timeout: 60000 });

  const userField = page.locator('input[type="email"]').first();
  const passField = page.locator('input[type="password"]').first();
  await userField.waitFor({ timeout: 30000 });
  // UI5 reads from its own model, not the DOM — set values via the UI5 API so
  // the submit handler sees them (fill()/typing alone is not picked up).
  await page.evaluate(({ user, pass }) => {
    const core = sap.ui.getCore();
    const byInner = (s) => { const el = document.querySelector(`input[id$="${s}"]`); return el && core.byId(el.id.replace(/-inner$/, "")); };
    const e = byInner("Input-Email_-inner"), p = byInner("Input-Password_-inner");
    e.setValue(user); e.fireChange({ value: user });
    p.setValue(pass); p.fireChange({ value: pass });
  }, { user: USER, pass: PASS });
  await page.locator('[id$="_Login-Button-Login_"]').click();
  await userField.waitFor({ state: "detached", timeout: 30000 }).catch(() => {});
  if (await userField.count() > 0) { await notify(page.request, "HR box: login failed", "Check credentials.", "high"); throw new Error("Login rejected"); }
  log("Login ok");

  const api = page.request;   // carries the session cookie
  const res = await api.get(`${BASE}/api/v1/internal/documents?page=0&size=200`);
  const dj = await res.json();
  if (DEBUG) writeFileSync("/state/documents.json", JSON.stringify(dj, null, 2));
  const docs = dj.documents || dj.results || dj.data || dj.items || dj.rows || [];
  log(`Documents reported: ${dj.totalCount ?? "?"} (list: ${docs.length})`);
  if (!docs.length) { await notify(api, "HR box: empty list", "Login ok but documents[] empty — check structure (DEBUG=1).", "high"); await browser.close(); return; }

  let neu = 0;
  for (const d of docs) {
    const id = d.FILE_INDEX;
    // filename: ISO date + folder + name, all from the document metadata
    const raw = `${(d.ATT_DOC_DATE || "").split(".").reverse().join("-")} ${d.ATT_FOLDER_DESCRIPTION || ""} ${d.ATT_NAME || id}`;
    const name = raw.replace(/[\/\\]/g, "-").replace(/[^\w.\- ]/g, "_").replace(/\s+/g, " ").trim();
    if (id == null || seen.has(String(id))) continue;
    const dl = await api.get(`${BASE}/api/v1/internal/documents/${id}/pdf`);
    const ct = dl.headers()["content-type"] || "";
    if (!dl.ok() || !/pdf/i.test(ct)) { log(`No PDF for ${id} (${dl.status()} ${ct})`); continue; }
    writeFileSync(`${OUT}/${name}.pdf`, await dl.body());
    seen.add(String(id)); neu++;
    log(`Downloaded: ${name}.pdf`);
  }
  writeFileSync(STATE, JSON.stringify([...seen]));
  await browser.close();
  log(`Done. New documents: ${neu}`);
  if (neu > 0) await notify(api, "HR box: new documents", `${neu} new document(s) downloaded.`);
};

run().catch((e) => { log("ERROR:", e.message); process.exit(1); });
