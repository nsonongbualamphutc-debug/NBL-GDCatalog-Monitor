// =====================================================================
//  NBL Data Health Monitor — ตัวเก็บข้อมูลอัตโนมัติ (รันบน GitHub Actions)
//  ดึงข้อมูลจาก nongbualamphu.gdcatalog.go.th และ gdcatalog.go.th (องค์กร: จังหวัดหนองบัวลำภู)
//  แล้วบันทึกเป็นไฟล์ JSON ในโฟลเดอร์ data/ ให้แดชบอร์ดอ่าน
//  ใช้เกณฑ์ตรวจชุดเดียวกับ index.html (อ่านบล็อก CORE จาก index.html โดยตรง)
// =====================================================================
import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.env.ROOT_DIR || process.cwd();
const DATA = path.join(ROOT, 'data');
const NOW = Date.now();
const bkkDate = (t = NOW) => new Date(t + 7 * 3600e3).toISOString().slice(0, 10);
const TODAY = bkkDate();
const FORCE = process.env.FORCE === '1';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- load shared logic from index.html ----------
const html = await fs.readFile(path.join(ROOT, 'index.html'), 'utf8');
const core = html.match(/\/\*CORE-START\*\/([\s\S]*?)\/\*CORE-END\*\//)[1];
const DEF = Function('return ' + html.match(/const DEF=(\{[^;]*\});/)[1])();
const CFG = Object.assign({}, DEF);
// admin-controlled target year (data/config.json written by admin.html)
let ADM = {};
try { const ac = ADM = JSON.parse(await fs.readFile(path.join(ROOT, 'data', 'config.json'), 'utf8')); if (ac.target) { if (+ac.target.year > 2500) CFG.cur = +ac.target.year; if (+ac.target.back > 0) CFG.back = +ac.target.back; } } catch {}
const S = { orgs: {}, store: { prov: { orgs: [], raw: [], ok: false }, nat: { orgs: [], raw: [], ok: false } }, deep: {} };
const C = Function('CFG', 'S', core + '\nreturn {SRCS,analyze,scoped,ISSUES,toBE,PBI:typeof PBI!=="undefined"?PBI:{}};')(CFG, S);
const API = k => C.SRCS[k].site + '/api/3/action/';

// ---------- http ----------
async function get(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (NBL-Data-Health-Monitor; +github actions)', Accept: 'application/json' }, signal: AbortSignal.timeout(90000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      if (!j.success) throw new Error('API error');
      return j.result;
    } catch (e) { err = e; await new Promise(r => setTimeout(r, 1500 * (i + 1))); }
  }
  throw new Error(url + ' → ' + err.message);
}
async function pool(items, n, fn) {
  let i = 0; const out = [];
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } }));
  return out;
}
async function searchAll(k) {
  const fq = C.SRCS[k].fq ? '&fq=' + encodeURIComponent(C.SRCS[k].fq) : '';
  let start = 0, count = Infinity, out = [];
  while (start < count) {
    const r = await get(API(k) + 'package_search?rows=1000&start=' + start + fq + '&sort=metadata_created%20desc');
    count = r.count; out = out.concat(r.results); start += 1000; if (!r.results.length) break;
  }
  return out;
}

// ---------- file helpers ----------
async function readJSON(f, d) { try { return JSON.parse(await fs.readFile(path.join(DATA, f), 'utf8')); } catch { return d; } }
const changed = [];
async function writeJSON(f, obj) {
  const txt = JSON.stringify(obj);
  let old = null; try { old = await fs.readFile(path.join(DATA, f), 'utf8'); } catch {}
  if (old === txt) return false;
  await fs.writeFile(path.join(DATA, f), txt); changed.push(f); return true;
}
const cut = (s, n) => (s == null ? s : String(s).slice(0, n));

