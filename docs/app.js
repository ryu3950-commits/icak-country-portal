// app.js (FINAL)
// - 사이드바 제거에 맞춘 UI
// - "자재비" -> "공사원가" (표시명 변경)
// - 공사원가 화면 하단에 인건비(표) 추가 (UAE 포함)
// - 비작업일수 12개월 표시
// - materialsQuarterly / materials 둘 다 지원 (가격 안 뜨는 문제 대응)
// - GitHub Pages 경로 우선

const GEOJSON_URLS = [
  "./data/countries.geojson",
  "./countries.geojson",
];

const DATA_URLS = [
  "./data/countrydata.json",
  "./countrydata.json",
];

const MAP_STYLE = "https://demotiles.maplibre.org/style.json";

// ✅ 시작 화면: 중동 확대 (원하면 숫자만 바꾸면 됨)
const DEFAULT_CENTER = [50.0, 24.0]; // UAE 근처
const DEFAULT_ZOOM = 3.2;

const infoTitle = document.getElementById("infoTitle");
const infoBody = document.getElementById("infoBody");

const searchInput = document.getElementById("searchInput");
const clearBtn = document.getElementById("clearBtn");
const searchBtn = document.getElementById("searchBtn");

let map;
let countriesGeo = null;
let countryData = {};

// 선택 상태
let selectedISO = null;
let selectedIsoRaw = "UNK";
let selectedFID = null;
let selectedName = null;

// 탭 상태
// costbase(공사원가) | materialCalc(자재비계산) | laborCalc(인건비계산) | nonwork(비작업일수)
let view = "costbase";

// 계산 상태(자재비/인건비)
let materialCalcState = { period: "", qty: {} };
let laborCalcState = { year: "", manDays: {} };

// ---------------- helpers ----------------
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

