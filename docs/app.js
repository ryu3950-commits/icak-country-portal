// app.js (Fix)
// - 분기 드롭다운에 currency/note 뜨는 문제 방지(YYYYQ#만 허용)
// - countrydata.json이 국가객체(ARE/VNM)가 아니어도 자동 정규화
// - 단가 없을 때 0이 아니라 "—"로 표시
// - 인건비 계산의 "참고" 문구 제거
// - 시작화면 중동 확대

const MAP_STYLE = "https://demotiles.maplibre.org/style.json";

function u(path) {
  return new URL(path, window.location.href).toString();
}

const GEOJSON_URLS = [
  u("./data/countries.geojson"),
  u("./countries.geojson"),
  u("./country-demo/data/countries.geojson"),
  u("./docs/data/countries.geojson"),
];

const DATA_URLS = [
  u("./data/countrydata.json"),
  u("./data/countryData.json"),
  u("./countrydata.json"),
  u("./countryData.json"),
  u("./country-demo/data/countrydata.json"),
  u("./country-demo/data/countryData.json"),
  u("./docs/data/countrydata.json"),
  u("./docs/data/countryData.json"),
];

const infoTitle = document.getElementById("infoTitle");
const infoBody = document.getElementById("infoBody");

const searchInput = document.getElementById("searchInput");
const clearBtn = document.getElementById("clearBtn");
const searchBtn = document.getElementById("searchBtn");
const advancedBtn = document.getElementById("advancedBtn");

let map;
let countriesGeo = null;
let countryData = {}; // { ARE: {...}, ... }

let selectedISO = null;
let selectedIsoRaw = "UNK";
let selectedFID = null;
let selectedName = null;

let view = "costs"; // costs | matcalc | laborcalc | nonwork

// 자재비 계산 상태
let matCalcState = {
  period: "",
  qty: {
    brent_bbl: "",
    lng_mmbtu: "",
    copper_t: "",
    aluminum_t: "",
    rebar_t: "",
    cement_t: "",
  }
};

// 인건비 계산 상태(올해)
let laborCalcState = {
  year: new Date().getFullYear(),
  uaeDailyUSD: "",
  korDailyUSD: "",
  robotAnnualUsdPerM2: 59.76,
  laborAnnualUsdPerM2: 21.07,
  applyRamadan: true,
  applyPrayerLoss: true,
  overtimePremium: 1.25,
  areaM2: "",
};

//
// ============== helpers ==============
//
const PERIOD_RE = /^(\d{4})Q([1-4])$/;

const isIso3 = (v) => {
  if (typeof v !== "string") return false;
  const s = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(s) && s !== "-99";
};
const norm = (s) => (s || "").toString().trim().toLowerCase();
const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

function pick(obj, keys, fallback = "") {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return fallback;
}

function toNum(v) {
  const n = Number(String(v ?? "").replaceAll(",", "").trim());
  return Number.isFinite(n) ? n : null;
}
function fmtNum(n, maxFrac = 3) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  return num.toLocaleString(undefined, { maximumFractionDigits: maxFrac });
}

function setInfo(title, html) {
  infoTitle.textContent = title;
  infoBody.innerHTML = html;
}

async function fetchJsonFirstOk(urls, label) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        lastErr = new Error(`${label} 로드 실패: ${url} (${res.status})`);
        continue;
      }
      const json = await res.json();
      return { json, url };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`${label} 로드 실패`);
}

// ✅ 핵심: countrydata.json 구조 정규화
function normalizeCountryData(json) {
  // 1) 이미 { ARE: {...}, VNM: {...} } 형태면 그대로
  if (json && typeof json === "object") {
    const keys = Object.keys(json);
    const hasIsoKey = keys.some(k => isIso3(k));
    if (hasIsoKey) return json;
  }

  // 2) 아니면(= constructionCost만 있는 형태 등) -> ARE로 감싸기
  //    (너가 UAE만 쓴다고 했으니 기본 ARE로 처리)
  if (json && typeof json === "object") {
    return { ARE: json };
  }

  return {};
}

