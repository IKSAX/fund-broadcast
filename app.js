/* =========================================================
 * 重点基金净值播报 - 前端逻辑（数据来自 data.json，与界面分离）
 * 颜色约定：红涨绿跌（A股习惯），全站统一
 * 播报格式：与理财经理现有群发格式一致（🔥💰📊🎯🗣️💡⏳⚠️）
 * ======================================================= */

/* ---------- 工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const fmtPct = (v, { sign = true, trimZero = false, plain = false } = {}) => {
  if (v === null || v === undefined) return "—";
  const s = sign && v > 0 ? "+" : "";
  const t = trimZero ? v.toFixed(2).replace(/\.?0+$/, "") : v.toFixed(2);
  return plain ? s + t : s + t + "%";
};
/* 债基日波动通常在 ±0.0x%，±0.1% 以内视为"平稳"，不触发上涨/下跌话术 */
const FLAT_BAND = 0.1;
const fmtSign = (v) => (v > FLAT_BAND ? "up" : v < -FLAT_BAND ? "down" : "flat");

function showToast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 1600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    // 兼容非 HTTPS / 旧浏览器
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  }
}

/* 稳定哈希：保证同一天同一基金话术固定、不同基金话术不同 */
function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

/* ---------- 理财经理话术（对齐用户群发模板：市场速览开头 + 短名 + 近6月回撤 + 持有期 + 业绩 + 鼓励买入） ---------- */
function genManagerScript(fund, marketBrief) {
  const short = fund.shortName || fund.name;
  const dd6 = Math.abs(fund.maxDrawdown6m ?? fund.maxDrawdown1y ?? 0).toFixed(2);
  const lockup = fund.scriptLockup || fund.lockupDesc || "申赎安排请以基金公告为准。";
  const invest = "它只投纯债，不碰股票，所以股市再怎么跌，都不会直接连累它。";
  const y1 = fmtPct(fund.y1, { plain: true, trimZero: true, sign: false });
  const perf = fund.rankNote
    ? `近1年涨幅${y1}%，${fund.rankNote}，在纯债里表现是比较靠前的。`
    : `近1年涨幅${y1}%，稳健属性在纯债里比较突出。`;
  const hot = marketBrief ? `${marketBrief}` : "";

  return `${hot}XXX，如果您有一笔钱短期不用，又觉得放活期或买理财收益太薄，可以看看这只${short}。${invest}近6个月最大回撤才${dd6}%左右，净值走势非常平稳。${lockup}${perf}有短期不用的闲钱，可以考虑把它安排起来。`;
}

/* ---------- 播报文本（与理财经理现有群发格式一致） ---------- */
function fundBroadcast(fund, marketBrief, dateKey) {
  const d = fund.dailyChange ?? 0;
  const sign = fmtSign(d);
  const chg = (d > 0 ? "+" : "") + d.toFixed(2) + "%";
  const emoji = sign === "up" ? "❤️" : sign === "down" ? "💚" : "⚖️";
  const mmdd = (fund.navDate || "").slice(5).replace("-", ".");
  const dd = fmtPct(fund.maxDrawdown6m ?? fund.maxDrawdown1y, { plain: true, trimZero: true });

  const lines = [
    `🔥${fund.name}（${fund.code}）—— ${fund.tagline || "稳健之选"}`,
    `💯 净值播报：${fund.nav}（${mmdd}）`,
    `${emoji} 当日涨跌：${chg}`,
    `💰近1月年化${fmtPct(fund.ann1m, { plain: true })}%；近3月年化${fmtPct(fund.ann3m, { plain: true })}%；近6月年化${fmtPct(fund.ann6m, { plain: true })}%`,
    `📊近6个月最大回撤仅约${dd}%`,
  ];
  if (fund.investDesc) lines.push(`🎯投向：${fund.investDesc}`);
  lines.push(`🗣️理财经理话术：\n${genManagerScript(fund, marketBrief)}`);
  if (fund.feeDesc) lines.push(`💡${fund.feeDesc}`);
  if (fund.lockupDesc) lines.push(`⏳${fund.lockupDesc}`);
  lines.push(`⚠️风险提示：${fund.riskNote || "本基金受利率及信用风险影响，基金净值仍会有波动，不保证本金不受损失。市场有风险，投资须谨慎。"}`);
  return lines.join("\n");
}

/* ---------- 渲染 ---------- */
const PERIODS = [
  ["w1", "近一周"],
  ["m1", "近一月"],
  ["m3", "近三月"],
  ["m6", "近半年"],
];

let DATA = null;