function buildHiLo(obj) {
  const hi = pick(obj, ["avgHighLow", "avgHigh", "high", "tMax", "avgMax", "meanMax", "max"]);
  const lo = pick(obj, ["avgLow", "low", "tMin", "avgMin", "meanMin", "min"]);
  if (typeof hi === "string" && hi.includes("/")) return hi; // 이미 "최고/최저"
  if (hi !== "" && lo !== "") return `${hi}/${lo}`;
  return "";
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

// 표시 이름
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

// ISO3 추출 (trim/upper 강제)
function getISOFromProps(props = {}) {
  const candidates = [
    "ISO_A3", "iso_a3", "ISO3", "iso3",
    "ADM0_A3", "adm0_a3", "SOV_A3", "sov_a3",
    "ISO_A3_EH", "iso_a3_eh", "ISO3166_A3",
    "ISO_3", "iso_3",
  ];

  for (const k of candidates) {
    const vv = (props?.[k] ?? "").toString().trim().toUpperCase();
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
  return null;
}

// geo 전처리: __name/__iso/__fid 주입 + iso 정규화
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

// ---------------- data helpers (materials/labor) ----------------
function getMaterialsQuarterlyMap(iso) {
  const m = countryData?.[iso]?.materialsQuarterly;
  return (m && typeof m === "object") ? m : null;
}

function listMaterialPeriods(iso) {
  const mq = getMaterialsQuarterlyMap(iso);
  if (!mq) return [];
  return Object.keys(mq).sort(); // "2020Q1" 식이면 문자열 정렬로도 충분
}

function getDefaultMaterialPeriod(iso) {
  const periods = listMaterialPeriods(iso);
  if (!periods.length) return "";
  return periods[periods.length - 1];
}

function getMaterialsForPeriod(iso, period) {
  const mq = getMaterialsQuarterlyMap(iso);
  if (mq && period && Array.isArray(mq[period])) return mq[period];
  // fallback: materials (단일 최신)
  const base = countryData?.[iso]?.materials;
  return Array.isArray(base) ? base : [];
}

function listLaborYears(iso) {
  const y = countryData?.[iso]?.laborYearly;
  if (!y || typeof y !== "object") return [];
  return Object.keys(y).sort();
}

function getDefaultLaborYear(iso) {
  const years = listLaborYears(iso);
  if (!years.length) return "";
  return years[years.length - 1];
}

function getLaborForYear(iso, year) {
  const y = countryData?.[iso]?.laborYearly;
  if (y && year && Array.isArray(y[year])) return y[year];
  // fallback: labor (단일 최신)
  const base = countryData?.[iso]?.labor;
  return Array.isArray(base) ? base : [];
}

function fmtNum(n, frac = 3) {
  const num = Number(n);
  if (!isFinite(num)) return "—";
  return num.toLocaleString(undefined, { maximumFractionDigits: frac });
}

// ---------------- CSV Export ----------------
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

function exportCurrentCSV() {
  if (!selectedISO) return alert("먼저 국가를 선택하세요.");
  const d = countryData?.[selectedISO];
  if (!d) return alert(`데이터 없음: ${selectedISO}`);

  // 공사원가(=자재) CSV
  const period = materialCalcState.period || getDefaultMaterialPeriod(selectedISO);
  const mats = getMaterialsForPeriod(selectedISO, period);

  const matHeaders = ["period", "item", "price", "unit"];
  const matRows = mats.map(x => [
    period || (d.updated || ""),
    pick(x, ["item", "name", "material"], ""),
    pick(x, ["price", "value"], ""),
    pick(x, ["unit"], "")
  ]);
  downloadCSV(`${selectedISO}_공사원가.csv`, rowsToCSV(matHeaders, matRows));

  // 비작업일수 CSV
  const arr = d.nonWorkDays || [];
  if (!arr.length) return;

  const isDesert = detectDesertSchema(d, arr);
  const third = isDesert ? "sandstorm_per_month" : "rainDays_per_month";

  const nwHeaders = ["month","avgTemp","avgHighLow", third, "weekend","holidayWeekday","fixedOff","eqOff8h","note"];
  const nwRows = arr.map(r => [
    pick(r, ["month","m","mon"], ""),
    pick(r, ["avgTemp","tAvg"], ""),
    pick(r, ["avgHighLow","avgHiLo"], "") || buildHiLo(r),
    isDesert ? pick(r, ["storm","sandstorm","shamal"], "") : pick(r, ["rainDays","rain_day","rainyDays"], ""),
    pick(r, ["weekend","weekendDays"], ""),
    pick(r, ["holidayWeekday","holiday","holidayWeekdays"], ""),
    pick(r, ["fixedOff","confirmedOff","confirmedNonwork"], ""),
    pick(r, ["eqOff8h","equivOff8h","eqOff"], ""),
    pick(r, ["note","remark","remarks"], "")
  ]);

  setTimeout(() => {
    downloadCSV(`${selectedISO}_비작업일수.csv`, rowsToCSV(nwHeaders, nwRows));
  }, 250);
}

// ---------------- UI Render ----------------
function buildTabs() {
  return `
    <div style="display:flex; gap:8px; margin:10px 0 6px; align-items:center; flex-wrap:wrap;">
      <button data-view="costbase"
        style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="costbase"?"#111827":"#fff"};color:${view==="costbase"?"#fff":"#111827"};cursor:pointer;">
        공사원가
      </button>

      <button data-view="materialCalc"
        style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="materialCalc"?"#111827":"#fff"};color:${view==="materialCalc"?"#fff":"#111827"};cursor:pointer;">
        자재비계산
      </button>

      <button data-view="laborCalc"
        style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="laborCalc"?"#111827":"#fff"};color:${view==="laborCalc"?"#fff":"#111827"};cursor:pointer;">
        인건비계산
      </button>

      <button data-view="nonwork"
        style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="nonwork"?"#111827":"#fff"};color:${view==="nonwork"?"#fff":"#111827"};cursor:pointer;">
        비작업일수
      </button>

      <button data-action="csv"
        style="padding:8px 12px;border:1px solid #ddd;border-radius:14px;background:#fff;color:#111827;cursor:pointer;">
        CSV
      </button>
    </div>
  `;
}

function renderCostBase(iso) {
  const d = countryData?.[iso];
  const periods = listMaterialPeriods(iso);
  const hasQuarterly = periods.length > 0;

  if (!materialCalcState.period) materialCalcState.period = getDefaultMaterialPeriod(iso);

  const activePeriod = hasQuarterly ? (materialCalcState.period || getDefaultMaterialPeriod(iso)) : "";
  const mats = getMaterialsForPeriod(iso, activePeriod);

  const updated = d.updated || d.materialsUpdated || "—";

  const periodUI = hasQuarterly ? `
    <div style="margin:10px 0; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <div style="font-weight:700;">기준 분기</div>
      <select id="matPeriod" data-field="matPeriod"
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
        ${periods.map(p => `<option value="${esc(p)}" ${String(p)===String(activePeriod)?"selected":""}>${esc(p)}</option>`).join("")}
      </select>
      <div class="muted">업데이트: ${esc(updated)}</div>
    </div>
  ` : `<div class="muted">업데이트: ${esc(updated)}</div>`;

  const matRows = mats.map(r => `
    <tr>
      <td>${esc(pick(r, ["item","name","material"], ""))}</td>
      <td class="right">${fmtNum(pick(r, ["price","value"], ""))}</td>
      <td>${esc(pick(r, ["unit"], ""))}</td>
    </tr>
  `).join("");

  const matTable = `
    ${periodUI}
    <table class="table">
      <thead>
        <tr><th>품목</th><th class="right">가격</th><th>단위</th></tr>
      </thead>
      <tbody>${matRows || `<tr><td colspan="3">데이터 없음</td></tr>`}</tbody>
    </table>
  `;

  // ✅ 공사원가 화면 하단 "인건비(표)" 추가 (UAE 포함, 다른 국가도 있으면 표시)
  const laborYear = laborCalcState.year || getDefaultLaborYear(iso) || "";
  const laborRowsArr = getLaborForYear(iso, laborYear);

  const laborYearUI = listLaborYears(iso).length ? `
    <div style="margin:12px 0 6px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <div style="font-weight:800;">인건비 (참고)</div>
      <div class="muted">기준 연도</div>
      <select id="laborYearInline" data-field="laborYearInline"
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
        ${listLaborYears(iso).map(y => `<option value="${esc(y)}" ${String(y)===String(laborYear)?"selected":""}>${esc(y)}</option>`).join("")}
      </select>
    </div>
  ` : `<div style="margin:12px 0 6px; font-weight:800;">인건비 (참고)</div>`;

  const laborRows = laborRowsArr.map(r => `
    <tr>
      <td>${esc(pick(r, ["role","name"], ""))}</td>
      <td class="right">${fmtNum(pick(r, ["wage","price","value"], ""), 2)}</td>
      <td>${esc(pick(r, ["unit"], ""))}</td>
    </tr>
  `).join("");

  const laborTable = `
    ${laborYearUI}
    <table class="table">
      <thead>
        <tr><th>직종</th><th class="right">단가</th><th>단위</th></tr>
      </thead>
      <tbody>${laborRows || `<tr><td colspan="3">데이터 없음</td></tr>`}</tbody>
    </table>
  `;

  const lawUrl = d.ppp?.lawUrl;
  const statusUrl = d.ppp?.statusUrl;

  const pppBlock = `
    <div class="btnrow">
      <a class="btn" href="${lawUrl || "#"}" target="_blank" rel="noopener noreferrer"
         style="${lawUrl ? "" : "pointer-events:none;opacity:.45;"}">→ PPP 제도</a>
      <a class="btn" href="${statusUrl || "#"}" target="_blank" rel="noopener noreferrer"
         style="${statusUrl ? "" : "pointer-events:none;opacity:.45;"}">→ PPP 발주현황</a>
    </div>
  `;

  return matTable + `<div style="margin-top:12px;"></div>` + laborTable + pppBlock;
}

function renderMaterialCalc(iso) {
  const d = countryData?.[iso];
  const periods = listMaterialPeriods(iso);
  const hasQuarterly = periods.length > 0;

  if (!materialCalcState.period) materialCalcState.period = getDefaultMaterialPeriod(iso);

  const period = hasQuarterly ? (materialCalcState.period || getDefaultMaterialPeriod(iso)) : "";
  const mats = getMaterialsForPeriod(iso, period);

  // 계산 대상 품목 고정(없으면 0 처리)
  const targets = ["원유 (Brent)", "LNG (JKM)", "구리 (LME Cash)", "알루미늄", "철근", "시멘트"];

  // 품목 매칭(부분 포함)
  function findMatByTarget(t) {
    const tn = norm(t);
    return mats.find(x => norm(pick(x, ["item","name","material"], "")).includes(tn)) || null;
  }

  const rows = targets.map(t => {
    const mat = findMatByTarget(t);
    const key = t;
    const unit = mat ? pick(mat, ["unit"], "") : "";
    const price = mat ? Number(pick(mat, ["price","value"], 0)) : 0;
    const qty = Number(materialCalcState.qty?.[key] || 0);
    const cost = (isFinite(price) ? price : 0) * (isFinite(qty) ? qty : 0);

    return { key, display: t, unit, price, qty, cost };
  });

  const total = rows.reduce((s, r) => s + (isFinite(r.cost) ? r.cost : 0), 0);

  const periodUI = hasQuarterly ? `
    <div style="margin:10px 0; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <div style="font-weight:700;">기준 분기</div>
      <select id="matCalcPeriod" data-field="matCalcPeriod"
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
        ${periods.map(p => `<option value="${esc(p)}" ${String(p)===String(period)?"selected":""}>${esc(p)}</option>`).join("")}
      </select>
      <div class="muted">수량을 넣으면 해당 분기 단가로 합계가 계산됩니다.</div>
    </div>
  ` : `<div class="muted" style="margin:10px 0;">현재 분기별 데이터가 없어서 최신 단가로 계산합니다.</div>`;

  const calcTable = `
    ${periodUI}
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
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${esc(r.display)}</td>
            <td class="right">${fmtNum(r.price, 3)}</td>
            <td>${esc(r.unit)}</td>
            <td class="right">
              <input
                data-mqty="${esc(r.key)}"
                type="number"
                min="0"
                step="0.01"
                value="${esc(r.qty)}"
                style="width:120px; padding:8px 10px; border:1px solid #e5e7eb; border-radius:12px; text-align:right;"
              />
            </td>
            <td class="right"><b>${fmtNum(r.cost, 2)}</b></td>
          </tr>
        `).join("")}
        <tr>
          <td colspan="4"><b>합계</b></td>
          <td class="right"><b>${fmtNum(total, 2)}</b></td>
        </tr>
      </tbody>
    </table>
  `;

  return calcTable;
}

function renderLaborCalc(iso) {
  const years = listLaborYears(iso);
  const hasYearly = years.length > 0;

  if (!laborCalcState.year) laborCalcState.year = getDefaultLaborYear(iso);

  const year = hasYearly ? (laborCalcState.year || getDefaultLaborYear(iso)) : "";
  const labor = getLaborForYear(iso, year);

  // 역할별 man-days 입력으로 계산
  const rows = labor.map(r => {
    const role = pick(r, ["role","name"], "");
    const unit = pick(r, ["unit"], "");
    const wage = Number(pick(r, ["wage","price","value"], 0));
    const md = Number(laborCalcState.manDays?.[role] || 0);
    const cost = (isFinite(wage) ? wage : 0) * (isFinite(md) ? md : 0);
    return { role, unit, wage, md, cost };
  });

  const total = rows.reduce((s, r) => s + (isFinite(r.cost) ? r.cost : 0), 0);

  const yearUI = hasYearly ? `
    <div style="margin:10px 0; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <div style="font-weight:700;">기준 연도</div>
      <select id="laborCalcYear" data-field="laborCalcYear"
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
        ${years.map(y => `<option value="${esc(y)}" ${String(y)===String(year)?"selected":""}>${esc(y)}</option>`).join("")}
      </select>
      <div class="muted">역할별 투입 Man-day를 넣으면 합계가 계산됩니다.</div>
    </div>
  ` : `<div class="muted" style="margin:10px 0;">연도별 데이터가 없어서 최신 단가로 계산합니다.</div>`;

  const table = `
    ${yearUI}
    <table class="table">
      <thead>
        <tr>
          <th>직종</th>
          <th class="right">단가</th>
          <th>단위</th>
          <th class="right">Man-day</th>
          <th class="right">금액(USD)</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${esc(r.role)}</td>
            <td class="right">${fmtNum(r.wage, 2)}</td>
            <td>${esc(r.unit)}</td>
            <td class="right">
              <input
                data-md="${esc(r.role)}"
                type="number"
                min="0"
                step="1"
                value="${esc(r.md)}"
                style="width:120px; padding:8px 10px; border:1px solid #e5e7eb; border-radius:12px; text-align:right;"
              />
            </td>
            <td class="right"><b>${fmtNum(r.cost, 2)}</b></td>
          </tr>
        `).join("")}
        <tr>
          <td colspan="4"><b>합계</b></td>
          <td class="right"><b>${fmtNum(total, 2)}</b></td>
        </tr>
      </tbody>
    </table>
  `;

  return table;
}