//
// ============== geo helpers ==============
//
function getName(props = {}) {
  return (
    props.NAME_KO ||
    props.name_ko ||
    props.ADMIN ||
    props.NAME_EN ||
    props.NAME ||
    props.name ||
    props.SOVEREIGNT ||
    ""
  );
}

function getISOFromProps(props = {}) {
  const candidates = [
    "ISO_A3","iso_a3","ISO3","iso3",
    "ADM0_A3","adm0_a3","SOV_A3","sov_a3",
    "ISO_A3_EH","iso_a3_eh","ISO3166_A3",
    "ISO_3","iso_3",
  ];
  for (const k of candidates) {
    const v = props[k];
    const vv = (v ?? "").toString().trim().toUpperCase();
    if (isIso3(vv)) return vv;
  }
  for (const v of Object.values(props)) {
    const vv = (v ?? "").toString().trim().toUpperCase();
    if (isIso3(vv)) return vv;
  }
  return null;
}

function isoFallbackByName(name) {
  const n = norm(name);
  if (n.includes("united arab emirates") || n.includes("uae") || n.includes("아랍에미리트")) return "ARE";
  if (n.includes("vietnam") || n.includes("베트남")) return "VNM";
  if (n.includes("korea") || n.includes("south korea") || n.includes("한국")) return "KOR";
  return null;
}

function preprocessCountriesGeo(geo) {
  const features = geo?.features || [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    f.properties = f.properties || {};

    const name = getName(f.properties) || "Unknown";
    const iso = (getISOFromProps(f.properties) || isoFallbackByName(name) || "UNK").trim().toUpperCase();
    const fid = (f.id !== undefined && f.id !== null) ? f.id : i;

    f.properties.__name = name;
    f.properties.__iso = iso;
    f.properties.__fid = fid;
    if (f.id === undefined || f.id === null) f.id = fid;
  }
  return geo;
}

function computeBbox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  const visit = (c) => {
    const [x, y] = c;
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  const walk = (arr) => {
    if (!Array.isArray(arr)) return;
    if (typeof arr[0] === "number") return visit(arr);
    for (const a of arr) walk(a);
  };

  walk(geometry?.coordinates);
  return [[minX, minY], [maxX, maxY]];
}

function highlightFID(fid) {
  if (!map?.getLayer("countries-selected")) return;
  if (fid === null || fid === undefined) {
    map.setFilter("countries-selected", ["==", 1, 0]);
    map.setFilter("countries-selected-outline", ["==", 1, 0]);
    return;
  }
  map.setFilter("countries-selected", ["==", ["get", "__fid"], fid]);
  map.setFilter("countries-selected-outline", ["==", ["get", "__fid"], fid]);
}

//
// ============== period utilities ==============
//
function listAvailablePeriods(d) {
  const periods = new Set();

  // materialSeries에서 수집
  const ms = d?.materialSeries;
  if (ms && typeof ms === "object") {
    for (const k of Object.keys(ms)) {
      const arr = ms[k];
      if (!Array.isArray(arr)) continue;
      for (const r of arr) {
        const p = String(r?.period ?? "").trim();
        if (PERIOD_RE.test(p)) periods.add(p);
      }
    }
  }

  // constructionCost.series에서 수집(있어도 YYYYQ#만)
  const cc = d?.constructionCost?.series;
  if (Array.isArray(cc)) {
    for (const r of cc) {
      const p = String(r?.period ?? "").trim();
      if (PERIOD_RE.test(p)) periods.add(p);
    }
  }

  const out = [...periods].sort((a,b)=>{
    const pa = a.match(PERIOD_RE);
    const pb = b.match(PERIOD_RE);
    const ya = parseInt(pa[1],10), qa = parseInt(pa[2],10);
    const yb = parseInt(pb[1],10), qb = parseInt(pb[2],10);
    return (ya*10+qa) - (yb*10+qb);
  });

  return out;
}

function getLatestPeriod(d) {
  const p = listAvailablePeriods(d);
  return p.length ? p[p.length - 1] : "";
}