// ---------- trim package (keep only what the dashboard uses) ----------
function trim(p, nat) {
  const o = p.organization || {};
  const t = {
    id: p.id, name: p.name, title: p.title,
    organization: { name: o.name, title: o.title, image_url: o.image_url },
    groups: (p.groups || []).map(g => ({ title: g.title || g.display_name || g.name })),
    resources: (p.resources || []).filter(r => r.state !== 'deleted').map(r => ({
      id: r.id, name: cut(r.name, 200), description: cut(r.description, 300), format: r.format, url: r.url, url_type: r.url_type,
      created: r.created, last_modified: r.last_modified, metadata_modified: r.metadata_modified, datastore_active: !!r.datastore_active })),
    num_resources: p.num_resources, num_tags: p.num_tags,
    metadata_created: p.metadata_created, metadata_modified: p.metadata_modified, notes: cut(p.notes, 300)
  };
  for (const k of ['first_year_of_data', 'last_year_of_data', 'last_updated_date', 'data_type', 'data_format', 'update_frequency_interval', 'update_frequency_unit',
    'geo_coverage', 'maintainer', 'maintainer_email', 'data_source', 'unit_of_measure', 'license_id', 'objective']) if (p[k] != null) t[k] = p[k];
  if (nat) t.extras = (p.extras || []).filter(e => e.key === 'source_dataset_id' || e.key === 'harvest_url');
  return t;
}

// =====================================================================
await fs.mkdir(DATA, { recursive: true });
const meta = await readJSON('meta.json', {});
log('fetch provincial catalog…');
const [orgsRaw, provRaw] = await Promise.all([get(API('prov') + 'organization_list?all_fields=true&include_dataset_count=true&limit=1000'), searchAll('prov')]);
let natRaw = [], natOk = true;
try { log('fetch national catalog…'); natRaw = await searchAll('nat'); } catch (e) { natOk = false; log('national failed:', e.message); }
log(`prov ${provRaw.length} · orgs ${orgsRaw.length} · nat ${natRaw.length}`);

const orgs = orgsRaw.map(o => ({ name: o.name, title: o.title, image_url: o.image_url, image_display_url: o.image_display_url, package_count: o.package_count }));
const prov = provRaw.map(p => trim(p, false));
const nat = natOk ? natRaw.map(p => trim(p, true)) : (await readJSON('nat.json', { raw: [] })).raw;
const dataChanged = [await writeJSON('prov.json', { orgs, raw: prov }), natOk ? await writeJSON('nat.json', { raw: nat }) : false].some(Boolean);

S.store.prov = { orgs, raw: prov, ok: true };
S.store.nat = { orgs: [], raw: nat, ok: true };

// ---------- events (diff against previous state) ----------
const state = await readJSON('state.json', null);
let events = await readJSON('events.json', []);
const newState = { prov: {}, nat: {} };
for (const [k, L] of [['prov', prov], ['nat', nat]]) {
  for (const p of L) newState[k][p.id] = [p.metadata_modified, p.resources.map(r => r.id.slice(0, 8))];
  if (!state || !state[k]) continue;
  const old = state[k], byId = Object.fromEntries(L.map(p => [p.id, p]));
  for (const p of L) {
    const o = old[p.id], org = p.organization.title;
    if (!o) { events.push({ ts: NOW, src: k, type: 'new', id: p.id, title: p.title, org }); continue; }
    const had = new Set(o[1]);
    const add = p.resources.filter(r => !had.has(r.id.slice(0, 8)));
    if (add.length) events.push({ ts: NOW, src: k, type: 'imp', id: p.id, title: p.title, org, res: add.slice(0, 3).map(r => (r.name || 'ไฟล์') + ' (' + (r.format || '-') + ')').join(', ') + (add.length > 3 ? ' +' + (add.length - 3) : '') });
  }
  for (const id in old) if (!byId[id]) events.push({ ts: NOW, src: k, type: 'del', id, title: (state.titles && state.titles[id]) || id });
}
newState.titles = Object.fromEntries([...prov, ...nat].map(p => [p.id, p.title]));
events = events.slice(-1500);
await writeJSON('state.json', newState);
await writeJSON('events.json', events);

