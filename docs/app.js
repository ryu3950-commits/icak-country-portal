// app.js (FINAL)
// - Middle East zoom on load
// - "공사원가" = 분기별 단가(materialsQuarterly) 기반 표시 (0 문제 해결)
// - "자재비계산" = 분기 단가 * 수량
// - "인건비계산" = 한국 vs UAE vs 로봇(파일 수치 기반) 비교
// - "비작업일수" = 12개월 자동 복구(ARE/VNM) + 표 표시
// - CSV 다운로드: 공사원가(선택분기) + 비작업일수(12개월)

// =========================
// URLs
// =========================
const GEOJSON_URLS = [
  "./data/countries.geojson",
  "./data/countries.json",
  "./countries.geojson",
  "./country-demo/data/countries.geojson",
  "./docs/data/countries.geojson",
];

const DATA_URLS = [
  "./data/countrydata.json",
  "./data/countryData.json",
  "./countrydata.json",
  "./countryData.json",
  "./country-demo/data/countrydata.json",
  "./docs/data/countrydata.json",
];

// MapLibre demo style
const MAP_STYLE = "https://demotiles.maplibre.org/style.json";

// =========================
// DOM
// =========================
const infoTitle = document.getElementById("infoTitle");
const infoBody = document.getElementById("infoBody");

const searchInput = document.getElementById("searchInput");
const clearBtn = document.getElementById("clearBtn");
const searchBtn = document.getElementById("searchBtn");
const advancedBtn = document.getElementById("advancedBtn");

// =========================
// State
// =========================
let map;
let countriesGeo = null;
let countryData = {};

let selectedISO = null;     // ISO3 (ARE)
let selectedIsoRaw = "UNK"; // raw from geojson
let selectedFID = null;
let selectedName = null;

let view = "cost";          // cost | calc | labor | nonwork
let selectedPeriod = null;  // e.g. "2026Q1"

// =========================
// Defaults (비작업일수 원상복구용)
// =========================
const DEFAULT_ARE_NONWORK = [
  { month: "1월",  avgTemp: 19.4, avgHighLow: "23.4/15.0", storm: 0.49, weekend: 9,  holidayWeekday: 1, fixedOff: 10, eqOff8h: 10.2, note: "모래폭풍/샤말 빈도↑" },
  { month: "2월",  avgTemp: 20.5, avgHighLow: "25.0/15.7", storm: 0.58, weekend: 8,  holidayWeekday: 0, fixedOff: 8,  eqOff8h: 10.2, note: "라마단(-2h/일), 모래폭풍/샤말 빈도↑" },
  { month: "3월",  avgTemp: 23.1, avgHighLow: "28.2/17.9", storm: 0.58, weekend: 9,  holidayWeekday: 1, fixedOff: 10, eqOff8h: 13.7, note: "라마단(-2h/일), 모래폭풍/샤말 빈도↑" },
  { month: "4월",  avgTemp: 27.3, avgHighLow: "32.8/21.5", storm: 0.35, weekend: 8,  holidayWeekday: 0, fixedOff: 8,  eqOff8h: 8.1,  note: "-" },
  { month: "5월",  avgTemp: 31.3, avgHighLow: "36.9/25.2", storm: 0.15, weekend: 10, holidayWeekday: 4, fixedOff: 14, eqOff8h: 14.1, note: "-" },
  { month: "6월",  avgTemp: 33.0, avgHighLow: "38.5/27.3", storm: 0.09, weekend: 8,  holidayWeekday: 0, fixedOff: 8,  eqOff8h: 11.8, note: "혹서기 한낮작업금지(12:30-15:00)" },
  { month: "7월",  avgTemp: 34.9, avgHighLow: "40.0/29.6", storm: 0.09, weekend: 8,  holidayWeekday: 0, fixedOff: 8,  eqOff8h: 15.2, note: "혹서기 한낮작업금지(12:30-15:00)" },
  { month: "8월",  avgTemp: 35.3, avgHighLow: "40.7/30.0", storm: 0.09, weekend: 10, holidayWeekday: 0, fixedOff: 10, eqOff8h: 16.6, note: "혹서기 한낮작업금지(12:30-15:00)" },
  { month: "9월",  avgTemp: 33.0, avgHighLow: "38.4/27.8", storm: 0.09, weekend: 8,  holidayWeekday: 0, fixedOff: 8,  eqOff8h: 11.5, note: "혹서기 한낮작업금지(12:30-15:00)" },
  { month: "10월", avgTemp: 30.0, avgHighLow: "35.0/24.7", storm: 0.15, weekend: 9,  holidayWeekday: 0, fixedOff: 9,  eqOff8h: 9.1,  note: "-" },
  { month: "11월", avgTemp: 25.7, avgHighLow: "29.9/21.1", storm: 0.15, weekend: 9,  holidayWeekday: 0, fixedOff: 9,  eqOff8h: 9.1,  note: "-" },
  { month: "12월", avgTemp: 21.5, avgHighLow: "25.5/17.3", storm: 0.41, weekend: 8,  holidayWeekday: 2, fixedOff: 10, eqOff8h: 10.2, note: "모래폭풍/샤말 빈도↑" },
];

