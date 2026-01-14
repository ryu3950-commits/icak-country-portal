// app.js (LIGHT LABOR ADDED + DURATION CALC ADDED)
// ✅ 인건비 표 위치: "공사원가(costs)"의 자재비 표 아래
// ✅ 인건비 섹션의 설명 문구 제거
// ✅ "자재비 계산(matcalc)" 화면에서는 인건비 표 제거
// ✅ 탭: 공사원가 / 자재비 계산 / 인건비 계산 / 비작업일수 / 공사기간 계산 / CSV
// ✅ 공사기간 계산: 비작업일수(월별) 기반 작업가능비율 추정 → 작업일수/달력일수/필요인원 계산

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
  manDays: "",         // 총 작업량(인일)
  crew: "40",          // 투입 인원(명)
  shiftMode: "day",    // day | daynight
  overtimePremium: "1.0", // 1.0 | 1.25 | 1.5
  targetCalendarDays: "", // 목표 공사기간(달력일) - 선택
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

// ✅ 핵심: countrydata.json 구조 정규화
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
      const iso = String(it?.iso || it?.ISO || it?.iso3 || it?.ISO3 || it?.code || "").trim().toUpperCase();
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

  // 혹시 다른 구조가 있어도 호환
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

  // 공사원가(선택분기)
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

  // 비작업일수
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

  const sorted = [...arr].sort(
    (a, b) => monthIndex(a.month ?? a.m ?? a.mon) - monthIndex(b.month ?? b.m ?? b.mon)
  );

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

function renderLaborBlock(d) {
  const labor = Array.isArray(d?.labor) ? d.labor : [];
  const rows = labor
    .map((x) => {
      const role = esc(pick(x, ["role", "name", "title"], ""));
      const w = toNum(pick(x, ["wage", "value", "price"], ""));
      const unit = esc(pick(x, ["unit"], ""));
      return `<tr><td>${role}</td><td class="right">${w !== null ? fmtNum(w, 2) : "—"}</td><td>${unit}</td></tr>`;
    })
    .join("");

  return `
    <div style="margin-top:16px; font-weight:900;">인건비</div>
    <table class="table" style="margin-top:8px;">
      <thead><tr><th>구분</th><th class="right">금액</th><th>단위</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="3">데이터 없음</td></tr>`}</tbody>
    </table>
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

    ${renderLaborBlock(d)}
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

function renderLaborCalcView(d) {
  // 계산 없이 표만 보여주는 "인건비 계산" 탭
  return `${renderLaborBlock(d)}`;
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

  const sorted = [...nwd].sort(
    (a, b) => monthIndex(a.month ?? a.m ?? a.mon) - monthIndex(b.month ?? b.m ?? b.mon)
  );

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
  return new Date(year, m, 0).getDate(); // month is 1-based here: new Date(y, m, 0) = last day of month m
}

function parseMonthNumber(m) {
  const s = String(m ?? "");
  const n = parseInt(s.replace(/[^0-9]/g, ""), 10);
  if (!Number.isFinite(n)) return null;
  if (n >= 1 && n <= 12) return n;
  return null;
}

// 월별 비작업일수에서 "비작업 총량"을 뽑아내서 연간 작업가능비율 계산
function computeWorkabilityRatio(d, year) {
  const nwd = Array.isArray(d?.nonWorkDays) ? d.nonWorkDays : [];
  if (!nwd.length) {
    // 데이터 없으면 보수적으로 0.72(주5일 기준) 정도로 둠
    return { ratio: 0.72, detail: null };
  }

  let totalDays = 0;
  let totalOff = 0;

  for (const r of nwd) {
    const mon = parseMonthNumber(pick(r, ["month", "m", "mon"], ""));
    if (!mon) continue;

    const mdays = daysInMonth(year, mon);
    totalDays += mdays;

    // eqOff8h가 있으면 그걸 우선(8h 기준 등가 비작업일)
    const eq = toNum(pick(r, ["eqOff8h", "equivOff8h"], ""));
    const conf = toNum(pick(r, ["fixedOff", "confirmedOff", "fixedOffDays"], ""));

    const off = (eq !== null ? eq : (conf !== null ? conf : 0));
    totalOff += Math.max(0, off);
  }

  if (totalDays <= 0) return { ratio: 0.72, detail: null };

  const workable = Math.max(0, totalDays - totalOff);
  const ratio = workable / totalDays;

  return {
    ratio: Math.min(0.95, Math.max(0.3, ratio)),
    detail: { totalDays, totalOff, workable }
  };
}

function getShiftMultiplier(mode) {
  // 주간=1.0, 주야간=1.6 (야간 생산성 저하를 포함한 단순 계수)
  if (mode === "daynight") return 1.6;
  return 1.0;
}