// 단가 조회
function getMaterialUnitPrice(d, key, period) {
  // 1) materialSeries에서 period 매칭
  const ms = d?.materialSeries?.[key];
  if (Array.isArray(ms)) {
    const target = period ? ms.find(r => String(r.period) === String(period)) : null;
    const row = target || ms[ms.length - 1]; // period 없으면 최신
    if (row) {
      const v = toNum(row.usd);
      if (v !== null) return { usd: v, unit: row.unit || "" };
    }
  }

  // 2) 최신 materials에서 item 매칭
  const nameMap = {
    brent_bbl: ["원유", "brent"],
    lng_mmbtu: ["lng", "jkm"],
    copper_t: ["구리", "copper", "lme"],
    aluminum_t: ["알루미늄", "aluminum"],
    rebar_t: ["철근", "rebar"],
    cement_t: ["시멘트", "cement"],
  };

  const mats = Array.isArray(d?.materials) ? d.materials : [];
  const keys = nameMap[key] || [];
  const found = mats.find(m => {
    const item = norm(pick(m, ["item","name","material"], ""));
    return keys.some(k => item.includes(norm(k)));
  });

  if (found) {
    const p = toNum(pick(found, ["price","value"], ""));
    const unit = pick(found, ["unit"], "");
    if (p !== null) return { usd: p, unit };
  }

  return { usd: null, unit: "" };
}