function renderNonWork(iso) {
  const d = countryData?.[iso];
  const nwd = d.nonWorkDays || [];
  const isDesert = detectDesertSchema(d, nwd);
  const thirdColName = isDesert ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";

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
      <tbody>
        ${
          nwd.map((r) => {
            const month = pick(r, ["month","m","mon"], "");
            const avgTemp = pick(r, ["avgTemp","tAvg"], "");
            const hiLo = pick(r, ["avgHighLow","avgHiLo","avgHighLowStr"], "") || buildHiLo(r);

            const storm = pick(r, ["sandstorm","storm","dustStorm","shamal"], "");
            const rain = pick(r, ["rainDays","rain_day","rainyDays"], "");

            const weekend = pick(r, ["weekend","weekendDays"], "");
            const holiday = pick(r, ["holidayWeekday","holiday","holidayWeekdays"], "");

            const confirmed = pick(r, ["fixedOff","confirmedOff","fixedOffDays","confirmedNonwork"], "");
            const equiv = pick(r, ["eqOff8h","equivOff8h","eqOff","equivalentOff8h"], "");

            const note = pick(r, ["note","remark","remarks"], "");

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
          }).join("") || `<tr><td colspan="9">데이터 없음</td></tr>`
        }
      </tbody>
    </table>
  `;
}

function renderPanel(isoRaw, fallbackName) {
  selectedIsoRaw = (isoRaw ?? "UNK").toString().trim().toUpperCase();
  const iso = (isIso3(selectedIsoRaw) && selectedIsoRaw !== "UNK") ? selectedIsoRaw : null;
  selectedISO = iso;

  let title = fallbackName || (isoRaw || "선택 국가");
  if (iso && countryData?.[iso]) title = countryData[iso].name || title;

  const tabs = buildTabs();

  if (!iso) {
    setInfo(title, tabs + `<div class="muted">이 국가의 상세 데이터가 없습니다.</div>`);
    return;
  }

  const d = countryData?.[iso];
  if (!d) {
    setInfo(title, tabs + `<div class="muted">이 국가의 상세 데이터가 없습니다. (데이터 키: ${esc(iso)})</div>`);
    return;
  }

  // ✅ 기본 선택값 초기화
  if (!materialCalcState.period) materialCalcState.period = getDefaultMaterialPeriod(iso);
  if (!laborCalcState.year) laborCalcState.year = getDefaultLaborYear(iso);

  const body =
    (view === "nonwork") ? renderNonWork(iso) :
    (view === "materialCalc") ? renderMaterialCalc(iso) :
    (view === "laborCalc") ? renderLaborCalc(iso) :
    renderCostBase(iso);

  setInfo(title, tabs + body);
}

// ---------------- Init ----------------
async function init() {
  setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);

  // 데이터 로드 + 로그
  try {
    const { json, url } = await fetchJsonFirstOk(DATA_URLS, "countrydata.json");
    countryData = json || {};
    console.log("[countrydata] loaded:", url, "keys:", Object.keys(countryData));
  } catch (e) {
    countryData = {};
    console.warn("[countrydata] load failed:", e);
    setInfo("오류", `<div class="muted">데이터 파일을 불러오지 못했습니다. (data/countrydata.json 경로 확인)</div>`);
    // 지도는 그래도 뜨게 진행
  }

  map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
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

        view = "costbase";
        renderPanel(isoRaw, name);
      });
    } catch (e) {
      console.warn(e);
      setInfo("오류", `<div class="muted">지도 데이터를 불러오지 못했습니다. (data/countries.geojson 경로 확인)</div>`);
    }
  });

  // 검색
  const doSearch = () => {
    const q = searchInput.value.trim();
    if (!q || !countriesGeo?.features?.length) return;

    const qn = norm(q);

    const f = countriesGeo.features.find((ft) => {
      const props = ft.properties || {};
      const isoRaw = (props.__iso || "UNK").toString().trim().toUpperCase();
      const name = props.__name || getName(props);
      const isoGood = (isIso3(isoRaw) && isoRaw !== "UNK") ? isoRaw : null;
      const dataName = isoGood ? (countryData?.[isoGood]?.name_ko || countryData?.[isoGood]?.name || "") : "";
      return norm(name).includes(qn) || norm(isoRaw).includes(qn) || norm(dataName).includes(qn);
    });

    if (!f) {
      setInfo("국가를 선택하세요", `<div class="muted">검색 결과가 없습니다.</div>`);
      return;
    }

    const props = f.properties || {};
    const fid = props.__fid;
    const isoRaw = (props.__iso || "UNK").toString().trim().toUpperCase();
    const name = props.__name || getName(props) || "국가";

    selectedFID = fid;
    selectedName = name;

    highlightFID(fid);

    if (f.geometry) {
      const bbox = computeBbox(f.geometry);
      if (isFinite(bbox?.[0]?.[0])) map.fitBounds(bbox, { padding: 60, duration: 700 });
    }

    view = "costbase";
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
    view = "costbase";

    setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);
    highlightFID(null);
  });

  // info 영역 이벤트 위임
  const infoEl = document.getElementById("info");

  infoEl.addEventListener("click", (e) => {
    const csvBtn = e.target.closest('button[data-action="csv"]');
    if (csvBtn) {
      exportCurrentCSV();
      return;
    }

    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    view = btn.dataset.view;
    renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
  });

  // 공사원가 분기 선택 / 인라인 인건비 연도 선택
  infoEl.addEventListener("change", (e) => {
    const field = e.target?.getAttribute?.("data-field");
    if (!field) return;

    if (field === "matPeriod") {
      materialCalcState.period = e.target.value;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }

    if (field === "laborYearInline") {
      laborCalcState.year = e.target.value;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }

    if (field === "matCalcPeriod") {
      materialCalcState.period = e.target.value;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }

    if (field === "laborCalcYear") {
      laborCalcState.year = e.target.value;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }
  });

  // 자재비계산 수량 입력 / 인건비계산 man-day 입력
  infoEl.addEventListener("input", (e) => {
    const mKey = e.target?.getAttribute?.("data-mqty");
    if (mKey) {
      materialCalcState.qty[mKey] = e.target.value;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }

    const mdKey = e.target?.getAttribute?.("data-md");
    if (mdKey) {
      laborCalcState.manDays[mdKey] = e.target.value;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