function renderDurationCalcView(d) {
  const year = Number(durationCalcState.year) || new Date().getFullYear();
  const manDays = toNum(durationCalcState.manDays);
  const crew = Math.max(1, toNum(durationCalcState.crew) ?? 40);
  const ot = Math.max(1, toNum(durationCalcState.overtimePremium) ?? 1.0);
  const shiftM = getShiftMultiplier(durationCalcState.shiftMode);

  const { ratio, detail } = computeWorkabilityRatio(d, year);

  // 산정
  const workDaysNeeded = (manDays !== null) ? (manDays / (crew * shiftM * ot)) : null;
  const calendarDaysNeeded = (workDaysNeeded !== null) ? (workDaysNeeded / ratio) : null;

  const targetCal = toNum(durationCalcState.targetCalendarDays);
  const crewNeeded = (manDays !== null && targetCal !== null && targetCal > 0)
    ? (manDays / (targetCal * ratio * shiftM * ot))
    : null;

  const ratioText = (detail)
    ? `${fmtNum(ratio * 100, 1)}% (연간 ${detail.workable.toFixed(0)}/${detail.totalDays.toFixed(0)}일 작업 가능)`
    : `${fmtNum(ratio * 100, 1)}%`;

  const resultBlock = `
    <div style="margin-top:14px;">
      <div style="font-weight:900; margin-bottom:8px;">결과</div>
      <table class="table">
        <thead>
          <tr>
            <th>항목</th>
            <th class="right">값</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>작업가능비율</td>
            <td class="right"><b>${esc(ratioText)}</b></td>
          </tr>
          <tr>
            <td>필요 작업일수</td>
            <td class="right"><b>${workDaysNeeded !== null ? fmtNum(workDaysNeeded, 1) + " 일" : "—"}</b></td>
          </tr>
          <tr>
            <td>예상 공사기간(달력일)</td>
            <td class="right"><b>${calendarDaysNeeded !== null ? fmtNum(calendarDaysNeeded, 0) + " 일" : "—"}</b></td>
          </tr>
          <tr>
            <td>목표 달력일 기준 필요 인원</td>
            <td class="right"><b>${crewNeeded !== null ? fmtNum(Math.ceil(crewNeeded), 0) + " 명" : "—"}</b></td>
          </tr>
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
            style="width:140px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; text-align:right;" />
          <span class="muted">명</span>
          <button type="button" data-duration-preset="12"
            style="padding:8px 10px;border:1px solid #ddd;border-radius:12px;background:#fff;cursor:pointer;">
            12명
          </button>
          <button type="button" data-duration-preset="40"
            style="padding:8px 10px;border:1px solid #ddd;border-radius:12px;background:#fff;cursor:pointer;">
            40명
          </button>
        </div>
      </div>

      <div style="border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
        <div style="font-weight:900;">작업 방식</div>
        <div style="display:flex; gap:10px; align-items:center; margin-top:8px; flex-wrap:wrap;">
          <select data-duration-field="shiftMode"
            style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
            <option value="day" ${durationCalcState.shiftMode === "day" ? "selected" : ""}>주간</option>
            <option value="daynight" ${durationCalcState.shiftMode === "daynight" ? "selected" : ""}>주야간</option>
          </select>

          <div style="display:flex; align-items:center; gap:8px;">
            <span class="muted">OT</span>
            <select data-duration-field="overtimePremium"
              style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
              ${[1.0, 1.25, 1.5].map(v => `
                <option value="${v}" ${Number(durationCalcState.overtimePremium) === v ? "selected" : ""}>x${v}</option>
              `).join("")}
            </select>
          </div>
        </div>
      </div>
    </div>

    <div style="margin-top:12px; border:1px solid #e5e7eb; border-radius:14px; padding:12px;">
      <div style="font-weight:900;">목표 공사기간(선택)</div>
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

  // period default
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

  // advanced 버튼은 없어도 안전하게
  if (advancedBtn) advancedBtn.addEventListener("click", () => alert(" "));

  // ✅ info 영역 이벤트: 탭/CSV 클릭
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

      // 공사기간 계산 - 인원 프리셋
      const preset = e.target.closest("button[data-duration-preset]");
      if (preset) {
        durationCalcState.crew = preset.dataset.durationPreset;
        renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
        return;
      }
    });

    // ✅ period 변경은 change로 받는게 확실함
    infoEl.addEventListener("change", (e) => {
      const t = e.target;

      if (t && t.matches('select[data-mat-field="period"]')) {
        matCalcState.period = t.value;
        renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
        return;
      }

      // duration fields (select)
      const df = t?.getAttribute?.("data-duration-field");
      if (df) {
        durationCalcState[df] = t.value;
        renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
        return;
      }
    });

    // ✅ qty 입력은 input으로 즉시 반영
    infoEl.addEventListener("input", (e) => {
      const t = e.target;

      // mat qty
      const k = t?.getAttribute?.("data-matqty");
      if (k) {
        matCalcState.qty[k] = t.value;
        updateMatTotal();
        return;
      }

      // duration fields (input)
      const df = t?.getAttribute?.("data-duration-field");
      if (df) {
        durationCalcState[df] = t.value;
        renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
        return;
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
