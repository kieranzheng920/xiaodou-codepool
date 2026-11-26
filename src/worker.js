// 小豆邀请码 · 公共码池
// Cloudflare Worker + D1。前端页面与接口在同一个文件里。

const DAY = 24 * 60 * 60 * 1000;
const CODE_TTL = 3 * DAY;              // 邀请码默认 3 天后过期
const LIMITS = {
  give:     { max: 10, window: 60 * 60 * 1000 }, // 每人每小时最多投 10 个
  claim:    { max: 3,  window: DAY },            // 每人每天最多领 3 个
  feedback: { max: 30, window: 60 * 60 * 1000 },
};
const CODE_RE = /^[A-Z0-9]{6}$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/" && request.method === "GET") {
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      }
      if (url.pathname.startsWith("/api/")) return await api(request, env, url);
      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ ok: false, msg: "服务器开小差了，稍后再试" }, 500);
    }
  },
};

async function api(request, env, url) {
  const db = env.DB;
  const now = Date.now();
  const who = await hashIp(request, env);

  // 顺手清理：过期的码、被多人反馈已用的码
  await db.prepare(
    "UPDATE codes SET status='dead' WHERE status='available' AND (expires_at <= ? OR used_votes >= 2)"
  ).bind(now).run();

  if (url.pathname === "/api/stats" && request.method === "GET") {
    const r = await db.prepare(
      `SELECT
         SUM(CASE WHEN status='available' THEN 1 ELSE 0 END) AS available,
         SUM(CASE WHEN claimed_at >= ? THEN 1 ELSE 0 END)    AS claimed_today,
         COUNT(*)                                             AS total
       FROM codes`
    ).bind(now - DAY).first();
    return json({ ok: true, available: r.available || 0, claimed_today: r.claimed_today || 0, total: r.total || 0 });
  }

  if (url.pathname === "/api/recent" && request.method === "GET") {
    const { results } = await db.prepare(
      "SELECT code, note, status, created_at, claimed_at, ok_votes, used_votes FROM codes ORDER BY id DESC LIMIT 20"
    ).all();
    return json({
      ok: true,
      items: results.map((c) => ({
        code: c.code.slice(0, 2) + "**" + c.code.slice(4), // 打码显示
        note: c.note,
        status: c.status,
        created_at: c.created_at,
        claimed_at: c.claimed_at,
        ok_votes: c.ok_votes,
        used_votes: c.used_votes,
      })),
    });
  }

  if (url.pathname === "/api/give" && request.method === "POST") {
    const body = await readJson(request);
    const codes = String(body.codes || "")
      .toUpperCase()
      .split(/[\s,，;；、]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const note = String(body.note || "").slice(0, 40);
    if (!codes.length) return json({ ok: false, msg: "请填入邀请码" }, 400);
    const bad = codes.filter((c) => !CODE_RE.test(c));
    if (bad.length) return json({ ok: false, msg: `格式不对：${bad.join("、")}（应为 6 位字母或数字）` }, 400);
    if (codes.length > LIMITS.give.max) return json({ ok: false, msg: `一次最多投 ${LIMITS.give.max} 个` }, 400);
    if (!(await allow(db, who, "give", now, codes.length)))
      return json({ ok: false, msg: "投得太快啦，一小时后再来" }, 429);

    let added = 0, dup = 0;
    for (const c of codes) {
      const r = await db.prepare(
        "INSERT OR IGNORE INTO codes (code, note, created_at, expires_at, donor) VALUES (?, ?, ?, ?, ?)"
      ).bind(c, note, now, now + CODE_TTL, who).run();
      if (r.meta.changes) { added++; await log(db, who, "give", now); } else dup++;
    }
    return json({ ok: true, added, dup, msg: `感谢！收入 ${added} 个${dup ? `，${dup} 个已在池里` : ""}` });
  }

  if (url.pathname === "/api/claim" && request.method === "POST") {
    if (!(await allow(db, who, "claim", now, 1)))
      return json({ ok: false, msg: `每人每天最多领 ${LIMITS.claim.max} 个，把机会留给别人吧` }, 429);
    // 原子领取：同一个码绝不会发给两个人；不领自己投的码
    const row = await db.prepare(
      `UPDATE codes SET status='claimed', claimed_at=?, claimer=?
       WHERE id = (
         SELECT id FROM codes
         WHERE status='available' AND expires_at > ? AND donor != ?
         ORDER BY created_at ASC LIMIT 1
       ) AND status='available'
       RETURNING code, note, expires_at`
    ).bind(now, who, now, who).first();
    if (!row) return json({ ok: false, msg: "码池暂时空了，过会儿再来，或者先投一个吧" }, 404);
    await log(db, who, "claim", now);
    return json({ ok: true, code: row.code, note: row.note, expires_at: row.expires_at });
  }

  if (url.pathname === "/api/feedback" && request.method === "POST") {
    const body = await readJson(request);
    const code = String(body.code || "").toUpperCase();
    const result = body.result === "ok" ? "ok" : "used";
    if (!CODE_RE.test(code)) return json({ ok: false, msg: "邀请码格式不对" }, 400);
    if (!(await allow(db, who, "feedback", now, 1))) return json({ ok: false, msg: "操作太频繁" }, 429);
    const col = result === "ok" ? "ok_votes" : "used_votes";
    await db.prepare(`UPDATE codes SET ${col} = ${col} + 1 WHERE code = ?`).bind(code).run();
    await log(db, who, "feedback", now);
    return json({ ok: true, msg: result === "ok" ? "太好了，恭喜上车！" : "收到，已记下，再领一个试试" });
  }

  return json({ ok: false, msg: "Not found" }, 404);
}

async function allow(db, who, kind, now, n) {
  const { max, window } = LIMITS[kind];
  const r = await db.prepare("SELECT COUNT(*) AS c FROM actions WHERE who=? AND kind=? AND at>?")
    .bind(who, kind, now - window).first();
  return (r.c || 0) + n <= max;
}
const log = (db, who, kind, at) =>
  db.prepare("INSERT INTO actions (who, kind, at) VALUES (?, ?, ?)").bind(who, kind, at).run();

async function hashIp(request, env) {
  const ip = request.headers.get("cf-connecting-ip") || "0.0.0.0";
  const data = new TextEncoder().encode(ip + (env.SALT || "xiaodou"));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].slice(0, 12).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// ---------------- 前端页面 ----------------
const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>小豆邀请码 · 公共码池</title>
<style>
  :root{--bg:#f6f4ef;--card:#fff;--ink:#1f1d1a;--muted:#8a857c;--accent:#ff6b3d;--ok:#1e9e6a;--line:#ece8e0}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
  .wrap{max-width:560px;margin:0 auto;padding:28px 18px 60px}
  h1{font-size:28px;margin:0 0 4px}
  .sub{color:var(--muted);margin:0 0 20px}
  .stats{display:flex;gap:10px;margin-bottom:18px}
  .stat{flex:1;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;text-align:center}
  .stat b{display:block;font-size:24px}
  .stat span{color:var(--muted);font-size:13px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:18px;padding:20px;margin-bottom:16px}
  .card h2{font-size:18px;margin:0 0 12px}
  button{border:0;border-radius:12px;padding:13px 18px;font-size:16px;font-weight:600;cursor:pointer;width:100%}
  .primary{background:var(--accent);color:#fff}
  .ghost{background:#f1eee8;color:var(--ink)}
  button:disabled{opacity:.5}
  textarea,input{width:100%;border:1px solid var(--line);border-radius:12px;padding:12px;font-size:16px;font-family:inherit;margin-bottom:10px;background:#fcfbf9}
  .code{font:700 38px/1.2 ui-monospace,Menlo,monospace;letter-spacing:8px;text-align:center;padding:14px;border:2px dashed var(--accent);border-radius:14px;margin:12px 0;user-select:all}
  .row{display:flex;gap:8px}
  .row button{flex:1}
  .msg{min-height:22px;color:var(--muted);font-size:14px;margin-top:8px}
  .hidden{display:none}
  ol{padding-left:20px;margin:0}
  li{margin-bottom:6px}
  .list{list-style:none;padding:0;margin:0}
  .list li{display:flex;justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0;font-size:14px}
  .tag{font-size:12px;padding:2px 8px;border-radius:99px;background:#f1eee8;color:var(--muted)}
  .tag.available{background:#e6f6ee;color:var(--ok)}
  .tag.claimed{background:#fff0ea;color:var(--accent)}
  footer{color:var(--muted);font-size:12px;text-align:center;margin-top:24px}
</style>
</head>
<body>
<div class="wrap">
  <h1>小豆邀请码 · 码池</h1>
  <p class="sub">有码投一个，没码领一个。一人一码，领走即下架。</p>

  <div class="stats">
    <div class="stat"><b id="sAvail">–</b><span>池中可领</span></div>
    <div class="stat"><b id="sToday">–</b><span>24 小时内领走</span></div>
    <div class="stat"><b id="sTotal">–</b><span>累计投入</span></div>
  </div>

  <div class="card">
    <h2>🎟️ 领一个邀请码</h2>
    <button class="primary" id="btnClaim">立即领取</button>
    <div id="got" class="hidden">
      <div class="code" id="gotCode"></div>
      <div class="row">
        <button class="ghost" id="btnCopy">复制</button>
        <button class="ghost" id="btnOk">✅ 能用</button>
        <button class="ghost" id="btnUsed">❌ 已被用</button>
      </div>
    </div>
    <div class="msg" id="claimMsg"></div>
  </div>

  <div class="card">
    <h2>🎁 投入邀请码</h2>
    <textarea id="giveCodes" rows="3" placeholder="填入 6 位邀请码，多个用空格或换行隔开"></textarea>
    <input id="giveNote" maxlength="40" placeholder="留言（选填），如：祝早日上车">
    <button class="primary" id="btnGive">投入码池</button>
    <div class="msg" id="giveMsg"></div>
  </div>

  <div class="card">
    <h2>📖 怎么用</h2>
    <ol>
      <li>打开小豆 App 并登录，进入等候名单页。</li>
      <li>点「我有邀请码，马上去体验」，把 6 位码填进格子，点确定。</li>
      <li>用上后去小豆「设置」里找自己的邀请码，回来投一个，传下去。</li>
      <li>码会被抢，领到请马上用；提示已被使用，点「已被用」再领一个。</li>
    </ol>
  </div>

  <div class="card">
    <h2>🕒 最近动态</h2>
    <ul class="list" id="recent"><li>加载中…</li></ul>
  </div>

  <footer>非官方 · 由用户自发分享 · 邀请码 3 天后自动下架</footer>
</div>
<script>
const $ = (id) => document.getElementById(id);
const post = (p, b) => fetch(p, {method:"POST", headers:{"content-type":"application/json"}, body: JSON.stringify(b||{})}).then(r=>r.json());
const ago = (t) => { const m = Math.round((Date.now()-t)/60000); return m<1?"刚刚":m<60?m+" 分钟前":m<1440?Math.round(m/60)+" 小时前":Math.round(m/1440)+" 天前"; };
const label = {available:"可领", claimed:"已领走", dead:"已失效"};
let current = "";

async function refresh(){
  const s = await fetch("/api/stats").then(r=>r.json());
  if (s.ok){ $("sAvail").textContent=s.available; $("sToday").textContent=s.claimed_today; $("sTotal").textContent=s.total; }
  const r = await fetch("/api/recent").then(r=>r.json());
  if (r.ok){
    $("recent").innerHTML = r.items.length ? r.items.map(i =>
      '<li><span>'+i.code+(i.note?' · '+i.note.replace(/[<>&]/g,""):"")+'</span><span><span class="tag '+i.status+'">'+label[i.status]+'</span> '+ago(i.claimed_at||i.created_at)+'</span></li>'
    ).join("") : "<li>还没有人投码，做第一个吧</li>";
  }
}

$("btnClaim").onclick = async () => {
  $("btnClaim").disabled = true; $("claimMsg").textContent = "领取中…";
  const r = await post("/api/claim");
  $("btnClaim").disabled = false;
  if (r.ok){
    current = r.code; $("gotCode").textContent = r.code; $("got").classList.remove("hidden");
    $("claimMsg").textContent = "到手！赶紧去小豆里填" + (r.note ? " · 投码人留言：" + r.note : "");
  } else $("claimMsg").textContent = r.msg;
  refresh();
};
$("btnCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(current); $("claimMsg").textContent = "已复制 " + current; }
  catch { $("claimMsg").textContent = "长按邀请码即可复制"; }
};
$("btnOk").onclick = async () => { const r = await post("/api/feedback",{code:current,result:"ok"}); $("claimMsg").textContent = r.msg; };
$("btnUsed").onclick = async () => { const r = await post("/api/feedback",{code:current,result:"used"}); $("claimMsg").textContent = r.msg; };
$("btnGive").onclick = async () => {
  $("btnGive").disabled = true;
  const r = await post("/api/give",{codes:$("giveCodes").value, note:$("giveNote").value});
  $("btnGive").disabled = false; $("giveMsg").textContent = r.msg;
  if (r.ok){ $("giveCodes").value=""; refresh(); }
};
refresh(); setInterval(refresh, 30000);
</script>
</body>
</html>`;