const DEFAULT_VNM_NONWORK = [
  { month: "1월",  avgTemp: 26.1, avgHighLow: "30.8/22.2", rainDays: 0.9, weekend: 9,  holidayWeekday: 2, fixedOff: 11, eqOff8h: 11.1, note: "공휴일(평일)" },
  { month: "2월",  avgTemp: 27.1, avgHighLow: "32.5/22.9", rainDays: 0.6, weekend: 8,  holidayWeekday: 5, fixedOff: 13, eqOff8h: 13.1, note: "공휴일(평일)" },
  { month: "3월",  avgTemp: 28.3, avgHighLow: "33.6/24.5", rainDays: 1.6, weekend: 9,  holidayWeekday: 0, fixedOff: 9,  eqOff8h: 9.2,  note: "-" },
  { month: "4월",  avgTemp: 28.9, avgHighLow: "33.8/25.6", rainDays: 4.3, weekend: 8,  holidayWeekday: 2, fixedOff: 10, eqOff8h: 10.6, note: "공휴일(평일)" },
  { month: "5월",  avgTemp: 28.1, avgHighLow: "32.3/25.5", rainDays: 11.7, weekend: 10, holidayWeekday: 1, fixedOff: 11, eqOff8h: 12.8, note: "공휴일(평일), 우기(강우일↑)" },
  { month: "6월",  avgTemp: 27.1, avgHighLow: "30.9/24.9", rainDays: 15.9, weekend: 8,  holidayWeekday: 0, fixedOff: 8,  eqOff8h: 10.4, note: "우기(강우일↑)" },
  { month: "7월",  avgTemp: 26.8, avgHighLow: "30.5/24.6", rainDays: 16.7, weekend: 8,  holidayWeekday: 0, fixedOff: 8,  eqOff8h: 10.5, note: "우기(강우일↑)" },
  { month: "8월",  avgTemp: 26.7, avgHighLow: "30.5/24.4", rainDays: 15.7, weekend: 10, holidayWeekday: 1, fixedOff: 11, eqOff8h: 13.4, note: "공휴일(평일), 우기(강우일↑)" },
  { month: "9월",  avgTemp: 26.5, avgHighLow: "30.4/24.2", rainDays: 16.6, weekend: 8,  holidayWeekday: 2, fixedOff: 10, eqOff8h: 12.5, note: "공휴일(평일), 우기(강우일↑)" },
  { month: "10월", avgTemp: 26.3, avgHighLow: "30.1/23.9", rainDays: 16.5, weekend: 9,  holidayWeekday: 0, fixedOff: 9,  eqOff8h: 11.5, note: "우기(강우일↑)" },
  { month: "11월", avgTemp: 26.3, avgHighLow: "30.1/23.5", rainDays: 8.4, weekend: 9,  holidayWeekday: 0, fixedOff: 9,  eqOff8h: 10.3, note: "-" },
  { month: "12월", avgTemp: 26.0, avgHighLow: "30.2/22.6", rainDays: 2.9, weekend: 8,  holidayWeekday: 0, fixedOff: 8,  eqOff8h: 8.4,  note: "-" },
];

// =========================
// Helpers
// =========================
const isIso3 = (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v) && v !== "-99";
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
    if (v !== undefined && v !== null && v !== "") return v; // 0 is valid
  }
  return fallback;
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

// Geo helpers
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
    "ISO_A3","iso_a3","ISO3","iso3","ADM0_A3","adm0_a3","SOV_A3","sov_a3",
    "ISO_A3_EH","iso_a3_eh","ISO3166_A3","ISO_3","iso_3",
  ];
  for (const k of candidates) {
    const v = props[k];
    if (isIso3(v)) return String(v).toUpperCase();
  }
  for (const v of Object.values(props)) {
    if (isIso3(v)) return String(v).toUpperCase();
  }
  return null;
}

function isoFallbackByName(name) {
  const n = norm(name);
  if (n.includes("united arab emirates") || n.includes("uae") || n.includes("아랍에미리트")) return "ARE";
  if (n.includes("vietnam") || n.includes("베트남")) return "VNM";
  return null;
}

