// app.js (LIGHT LABOR + ROBOT COST + LABOR CALC + DURATION CALC)
// ✅ 공사원가(costs): "로봇 세척 비용" 블록 제거 → 인건비 블록에서만 로봇 가격 표시
// ✅ 인건비: countrydata의 laborAnnual(연도별) 있으면 연도 선택 가능 + 없으면 labor(기존) fallback
// ✅ 인건비 계산(laborcalc): 총 인일 + 프리미엄 + 로봇 투입(대체율/로봇단가/대체 인일) + 고정비(F) → 절감효과 계산
// ✅ 공사기간 계산(duration): 비작업일수 기반 작업가능비율 추정 → 작업일수/달력일수/필요인원 계산
// ✅ duration: OT 제거, crew 기본값 빈칸(입력 전 계산 안 함)
//
// [countrydata.json 권장 구조]
// - laborAnnual: { unit:"USD/day", series:[{year, unskilled, skilled}, ...] }
// - robotCleaning: {
//     annualCostUsdPerM2:{robot, labor},     // (PDF 기반) USD/m²·year
//     robotDailyUsd: 600,                    // 로봇 1대·일 단가(USD/day)
//     robotDailyUnit:"USD/robot-day",
//     note:"..."
//   }

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

// DOM
const infoTitle = document.getElementById("infoTitle");
const infoBody = document.getElementById("infoBody");

const searchInput = document.getElementById("searchInput");
const clearBtn = document.getElementById("clearBtn");
const searchBtn = document.getElementById("searchBtn");
const advancedBtn = document.getElementById("advancedBtn");

// State
let map;
let countriesGeo = null;
let countryData = {}; // { ARE: {...}, VNM: {...} }

let selectedISO = null;
let selectedIsoRaw = "UNK";
let selectedFID = null;
let selectedName = null;

let view = "costs"; // costs | matcalc | laborcalc | nonwork | duration

// 자재비 계산 상태(분기/수량)
let matCalcState = {
  period: "",
  qty: {
    brent: "",
    lng: "",
    copper: "",
    aluminium: "",
    rebar: "",
    cement: "",
  },
};

// 공사기간 계산 상태
let durationCalcState = {
  year: new Date().getFullYear(),
  manDays: "", // 총 작업량(인일)
  crew: "", // ✅ 기본값 빈칸(기존 40)
  shiftMode: "day", // day | daynight
  targetCalendarDays: "", // 목표 공사기간(달력일)
};

// 인건비 계산 상태(로봇 포함)
let laborCalcState = {
  year: new Date().getFullYear(),
  role: "unskilled", // unskilled | skilled
  wageOverride: "", // (선택) 직접 입력 시 우선
  premHigh: false,
  premElectrical: false,
  premDayNight: false,
  premEquip: false,

  totalManDays: "", // 총 인일

  robotUse: false,
  robotDailyUsd: "", // 없으면 countrydata.robotCleaning.robotDailyUsd → 없으면 600
  robotFixedUsd: "1500", // ✅ 고정비(F) 기본값(USD) - 수정 가능
  replaceRate: "50", // %
  // ✅ (표 기준) 로봇 1대가 인력의 약 10배 → 기본 10 인일/대·일
  replaceManDaysPerRobotDay: "10",
  robots: "1", // 로봇 대수
};

// ============== helpers ==============
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
    if (v !== undefined && v !== null && v !== "") return v; // 0은 유효
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

// ✅ countrydata.json 구조 정규화
function normalizeCountryData(json) {
  // 1) { ARE: {...}, VNM: {...} } 형태면 그대로
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const keys = Object.keys(json);
    const hasIsoKey = keys.some((k) => isIso3(k));
    if (hasIsoKey) return json;

    // 2) wrapper 케이스 지원
    const wrapped = json.data || json.countries || json.countryData || json.countrydata;
    if (wrapped && typeof wrapped === "object" && !Array.isArray(wrapped)) {
      const wkeys = Object.keys(wrapped);
      const whasIsoKey = wkeys.some((k) => isIso3(k));
      if (whasIsoKey) return wrapped;
    }
  }

  // 3) 배열 케이스 [{iso:"ARE", ...}]
  if (Array.isArray(json)) {
    const out = {};
    for (const it of json) {
      const iso = String(it?.iso || it?.ISO || it?.iso3 || it?.ISO3 || it?.code || "")
        .trim()
        .toUpperCase();
      if (isIso3(iso)) out[iso] = it;
    }
    return out;
  }

  // 4) UAE만 단독 객체로 들어온 경우 -> ARE로 감싸기
  if (json && typeof json === "object") return { ARE: json };

  return {};
}

// ============== geo helpers ==============
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
    "ISO_A3",
    "iso_a3",
    "ISO3",
    "iso3",
    "ADM0_A3",
    "adm0_a3",
    "SOV_A3",
    "sov_a3",
    "ISO_A3_EH",
    "iso_a3_eh",
    "ISO3166_A3",
    "ISO_3",
    "iso_3",
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
  return null;
}

function preprocessCountriesGeo(geo) {
  const features = geo?.features || [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    f.properties = f.properties || {};

    const name = getName(f.properties) || "Unknown";
    const iso = (getISOFromProps(f.properties) || isoFallbackByName(name) || "UNK").trim().toUpperCase();
    const fid = f.id !== undefined && f.id !== null ? f.id : i;

    f.properties.__name = name;
    f.properties.__iso = iso;
    f.properties.__fid = fid;
    if (f.id === undefined || f.id === null) f.id = fid;
  }
  return geo;
}