//
// ============== CSV export ==============
//
function csvEscape(v) {
  const s = String(v ?? "");
  return /[,"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function rowsToCSV(headers, rows) {
  const head = headers.map(csvEscape).join(",");
  const body = rows.map(r => r.map(csvEscape).join(",")).join("\n");
  return "\ufeff" + head + "\n" + body;
}
function downloadCSV(filename, csvText) {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function detectDesertSchema(d, arr) {
  const schema = String(d?.nonWorkSchema || "").toUpperCase();
  if (schema === "UAE" || schema === "ARE") return true;
  const r0 = arr?.[0] || {};
  if (r0.storm !== undefined || r0.sandstorm !== undefined || r0.shamal !== undefined) return true;
  return false;
}

function exportMaterialsAndNonworkCSV() {
  if (!selectedISO) return alert("먼저 국가를 선택하세요.");
  const d = countryData?.[selectedISO];
  if (!d) return alert(`데이터 없음: ${selectedISO}`);

  const matHeaders = ["품목", "가격", "단위"];
  const matRows = (d.materials || []).map(x => [
    pick(x, ["item", "name", "material"], ""),
    pick(x, ["price", "value"], ""),
    pick(x, ["unit"], "")
  ]);
  downloadCSV(`${selectedISO}_공사원가.csv`, rowsToCSV(matHeaders, matRows));

  const arr = Array.isArray(d.nonWorkDays) ? d.nonWorkDays : [];
  if (!arr.length) return;

  const isDesert = detectDesertSchema(d, arr);
  const third = isDesert ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";
  const headers = ["월","평균기온","평균최고/최저", third, "주말", "공휴일(평일)", "확정 비작업일", "등가 비작업일(8h)", "비고"];

  const monthIndex = (m) => {
    const s = String(m ?? "");
    const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) ? n : 99;
  };

  const sorted = [...arr].sort((a,b)=> monthIndex(a.month ?? a.m ?? a.mon) - monthIndex(b.month ?? b.m ?? b.mon));

  const rows = sorted.map(r => {
    const month = pick(r, ["month", "m", "mon"], "");
    const avgTemp = pick(r, ["avgTemp", "tAvg"], "");
    const hiLo = pick(r, ["avgHighLow", "avgHiLo"], "");
    const storm = pick(r, ["sandstorm", "storm", "dustStorm", "shamal"], "");
    const rain = pick(r, ["rainDays", "rain_day", "rainyDays"], "");
    const weekend = pick(r, ["weekend", "weekendDays"], "");
    const holiday = pick(r, ["holidayWeekday", "holiday"], "");
    const confirmed = pick(r, ["fixedOff", "confirmedOff", "fixedOffDays"], "");
    const equiv = pick(r, ["eqOff8h", "equivOff8h"], "");
    const note = pick(r, ["note", "remark"], "");
    return [month, avgTemp, hiLo, (isDesert ? storm : rain), weekend, holiday, confirmed, equiv, note];
  });

  setTimeout(() => {
    downloadCSV(`${selectedISO}_비작업일수.csv`, rowsToCSV(headers, rows));
  }, 200);
}

//
// ============== render blocks ==============
//
function renderTabs() {
  // 버튼 순서: 공사원가, 자재비 계산, 인건비 계산, 비작업일수, CSV
  const mkBtn = (id, label, active) => `
    <button data-view="${id}"
      style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${active ? "#111827" : "#fff"};color:${active ? "#fff" : "#111827"};cursor:pointer;">
      ${label}
    </button>
  `;

  return `
    <div style="display:flex; gap:8px; margin:10px 0 6px; align-items:center; flex-wrap:wrap;">
      ${mkBtn("costs", "공사원가", view === "costs")}
      ${mkBtn("matcalc", "자재비 계산", view === "matcalc")}
      ${mkBtn("laborcalc", "인건비 계산", view === "laborcalc")}
      ${mkBtn("nonwork", "비작업일수", view === "nonwork")}
      <button data-action="csv"
        style="padding:8px 12px;border:1px solid #ddd;border-radius:14px;background:#fff;color:#111827;cursor:pointer;">
        CSV
      </button>
    </div>
  `;
}

function renderCostsView(d) {
  const updated = d.updated || "—";
  const rows = (Array.isArray(d.materials) ? d.materials : []).map(r => {
    const item = esc(pick(r, ["item","name","material"], ""));
    const unit = esc(pick(r, ["unit"], ""));
    const pRaw = pick(r, ["price","value"], "");
    const pn = toNum(pRaw);
    const price = pn !== null ? fmtNum(pn, 3) : esc(String(pRaw ?? ""));
    return `<tr><td>${item}</td><td class="right">${price}</td><td>${unit}</td></tr>`;
  }).join("");

  // 인건비(하단 간단표)
  const laborRows = (Array.isArray(d.labor) ? d.labor : []).map(x => {
    const role = esc(pick(x, ["role","name"], ""));
    const w = toNum(pick(x, ["wage","value"], ""));
    const unit = esc(pick(x, ["unit"], ""));
    return `<tr><td>${role}</td><td class="right">${w !== null ? fmtNum(w, 2) : "—"}</td><td>${unit}</td></tr>`;
  }).join("");

  return `
    <div class="muted">업데이트: ${esc(updated)}</div>
    <table class="table">
      <thead><tr><th>품목</th><th class="right">가격</th><th>단위</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3">데이터 없음</td></tr>`}</tbody>
    </table>

    <div style="margin-top:12px; font-weight:900;">인건비</div>
    <table class="table" style="margin-top:6px;">
      <thead><tr><th>구분</th><th class="right">금액</th><th>단위</th></tr></thead>
      <tbody>${laborRows || `<tr><td colspan="3">데이터 없음</td></tr>`}</tbody>
    </table>
  `;
}

function renderMatCalcView(d) {
  const periods = listAvailablePeriods(d);
  if (!matCalcState.period) matCalcState.period = getLatestPeriod(d);

  const safePeriods = periods.length ? periods : (matCalcState.period ? [matCalcState.period] : []);
  const options = safePeriods.map(p => {
    const sel = String(p) === String(matCalcState.period) ? "selected" : "";
    return `<option value="${esc(p)}" ${sel}>${esc(p)}</option>`;
  }).join("");

  const items = [
    { key: "brent_bbl", label: "원유(Brent)", qtyLabel: "bbl" },
    { key: "lng_mmbtu", label: "LNG(JKM)", qtyLabel: "MMBtu" },
    { key: "copper_t", label: "구리(LME)", qtyLabel: "t" },
    { key: "aluminum_t", label: "알루미늄", qtyLabel: "t" },
    { key: "rebar_t", label: "철근", qtyLabel: "t" },
    { key: "cement_t", label: "시멘트", qtyLabel: "t" },
  ];

  const rows = items.map(it => {
    const up = getMaterialUnitPrice(d, it.key, matCalcState.period);
    const unitPrice = up.usd; // null이면 표시 "—"
    const unitStr = up.unit || (it.qtyLabel ? `USD/${it.qtyLabel}` : "USD");

    const qtyVal = matCalcState.qty[it.key] ?? "";
    const qtyNum = toNum(qtyVal);
    const cost = (qtyNum !== null && unitPrice !== null) ? qtyNum * unitPrice : null;

    return `
      <tr>
        <td style="font-weight:700;">${esc(it.label)}</td>
        <td class="right">${unitPrice !== null ? fmtNum(unitPrice, 3) : "—"}</td>
        <td>${esc(unitStr)}</td>
        <td class="right">
          <input data-matqty="${esc(it.key)}" type="number" min="0" step="0.01"
            value="${esc(qtyVal)}"
            placeholder=""
            style="width:120px; padding:8px 10px; border:1px solid #e5e7eb; border-radius:12px; text-align:right;"
          />
          <span class="muted" style="margin-left:6px;">${esc(it.qtyLabel)}</span>
        </td>
        <td class="right"><b>${cost !== null ? fmtNum(cost, 2) : "—"}</b></td>
      </tr>
    `;
  }).join("");

  return `
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:10px 0;">
      <div style="font-weight:900;">기준 연도/분기</div>
      <select id="matPeriod" data-mat-field="period"
        ${safePeriods.length ? "" : "disabled"}
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
        ${options || `<option value="">—</option>`}
      </select>
    </div>

    <table class="table">
      <thead>
        <tr>
          <th>품목</th>
          <th class="right">단가</th>
          <th>단위</th>
          <th class="right">수량</th>
          <th class="right">금액(USD)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <div id="matTotal" style="margin-top:12px; font-weight:900; text-align:right; font-size:16px;"></div>
  `;
}

function updateMatTotal() {
  if (view !== "matcalc") return;
  const d = countryData?.[selectedISO];
  if (!d) return;

  const items = ["brent_bbl","lng_mmbtu","copper_t","aluminum_t","rebar_t","cement_t"];
  let sum = 0;
  let hasAny = false;

  for (const k of items) {
    const qtyNum = toNum(matCalcState.qty[k]);
    const up = getMaterialUnitPrice(d, k, matCalcState.period);
    if (qtyNum !== null && up.usd !== null) {
      sum += qtyNum * up.usd;
      hasAny = true;
    }
  }

  const el = document.getElementById("matTotal");
  if (!el) return;
  el.textContent = hasAny ? `합계: ${fmtNum(sum, 2)} USD` : `합계: —`;
}

function computeAnnualRiskMultiplier() {
  // 아주 단순 모델(연간 평균)
  const baseRamadanAnnual = (11 + 1.333) / 12; // 약 1.0277
  let m = 1;
  if (laborCalcState.applyRamadan) m *= baseRamadanAnnual;

  if (laborCalcState.applyPrayerLoss) {
    const hours = laborCalcState.applyRamadan ? 6 : 8;
    const eff = Math.max(1, hours - 1);
    m *= (hours / eff);
  }
  return m;
}

function renderLaborCalcView() {
  const year = Number(laborCalcState.year) || new Date().getFullYear();
  const area = toNum(laborCalcState.areaM2);

  const uaeDaily = laborCalcState.uaeDailyUSD !== "" ? toNum(laborCalcState.uaeDailyUSD) : 55;
  const korDaily = laborCalcState.korDailyUSD !== "" ? toNum(laborCalcState.korDailyUSD) : 180;

  const robotAnnual = toNum(laborCalcState.robotAnnualUsdPerM2) ?? 59.76;
  const laborAnnualBase = toNum(laborCalcState.laborAnnualUsdPerM2) ?? 21.07;

  const riskM = computeAnnualRiskMultiplier();

  const uaeAnnualPerM2 = laborAnnualBase * riskM;
  const wageRatio = (uaeDaily && korDaily) ? (korDaily / uaeDaily) : null;
  const korAnnualPerM2 = wageRatio ? (laborAnnualBase * wageRatio) : null;

  const uaeTotal = (area !== null) ? area * uaeAnnualPerM2 : null;
  const korTotal = (area !== null && korAnnualPerM2 !== null) ? area * korAnnualPerM2 : null;
  const robotTotal = (area !== null) ? area * robotAnnual : null;

  return `
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <div style="font-weight:900;">기준 연도</div>
      <input type="number" data-labor-field="year" value="${esc(year)}"
        style="width:110px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px;" />
      <div style="font-weight:900; margin-left:8px;">면적</div>
      <input type="number" data-labor-field="areaM2" value="${esc(laborCalcState.areaM2)}"
        placeholder="예: 200000"
        style="width:160px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
      <span class="muted">m²</span>
    </div>

    <div style="margin-top:12px; display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
      <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:900;">UAE 인력(일급, USD/day)</div>
        <input type="number" data-labor-field="uaeDailyUSD" value="${esc(laborCalcState.uaeDailyUSD)}"
          placeholder="예: 55"
          style="margin-top:8px; width:100%; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
      </div>

      <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:900;">한국 인력(일급, USD/day)</div>
        <input type="number" data-labor-field="korDailyUSD" value="${esc(laborCalcState.korDailyUSD)}"
          placeholder="예: 180"
          style="margin-top:8px; width:100%; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
      </div>
    </div>

    <div style="margin-top:12px; display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
      <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:900;">로봇 연간 단가(USD/m²·year)</div>
        <input type="number" step="0.01" data-labor-field="robotAnnualUsdPerM2" value="${esc(laborCalcState.robotAnnualUsdPerM2)}"
          style="margin-top:8px; width:100%; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
      </div>

      <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:900;">인력 연간 단가(기본, USD/m²·year)</div>
        <input type="number" step="0.01" data-labor-field="laborAnnualUsdPerM2" value="${esc(laborCalcState.laborAnnualUsdPerM2)}"
          style="margin-top:8px; width:100%; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
      </div>
    </div>

    <div style="margin-top:12px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
      <label style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" data-labor-field="applyRamadan" ${laborCalcState.applyRamadan ? "checked" : ""}/>
        <span>라마단 반영</span>
      </label>
      <label style="display:flex; align-items:center; gap:8px;">
        <input type="checkbox" data-labor-field="applyPrayerLoss" ${laborCalcState.applyPrayerLoss ? "checked" : ""}/>
        <span>기도시간 손실 반영</span>
      </label>
      <div style="display:flex; align-items:center; gap:8px;">
        <span class="muted">OT</span>
        <select data-labor-field="overtimePremium" style="padding:8px 10px; border:1px solid #e5e7eb; border-radius:12px;">
          ${[1.0,1.25,1.5].map(v=>`<option value="${v}" ${Number(laborCalcState.overtimePremium)===v?"selected":""}>x${v}</option>`).join("")}
        </select>
      </div>
    </div>

    <div style="margin-top:14px;">
      <table class="table">
        <thead>
          <tr>
            <th>비교</th>
            <th class="right">단가(USD/m²·year)</th>
            <th class="right">총액(USD/year)</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td><b>UAE 인력</b></td>
            <td class="right">${fmtNum(uaeAnnualPerM2, 2)}</td>
            <td class="right"><b>${uaeTotal !== null ? fmtNum(uaeTotal, 0) : "—"}</b></td>
          </tr>
          <tr>
            <td><b>한국 인력</b></td>
            <td class="right">${korAnnualPerM2 !== null ? fmtNum(korAnnualPerM2, 2) : "—"}</td>
            <td class="right"><b>${korTotal !== null ? fmtNum(korTotal, 0) : "—"}</b></td>
          </tr>
          <tr>
            <td><b>로봇</b></td>
            <td class="right">${fmtNum(robotAnnual, 2)}</td>
            <td class="right"><b>${robotTotal !== null ? fmtNum(robotTotal, 0) : "—"}</b></td>
          </tr>
        </tbody>
      </table>
    </div>
  `;
}

function renderNonWorkView(d) {
  const nwd = Array.isArray(d.nonWorkDays) ? d.nonWorkDays : [];
  const isDesert = detectDesertSchema(d, nwd);
  const thirdColName = isDesert ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";

  const monthIndex = (m) => {
    const s = String(m ?? "");
    const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) ? n : 99;
  };

  const sorted = [...nwd].sort((a,b)=> monthIndex(a.month ?? a.m ?? a.mon) - monthIndex(b.month ?? b.m ?? b.mon));

  const rows = sorted.map(r => {
    const month = pick(r, ["month","m","mon"], "");
    const avgTemp = pick(r, ["avgTemp","tAvg"], "");
    const hiLo = pick(r, ["avgHighLow","avgHiLo"], "");
    const storm = pick(r, ["storm","sandstorm","dustStorm","shamal"], "");
    const rain = pick(r, ["rainDays","rain_day","rainyDays"], "");
    const weekend = pick(r, ["weekend","weekendDays"], "");
    const holiday = pick(r, ["holidayWeekday","holiday"], "");
    const confirmed = pick(r, ["fixedOff","confirmedOff","fixedOffDays"], "");
    const equiv = pick(r, ["eqOff8h","equivOff8h"], "");
    const note = pick(r, ["note","remark"], "");

    return `
      <tr>
        <td>${esc(month)}</td>
        <td class="right">${esc(avgTemp)}</td>
        <td class="right">${esc(hiLo)}</td>
        <td class="right">${esc(isDesert ? storm : rain)}</td>
        <td class="right">${esc(weekend)}</td>
        <td class="right">${esc(holiday)}</td>
        <td class="right">${esc(confirmed)}</td>
        <td class="right">${esc(equiv)}</td>
        <td>${esc(note)}</td>
      </tr>
    `;
  }).join("");

  return `
    <table class="table">
      <thead>
        <tr>
          <th>월</th>
          <th class="right">평균기온</th>
          <th class="right">평균최고/최저</th>
          <th class="right">${thirdColName}</th>
          <th class="right">주말</th>
          <th class="right">공휴일(평일)</th>
          <th class="right">확정 비작업일</th>
          <th class="right">등가 비작업일(8h)</th>
          <th>비고</th>
        </tr>
      </thead>
      <tbody>${rows || `<tr><td colspan="9">데이터 없음</td></tr>`}</tbody>
    </table>
  `;
}

function renderPanel(isoRaw, fallbackName) {
  selectedIsoRaw = (isoRaw || "UNK").toString().trim().toUpperCase();
  const iso = (isIso3(selectedIsoRaw) && selectedIsoRaw !== "UNK") ? selectedIsoRaw : null;
  selectedISO = iso;

  let title = fallbackName || (isoRaw || "선택 국가");
  if (iso && countryData?.[iso]) title = countryData[iso].name || title;

  const tabs = renderTabs();

  if (!iso) {
    setInfo(title, tabs + `<div class="muted">이 국가의 상세 데이터가 없습니다.</div>`);
    return;
  }

  const d = countryData?.[iso];
  if (!d) {
    setInfo(title, tabs + `<div class="muted">이 국가의 상세 데이터가 없습니다.</div>`);
    return;
  }

  let body = "";
  if (view === "costs") body = renderCostsView(d);
  else if (view === "matcalc") body = renderMatCalcView(d);
  else if (view === "laborcalc") body = renderLaborCalcView();
  else if (view === "nonwork") body = renderNonWorkView(d);

  setInfo(title, tabs + body);

  updateMatTotal();
}

//
// ============== init ==============
//
async function init() {
  setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);

  // 데이터 로드
  try {
    const { json } = await fetchJsonFirstOk(DATA_URLS, "countrydata.json");
    countryData = normalizeCountryData(json);
  } catch {
    countryData = {};
  }

  // 지도 생성: 시작 중동 확대
  map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [48.0, 24.0], // UAE 근처
    zoom: 3.4,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", async () => {
    try {
      const { json } = await fetchJsonFirstOk(GEOJSON_URLS, "countries.geojson");
      countriesGeo = preprocessCountriesGeo(json);

      map.addSource("countries", { type: "geojson", data: countriesGeo });

      map.addLayer({
        id: "countries-fill",
        type: "fill",
        source: "countries",
        paint: { "fill-color": "#7c8794", "fill-opacity": 0.08 },
      });

      map.addLayer({
        id: "countries-line",
        type: "line",
        source: "countries",
        paint: { "line-color": "#6b7280", "line-width": 1, "line-opacity": 0.45 },
      });

      map.addLayer({
        id: "countries-selected",
        type: "fill",
        source: "countries",
        paint: { "fill-color": "#0ea5a5", "fill-opacity": 0.35 },
        filter: ["==", 1, 0],
      });

      map.addLayer({
        id: "countries-selected-outline",
        type: "line",
        source: "countries",
        paint: { "line-color": "#0ea5a5", "line-width": 2 },
        filter: ["==", 1, 0],
      });

      map.on("mouseenter", "countries-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "countries-fill", () => (map.getCanvas().style.cursor = ""));

      map.on("click", "countries-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;

        const props = f.properties || {};
        const fid = props.__fid;
        const isoRaw = (props.__iso || getISOFromProps(props) || "UNK").toString().trim().toUpperCase();
        const name = props.__name || getName(props) || "국가";

        selectedFID = fid;
        selectedName = name;

        highlightFID(fid);

        if (f.geometry) {
          const bbox = computeBbox(f.geometry);
          if (isFinite(bbox?.[0]?.[0])) map.fitBounds(bbox, { padding: 60, duration: 700 });
        }

        view = "costs";
        renderPanel(isoRaw, name);
      });

    } catch (e) {
      setInfo("오류", `<div class="muted">지도 데이터를 불러오지 못했습니다.</div>`);
    }
  });

  // 검색
  const doSearch = () => {
    const q = searchInput.value.trim();
    if (!q || !countriesGeo?.features?.length) return;
    const qn = norm(q);

    const f = countriesGeo.features.find((ft) => {
      const props = ft.properties || {};
      const isoRaw = props.__iso || "UNK";
      const name = props.__name || getName(props);
      const isoGood = (isIso3(isoRaw) && isoRaw !== "UNK") ? isoRaw : null;
      const dataName = isoGood ? (countryData?.[isoGood]?.name || "") : "";
      return norm(name).includes(qn) || norm(isoRaw).includes(qn) || norm(dataName).includes(qn);
    });

    if (!f) {
      setInfo("국가를 선택하세요", `<div class="muted">검색 결과가 없습니다.</div>`);
      return;
    }

    const props = f.properties || {};
    const fid = props.__fid;
    const isoRaw = props.__iso || "UNK";
    const name = props.__name || getName(props) || "국가";

    selectedFID = fid;
    selectedName = name;

    highlightFID(fid);

    if (f.geometry) {
      const bbox = computeBbox(f.geometry);
      if (isFinite(bbox?.[0]?.[0])) map.fitBounds(bbox, { padding: 60, duration: 700 });
    }

    view = "costs";
    renderPanel(isoRaw, name);
  };

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    selectedISO = null;
    selectedIsoRaw = "UNK";
    selectedFID = null;
    selectedName = null;
    setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);
    highlightFID(null);
  });

  advancedBtn.addEventListener("click", () => { alert(" "); });

  // info 영역 이벤트(탭/CSV/입력)
  document.getElementById("info").addEventListener("click", (e) => {
    const csvBtn = e.target.closest('button[data-action="csv"]');
    if (csvBtn) { exportMaterialsAndNonworkCSV(); return; }

    const btn = e.target.closest("button[data-view]");
    if (btn) {
      view = btn.dataset.view;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }
  });

  // 자재비 계산 입력
  document.getElementById("info").addEventListener("input", (e) => {
    const t = e.target;

    // period 변경
    if (t && t.matches('select[data-mat-field="period"]')) {
      matCalcState.period = t.value;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }

    // qty 변경
    const k = t?.getAttribute?.("data-matqty");
    if (k) {
      matCalcState.qty[k] = t.value;
      updateMatTotal();
      return;
    }

    // labor fields
    const lf = t?.getAttribute?.("data-labor-field");
    if (lf) {
      laborCalcState[lf] = t.type === "checkbox" ? t.checked : t.value;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }
  });

  // 체크박스 변경(인건비)
  document.getElementById("info").addEventListener("change", (e) => {
    const t = e.target;
    const lf = t?.getAttribute?.("data-labor-field");
    if (lf) {
      laborCalcState[lf] = t.type === "checkbox" ? t.checked : t.value;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