// ---------- views (tracking_summary) — every 6 h ----------
let views = await readJSON('views.json', { updatedAt: 0, map: {}, daily: {} });
if (FORCE || NOW - (views.updatedAt || 0) > 6 * 3600e3) {
  log('views…');
  const jobs = [...prov.map(p => ['prov', p.id]), ...nat.map(p => ['nat', p.id])];
  const res = await pool(jobs, 8, async ([k, id]) => { const r = await get(API(k) + 'package_show?id=' + id + '&include_tracking=true', 2); const t = r.tracking_summary || {}; return [+t.total || 0, +t.recent || 0]; });
  const map = Object.assign({}, views.map);
  jobs.forEach(([, id], i) => { if (res[i]) map[id] = res[i]; });
  const sum = L => L.reduce((a, p) => { const v = map[p.id]; return v ? [a[0] + v[0], a[1] + v[1]] : a; }, [0, 0]);
  CFG.prov = true;
  const day = {}; for (const k of ['prov', 'nat']) { day[k] = sum(C.scoped(k).raw); day[k + '_all'] = sum(k === 'prov' ? prov : nat); }
  views = { updatedAt: NOW, map, daily: Object.assign({}, views.daily, { [TODAY]: day }) };
  const keys = Object.keys(views.daily).sort(); keys.slice(0, Math.max(0, keys.length - 730)).forEach(d => delete views.daily[d]);
  await writeJSON('views.json', views);
}

// ---------- deep content check (DataStore) — daily ----------
let deep = await readJSON('deep.json', { updatedAt: 0, map: {} });
if (FORCE || NOW - (deep.updatedAt || 0) > 20 * 3600e3) {
  log('deep check…');
  // ตรวจทุกชุดข้อมูล (รวมระดับกรม) และลองเรียกไฟล์ตารางทุกไฟล์ เพราะสถานะ datastore_active เชื่อไม่ได้เสมอ
  const R = []; for (const p of prov) for (const r of p.resources || []) if (r.datastore_active || /^(csv|xlsx?|tsv)$/i.test(String(r.format || '').trim())) R.push(r.id);
  const YEAR_COL = /(^|[^a-z])(year|yr|fiscal)|ปี|พ\.?ศ/i;
  const out = await pool(R, 6, async id => {
    let a; try { a = await get(API('prov') + 'datastore_search?resource_id=' + id + '&limit=0', 1); } catch { return null; }
    const fields = (a.fields || []).filter(f => f.id !== '_id');
    const names = fields.map(f => f.id);
    const enc = !names.some(n => /Ã|à¸|à¹|�/.test(n));
    const yc = names.find(n => YEAR_COL.test(n)) || null;
    let ys = [], yok = false;
    if (yc) {
      try {
        const b = await get(API('prov') + 'datastore_search?resource_id=' + id + '&fields=' + encodeURIComponent(yc) + '&distinct=true&limit=500', 2);
        const set = new Set();
        for (const rec of b.records || []) { const m = String(rec[yc] ?? '').match(/(25\d\d|20\d\d)/g) || []; m.forEach(x => { const y = C.toBE(x); if (y && y <= CFG.cur + 1) set.add(y); }); }
        ys = [...set].sort(); yok = true;
      } catch {}
    }
    // ถ้าอ่านค่าปีไม่สำเร็จ ไม่นับว่ามีคอลัมน์ปี (กันการแจ้งเตือนผิด)
    return { n: a.total || 0, f: fields.length, yc: yok ? yc : null, ys, enc };
  });
  const map = {}; R.forEach((id, i) => { if (out[i]) map[id] = out[i]; });
  deep = { updatedAt: NOW, map };
  await writeJSON('deep.json', deep);
}
S.deep = deep.map || {};

// ---------- ตรวจ resource ที่รายงาน Power BI ใช้ (วันละครั้ง) ----------
let pbic = await readJSON('pbi_check.json', { updatedAt: 0, map: {} });
if (FORCE || bkkDate(pbic.updatedAt || 0) !== TODAY) {
  const items = [];
  for (const P of Object.values(C.PBI || {})) for (const r of P.rows || []) for (const x of r.s || []) if (x.k === 'api' && x.r && x.h) items.push([x.h, x.r]);
  const uniq = [...new Map(items.map(i => [i[1], i])).values()];
  log('pbi check', uniq.length, 'resources');
  const out = await pool(uniq, 4, async ([h, rid]) => {
    try { const a = await get('https://' + h + '/api/3/action/datastore_search?resource_id=' + rid + '&limit=0', 1); return { t: a.total ?? null }; }
    catch (e) { return { e: /404|not found|API error/i.test(e.message) ? 'gone' : 'err' }; }
  });
  const map = {}; uniq.forEach(([, rid], i) => { if (out[i]) map[rid] = out[i]; });
  pbic = { updatedAt: NOW, map };
  await writeJSON('pbi_check.json', pbic);
}