function computeBbox(geometry) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;

  const visit = (c) => {
    const [x, y] = c;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  const walk = (arr) => {
    if (!Array.isArray(arr)) return;
    if (typeof arr[0] === "number") return visit(arr);
    for (const a of arr) walk(a);
  };

  walk(geometry?.coordinates);
  return [
    [minX, minY],
    [maxX, maxY],
  ];
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

// ============== period utilities (materialsQuarterly 기준) ==============
function listAvailablePeriods(d) {
  const periods = new Set();

  const mq = d?.materialsQuarterly?.series;
  if (Array.isArray(mq)) {
    for (const r of mq) {
      const p = String(r?.period ?? "").trim();
      if (PERIOD_RE.test(p)) periods.add(p);
    }
  }

  // 호환
  const cc = d?.constructionCost?.series;
  if (Array.isArray(cc)) {
    for (const r of cc) {
      const p = String(r?.period ?? "").trim();
      if (PERIOD_RE.test(p)) periods.add(p);
    }
  }

  const out = [...periods].sort((a, b) => {
    const pa = a.match(PERIOD_RE);
    const pb = b.match(PERIOD_RE);
    const ya = parseInt(pa[1], 10),
      qa = parseInt(pa[2], 10);
    const yb = parseInt(pb[1], 10),
      qb = parseInt(pb[2], 10);
    return ya * 10 + qa - (yb * 10 + qb);
  });

  return out;
}

function getLatestPeriod(d) {
  const p = listAvailablePeriods(d);
  return p.length ? p[p.length - 1] : "";
}

function getQuarterRow(d, period) {
  const mq = d?.materialsQuarterly?.series;
  if (!Array.isArray(mq) || !mq.length) return null;
  if (period && PERIOD_RE.test(period)) {
    return mq.find((r) => String(r.period) === String(period)) || null;
  }
  return mq[mq.length - 1] || null;
}

function getMaterialUnitPrice(d, key, period) {
  const row = getQuarterRow(d, period);
  if (row && row[key] !== undefined && row[key] !== null) {
    const v = toNum(row[key]);
    const unit = d?.materialsQuarterly?.units?.[key] || "";
    return { usd: v, unit };
  }

  // fallback: materials 배열에 price가 있는 케이스
  const mats = Array.isArray(d?.materials) ? d.materials : [];
  const found = mats.find((m) => String(m?.key || "").trim() === key);
  if (found) {
    const p = toNum(pick(found, ["price", "value"], ""));
    const unit = pick(found, ["unit"], "");
    return { usd: p, unit };
  }

  return { usd: null, unit: "" };
}

// ============== labor utilities (연도별 지원) ==============
function listLaborYears(d) {
  const s = d?.laborAnnual?.series;
  if (!Array.isArray(s) || !s.length) return [];
  return [...new Set(s.map((r) => Number(r.year)).filter(Number.isFinite))].sort((a, b) => a - b);
}
function getLatestLaborYear(d) {
  const ys = listLaborYears(d);
  return ys.length ? ys[ys.length - 1] : null;
}

// ✅ 숙련/비숙련이 같게 나오는 버그 해결(비숙련 문자열에 '숙련' 포함됨)
function getLaborWageByYear(d, role, year) {
  // role: "unskilled" | "skilled"
  const s = d?.laborAnnual?.series;
  const y = Number(year);
  if (Array.isArray(s) && Number.isFinite(y)) {
    const row = s.find((r) => Number(r.year) === y);
    if (row && row[role] !== undefined && row[role] !== null) return toNum(row[role]);
  }

  // fallback: 기존 labor 배열(표시용)
  const arr = Array.isArray(d?.labor) ? d.labor : [];

  const label = (x) => String(pick(x, ["role", "name", "title"], ""));

  if (role === "unskilled") {
    // 비숙련 우선
    const u = arr.find((x) => label(x).includes("비숙련"));
    if (u) return toNum(pick(u, ["wage", "value", "price"], ""));
  }

  if (role === "skilled") {
    // '숙련'이면서 '비숙련'은 아닌 것
    const s2 = arr.find((x) => label(x).includes("숙련") && !label(x).includes("비숙련"));
    if (s2) return toNum(pick(s2, ["wage", "value", "price"], ""));
  }

  return null;
}

// ============== robot helpers ==============

// 표 기준: 로봇/인력 속도 10배 → 로봇 1대·일 대체 인일 기본 10
function getRobotReplaceManDaysPerRobotDayDefault() {
  return 10;
}

// ✅ 로봇 일단가 기본값: countrydata에 있으면 사용, 없으면 600 (손익분기점 구조가 잘 보이게)
function getRobotDailyUsdDefault(d) {
  const fromData =
    toNum(d?.robotCleaning?.robotDailyUsd) ??
    toNum(d?.robotDailyUSD) ??
    null;

  return fromData !== null ? fromData : 600;
}

// ✅ 로봇 고정비(F) 기본값: 1500 USD (운송/셋업/교육/예비부품/현장 투입 등 1회성 비용 가정)
function getRobotFixedUsdDefault(d) {
  const fromData = toNum(d?.robotCleaning?.robotFixedUsd) ?? toNum(d?.robotFixedUSD) ?? null;
  return fromData !== null ? fromData : 1500;
}

// ============== CSV export ==============
function csvEscape(v) {
  const s = String(v ?? "");
  return /[,"\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function rowsToCSV(headers, rows) {
  const head = headers.map(csvEscape).join(",");
  const body = rows.map((r) => r.map(csvEscape).join(",")).join("\n");
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

  const period = matCalcState.period || getLatestPeriod(d) || "";
  const items = Array.isArray(d.materials) ? d.materials : [];
  const headers = ["분기", "품목", "가격", "단위"];

  const rows = items.map((it) => {
    const key = it.key || "";
    const item = pick(it, ["item", "name", "material"], key);
    const up = getMaterialUnitPrice(d, key, period);
    return [period, item, up.usd ?? "", it.unit || up.unit || ""];
  });

  downloadCSV(`${selectedISO}_공사원가_${period || "period"}.csv`, rowsToCSV(headers, rows));

  const arr = Array.isArray(d.nonWorkDays) ? d.nonWorkDays : [];
  if (!arr.length) return;

  const isDesert = detectDesertSchema(d, arr);
  const third = isDesert ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";
  const nwHeaders = ["월", "평균기온", "평균최고/최저", third, "주말", "공휴일(평일)", "확정 비작업일", "등가 비작업일(8h)", "비고"];

  const monthIndex = (m) => {
    const s = String(m ?? "");
    const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
    return Number.isFinite(n) ? n : 99;
  };

  const sorted = [...arr].sort((a, b) => monthIndex(a.month ?? a.m ?? a.mon) - monthIndex(b.month ?? b.m ?? b.mon));

  const nwRows = sorted.map((r) => {
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
    return [month, avgTemp, hiLo, isDesert ? storm : rain, weekend, holiday, confirmed, equiv, note];
  });

  setTimeout(() => {
    downloadCSV(`${selectedISO}_비작업일수.csv`, rowsToCSV(nwHeaders, nwRows));
  }, 200);
}

// ============== render blocks ==============
function renderTabs() {
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
      ${mkBtn("duration", "공사기간 계산", view === "duration")}
      <button data-action="csv"
        style="padding:8px 12px;border:1px solid #ddd;border-radius:14px;background:#fff;color:#111827;cursor:pointer;">
        CSV
      </button>
    </div>
  `;
}

function renderPeriodSelect(d) {
  const periods = listAvailablePeriods(d);
  if (!matCalcState.period) matCalcState.period = getLatestPeriod(d);
  if (periods.length && !periods.includes(matCalcState.period)) matCalcState.period = periods[periods.length - 1] || "";

  const safePeriods = periods.length ? periods : matCalcState.period ? [matCalcState.period] : [];
  const options = safePeriods
    .map((p) => {
      const sel = String(p) === String(matCalcState.period) ? "selected" : "";
      return `<option value="${esc(p)}" ${sel}>${esc(p)}</option>`;
    })
    .join("");

  return `
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:10px 0;">
      <div style="font-weight:900;">기준 연도/분기</div>
      <select id="matPeriod" data-mat-field="period"
        ${safePeriods.length ? "" : "disabled"}
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
        ${options || `<option value="">—</option>`}
      </select>
    </div>
  `;
}

// ✅ 공사원가(costs)에서 보여줄 인건비 + 로봇(세척) 1대·일 + 대체효과
function renderLaborBlock(d, opts = {}) {
  const mode = opts.mode || "simple"; // simple | calc
  const years = listLaborYears(d);
  const defaultYear = getLatestLaborYear(d) ?? new Date().getFullYear();

  const y = mode === "calc" ? Number(laborCalcState.year) || defaultYear : Number(durationCalcState.year) || defaultYear;

  const unsk = getLaborWageByYear(d, "unskilled", y);
  const skl = getLaborWageByYear(d, "skilled", y);
  const unit = esc(d?.laborAnnual?.unit || (Array.isArray(d?.labor) && d.labor[0]?.unit) || "USD/day");

  const robotDaily = getRobotDailyUsdDefault(d);
  const replaceDefault = getRobotReplaceManDaysPerRobotDayDefault();

  const yearSelect = years.length
    ? `
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:10px;">
        <div style="font-weight:900;">인건비 연도</div>
        <select data-labor-year style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
          ${years.map(v => `<option value="${v}" ${v === y ? "selected" : ""}>${v}</option>`).join("")}
        </select>
      </div>
    `
    : "";

  return `
    <div style="margin-top:16px; font-weight:900;">인건비</div>
    ${yearSelect}
    <table class="table" style="margin-top:8px;">
      <thead><tr><th>구분</th><th class="right">일급</th><th>단위</th></tr></thead>
      <tbody>
        <tr><td>비숙련</td><td class="right">${unsk !== null ? fmtNum(unsk, 2) : "—"}</td><td>${unit}</td></tr>
        <tr><td>숙련</td><td class="right">${skl !== null ? fmtNum(skl, 2) : "—"}</td><td>${unit}</td></tr>

        <tr><td><b>로봇 대체(세척 시)</b></td><td class="right"><b>${fmtNum(replaceDefault, 1)}</b></td><td>인일/대·일</td></tr>
        <tr><td><b>로봇(세척) 1대·일</b></td><td class="right"><b>${fmtNum(robotDaily, 0)}</b></td><td>USD/day</td></tr>
      </tbody>
    </table>
    <div class="muted" style="margin-top:8px;">
      ※ 기준: 로봇 150~200장/h vs 인력 15~20장/h → 로봇 1대 ≈ 인력 10명 수준
    </div>
  `;
}

function renderCostsView(d) {
  const updated = d.updated || "—";
  const period = matCalcState.period || getLatestPeriod(d) || "";
  const items = Array.isArray(d.materials) ? d.materials : [];

  const rows = items
    .map((it) => {
      const key = it.key || "";
      const item = esc(pick(it, ["item", "name", "material"], key));
      const up = getMaterialUnitPrice(d, key, period);
      const price = up.usd !== null ? fmtNum(up.usd, 3) : "—";
      const unit = esc(it.unit || up.unit || "");
      return `<tr><td>${item}</td><td class="right">${price}</td><td>${unit}</td></tr>`;
    })
    .join("");

  return `
    <div class="muted">업데이트: ${esc(updated)}</div>
    ${renderPeriodSelect(d)}
    <table class="table">
      <thead><tr><th>품목</th><th class="right">가격</th><th>단위</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3">데이터 없음</td></tr>`}</tbody>
    </table>

    ${renderLaborBlock(d, { mode: "simple" })}
  `;
}

function renderMatCalcView(d) {
  const period = matCalcState.period || getLatestPeriod(d) || "";

  const items = [
    { key: "brent", label: "원유(Brent)", qtyLabel: "bbl" },
    { key: "lng", label: "LNG(JKM)", qtyLabel: "MMBtu" },
    { key: "copper", label: "구리(LME)", qtyLabel: "t" },
    { key: "aluminium", label: "알루미늄", qtyLabel: "t" },
    { key: "rebar", label: "철근", qtyLabel: "t" },
    { key: "cement", label: "시멘트", qtyLabel: "t" },
  ];

  const rows = items
    .map((it) => {
      const up = getMaterialUnitPrice(d, it.key, period);
      const unitPrice = up.usd;
      const unitStr = up.unit || (it.qtyLabel ? `USD/${it.qtyLabel}` : "USD");

      const qtyVal = matCalcState.qty[it.key] ?? "";
      const qtyNum = toNum(qtyVal);
      const cost = qtyNum !== null && unitPrice !== null ? qtyNum * unitPrice : null;

      return `
        <tr>
          <td style="font-weight:700;">${esc(it.label)}</td>
          <td class="right">${unitPrice !== null ? fmtNum(unitPrice, 3) : "—"}</td>
          <td>${esc(unitStr)}</td>
          <td class="right">
            <input data-matqty="${esc(it.key)}" type="number" min="0" step="0.01"
              value="${esc(qtyVal)}"
              style="width:120px; padding:8px 10px; border:1px solid #e5e7eb; border-radius:12px; text-align:right;"
            />
            <span class="muted" style="margin-left:6px;">${esc(it.qtyLabel)}</span>
          </td>
          <td class="right"><b>${cost !== null ? fmtNum(cost, 2) : "—"}</b></td>
        </tr>
      `;
    })
    .join("");

  return `
    ${renderPeriodSelect(d)}
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

  const period = matCalcState.period || getLatestPeriod(d) || "";
  const keys = ["brent", "lng", "copper", "aluminium", "rebar", "cement"];

  let sum = 0;
  let hasAny = false;

  for (const k of keys) {
    const qtyNum = toNum(matCalcState.qty[k]);
    const up = getMaterialUnitPrice(d, k, period);
    if (qtyNum !== null && up.usd !== null) {
      sum += qtyNum * up.usd;
      hasAny = true;
    }
  }

  const el = document.getElementById("matTotal");
  if (!el) return;
  el.textContent = hasAny ? `합계: ${fmtNum(sum, 2)} USD` : `합계: —`;
}

// ============== laborcalc (계산) ==============
const LABOR_PREM = {
  high: 1.15,
  electrical: 1.10,
  daynight: 1.25,
  equip: 1.05,
};

function computeLaborCalc(d) {
  const y = Number(laborCalcState.year) || getLatestLaborYear(d) || new Date().getFullYear();
  const role = laborCalcState.role === "skilled" ? "skilled" : "unskilled";

  const base = (() => {
    const ov = toNum(laborCalcState.wageOverride);
    if (ov !== null && ov > 0) return ov;
    return getLaborWageByYear(d, role, y);
  })();

  const totalManDays = toNum(laborCalcState.totalManDays);

  const prem =
    (laborCalcState.premHigh ? LABOR_PREM.high : 1) *
    (laborCalcState.premElectrical ? LABOR_PREM.electrical : 1) *
    (laborCalcState.premDayNight ? LABOR_PREM.daynight : 1) *
    (laborCalcState.premEquip ? LABOR_PREM.equip : 1);

  const effectiveWage = base !== null ? base * prem : null;
  const laborCostNoRobot = effectiveWage !== null && totalManDays !== null ? effectiveWage * totalManDays : null;

  // ✅ 로봇 단가/대체효과/대수 "0 입력" 방지 보정
  const robotDailyCandidate = toNum(laborCalcState.robotDailyUsd);
  const robotDailyDefault =
    robotDailyCandidate !== null && robotDailyCandidate > 0 ? robotDailyCandidate : getRobotDailyUsdDefault(d);

  // ✅ 고정비(F) 기본값/보정
  const fixedCandidate = toNum(laborCalcState.robotFixedUsd);
  const robotFixedUsd =
    fixedCandidate !== null && fixedCandidate >= 0 ? fixedCandidate : getRobotFixedUsdDefault(d);

  if (!laborCalcState.robotUse) {
    return {
      year: y,
      baseWage: base,
      effectiveWage,
      prem,
      totalManDays,
      laborCostNoRobot,
      robot: null,
    };
  }

  const replaceRate = Math.min(100, Math.max(0, toNum(laborCalcState.replaceRate) ?? 0));
  const replaceManDays = totalManDays !== null ? totalManDays * (replaceRate / 100) : null;

  const robotsCandidate = toNum(laborCalcState.robots);
  const robots = Math.max(1, Math.floor(robotsCandidate !== null && robotsCandidate > 0 ? robotsCandidate : 1));

  const mdCandidate = toNum(laborCalcState.replaceManDaysPerRobotDay);
  const mdPerRobotDay =
    mdCandidate !== null && mdCandidate > 0 ? mdCandidate : getRobotReplaceManDaysPerRobotDayDefault();

  const robotTotalDays = replaceManDays !== null ? replaceManDays / mdPerRobotDay : null;
  const robotFleetCalendarDays = robotTotalDays !== null ? robotTotalDays / robots : null;

  const remainManDays =
    totalManDays !== null && replaceManDays !== null ? Math.max(0, totalManDays - replaceManDays) : null;

  const laborCostWithRobot = effectiveWage !== null && remainManDays !== null ? effectiveWage * remainManDays : null;

  // ✅ 로봇 비용 = (로봇 운영일수 × R) + 고정비(F)
  const robotCost =
    robotTotalDays !== null ? robotTotalDays * robotDailyDefault + robotFixedUsd : null;

  const totalCostWithRobot =
    laborCostWithRobot !== null && robotCost !== null ? laborCostWithRobot + robotCost : null;

  // ✅ Saving = MD*r*(W - kR) - F
  // k = 1/mdPerRobotDay, R=robotDaily, W=effectiveWage, F=robotFixedUsd
  const saving = (() => {
    if (effectiveWage === null || totalManDays === null) return null;
    const MD = totalManDays;
    const r = replaceRate / 100;
    const W = effectiveWage;
    const R = robotDailyDefault;
    const k = 1 / mdPerRobotDay;
    const F = robotFixedUsd;
    return MD * r * (W - k * R) - F;
  })();

  const savingRate =
    saving !== null && laborCostNoRobot !== null && laborCostNoRobot > 0 ? saving / laborCostNoRobot : null;

  return {
    year: y,
    baseWage: base,
    effectiveWage,
    prem,
    totalManDays,
    laborCostNoRobot,
    robot: {
      robotDailyUsd: robotDailyDefault,
      robotFixedUsd,
      replaceRate,
      replaceManDays,
      mdPerRobotDay,
      robots,
      robotTotalDays,
      robotFleetCalendarDays,
      remainManDays,
      laborCostWithRobot,
      robotCost,
      totalCostWithRobot,
      saving,
      savingRate,
    },
  };
}

function renderLaborCalcView(d) {
  const years = listLaborYears(d);
  const defaultYear = getLatestLaborYear(d) ?? new Date().getFullYear();
  if (!years.length) laborCalcState.year = laborCalcState.year || defaultYear;
  else if (!years.includes(Number(laborCalcState.year))) laborCalcState.year = String(defaultYear);

  // ✅ robotFixedUsd 초기 비어있으면 기본값 넣기(안 건드리면 1500)
  if (laborCalcState.robotFixedUsd === "" || laborCalcState.robotFixedUsd === null || laborCalcState.robotFixedUsd === undefined) {
    laborCalcState.robotFixedUsd = String(getRobotFixedUsdDefault(d));
  }

  const unit = esc(d?.laborAnnual?.unit || "USD/day");
  const res = computeLaborCalc(d);

  const appliedWageText =
    res.effectiveWage !== null ? `${fmtNum(res.effectiveWage, 2)} ${unit}` : "—";

  const premText = res.baseWage !== null ? `적용 일급: ${fmtNum(res.baseWage, 2)} × ${fmtNum(res.prem, 3)}` : `적용 일급: —`;

  const robotBlock = (() => {
    const rc = res.robot;
    if (!rc) return "";

    return `
      <div style="margin-top:12px; border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:900;">로봇 투입</div>

        <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px;">
          <label style="display:flex; align-items:center; gap:8px;">
            <span class="muted">로봇 1대·일(R)</span>
            <input type="number" min="1" step="0.1" data-labor-field="robotDailyUsd" value="${esc(laborCalcState.robotDailyUsd)}"
              placeholder="${fmtNum(getRobotDailyUsdDefault(d), 0)}"
              style="width:140px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
            <span class="muted">USD/day</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px;">
            <span class="muted">고정비(F)</span>
            <input type="number" min="0" step="10" data-labor-field="robotFixedUsd" value="${esc(laborCalcState.robotFixedUsd)}"
              placeholder="${fmtNum(getRobotFixedUsdDefault(d), 0)}"
              style="width:140px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
            <span class="muted">USD</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px;">
            <span class="muted">대체율(r)</span>
            <input type="number" min="0" max="100" step="1" data-labor-field="replaceRate" value="${esc(laborCalcState.replaceRate)}"
              style="width:110px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
            <span class="muted">%</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px;">
            <span class="muted"><b>로봇 대체</b></span>
            <input type="number" min="0.1" step="0.1" data-labor-field="replaceManDaysPerRobotDay" value="${esc(laborCalcState.replaceManDaysPerRobotDay)}"
              style="width:120px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
            <span class="muted">인일/대·일</span>
          </label>

          <label style="display:flex; align-items:center; gap:8px;">
            <span class="muted">로봇 대수</span>
            <input type="number" min="1" step="1" data-labor-field="robots" value="${esc(laborCalcState.robots)}"
              style="width:90px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
          </label>
        </div>

        <div class="muted" style="margin-top:8px;">
          Saving = MD·r·(W − kR) − F,  k = 1/(로봇대체 인일/대·일)
        </div>
      </div>
    `;
  })();

  const resultRows = (() => {
    const r = res.robot;
    if (!r) {
      return `
        <tr><td>인건비(로봇 미사용)</td><td class="right"><b>${res.laborCostNoRobot !== null ? fmtNum(res.laborCostNoRobot, 2) + " USD" : "—"}</b></td></tr>
      `;
    }

    return `
      <tr><td>인건비(로봇 미사용)</td><td class="right"><b>${res.laborCostNoRobot !== null ? fmtNum(res.laborCostNoRobot, 2) + " USD" : "—"}</b></td></tr>
      <tr><td><b>로봇 대체</b></td><td class="right"><b>${r.mdPerRobotDay !== null ? fmtNum(r.mdPerRobotDay, 1) + " 인일/대·일" : "—"}</b></td></tr>
      <tr><td>로봇 대체 인일</td><td class="right"><b>${r.replaceManDays !== null ? fmtNum(r.replaceManDays, 1) + " 인일" : "—"}</b></td></tr>
      <tr><td>로봇 필요 대수·일(총)</td><td class="right"><b>${r.robotTotalDays !== null ? fmtNum(r.robotTotalDays, 1) + " 대·일" : "—"}</b></td></tr>
      <tr><td>로봇 운영기간(대수 고려)</td><td class="right"><b>${r.robotFleetCalendarDays !== null ? fmtNum(r.robotFleetCalendarDays, 1) + " 일" : "—"}</b></td></tr>
      <tr><td>인건비(로봇 사용 후)</td><td class="right"><b>${r.laborCostWithRobot !== null ? fmtNum(r.laborCostWithRobot, 2) + " USD" : "—"}</b></td></tr>
      <tr><td>로봇 비용(R×일수)</td><td class="right"><b>${(r.robotCost !== null) ? fmtNum(Math.max(0, r.robotCost - r.robotFixedUsd), 2) + " USD" : "—"}</b></td></tr>
      <tr><td>로봇 고정비(F)</td><td class="right"><b>${fmtNum(r.robotFixedUsd, 2)} USD</b></td></tr>
      <tr><td>총비용(인건비+로봇)</td><td class="right"><b>${r.totalCostWithRobot !== null ? fmtNum(r.totalCostWithRobot, 2) + " USD" : "—"}</b></td></tr>
      <tr><td>절감액(Saving)</td><td class="right"><b>${r.saving !== null ? fmtNum(r.saving, 2) + " USD" : "—"}</b></td></tr>
      <tr><td>절감률</td><td class="right"><b>${r.savingRate !== null ? fmtNum(r.savingRate * 100, 1) + "%" : "—"}</b></td></tr>
    `;
  })();

  return `
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <div style="font-weight:900;">연도</div>
      <select data-labor-field="year"
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
        ${(years.length ? years : [defaultYear])
          .map((v) => `<option value="${v}" ${Number(laborCalcState.year) === v ? "selected" : ""}>${v}</option>`)
          .join("")}
      </select>

      <div style="font-weight:900;">직종</div>
      <select data-labor-field="role"
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
        <option value="unskilled" ${laborCalcState.role === "unskilled" ? "selected" : ""}>일반공(비숙련)</option>
        <option value="skilled" ${laborCalcState.role === "skilled" ? "selected" : ""}>숙련공</option>
      </select>

      <div style="font-weight:900;">일급(선택)</div>
      <input type="number" min="0" step="0.1" data-labor-field="wageOverride" value="${esc(laborCalcState.wageOverride)}"
        placeholder="자동 불러오기"
        style="width:150px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
      <span class="muted">${unit}</span>
    </div>

    <div style="margin-top:10px;" class="muted">${esc(premText)} → <b>${esc(appliedWageText)}</b></div>

    <div style="margin-top:12px; border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
      <div style="font-weight:900;">프리미엄</div>
      <div style="display:flex; gap:14px; align-items:center; flex-wrap:wrap; margin-top:8px;">
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" data-labor-field="premHigh" ${laborCalcState.premHigh ? "checked" : ""}/>
          고소작업
        </label>
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" data-labor-field="premElectrical" ${laborCalcState.premElectrical ? "checked" : ""}/>
          전기설비 근접
        </label>
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" data-labor-field="premDayNight" ${laborCalcState.premDayNight ? "checked" : ""}/>
          주야간
        </label>
        <label style="display:flex; align-items:center; gap:8px;">
          <input type="checkbox" data-labor-field="premEquip" ${laborCalcState.premEquip ? "checked" : ""}/>
          장비 포함
        </label>
      </div>
    </div>

    <div style="margin-top:12px; border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
      <div style="font-weight:900;">작업량 입력</div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px;">
        <input type="number" min="0" step="0.1" data-labor-field="totalManDays" value="${esc(laborCalcState.totalManDays)}"
          placeholder="총 인일(예: 4000)"
          style="width:200px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
        <span class="muted">인일</span>
      </div>
    </div>

    <div style="margin-top:12px; border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
      <div style="display:flex; align-items:center; gap:10px;">
        <label style="display:flex; align-items:center; gap:8px; font-weight:900;">
          <input type="checkbox" data-labor-field="robotUse" ${laborCalcState.robotUse ? "checked" : ""}/>
          로봇 사용
        </label>
        <span class="muted">체크 시 로봇 투입 계산</span>
      </div>
      ${laborCalcState.robotUse ? robotBlock : ""}
    </div>

    <div style="margin-top:14px;">
      <div style="font-weight:900; margin-bottom:8px;">결과</div>
      <table class="table">
        <thead><tr><th>항목</th><th class="right">값</th></tr></thead>
        <tbody>
          ${resultRows}
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

  const sorted = [...nwd].sort((a, b) => monthIndex(a.month ?? a.m ?? a.mon) - monthIndex(b.month ?? b.m ?? b.mon));

  const rows = sorted
    .map((r) => {
      const month = pick(r, ["month", "m", "mon"], "");
      const avgTemp = pick(r, ["avgTemp", "tAvg"], "");
      const hiLo = pick(r, ["avgHighLow", "avgHiLo"], "");
      const storm = pick(r, ["storm", "sandstorm", "dustStorm", "shamal"], "");
      const rain = pick(r, ["rainDays", "rain_day", "rainyDays"], "");
      const weekend = pick(r, ["weekend", "weekendDays"], "");
      const holiday = pick(r, ["holidayWeekday", "holiday"], "");
      const confirmed = pick(r, ["fixedOff", "confirmedOff", "fixedOffDays"], "");
      const equiv = pick(r, ["eqOff8h", "equivOff8h"], "");
      const note = pick(r, ["note", "remark"], "");

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
    })
    .join("");

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

// ============== duration calc helpers ==============
function daysInMonth(year, month1to12) {
  const m = Math.max(1, Math.min(12, Number(month1to12) || 1));
  return new Date(year, m, 0).getDate();
}

function parseMonthNumber(m) {
  const s = String(m ?? "");
  const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
  if (!Number.isFinite(n)) return null;
  if (n >= 1 && n <= 12) return n;
  return null;
}

function computeWorkabilityRatio(d, year) {
  const nwd = Array.isArray(d?.nonWorkDays) ? d.nonWorkDays : [];
  if (!nwd.length) {
    return { ratio: 0.72, detail: null };
  }

  let totalDays = 0;
  let totalOff = 0;

  for (const r of nwd) {
    const mon = parseMonthNumber(pick(r, ["month", "m", "mon"], ""));
    if (!mon) continue;

    const mdays = daysInMonth(year, mon);
    totalDays += mdays;

    const eq = toNum(pick(r, ["eqOff8h", "equivOff8h"], ""));
    const conf = toNum(pick(r, ["fixedOff", "confirmedOff", "fixedOffDays"], ""));

    const off = eq !== null ? eq : conf !== null ? conf : 0;
    totalOff += Math.max(0, off);
  }

  if (totalDays <= 0) return { ratio: 0.72, detail: null };

  const workable = Math.max(0, totalDays - totalOff);
  const ratio = workable / totalDays;

  return {
    ratio: Math.min(0.95, Math.max(0.3, ratio)),
    detail: { totalDays, totalOff, workable },
  };
}

function getShiftMultiplier(mode) {
  if (mode === "daynight") return 1.6;
  return 1.0;
}

// ✅ duration 결과: OT 제거, crew 빈칸이면 계산 안함
function renderDurationCalcView(d) {
  const year = Number(durationCalcState.year) || new Date().getFullYear();
  const manDays = toNum(durationCalcState.manDays);

  const crewNum = toNum(durationCalcState.crew);
  const crew = crewNum !== null && crewNum > 0 ? crewNum : null; // ✅ 입력 전 null

  const shiftMode = durationCalcState.shiftMode || "day";
  const shiftM = getShiftMultiplier(shiftMode);

  const { ratio, detail } = computeWorkabilityRatio(d, year);

  // ✅ OT 제거: workDaysNeeded = MD / (crew * shiftM)
  const workDaysNeeded =
    manDays !== null && crew !== null ? manDays / (crew * shiftM) : null;

  const calendarDaysNeeded =
    workDaysNeeded !== null ? workDaysNeeded / ratio : null;

  const targetCal = toNum(durationCalcState.targetCalendarDays);

  // ✅ 목표 달력일 입력 시 필요한 인원 계산(주간/주야간) - OT 제거
  const crewNeededDay =
    manDays !== null && targetCal !== null && targetCal > 0
      ? manDays / (targetCal * ratio * 1.0)
      : null;

  const crewNeededDayNight =
    manDays !== null && targetCal !== null && targetCal > 0
      ? manDays / (targetCal * ratio * 1.6)
      : null;

  // ✅ 대안 판단
  let altHtml = "";
  if (manDays !== null && targetCal !== null && targetCal > 0) {
    const feasibleNow = calendarDaysNeeded !== null ? calendarDaysNeeded <= targetCal : false;

    const needNight = crewNeededDay !== null && crew !== null ? Math.ceil(crewNeededDay) > crew : false;

    const addCrewDay =
      crewNeededDay !== null && crew !== null ? Math.max(0, Math.ceil(crewNeededDay) - crew) : null;

    const addCrewDayNight =
      crewNeededDayNight !== null && crew !== null ? Math.max(0, Math.ceil(crewNeededDayNight) - crew) : null;

    if (feasibleNow) {
      altHtml = `
        <tr><td><b>야간 작업 필요</b></td><td class="right"><b>필요 없음</b></td></tr>
        <tr><td><b>대안</b></td><td class="right"><b>현재 조건으로 목표기간 달성 가능</b></td></tr>
      `;
    } else {
      altHtml = `
        <tr><td><b>야간 작업 필요</b></td><td class="right"><b>${needNight ? "필요(권장)" : "선택"}</b></td></tr>

        <tr>
          <td><b>대안(주간 유지)</b></td>
          <td class="right">
            ${
              crewNeededDay !== null
                ? (crew !== null
                    ? `<b>인원 +${fmtNum(addCrewDay, 0)}명</b> 필요 (총 ${fmtNum(Math.ceil(crewNeededDay), 0)}명)`
                    : `<b>필요 인원</b> ${fmtNum(Math.ceil(crewNeededDay), 0)}명 (현재 인원 입력 필요)`)
                : "—"
            }
          </td>
        </tr>

        <tr>
          <td><b>대안(주야간 전환)</b></td>
          <td class="right">
            ${
              crewNeededDayNight !== null
                ? `<b>주야간 적용 시</b> 필요 인원 ${fmtNum(Math.ceil(crewNeededDayNight), 0)}명`
                : "—"
            }
            ${
              addCrewDayNight !== null
                ? `<div class="muted" style="margin-top:4px;">(현재 ${crew}명 기준: +${fmtNum(addCrewDayNight, 0)}명)</div>`
                : ""
            }
          </td>
        </tr>
      `;
    }
  }

  const ratioText = detail
    ? `${fmtNum(ratio * 100, 1)}% (연간 ${detail.workable.toFixed(0)}/${detail.totalDays.toFixed(0)}일 작업 가능)`
    : `${fmtNum(ratio * 100, 1)}%`;

  const resultBlock = `
    <div style="margin-top:14px;">
      <div style="font-weight:900; margin-bottom:8px;">결과</div>
      <table class="table">
        <thead>
          <tr><th>항목</th><th class="right">값</th></tr>
        </thead>
        <tbody>
          <tr><td>작업가능비율</td><td class="right"><b>${esc(ratioText)}</b></td></tr>
          <tr><td>필요 작업일수</td><td class="right"><b>${workDaysNeeded !== null ? fmtNum(workDaysNeeded, 1) + " 일" : "—"}</b></td></tr>
          <tr><td>예상 공사기간(달력일)</td><td class="right"><b>${calendarDaysNeeded !== null ? fmtNum(calendarDaysNeeded, 0) + " 일" : "—"}</b></td></tr>
          ${
            targetCal !== null && targetCal > 0
              ? `<tr><td>목표 공사기간</td><td class="right"><b>${fmtNum(targetCal, 0)} 일</b></td></tr>`
              : ""
          }
          ${altHtml}
        </tbody>
      </table>
    </div>
  `;

  return `
    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <div style="font-weight:900;">기준 연도</div>
      <input type="number" data-duration-field="year" value="${esc(year)}"
        style="width:120px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px;" />

      <div style="font-weight:900;">총 작업량</div>
      <input type="number" data-duration-field="manDays" value="${esc(durationCalcState.manDays)}"
        placeholder="인일(예: 4000)"
        style="width:180px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
      <span class="muted">인일</span>
    </div>

    <div style="margin-top:12px; display:grid; grid-template-columns: 1fr 1fr; gap:10px;">
      <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:900;">투입 인원</div>
        <div style="display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap;">
          <input type="number" min="1" data-duration-field="crew" value="${esc(durationCalcState.crew)}"
            placeholder="예: 40"
            style="width:140px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
          <span class="muted">명</span>
        </div>
      </div>

      <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:900;">작업 방식</div>
        <div style="display:flex; gap:10px; align-items:center; margin-top:8px; flex-wrap:wrap;">
          <select data-duration-field="shiftMode"
            style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
            <option value="day" ${shiftMode === "day" ? "selected" : ""}>주간</option>
            <option value="daynight" ${shiftMode === "daynight" ? "selected" : ""}>주야간</option>
          </select>
        </div>
      </div>
    </div>

    <div style="margin-top:12px; border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
      <div style="font-weight:900;">목표 공사기간</div>
      <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:8px;">
        <input type="number" min="1" data-duration-field="targetCalendarDays" value="${esc(durationCalcState.targetCalendarDays)}"
          placeholder="달력일(예: 180)"
          style="width:180px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
        <span class="muted">일</span>
      </div>
    </div>

    ${resultBlock}
  `;
}

// ============== panel ==============
function renderPanel(isoRaw, fallbackName) {
  selectedIsoRaw = (isoRaw || "UNK").toString().trim().toUpperCase();
  const iso = isIso3(selectedIsoRaw) && selectedIsoRaw !== "UNK" ? selectedIsoRaw : null;
  selectedISO = iso;

  let title = fallbackName || isoRaw || "선택 국가";
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

  if (!matCalcState.period) matCalcState.period = getLatestPeriod(d);

  let body = "";
  if (view === "costs") body = renderCostsView(d);
  else if (view === "matcalc") body = renderMatCalcView(d);
  else if (view === "laborcalc") body = renderLaborCalcView(d);
  else if (view === "nonwork") body = renderNonWorkView(d);
  else if (view === "duration") body = renderDurationCalcView(d);

  setInfo(title, tabs + body);
  updateMatTotal();
}

// ============== ✅ 입력 렌더링 디바운스 + 포커스/커서 복원(타이핑 끊김 해결) ==============
let __rerenderTimer = null;
function scheduleRerender() {
  clearTimeout(__rerenderTimer);

  const active = document.activeElement;
  const key =
    active?.getAttribute?.("data-duration-field") ||
    active?.getAttribute?.("data-labor-field") ||
    null;

  const selStart = active?.selectionStart;
  const selEnd = active?.selectionEnd;

  __rerenderTimer = setTimeout(() => {
    renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);

    if (key) {
      // duration 우선 → labor도 같이
      const el =
        document.querySelector(`[data-duration-field="${key}"]`) ||
        document.querySelector(`[data-labor-field="${key}"]`);

      if (el && typeof el.focus === "function") {
        el.focus();
        if (
          typeof selStart === "number" &&
          typeof selEnd === "number" &&
          typeof el.setSelectionRange === "function"
        ) {
          try {
            el.setSelectionRange(selStart, selEnd);
          } catch {}
        }
      }
    }
  }, 500);
}

// ============== init ==============
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
    center: [48.0, 24.0],
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
    const q = searchInput?.value?.trim() || "";
    if (!q || !countriesGeo?.features?.length) return;
    const qn = norm(q);

    const f = countriesGeo.features.find((ft) => {
      const props = ft.properties || {};
      const isoRaw = props.__iso || "UNK";
      const name = props.__name || getName(props);
      const isoGood = isIso3(isoRaw) && isoRaw !== "UNK" ? isoRaw : null;
      const dataName = isoGood ? countryData?.[isoGood]?.name || "" : "";
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

  if (searchBtn) searchBtn.addEventListener("click", doSearch);
  if (searchInput)
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doSearch();
    });

  if (clearBtn)
    clearBtn.addEventListener("click", () => {
      if (searchInput) searchInput.value = "";
      selectedISO = null;
      selectedIsoRaw = "UNK";
      selectedFID = null;
      selectedName = null;
      view = "costs";
      setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);
      highlightFID(null);
    });

  if (advancedBtn) advancedBtn.addEventListener("click", () => alert(" "));

  // ✅ info 영역 이벤트: 탭/CSV/버튼 클릭
  const infoEl = document.getElementById("info");
  if (infoEl) {
    infoEl.addEventListener("click", (e) => {
      const csvBtn = e.target.closest('button[data-action="csv"]');
      if (csvBtn) {
        exportMaterialsAndNonworkCSV();
        return;
      }

      const btn = e.target.closest("button[data-view]");
      if (btn) {
        view = btn.dataset.view;
        renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
        return;
      }
    });

    // ✅ change 이벤트
    infoEl.addEventListener("change", (e) => {
      const t = e.target;

      // 분기
      if (t && t.matches('select[data-mat-field="period"]')) {
        matCalcState.period = t.value;
        renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
        return;
      }

      // duration fields (select)
      const df = t?.getAttribute?.("data-duration-field");
      if (df) {
        durationCalcState[df] = t.type === "checkbox" ? t.checked : t.value;
        renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
        return;
      }

      // laborcalc fields (select/checkbox)
      const lf = t?.getAttribute?.("data-labor-field");
      if (lf) {
        laborCalcState[lf] = t.type === "checkbox" ? t.checked : t.value;
        renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
        return;
      }

      // costs에서 인건비 연도 변경 UI(data-labor-year)
      if (t && t.matches('select[data-labor-year]')) {
        durationCalcState.year = t.value;
        renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
        return;
      }
    });

    // ✅ input 이벤트
    infoEl.addEventListener("input", (e) => {
      const t = e.target;

      // mat qty는 즉시 합계만 업데이트
      const k = t?.getAttribute?.("data-matqty");
      if (k) {
        matCalcState.qty[k] = t.value;
        updateMatTotal();
        return;
      }

      // duration fields (input) ✅ 디바운스 렌더링
      const df = t?.getAttribute?.("data-duration-field");
      if (df) {
        durationCalcState[df] = t.value;
        scheduleRerender();
        return;
      }

      // laborcalc fields (input) ✅ 디바운스 렌더링
      const lf = t?.getAttribute?.("data-labor-field");
      if (lf) {
        laborCalcState[lf] = t.value;
        scheduleRerender();
        return;
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", init);

    