function render() {
  const grid = $("#fundGrid");
  const marketBrief = DATA.marketBrief || "";
  const dateKey = DATA.generatedAt.slice(0, 10);
  const today = new Date().toISOString().slice(0, 10);

  grid.innerHTML = "";
  DATA.funds.forEach((fund) => {
    const tone = toneOf(fund.dailyChange);
    const cls = { up: "c-up", down: "c-down", flat: "c-flat" }[tone];
    const stale = fund.navDate !== today;

    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = `
      <div class="card-head">
        <div>
          <div class="fund-name">${fund.name}</div>
          <div class="fund-code">${fund.code}${fund.tagline ? ` ｜ ${fund.tagline}` : ""}</div>
        </div>
        <div class="date-chip ${stale ? "stale" : ""}"
             title="${stale ? "该基金净值尚未更新到今天，请注意核对" : "净值已更新至今天"}">
          数据日期 ${fund.navDate}${stale ? " ⚠️" : ""}
        </div>
      </div>
      <div class="nav-row">
        <span class="nav-value ${cls}">${fund.nav}</span>
        <span class="nav-change ${cls}">${fmtPct(fund.dailyChange)}</span>
      </div>
      <div class="period-row">
        ${PERIODS.map(([k, label]) => `
          <div class="period-cell">
            <div class="period-label">${label}</div>
            <div class="period-value ${cls}">${fmtPct(fund[k])}</div>
          </div>`).join("")}
      </div>
      <div class="period-row ann-row">
        <div class="period-cell">
          <div class="period-label">近1月年化</div>
          <div class="period-value">${fmtPct(fund.ann1m)}</div>
        </div>
        <div class="period-cell">
          <div class="period-label">近3月年化</div>
          <div class="period-value">${fmtPct(fund.ann3m)}</div>
        </div>
        <div class="period-cell">
          <div class="period-label">近6月年化</div>
          <div class="period-value">${fmtPct(fund.ann6m)}</div>
        </div>
        <div class="period-cell">
          <div class="period-label">近1年涨幅</div>
          <div class="period-value">${fmtPct(fund.y1)}</div>
        </div>
      </div>
      <div class="dd-row">
        <span class="dd-note" title="计算区间（近一年）：${fund.ddRange || "—"}">近一年最大回撤</span>
        <span class="dd-value">${fmtPct(fund.maxDrawdown1y)}</span>
        <span style="color:var(--text-sub)">（峰值→谷值：${fund.ddRange || "—"}）</span>
      </div>
      <div class="script-box">
        <div class="script-text">${genManagerScript(fund, marketBrief)}</div>
      </div>
      <div class="card-foot">
        <button class="btn btn-mini btn-copy-one">📋 复制该基金播报</button>
      </div>
    `;
    card.querySelector(".btn-copy-one").addEventListener("click", async () => {
      const ok = await copyText(fundBroadcast(fund, marketBrief, dateKey));
      showToast(ok ? "已复制" : "复制失败，请手动选择文本");
    });
    grid.appendChild(card);
  });
}

function toneOf(dailyChange) {
  const s = fmtSign(dailyChange);
  return s === "up" ? "up" : s === "down" ? "down" : "flat";
}

/* ---------- 启动 ---------- */
async function init() {
  try {
    const res = await fetch("data.json?t=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    DATA = await res.json();
  } catch (e) {
    // file:// 直接双击打开时浏览器禁止 fetch 本地 json，降级读取 data.js 注入的数据
    if (window.__FUND_DATA__) {
      DATA = window.__FUND_DATA__;
    } else {
      $("#fundGrid").innerHTML =
        `<div class="loading">数据加载失败（${e.message}）。<br>` +
        `请确认 data.json 与 data.js 和页面在同一目录；或运行 <code>python3 fetch_data.py</code> 重新生成。</div>`;
      return;
    }
  }

  $("#dataDate").textContent = `数据更新于 ${DATA.generatedAt}`;
  if (DATA.marketBrief) $("#marketNews").textContent = `📰 ${DATA.marketBrief}`;
  $("#btnCopyAll").disabled = false;

  $("#btnCopyAll").addEventListener("click", async () => {
    const marketBrief = DATA.marketBrief || "";
    const dateKey = DATA.generatedAt.slice(0, 10);
    const head = `📣 重点基金净值播报（${DATA.generatedAt.slice(5, 10).replace("-", ".")}）`;
    const body = DATA.funds.map((f) => fundBroadcast(f, marketBrief, dateKey)).join("\n\n");
    const ok = await copyText(head + "\n\n" + body + "\n");
    showToast(ok ? "已复制全部播报" : "复制失败，请手动选择文本");
  });

  render();
}

init();
