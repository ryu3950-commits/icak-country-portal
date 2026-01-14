// app.js (Fix v2)
// ✅ 버튼 클릭 안되는 원인(advancedBtn null) 방지
// ✅ 공사원가/자재비계산 단가를 materialsQuarterly.series에서 읽도록 수정
// ✅ 분기는 YYYYQ#만 허용
// ✅ 시작화면 중동 확대

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

// DOM (null 가능성 대비)
const infoTitle = document.getElementById("infoTitle");
const infoBody = document.getElementById("infoBody");

const searchInput = document.getElementById("searchInput");
const clearBtn = document.getElementById("clearBtn");
const searchBtn = document.getElementById("searchBtn");
// HTML에 없을 수 있음(= 여기서 죽으면 전체 클릭이 안 됨)
const advancedBtn = document.getElementById("advancedBtn");

let map;
let countriesGeo = null;
let countryData = {}; // { ARE: {...}, ... }

let selectedISO = null;
let selectedIsoRaw = "UNK";
let selectedFID = null;
let selectedName = null;

let view = "costs"; // costs | matcalc | laborcalc | nonwork

// 공사원가/자재비계산 공통 분기 상태(같이 쓰는 게 편함)
let periodState = { period: "" };

// 자재비 계산 상태
let matCalcState = {
  qty: {
    brent_bbl: "",
    lng_mmbtu: "",
    copper_t: "",
    aluminum_t: "",
    rebar_t: "",
    cement_t: "",
  }
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
  if (infoTitle) infoTitle.textContent = title;
  if (infoBody) infoBody.innerHTML = html;
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
  // 1) 이미 { ARE: {...} } 형태면 그대로
  if (json && typeof json === "object" && !Array.isArray(json)) {
    const keys = Object.keys(json);
    const hasIsoKey = keys.some(k => isIso3(k));
    if (hasIsoKey) return json;

    // 2) wrapper 케이스: { data:{ARE:{...}} } / { countries:{...} } 등
    const wrapped = json.data || json.countries || json.countryData || json.countrydata || null;
    if (wrapped && typeof wrapped === "object") {
      const wkeys = Object.keys(wrapped);
      if (wkeys.some(k => isIso3(k))) return wrapped;
    }

    // 3) 단일 국가 객체(= UAE만)로 온 경우 ARE로 감싸기
    return { ARE: json };
  }

  // 4) 배열 케이스: [{iso:"ARE",...}]
  if (Array.isArray(json)) {
    const out = {};
    for (const it of json) {
      const iso = String(it?.iso || it?.ISO || it?.iso3 || it?.ISO3 || it?.code || "")
        .trim().toUpperCase();
      if (isIso3(iso)) out[iso] = it;
    }
    return out;
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
// ============== period / unit price (materialsQuarterly 지원) ==============
//

// ✅ 네 데이터의 실제 필드명 매핑 (aluminium 주의)
const KEY_TO_SERIES_FIELD = {
  brent_bbl: "brent",
  lng_mmbtu: "lng",
  copper_t: "copper",
  aluminum_t: "aluminium", // 네 JSON은 aluminium
  rebar_t: "rebar",
  cement_t: "cement",
};

function listAvailablePeriods(d) {
  const periods = new Set();

  // ✅ materialsQuarterly.series에서 수집
  const mq = d?.materialsQuarterly?.series;
  if (Array.isArray(mq)) {
    for (const r of mq) {
      const p = String(r?.period ?? "").trim();
      if (PERIOD_RE.test(p)) periods.add(p);
    }
  }

  // (구버전 호환) constructionCost.series 등
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

function getSeriesRow(d, period) {
  const mq = d?.materialsQuarterly?.series;
  if (!Array.isArray(mq) || !mq.length) return null;
  if (period) return mq.find(r => String(r.period) === String(period)) || null;
  return mq[mq.length - 1];
}

// ✅ 단가 조회: materialsQuarterly 기준으로
function getMaterialUnitPrice(d, key, period) {
  const field = KEY_TO_SERIES_FIELD[key];
  const row = getSeriesRow(d, period);
  const units = d?.materialsQuarterly?.units || {};
  const unit = units[field] || "";

  if (row && field && typeof row[field] === "number") {
    return { usd: row[field], unit };
  }
  return { usd: null, unit };
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

function exportMaterialsCSV(d) {
  // 선택 분기 기준으로 공사원가 CSV
  const period = periodState.period || getLatestPeriod(d);
  const row = getSeriesRow(d, period) || {};
  const mats = Array.isArray(d.materials) ? d.materials : [];

  const headers = ["분기", "품목", "가격", "단위"];
  const rows = mats.map(m => {
    const k = m.key;
    const field = KEY_TO_SERIES_FIELD[
      k === "aluminium" ? "aluminum_t" : // 혹시 key가 그대로 들어오면
      (k === "brent" ? "brent_bbl" :
      k === "lng" ? "lng_mmbtu" :
      k === "copper" ? "copper_t" :
      k === "rebar" ? "rebar_t" :
      k === "cement" ? "cement_t" : null)
    ] || k;

    // row[field] 말고 key 기반으로 바로 접근(너의 원본 materials key를 활용)
    const price = row?.[k] ?? row?.[field] ?? "";
    const unit = m.unit || d?.materialsQuarterly?.units?.[k] || d?.materialsQuarterly?.units?.[field] || "";
    return [period, m.item || k, price, unit];
  });

  downloadCSV(`${selectedISO}_공사원가_${period}.csv`, rowsToCSV(headers, rows));
}

//
// ============== render blocks ==============
//
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
      <button data-action="csv"
        style="padding:8px 12px;border:1px solid #ddd;border-radius:14px;background:#fff;color:#111827;cursor:pointer;">
        CSV
      </button>
    </div>
  `;
}

// ✅ 공사원가: materialsQuarterly.series에서 “선택 분기” 단가 표시
function renderCostsView(d) {
  const updated = d.updated || "—";

  const periods = listAvailablePeriods(d);
  if (!periodState.period) periodState.period = getLatestPeriod(d);

  // 분기 옵션
  const options = periods.map(p => {
    const sel = (p === periodState.period) ? "selected" : "";
    return `<option value="${esc(p)}" ${sel}>${esc(p)}</option>`;
  }).join("");

  const row = getSeriesRow(d, periodState.period) || {};
  const mats = Array.isArray(d.materials) ? d.materials : [];

  const rows = mats.map(m => {
    const key = m.key;              // brent, lng, copper, aluminium, rebar, cement
    const item = esc(m.item || key);
    const unit = esc(m.unit || d?.materialsQuarterly?.units?.[key] || "");
    const price = (typeof row?.[key] === "number") ? fmtNum(row[key], 3) : "—";
    return `<tr><td>${item}</td><td class="right">${price}</td><td>${unit}</td></tr>`;
  }).join("");

  // 인건비 간단표(데이터에 labor 있으면 출력)
  const laborRows = (Array.isArray(d.labor) ? d.labor : []).map(x => {
    const role = esc(pick(x, ["role","name"], ""));
    const w = toNum(pick(x, ["wage","value"], ""));
    const unit = esc(pick(x, ["unit"], ""));
    return `<tr><td>${role}</td><td class="right">${w !== null ? fmtNum(w, 2) : "—"}</td><td>${unit}</td></tr>`;
  }).join("");

  return `
    <div class="muted">업데이트: ${esc(updated)}</div>

    <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:10px 0;">
      <div style="font-weight:900;">기준 분기</div>
      <select id="costPeriod" data-cost-field="period"
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
        ${options || `<option value="">—</option>`}
      </select>
    </div>

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
  if (!periodState.period) periodState.period = getLatestPeriod(d);

  const options = periods.map(p => {
    const sel = (p === periodState.period) ? "selected" : "";
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
    const up = getMaterialUnitPrice(d, it.key, periodState.period);
    const unitPrice = up.usd;
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
      <div style="font-weight:900;">기준 분기</div>
      <select id="matPeriod" data-mat-field="period"
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
    const up = getMaterialUnitPrice(d, k, periodState.period);
    if (qtyNum !== null && up.usd !== null) {
      sum += qtyNum * up.usd;
      hasAny = true;
    }
  }

  const el = document.getElementById("matTotal");
  if (!el) return;
  el.textContent = hasAny ? `합계: ${fmtNum(sum, 2)} USD` : `합계: —`;
}

function renderLaborCalcView() {
  return `<div class="muted">인건비 계산(구현 예정)</div>`;
}
function renderNonWorkView() {
  return `<div class="muted">비작업일수(구현 유지)</div>`;
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

  // period 기본값 세팅
  if (!periodState.period) periodState.period = getLatestPeriod(d);

  let body = "";
  if (view === "costs") body = renderCostsView(d);
  else if (view === "matcalc") body = renderMatCalcView(d);
  else if (view === "laborcalc") body = renderLaborCalcView(d);
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
  } catch (e) {
    console.error(e);
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
      console.error(e);
      setInfo("오류", `<div class="muted">지도 데이터를 불러오지 못했습니다.</div>`);
    }
  });

  // 검색
  const doSearch = () => {
    const q = (searchInput?.value || "").trim();
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

  if (searchBtn) searchBtn.addEventListener("click", doSearch);
  if (searchInput) searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

  if (clearBtn) clearBtn.addEventListener("click", () => {
    if (searchInput) searchInput.value = "";
    selectedISO = null;
    selectedIsoRaw = "UNK";
    selectedFID = null;
    selectedName = null;
    periodState.period = "";
    setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);
    highlightFID(null);
  });

  // ✅ 여기서 죽지 않도록 null 체크
  if (advancedBtn) advancedBtn.addEventListener("click", () => { alert(" "); });

  // info 영역 이벤트(탭/CSV/입력)
  const infoEl = document.getElementById("info");
  if (infoEl) {
    infoEl.addEventListener("click", (e) => {
      const csvBtn = e.target.closest('button[data-action="csv"]');
      if (csvBtn) {
        if (!selectedISO) return alert("먼저 국가를 선택하세요.");
        const d = countryData?.[selectedISO];
        if (!d) return alert("국가 데이터가 없습니다.");
        exportMaterialsCSV(d);
        return;
      }

      const btn = e.target.closest("button[data-view]");
      if (btn) {
        view = btn.dataset.view;
        renderPanel(selectedIsoRaw, selectedName || (infoTitle?.textContent || ""));
        return;
      }
    });

    // select/inputs
    infoEl.addEventListener("input", (e) => {
      const t = e.target;

      // 공사원가 분기
      if (t && t.matches('select[data-cost-field="period"]')) {
        periodState.period = t.value;
        renderPanel(selectedIsoRaw, selectedName || (infoTitle?.textContent || ""));
        return;
      }

      // 자재비 계산 분기
      if (t && t.matches('select[data-mat-field="period"]')) {
        periodState.period = t.value;
        renderPanel(selectedIsoRaw, selectedName || (infoTitle?.textContent || ""));
        return;
      }

      // qty
      const k = t?.getAttribute?.("data-matqty");
      if (k) {
        matCalcState.qty[k] = t.value;
        updateMatTotal();
        return;
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