function preprocessCountriesGeo(geo) {
  const features = geo?.features || [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    f.properties = f.properties || {};

    const name = getName(f.properties) || "Unknown";
    const iso = getISOFromProps(f.properties) || isoFallbackByName(name) || "UNK";
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

// =========================
// Data normalization
// =========================
function ensureNonWork12(d, iso) {
  if (!d) return;
  if (!Array.isArray(d.nonWorkDays) || d.nonWorkDays.length < 12) {
    if (iso === "ARE") d.nonWorkDays = DEFAULT_ARE_NONWORK.slice();
    if (iso === "VNM") d.nonWorkDays = DEFAULT_VNM_NONWORK.slice();
  }
}

// period list
function getPeriods(d) {
  const s = d?.materialsQuarterly?.series;
  if (!Array.isArray(s) || !s.length) return [];
  return s.map(x => x.period).filter(Boolean);
}

function getSeriesRowByPeriod(d, period) {
  const s = d?.materialsQuarterly?.series;
  if (!Array.isArray(s)) return null;
  return s.find(x => x.period === period) || null;
}

function normalizeCountryData(raw) {
  // case1) already correct: { ARE:{...}, VNM:{...} }
  if (raw && (raw.ARE || raw.VNM)) {
    if (raw.ARE) ensureNonWork12(raw.ARE, "ARE");
    if (raw.VNM) ensureNonWork12(raw.VNM, "VNM");
    return raw;
  }

  // case2) only { constructionCost: ... } 형태로 들어온 경우 (예전 상태)
  if (raw && raw.constructionCost && raw.constructionCost.series) {
    return {
      ARE: {
        name: "아랍에미리트(UAE)",
        updated: "",
        materials: [
          { key: "rebar", item: "철근", unit: "USD/t" },
          { key: "concrete", item: "레미콘", unit: "USD/m3" },
        ],
        materialsQuarterly: {
          currency: raw.constructionCost.currency || "USD",
          units: raw.constructionCost.units || { rebar: "USD/t", concrete: "USD/m3" },
          series: raw.constructionCost.series.map(r => ({
            period: r.period,
            rebar: r.rebar_usd_per_t,
            concrete: r.concrete_usd_per_m3,
          })),
        },
        nonWorkDays: DEFAULT_ARE_NONWORK.slice(),
      }
    };
  }

  // fallback
  return raw || {};
}

// =========================
// CSV
// =========================
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

// =========================
// UI builders
// =========================
function buttonStyle(active) {
  return [
    "padding:10px 12px",
    "border:1px solid #e5e7eb",
    "border-radius:14px",
    `background:${active ? "#111827" : "#ffffff"}`,
    `color:${active ? "#ffffff" : "#111827"}`,
    "cursor:pointer",
    "font-size:14px",
    "white-space:nowrap",
  ].join(";");
}

function renderTopNav() {
  return `
    <div style="display:flex; gap:8px; flex-wrap:wrap; margin:10px 0 12px; align-items:center;">
      <button data-view="cost"   style="${buttonStyle(view==="cost")}">공사원가</button>
      <button data-view="calc"   style="${buttonStyle(view==="calc")}">자재비계산</button>
      <button data-view="labor"  style="${buttonStyle(view==="labor")}">인건비계산</button>
      <button data-view="nonwork" style="${buttonStyle(view==="nonwork")}">비작업일수</button>
      <button data-action="csv" style="${[
        "padding:10px 12px",
        "border:1px solid #e5e7eb",
        "border-radius:14px",
        "background:#ffffff",
        "color:#111827",
        "cursor:pointer",
        "font-size:14px",
      ].join(";")}">CSV</button>
    </div>
  `;
}

function renderPeriodSelect(d) {
  const periods = getPeriods(d);
  if (!periods.length) return `<div class="muted">분기 데이터가 없습니다.</div>`;

  if (!selectedPeriod || !periods.includes(selectedPeriod)) {
    selectedPeriod = periods[periods.length - 1]; // latest
  }

  const options = periods.map(p => `<option value="${esc(p)}" ${p===selectedPeriod?"selected":""}>${esc(p)}</option>`).join("");
  return `
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:6px 0 12px;">
      <div style="font-weight:700;">기준 분기</div>
      <select id="periodSelect" style="padding:8px 10px;border:1px solid #e5e7eb;border-radius:12px;">
        ${options}
      </select>
    </div>
  `;
}

// =========================
// Renderers
// =========================
function renderCostTable(d) {
  const row = getSeriesRowByPeriod(d, selectedPeriod) || {};
  const items = Array.isArray(d.materials) ? d.materials : [];

  const bodyRows = items.map(it => {
    const key = it.key;
    const price = row?.[key];
    const unit = it.unit || d?.materialsQuarterly?.units?.[key] || "";

    const priceText = (typeof price === "number")
      ? price.toLocaleString(undefined, { maximumFractionDigits: 3 })
      : (price !== undefined && price !== null ? String(price) : "-");

    return `
      <tr>
        <td>${esc(it.item || key)}</td>
        <td class="right">${esc(priceText)}</td>
        <td>${esc(unit)}</td>
      </tr>
    `;
  }).join("");

  return `
    ${renderPeriodSelect(d)}
    <table class="table">
      <thead>
        <tr><th>품목</th><th class="right">가격</th><th>단위</th></tr>
      </thead>
      <tbody>
        ${bodyRows || `<tr><td colspan="3">데이터 없음</td></tr>`}
      </tbody>
    </table>
  `;
}

function renderMaterialCalc(d) {
  const row = getSeriesRowByPeriod(d, selectedPeriod) || {};
  const items = Array.isArray(d.materials) ? d.materials : [];

  const inputs = items.map(it => {
    const key = it.key;
    const unit = it.unit || d?.materialsQuarterly?.units?.[key] || "";
    return `
      <tr>
        <td>${esc(it.item || key)}</td>
        <td><input data-mqty="${esc(key)}" type="number" step="any" value="0"
                   style="width:140px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" /></td>
        <td>${esc(unit)}</td>
        <td class="right"><span data-mprice="${esc(key)}">-</span></td>
        <td class="right"><span data-msub="${esc(key)}">0</span></td>
      </tr>
    `;
  }).join("");

  return `
    ${renderPeriodSelect(d)}
    <div class="muted">선택 분기의 단가 × 입력 수량으로 합계를 계산합니다.</div>
    <table class="table">
      <thead>
        <tr>
          <th>품목</th>
          <th class="right">수량</th>
          <th>단위</th>
          <th class="right">단가(선택분기)</th>
          <th class="right">금액(USD)</th>
        </tr>
      </thead>
      <tbody>
        ${inputs || `<tr><td colspan="5">데이터 없음</td></tr>`}
      </tbody>
      <tfoot>
        <tr>
          <td colspan="4" class="right" style="font-weight:800;">합계</td>
          <td class="right" style="font-weight:900;"><span id="matTotal">0</span></td>
        </tr>
      </tfoot>
    </table>
  `;
}

function renderNonWork(d) {
  const nwd = Array.isArray(d.nonWorkDays) ? d.nonWorkDays : [];
  const isDesert = nwd.some(r => r.storm !== undefined || r.sandstorm !== undefined || r.shamal !== undefined);

  const thirdCol = isDesert ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";

  const rows = nwd.map(r => {
    const month = pick(r, ["month","m","mon"], "");
    const avgTemp = pick(r, ["avgTemp","tAvg"], "");
    const hiLo = pick(r, ["avgHighLow","avgHighLowC","avgHighLowStr","avgHighLowStrC","avgHighLow","avgHighLowC","avgHighLowStr","avgHighLowStrC","avgHighLowC","avgHighLowStr","avgHighLowStrC","avgHighLow"], "") || pick(r, ["avgHighLow","avgHighLowStr","avgHighLowC","avgHighLowStrC","avgHighLowC"], "") || pick(r, ["avgHighLow"], "");

    const storm = pick(r, ["storm","sandstorm","dustStorm","shamal"], "");
    const rain = pick(r, ["rainDays","rain_day","rainyDays"], "");
    const weekend = pick(r, ["weekend","weekendDays"], "");
    const holiday = pick(r, ["holidayWeekday","holiday","holidayWeekdays"], "");
    const fixed = pick(r, ["fixedOff","fixedOffDays","confirmedOff","confirmedNonwork"], "");
    const eq = pick(r, ["eqOff8h","equivOff8h","eqOff","equivalentOff8h"], "");
    const note = pick(r, ["note","remark","remarks"], "");

    return `
      <tr>
        <td>${esc(month)}</td>
        <td class="right">${esc(avgTemp)}</td>
        <td class="right">${esc(hiLo)}</td>
        <td class="right">${esc(isDesert ? storm : rain)}</td>
        <td class="right">${esc(weekend)}</td>
        <td class="right">${esc(holiday)}</td>
        <td class="right">${esc(fixed)}</td>
        <td class="right">${esc(eq)}</td>
        <td>${esc(note)}</td>
      </tr>
    `;
  }).join("");

  return `
    <div class="muted">UAE는 사막형(모래폭풍), 베트남은 강우일 기준으로 표시됩니다.</div>
    <table class="table">
      <thead>
        <tr>
          <th>월</th>
          <th class="right">평균기온</th>
          <th class="right">평균최고/최저</th>
          <th class="right">${thirdCol}</th>
          <th class="right">주말</th>
          <th class="right">공휴일(평일)</th>
          <th class="right">확정 비작업일</th>
          <th class="right">등가 비작업일(8h)</th>
          <th>비고</th>
        </tr>
      </thead>
      <tbody>
        ${rows || `<tr><td colspan="9">데이터 없음</td></tr>`}
      </tbody>
    </table>
  `;
}

function renderLaborCalc(d) {
  // PDF 핵심 수치 (연간 세척비용 / 속도) :contentReference[oaicite:1]{index=1}
  const DEFAULT_ROBOT_USD_PER_M2_YEAR = 59.76;
  const DEFAULT_MANUAL_USD_PER_M2_YEAR = 21.07;

  // 속도(패널/시간) 범위 :contentReference[oaicite:2]{index=2}
  const DEFAULT_ROBOT_PPH = 180;  // 150~200 중간값
  const DEFAULT_MANUAL_PPH = 18;  // 15~20 중간값

  return `
    <div class="muted">
      올해 기준(입력값 기반)으로 한국 인건비/아랍에미리트 인건비/로봇을 비교합니다.  
      (로봇·인력 세척 단가/속도는 제공한 자료의 대표값을 기본으로 넣었습니다.)
    </div>

    <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:10px 0 12px;">
      <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:800; margin-bottom:8px;">① 현장 규모</div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <div>패널 수</div>
          <input id="panelsCount" type="number" value="100000" step="1"
                 style="width:160px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
          <div>패널 면적(m²/장)</div>
          <input id="panelArea" type="number" value="2.0" step="any"
                 style="width:120px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
          <div>연 세척 횟수</div>
          <input id="cleanCycles" type="number" value="12" step="1"
                 style="width:100px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
        </div>
        <div class="muted" style="margin-top:8px;">총 면적 = 패널수 × 패널면적</div>
      </div>

      <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:800; margin-bottom:8px;">② 기본 단가(연간)</div>
        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
          <div>로봇(USD/m²·year)</div>
          <input id="robotUsdPerM2Year" type="number" value="${DEFAULT_ROBOT_USD_PER_M2_YEAR}" step="any"
                 style="width:140px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
          <div>인력(USD/m²·year)</div>
          <input id="manualUsdPerM2Year" type="number" value="${DEFAULT_MANUAL_USD_PER_M2_YEAR}" step="any"
                 style="width:140px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
        </div>
      </div>
    </div>

    <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px; margin-bottom:12px;">
      <div style="font-weight:800; margin-bottom:8px;">③ 인건비 입력(올해 기준)</div>
      <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px;">
        <div>
          <div style="font-weight:700; margin-bottom:6px;">UAE (AED → USD)</div>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <div>월급(AED)</div>
            <input id="uaeMonthlyAed" type="number" value="2500" step="any"
                   style="width:120px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
            <div>AED→USD</div>
            <input id="aedToUsd" type="number" value="0.272" step="any"
                   style="width:100px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
            <div>월 근무일</div>
            <input id="uaeDaysPerMonth" type="number" value="26" step="1"
                   style="width:80px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
            <div>일 근무시간</div>
            <input id="uaeHoursPerDay" type="number" value="8" step="any"
                   style="width:80px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
          </div>
        </div>

        <div>
          <div style="font-weight:700; margin-bottom:6px;">한국 (KRW → USD)</div>
          <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
            <div>일급(KRW)</div>
            <input id="krDailyKrw" type="number" value="200000" step="any"
                   style="width:140px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
            <div>KRW→USD</div>
            <input id="krwToUsd" type="number" value="0.00075" step="any"
                   style="width:110px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
            <div>일 근무시간</div>
            <input id="krHoursPerDay" type="number" value="8" step="any"
                   style="width:80px;padding:8px;border:1px solid #e5e7eb;border-radius:10px;" />
          </div>
        </div>
      </div>

      <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-top:10px;">
        <label style="display:flex; gap:6px; align-items:center;">
          <input id="applyRamadan" type="checkbox" />
          라마단(생산성↓) 반영
        </label>
        <label style="display:flex; gap:6px; align-items:center;">
          <input id="applyPrayerLoss" type="checkbox" />
          기도시간 손실(1h/day) 반영
        </label>
      </div>

      <div class="muted" style="margin-top:8px;">
        * 라마단/기도시간 수치는 자료의 “시간 단축/손실” 항목을 반영하는 옵션입니다. :contentReference[oaicite:3]{index=3}
      </div>
    </div>

    <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
      <div style="font-weight:900; margin-bottom:8px;">④ 결과</div>

      <table class="table">
        <thead>
          <tr>
            <th>항목</th>
            <th class="right">로봇</th>
            <th class="right">UAE 인력</th>
            <th class="right">한국 인력</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>총 면적(m²)</td>
            <td class="right" colspan="3"><span id="outArea">-</span></td>
          </tr>
          <tr>
            <td>연간 세척비용(단가 기반, USD/yr)</td>
            <td class="right"><span id="outRobotAnnual">-</span></td>
            <td class="right"><span id="outManualAnnual">-</span></td>
            <td class="right"><span id="outManualAnnualKR">-</span></td>
          </tr>
          <tr>
            <td>세척시간(속도 기반, hr/yr)</td>
            <td class="right"><span id="outRobotHours">-</span></td>
            <td class="right"><span id="outManualHours">-</span></td>
            <td class="right"><span id="outManualHoursKR">-</span></td>
          </tr>
          <tr>
            <td>인건비(속도×시간×시급, USD/yr)</td>
            <td class="right">-</td>
            <td class="right"><span id="outLaborCostUAE">-</span></td>
            <td class="right"><span id="outLaborCostKR">-</span></td>
          </tr>
        </tbody>
      </table>

      <div class="muted" style="margin-top:10px;">
        ※ “단가 기반”은 USD/m²·year를 바로 곱한 값, “속도 기반”은 패널/시간 속도로 총 시간 산정 후 시급을 곱한 값입니다.
      </div>
    </div>
  `;
}

function renderPanel(isoRaw, fallbackName) {
  selectedIsoRaw = isoRaw || "UNK";
  const iso = (isIso3(selectedIsoRaw) && selectedIsoRaw !== "UNK") ? selectedIsoRaw : null;
  selectedISO = iso;

  // title
  let title = fallbackName || (isoRaw || "선택 국가");
  if (iso && countryData?.[iso]?.name) title = countryData[iso].name;

  const nav = renderTopNav();

  if (!iso) {
    setInfo(title, nav + `<div class="muted">이 국가의 상세 데이터가 없습니다.</div>`);
    return;
  }

  const d = countryData?.[iso];
  if (!d) {
    setInfo(title, nav + `<div class="muted">이 국가의 상세 데이터가 없습니다.</div>`);
    return;
  }

  // ensure nonWorkDays 12 months
  ensureNonWork12(d, iso);

  // pick default period
  const periods = getPeriods(d);
  if (periods.length) {
    if (!selectedPeriod || !periods.includes(selectedPeriod)) {
      selectedPeriod = periods[periods.length - 1];
    }
  }

  let body = "";
  if (view === "cost") body = renderCostTable(d);
  else if (view === "calc") body = renderMaterialCalc(d);
  else if (view === "labor") body = renderLaborCalc(d);
  else body = renderNonWork(d);

  setInfo(title, nav + body);
}

// =========================
// Wiring: material calc update
// =========================
function updateMaterialCalcUI() {
  if (!selectedISO) return;
  const d = countryData?.[selectedISO];
  if (!d) return;

  const row = getSeriesRowByPeriod(d, selectedPeriod) || {};
  const items = Array.isArray(d.materials) ? d.materials : [];

  let total = 0;

  for (const it of items) {
    const key = it.key;
    const unitPrice = row?.[key];
    const priceEl = document.querySelector(`[data-mprice="${CSS.escape(key)}"]`);
    const qtyEl = document.querySelector(`[data-mqty="${CSS.escape(key)}"]`);
    const subEl = document.querySelector(`[data-msub="${CSS.escape(key)}"]`);

    const priceText = (typeof unitPrice === "number")
      ? unitPrice.toLocaleString(undefined, { maximumFractionDigits: 3 })
      : (unitPrice !== undefined && unitPrice !== null ? String(unitPrice) : "-");

    if (priceEl) priceEl.textContent = priceText;

    const qty = qtyEl ? Number(qtyEl.value || 0) : 0;
    const sub = (typeof unitPrice === "number") ? (unitPrice * qty) : 0;
    total += sub;

    if (subEl) subEl.textContent = sub.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }

  const totalEl = document.getElementById("matTotal");
  if (totalEl) totalEl.textContent = total.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// =========================
// Wiring: labor calc update
// =========================
function fmtMoney(x) {
  if (!isFinite(x)) return "-";
  return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function fmtNum(x) {
  if (!isFinite(x)) return "-";
  return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function updateLaborCalcUI() {
  const panels = Number(document.getElementById("panelsCount")?.value || 0);
  const panelArea = Number(document.getElementById("panelArea")?.value || 0);
  const cycles = Number(document.getElementById("cleanCycles")?.value || 0);

  const robotUsdPerM2Year = Number(document.getElementById("robotUsdPerM2Year")?.value || 0);
  const manualUsdPerM2Year = Number(document.getElementById("manualUsdPerM2Year")?.value || 0);

  const uaeMonthlyAed = Number(document.getElementById("uaeMonthlyAed")?.value || 0);
  const aedToUsd = Number(document.getElementById("aedToUsd")?.value || 0);
  const uaeDaysPerMonth = Number(document.getElementById("uaeDaysPerMonth")?.value || 0);
  const uaeHoursPerDay = Number(document.getElementById("uaeHoursPerDay")?.value || 0);

  const krDailyKrw = Number(document.getElementById("krDailyKrw")?.value || 0);
  const krwToUsd = Number(document.getElementById("krwToUsd")?.value || 0);
  const krHoursPerDay = Number(document.getElementById("krHoursPerDay")?.value || 0);

  const applyRamadan = !!document.getElementById("applyRamadan")?.checked;
  const applyPrayerLoss = !!document.getElementById("applyPrayerLoss")?.checked;

  // area
  const totalArea = panels * panelArea;

  // annual cost by unit cost
  const robotAnnual = totalArea * robotUsdPerM2Year;
  const manualAnnual = totalArea * manualUsdPerM2Year;

  // speed-based hours
  const ROBOT_PPH = 180;
  const MANUAL_PPH = 18;

  // total cleaning panel-count per year
  const totalPanelsPerYear = panels * cycles;

  let robotHours = (ROBOT_PPH > 0) ? (totalPanelsPerYear / ROBOT_PPH) : 0;
  let manualHours = (MANUAL_PPH > 0) ? (totalPanelsPerYear / MANUAL_PPH) : 0;

  // productivity adjustment: Ramadan (8h->6h => need 8/6 = 1.333x hours)
  if (applyRamadan) {
    const ramadanFactor = 8 / 6;
    robotHours *= ramadanFactor;
    manualHours *= ramadanFactor;
  }
  // prayer loss: 하루 1h 손실 => 유효근무시간 감소, 시간 필요량 증가(간단히 8/(8-1)=1.1429x)
  if (applyPrayerLoss) {
    const base = 8;
    const effective = 7;
    const prayerFactor = base / effective;
    robotHours *= prayerFactor;
    manualHours *= prayerFactor;
  }

  // hourly wage
  const uaeMonthlyUsd = uaeMonthlyAed * aedToUsd;
  const uaeHourly = (uaeDaysPerMonth > 0 && uaeHoursPerDay > 0) ? (uaeMonthlyUsd / (uaeDaysPerMonth * uaeHoursPerDay)) : 0;

  const krDailyUsd = krDailyKrw * krwToUsd;
  const krHourly = (krHoursPerDay > 0) ? (krDailyUsd / krHoursPerDay) : 0;

  const laborCostUAE = manualHours * uaeHourly; // assume manual cleaning by labor
  const laborCostKR = manualHours * krHourly;

  // output
  const outArea = document.getElementById("outArea");
  const outRobotAnnual = document.getElementById("outRobotAnnual");
  const outManualAnnual = document.getElementById("outManualAnnual");
  const outManualAnnualKR = document.getElementById("outManualAnnualKR");
  const outRobotHours = document.getElementById("outRobotHours");
  const outManualHours = document.getElementById("outManualHours");
  const outManualHoursKR = document.getElementById("outManualHoursKR");
  const outLaborCostUAE = document.getElementById("outLaborCostUAE");
  const outLaborCostKR = document.getElementById("outLaborCostKR");

  if (outArea) outArea.textContent = fmtNum(totalArea);
  if (outRobotAnnual) outRobotAnnual.textContent = fmtMoney(robotAnnual);
  if (outManualAnnual) outManualAnnual.textContent = fmtMoney(manualAnnual);
  if (outManualAnnualKR) outManualAnnualKR.textContent = fmtMoney(manualAnnual); // 같은 단가표시(필요하면 한국 단가로 따로 입력 필드 추가 가능)

  if (outRobotHours) outRobotHours.textContent = fmtNum(robotHours);
  if (outManualHours) outManualHours.textContent = fmtNum(manualHours);
  if (outManualHoursKR) outManualHoursKR.textContent = fmtNum(manualHours);

  if (outLaborCostUAE) outLaborCostUAE.textContent = fmtMoney(laborCostUAE);
  if (outLaborCostKR) outLaborCostKR.textContent = fmtMoney(laborCostKR);
}

// =========================
// CSV export (공사원가(선택분기) + 비작업일수)
// =========================
function exportCSV() {
  if (!selectedISO) {
    alert("먼저 국가를 선택하세요.");
    return;
  }
  const d = countryData?.[selectedISO];
  if (!d) {
    alert(`데이터 없음: ${selectedISO}`);
    return;
  }

  // 1) 공사원가(선택 분기)
  const row = getSeriesRowByPeriod(d, selectedPeriod) || {};
  const items = Array.isArray(d.materials) ? d.materials : [];

  const costHeaders = ["분기", "품목", "가격", "단위"];
  const costRows = items.map(it => {
    const key = it.key;
    const unit = it.unit || d?.materialsQuarterly?.units?.[key] || "";
    const price = row?.[key];
    return [selectedPeriod || "", it.item || key, price ?? "", unit];
  });

  downloadCSV(`${selectedISO}_공사원가_${selectedPeriod || "period"}.csv`, rowsToCSV(costHeaders, costRows));

  // 2) 비작업일수
  ensureNonWork12(d, selectedISO);
  const nwd = Array.isArray(d.nonWorkDays) ? d.nonWorkDays : [];
  const isDesert = nwd.some(r => r.storm !== undefined || r.sandstorm !== undefined || r.shamal !== undefined);
  const third = isDesert ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";

  const nwHeaders = ["월","평균기온","평균최고/최저", third, "주말", "공휴일(평일)", "확정 비작업일", "등가 비작업일(8h)", "비고"];
  const nwRows = nwd.map(r => {
    const month = pick(r, ["month","m","mon"], "");
    const avgTemp = pick(r, ["avgTemp","tAvg"], "");
    const hiLo = pick(r, ["avgHighLow","avgHighLowStr","avgHighLowC","avgHighLowStrC"], "") || pick(r, ["avgHighLow"], "");
    const storm = pick(r, ["storm","sandstorm","dustStorm","shamal"], "");
    const rain = pick(r, ["rainDays","rain_day","rainyDays"], "");
    const weekend = pick(r, ["weekend","weekendDays"], "");
    const holiday = pick(r, ["holidayWeekday","holiday","holidayWeekdays"], "");
    const fixed = pick(r, ["fixedOff","fixedOffDays","confirmedOff","confirmedNonwork"], "");
    const eq = pick(r, ["eqOff8h","equivOff8h","eqOff","equivalentOff8h"], "");
    const note = pick(r, ["note","remark","remarks"], "");
    return [month, avgTemp, hiLo, (isDesert ? storm : rain), weekend, holiday, fixed, eq, note];
  });

  setTimeout(() => {
    downloadCSV(`${selectedISO}_비작업일수.csv`, rowsToCSV(nwHeaders, nwRows));
  }, 200);
}

// =========================
// Init
// =========================
async function init() {
  setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);

  // Load data
  try {
    const { json } = await fetchJsonFirstOk(DATA_URLS, "countrydata.json");
    countryData = normalizeCountryData(json);
  } catch (e) {
    countryData = {};
  }

  // Create map (Middle East zoom)
  map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [50, 24], // Middle East
    zoom: 3.2,
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
        const isoRaw = props.__iso || getISOFromProps(props) || "UNK";
        const name = props.__name || getName(props) || "국가";

        selectedFID = fid;
        selectedName = name;

        highlightFID(fid);

        // fit
        if (f.geometry) {
          const bbox = computeBbox(f.geometry);
          if (isFinite(bbox?.[0]?.[0])) map.fitBounds(bbox, { padding: 60, duration: 700 });
        }

        view = "cost";
        renderPanel(isoRaw, name);
        afterRenderHook();
      });

      // (옵션) 시작 시 UAE 자동 선택하고 싶으면 아래 활성화:
      // selectedISO = "ARE";
      // selectedIsoRaw = "ARE";
      // view = "cost";
      // renderPanel("ARE", "아랍에미리트(UAE)");
      // afterRenderHook();

    } catch (e) {
      setInfo("오류", `<div class="muted">지도 데이터를 불러오지 못했습니다.</div>`);
    }
  });

  // Search
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

    view = "cost";
    renderPanel(isoRaw, name);
    afterRenderHook();
  };

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    selectedISO = null;
    selectedIsoRaw = "UNK";
    selectedFID = null;
    selectedName = null;
    view = "cost";
    selectedPeriod = null;
    setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);
    highlightFID(null);
  });

  advancedBtn.addEventListener("click", () => alert(" "));

  // Info area delegation
  document.getElementById("info").addEventListener("click", (e) => {
    const csvBtn = e.target.closest('button[data-action="csv"]');
    if (csvBtn) {
      exportCSV();
      return;
    }

    const btn = e.target.closest("button[data-view]");
    if (btn) {
      view = btn.dataset.view;
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      afterRenderHook();
    }
  });

  // Period select / inputs delegation (change)
  document.getElementById("info").addEventListener("change", (e) => {
    const sel = e.target.closest("#periodSelect");
    if (sel) {
      selectedPeriod = sel.value;
      // rerender current view to refresh price table/calc
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      afterRenderHook();
      return;
    }

    // material calc qty
    if (e.target && e.target.matches('input[data-mqty]')) {
      updateMaterialCalcUI();
      return;
    }

    // labor calc inputs
    if (e.target && (
      e.target.id === "panelsCount" ||
      e.target.id === "panelArea" ||
      e.target.id === "cleanCycles" ||
      e.target.id === "robotUsdPerM2Year" ||
      e.target.id === "manualUsdPerM2Year" ||
      e.target.id === "uaeMonthlyAed" ||
      e.target.id === "aedToUsd" ||
      e.target.id === "uaeDaysPerMonth" ||
      e.target.id === "uaeHoursPerDay" ||
      e.target.id === "krDailyKrw" ||
      e.target.id === "krwToUsd" ||
      e.target.id === "krHoursPerDay" ||
      e.target.id === "applyRamadan" ||
      e.target.id === "applyPrayerLoss"
    )) {
      updateLaborCalcUI();
      return;
    }
  });

  // also listen input (for smooth updates)
  document.getElementById("info").addEventListener("input", (e) => {
    if (e.target && e.target.matches('input[data-mqty]')) {
      updateMaterialCalcUI();
      return;
    }

    if (e.target && (
      e.target.id === "panelsCount" ||
      e.target.id === "panelArea" ||
      e.target.id === "cleanCycles" ||
      e.target.id === "robotUsdPerM2Year" ||
      e.target.id === "manualUsdPerM2Year" ||
      e.target.id === "uaeMonthlyAed" ||
      e.target.id === "aedToUsd" ||
      e.target.id === "uaeDaysPerMonth" ||
      e.target.id === "uaeHoursPerDay" ||
      e.target.id === "krDailyKrw" ||
      e.target.id === "krwToUsd" ||
      e.target.id === "krHoursPerDay"
    )) {
      updateLaborCalcUI();
      return;
    }
  });
}

function afterRenderHook() {
  // after rendering a view, refresh calculations if needed
  if (view === "calc") updateMaterialCalcUI();
  if (view === "labor") updateLaborCalcUI();
}

document.addEventListener("DOMContentLoaded", init);