// ---------- daily history of compliance ----------
const history = await readJSON('history.json', []);
function stats(k, provOnly = true) {
  CFG.prov = provOnly;
  const sc = C.scoped(k); S.orgs = sc.orgs;
  const D = sc.raw.map(C.analyze), n = D.length, c = f => D.filter(f).length;
  const orgsOut = {};
  for (const d of D) { const o = orgsOut[d.org] = orgsOut[d.org] || [0, 0, 0, 0]; o[0]++; if (d.status === 'pass') o[1]++; o[2] += d.score; o[3] += d.md; }
  for (const k2 in orgsOut) { const o = orgsOut[k2]; orgsOut[k2] = [o[0], o[1], Math.round(o[2] * 1000 / (o[0] * 3)) / 10, Math.round(o[3] / o[0])]; }
  const issues = {}; for (const I of C.ISSUES) { const L = D.filter(d => d.groups.includes(I.g)); issues[I.g] = [L.length, L.filter(d => d.status === 'pass').length]; }
  return { n, pass: c(d => d.status === 'pass'), c1: c(d => d.c1), c2: c(d => d.c2), c3: c(d => d.c3), api: c(d => d.chan.api > 0), dsx: c(d => d.dsx > 0),
    md: n ? Math.round(D.reduce((a, d) => a + d.md, 0) / n) : 0, late: c(d => d.sched === 'late'), mism: c(d => d.mism), orgs: orgsOut, issues };
}
const entry = { d: TODAY, cfg: [CFG.cur, CFG.back], prov: stats('prov'), prov_all: stats('prov', false) };
if (nat.length) entry.nat = stats('nat');
const hi = history.findIndex(h => h.d === TODAY);
if (hi >= 0) history[hi] = entry; else history.push(entry);
history.sort((a, b) => a.d < b.d ? -1 : 1);
await writeJSON('history.json', history.slice(-1100));

// ---------- round archive: บันทึกผลสุดท้ายเมื่อพ้นวันกำหนดส่งของแต่ละรอบ ----------
{
  const rounds = (ADM.rounds || []).filter(r => r && r.id && r.due && r.on !== false);
  let arch = await readJSON('rounds.json', []); if (!Array.isArray(arch)) arch = [];
  let add = 0;
  for (const r of rounds) {
    const end = Date.parse(r.due + 'T23:59:59+07:00');
    if (!(NOW > end) || arch.some(a => a.id === r.id)) continue;
    CFG.prov = false; const sc = C.scoped('prov'); S.orgs = sc.orgs; const D = sc.raw.map(C.analyze);
    arch.push({ id: r.id, name: r.name || r.id, year: r.year || CFG.cur, open: r.open || '', due: r.due, closedAt: NOW, cfg: [CFG.cur, CFG.back],
      prov: entry.prov, prov_all: entry.prov_all,
      ds: D.map(d => [d.id, d.org, d.lvl === 'prov' ? 1 : 0, d.status === 'pass' ? 1 : 0, +d.c1, +d.c2, +d.c3, d.md, d.title]) });
    add++; log('archived round', r.id);
  }
  if (add) await writeJSON('rounds.json', arch);
}

// ---------- meta ----------
if (changed.length || !meta.generatedAt) {
  await writeJSON('meta.json', { generatedAt: NOW, ok: { prov: true, nat: natOk }, counts: { prov: prov.length, nat: nat.length }, viewsAt: views.updatedAt || 0, deepAt: deep.updatedAt || 0, dataChanged });
}
log('changed:', changed.join(', ') || '(none)');
