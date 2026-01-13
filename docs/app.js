// app.js (Full)
// - GitHub Pages 경로 안정화(./data/* 우선) + 로드 로그
// - ISO 정규화(trim/upper)로 "상세 데이터 없음" 방지
// - 탭 순서: 자재비, 자재비계산, 인건비계산, 비작업일수, CSV
// - 자재비계산: 분기(YYYYQ#) 선택 + 원유/LNG/구리/알루미늄/철근/시멘트 수량×단가 합산
// - 인건비계산: 역할별 일급 × 인원 × 일수 합산
// - CSV: 자재비+비작업일수 2개 다운로드

const GEOJSON_URLS = [
  "./data/countries.geojson",
  "./countries.geojson",
];

const DATA_URLS = [
  "./data/countrydata.json",
  "./data/countryData.json",
  "./countrydata.json",
  "./countryData.json",
];

const MAP_STYLE = "https://demotiles.maplibre.org/style.json";

const infoTitle = document.getElementById("infoTitle");
const infoBody = document.getElementById("infoBody");

const searchInput = document.getElementById("searchInput");
const clearBtn = document.getElementById("clearBtn");
const searchBtn = document.getElementById("searchBtn");
const advancedBtn = document.getElementById("advancedBtn");

let map;
let countriesGeo = null;
let countryData = {};

// 선택 상태
let selectedISO = null;     // "ARE" 같은 ISO3 (없으면 null)
let selectedIsoRaw = "UNK"; // 원본 ISO 값 (UNK 포함)
let selectedFID = null;     // 항상 있는 feature id(내부)
let selectedName = null;    // 표시용 국가명
let view = "materials";     // materials | matcalc | laborcalc | nonwork

// 자재비 계산 상태
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

// 인건비 계산 상태
let laborCalcState = {
  days: "20",
  headcount: {}, // roleKey -> 인원
};

// ---- helpers ----
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
  const hi = pick(obj, ["avgHigh", "high", "tMax", "avgMax", "meanMax", "max"]);
  const lo = pick(obj, ["avgLow", "low", "tMin", "avgMin", "meanMin", "min"]);
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

// ISO3 뽑기 (trim/upper 강제)
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

// ✅ __name / __iso / __fid 강제 주입 + ISO 정규화
function preprocessCountriesGeo(geo) {
  const features = geo?.features || [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    f.properties = f.properties || {};

    const name = getName(f.properties) || "Unknown";
    const iso = (getISOFromProps(f.properties) || isoFallbackByName(name) || "UNK")
      .toString()
      .trim()
      .toUpperCase();
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

/* =========================
   CSV Export
========================= */
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
  if (!selectedISO) {
    alert("먼저 국가를 선택하세요.");
    return;
  }
  const d = countryData?.[selectedISO];
  if (!d) {
    alert(`데이터 없음: ${selectedISO}`);
    return;
  }

  const matHeaders = ["품목", "가격", "단위"];
  const matRows = (d.materials || []).map(x => [
    pick(x, ["item", "name", "material"], ""),
    pick(x, ["price", "value"], ""),
    pick(x, ["unit"], "")
  ]);
  downloadCSV(`${selectedISO}_자재비.csv`, rowsToCSV(matHeaders, matRows));

  const arr = d.nonWorkDays || [];
  if (!arr.length) {
    alert("비작업일수 데이터가 없어서 자재비만 다운로드했습니다.");
    return;
  }

  const isDesert = detectDesertSchema(d, arr);
  const third = isDesert ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";

  const nwHeaders = ["월","평균기온","평균최고/최저", third, "주말", "공휴일(평일)", "확정 비작업일", "등가 비작업일(8h)", "비고"];

  const nwRows = arr.map(r => {
    const month = pick(r, ["month", "m", "mon"], "");
    const avgTemp = pick(r, ["avgTemp", "tAvg", "avg_temperature"], "");
    const hiLo = pick(r, ["avgHiLo", "avgHighLow", "avgHighLowC", "avgHighLowStr"], "") || buildHiLo(r);

    const storm = pick(r, ["sandstorm", "storm", "dustStorm", "shamal"], "");
    const rainDays = pick(r, ["rainDays", "rain_day", "rainyDays"], "");

    const weekend = pick(r, ["weekend", "weekendDays"], "");
    const holiday = pick(r, ["holidayWeekday", "holiday", "holidayWeekdays"], "");

    const confirmed = pick(r, ["confirmedOff", "fixedOff", "fixedOffDays", "confirmedNonwork"], "");
    const equiv = pick(r, ["equivOff8h", "eqOff8h", "eqOff", "equivalentOff8h"], "");

    const note = pick(r, ["note", "remark", "remarks"], "");

    return [
      month,
      avgTemp,
      hiLo,
      isDesert ? storm : rainDays,
      weekend,
      holiday,
      confirmed,
      equiv,
      note
    ];
  });

  setTimeout(() => {
    downloadCSV(`${selectedISO}_비작업일수.csv`, rowsToCSV(nwHeaders, nwRows));
  }, 250);
}

/* =========================
   자재비계산(분기별)
========================= */
function getMatSeries(d) {
  const s = d?.materialsQuarterly?.series;
  return Array.isArray(s) ? s : [];
}
function getDefaultMatPeriod(d) {
  const s = getMatSeries(d);
  if (!s.length) return "";
  return s[s.length - 1].period || "";
}
function getMatRowByPeriod(d, period) {
  const s = getMatSeries(d);
  return s.find(x => String(x.period) === String(period)) || null;
}
function fmtMoney(n) {
  const num = Number(n);
  if (!isFinite(num)) return "—";
  return num.toLocaleString(undefined, { maximumFractionDigits: 3 });
}
function toNum(v) {
  const n = parseFloat(String(v ?? "").trim());
  return isFinite(n) ? n : 0;
}

// 표준 key 세트(요청 6종)
const MAT_KEYS = [
  { key: "brent", label: "원유(Brent)", defaultUnit: "USD/bbl" },
  { key: "lng", label: "LNG(JKM)", defaultUnit: "USD/MMBtu" },
  { key: "copper", label: "구리", defaultUnit: "USD/t" },
  { key: "aluminium", label: "알루미늄", defaultUnit: "USD/t" },
  { key: "rebar", label: "철근", defaultUnit: "USD/t" },
  { key: "cement", label: "시멘트", defaultUnit: "USD/t" },
];

function getMatMeta(d, key) {
  const m = (d?.materials || []).find(x => String(x.key || "").toLowerCase() === key);
  return m || null;
}

function updateMatCalcResult() {
  if (view !== "matcalc") return;
  if (!selectedISO) return;

  const d = countryData?.[selectedISO];
  if (!d) return;

  const periodEl = document.getElementById("matPeriod");
  const outEl = document.getElementById("matCalcResult");
  if (!periodEl || !outEl) return;

  const period = periodEl.value || "";
  matCalcState.period = period;

  const row = getMatRowByPeriod(d, period);

  let total = 0;
  const rowsHtml = MAT_KEYS.map(({ key, label, defaultUnit }) => {
    const qtyEl = document.getElementById(`qty_${key}`);
    const qty = toNum(qtyEl?.value);
    if (qtyEl) matCalcState.qty[key] = qtyEl.value;

    const meta = getMatMeta(d, key);
    const unit = (d?.materialsQuarterly?.units?.[key]) || meta?.unit || defaultUnit;

    // 단가: 분기 row에 있으면 사용, 없으면 meta.price(있을 때) fallback
    const unitPrice = row && row[key] != null ? Number(row[key]) : Number(meta?.price ?? 0);

    const cost = (isFinite(qty) ? qty : 0) * (isFinite(unitPrice) ? unitPrice : 0);
    total += cost;

    return `
      <tr>
        <td>${esc(meta?.item || label)}</td>
        <td class="right">${fmtMoney(qty)}</td>
        <td class="right">${fmtMoney(unitPrice)} ${esc(unit)}</td>
        <td class="right">${fmtMoney(cost)} USD</td>
      </tr>
    `;
  }).join("");

  outEl.innerHTML = `
    <table class="table" style="margin-top:8px;">
      <thead>
        <tr>
          <th>품목</th>
          <th class="right">수량</th>
          <th class="right">단가(선택 분기)</th>
          <th class="right">금액</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml}
        <tr>
          <td colspan="3"><b>합계</b></td>
          <td class="right"><b>${fmtMoney(total)} USD</b></td>
        </tr>
      </tbody>
    </table>
    <div class="muted" style="margin-top:8px;">
      수량 단위는 품목 특성에 맞게 입력하세요 (예: 원유=bbl, LNG=MMBtu, 구리/알루미늄/철근/시멘트=t).
    </div>
  `;
}

/* =========================
   인건비계산
========================= */
function updateLaborCalcResult() {
  if (view !== "laborcalc") return;
  if (!selectedISO) return;

  const d = countryData?.[selectedISO];
  if (!d) return;

  const daysEl = document.getElementById("laborDays");
  const outEl = document.getElementById("laborCalcResult");
  if (!daysEl || !outEl) return;

  const days = toNum(daysEl.value);
  laborCalcState.days = String(daysEl.value ?? "");

  const laborArr = Array.isArray(d.labor) ? d.labor : [];
  let total = 0;

  const rowsHtml = laborArr.map((r, idx) => {
    const role = pick(r, ["role", "name"], `Role ${idx + 1}`);
    const wage = Number(pick(r, ["wage", "price", "daily"], 0));
    const unit = pick(r, ["unit"], "USD/day");

    const key = `labor_${idx}`;
    const hcEl = document.getElementById(`hc_${key}`);
    const head = toNum(hcEl?.value);
    if (hcEl) laborCalcState.headcount[key] = hcEl.value;

    const cost = (isFinite(wage) ? wage : 0) * (isFinite(head) ? head : 0) * (isFinite(days) ? days : 0);
    total += cost;

    return `
      <tr>
        <td>${esc(role)}</td>
        <td class="right">${fmtMoney(head)}</td>
        <td class="right">${fmtMoney(wage)} ${esc(unit)}</td>
        <td class="right">${fmtMoney(cost)} USD</td>
      </tr>
    `;
  }).join("");

  outEl.innerHTML = `
    <table class="table" style="margin-top:8px;">
      <thead>
        <tr>
          <th>직종</th>
          <th class="right">인원</th>
          <th class="right">일급</th>
          <th class="right">금액(일급×인원×일수)</th>
        </tr>
      </thead>
      <tbody>
        ${rowsHtml || `<tr><td colspan="4">데이터 없음</td></tr>`}
        <tr>
          <td colspan="3"><b>합계</b></td>
          <td class="right"><b>${fmtMoney(total)} USD</b></td>
        </tr>
      </tbody>
    </table>
  `;
}

/* =========================
   패널 렌더
========================= */
function renderPanel(isoRaw, fallbackName) {
  selectedIsoRaw = (isoRaw ?? "UNK").toString().trim().toUpperCase();
  const iso = (isIso3(selectedIsoRaw) && selectedIsoRaw !== "UNK") ? selectedIsoRaw : null;
  selectedISO = iso;

  // ✅ 탭(요청 순서) + CSV 버튼은 맨 끝
  const tabs = `
    <div style="display:flex; gap:8px; margin:10px 0 6px; align-items:center; flex-wrap:wrap;">
      <button data-view="materials" style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="materials"?"#111827":"#fff"};color:${view==="materials"?"#fff":"#111827"};cursor:pointer;">자재비</button>
      <button data-view="matcalc" style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="matcalc"?"#111827":"#fff"};color:${view==="matcalc"?"#fff":"#111827"};cursor:pointer;">자재비계산</button>
      <button data-view="laborcalc" style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="laborcalc"?"#111827":"#fff"};color:${view==="laborcalc"?"#fff":"#111827"};cursor:pointer;">인건비계산</button>
      <button data-view="nonwork" style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="nonwork"?"#111827":"#fff"};color:${view==="nonwork"?"#fff":"#111827"};cursor:pointer;">비작업일수</button>
      <button data-action="csv" style="padding:8px 12px;border:1px solid #ddd;border-radius:14px;background:#fff;color:#111827;cursor:pointer;">CSV</button>
    </div>
  `;

  let title = fallbackName || (isoRaw || "선택 국가");
  if (iso && countryData?.[iso]) title = countryData[iso].name || title;

  if (!iso) {
    setInfo(title, tabs + `<div class="muted">이 국가의 상세 데이터가 없습니다.</div>`);
    return;
  }

  const d = countryData?.[iso];
  if (!d) {
    setInfo(title, tabs + `<div class="muted">이 국가의 상세 데이터가 없습니다.</div>`);
    return;
  }

  const updated = d.materialsUpdated || d.updated || "—";

  // ---- 자재비(표) ----
  const matRows = (d.materials || []).map((r) => `
    <tr>
      <td>${esc(pick(r, ["item", "name", "material"], ""))}</td>
      <td class="right">${
        typeof r.price === "number"
          ? r.price.toLocaleString(undefined, { maximumFractionDigits: 3 })
          : esc(pick(r, ["price", "value"], ""))
      }</td>
      <td>${esc(pick(r, ["unit"], ""))}</td>
    </tr>
  `).join("");

  const materialsTable = `
    <div class="muted">업데이트: ${esc(updated)}</div>
    <table class="table">
      <thead>
        <tr><th>품목</th><th class="right">가격</th><th>단위</th></tr>
      </thead>
      <tbody>${matRows || `<tr><td colspan="3">데이터 없음</td></tr>`}</tbody>
    </table>
  `;

  // ---- 비작업일수 ----
  const nwd = d.nonWorkDays || [];
  const isDesert = detectDesertSchema(d, nwd);
  const thirdColName = isDesert ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";

  const nonWorkTable = `
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
            const month = pick(r, ["month", "m", "mon"], "");
            const avgTemp = pick(r, ["avgTemp", "tAvg"], "");
            const hiLo = pick(r, ["avgHiLo", "avgHighLow", "avgHighLowC", "avgHighLowStr"], "") || buildHiLo(r);

            const storm = pick(r, ["sandstorm", "storm", "dustStorm", "shamal"], "");
            const rain = pick(r, ["rainDays", "rain_day", "rainyDays"], "");

            const weekend = pick(r, ["weekend", "weekendDays"], "");
            const holiday = pick(r, ["holidayWeekday", "holiday", "holidayWeekdays"], "");

            const confirmed = pick(r, ["confirmedOff", "fixedOff", "fixedOffDays", "confirmedNonwork"], "");
            const equiv = pick(r, ["equivOff8h", "eqOff8h", "eqOff", "equivalentOff8h"], "");

            const note = pick(r, ["note", "remark", "remarks"], "");

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

  // ---- 자재비계산 UI ----
  const matSeries = getMatSeries(d);
  if (!matCalcState.period) matCalcState.period = getDefaultMatPeriod(d);

  const matCalcUI = `
    <div class="muted">선택한 분기(YYYYQ#)의 단가로 자재비를 계산합니다.</div>

    <div style="margin-top:10px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <div style="font-weight:700;">기준 연도/분기</div>
      <select
        id="matPeriod"
        data-mat-field="period"
        style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;"
      >
        ${
          matSeries.map(r => {
            const p = String(r.period || "");
            const sel = p === String(matCalcState.period) ? "selected" : "";
            return `<option value="${esc(p)}" ${sel}>${esc(p)}</option>`;
          }).join("") || `<option value="">(시계열 없음)</option>`
        }
      </select>
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px;">
      ${MAT_KEYS.map(({ key, label, defaultUnit }) => {
        const meta = getMatMeta(d, key);
        const unit = (d?.materialsQuarterly?.units?.[key]) || meta?.unit || defaultUnit;
        return `
          <div style="border:1px solid #e5e7eb; border-radius:14px; padding:10px;">
            <div style="font-weight:700; margin-bottom:6px;">${esc(meta?.item || label)}</div>
            <div style="display:flex; gap:8px; align-items:center;">
              <input
                id="qty_${key}"
                data-mat-field="qty"
                data-mat-key="${key}"
                type="number"
                inputmode="decimal"
                min="0"
                step="0.1"
                placeholder="수량 입력"
                value="${esc(matCalcState.qty[key] ?? "")}"
                style="flex:1; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px;"
              />
              <span class="muted">${esc(unit.split("/").pop() || unit)}</span>
            </div>
          </div>
        `;
      }).join("")}
    </div>

    <div id="matCalcResult"></div>
  `;

  // ---- 인건비계산 UI ----
  const laborArr = Array.isArray(d.labor) ? d.labor : [];
  const laborUI = `
    <div class="muted">일급 × 인원 × 일수로 인건비를 계산합니다.</div>

    <div style="margin-top:10px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
      <div style="font-weight:700;">작업일수</div>
      <input
        id="laborDays"
        data-labor-field="days"
        type="number"
        inputmode="numeric"
        min="0"
        step="1"
        value="${esc(laborCalcState.days)}"
        style="width:140px; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px;"
      />
      <span class="muted">days</span>
    </div>

    <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px;">
      ${
        laborArr.map((r, idx) => {
          const role = pick(r, ["role", "name"], `Role ${idx + 1}`);
          const wage = pick(r, ["wage", "price", "daily"], "");
          const unit = pick(r, ["unit"], "USD/day");
          const key = `labor_${idx}`;
          const val = laborCalcState.headcount[key] ?? "";
          return `
            <div style="border:1px solid #e5e7eb; border-radius:14px; padding:10px;">
              <div style="font-weight:700; margin-bottom:6px;">${esc(role)}</div>
              <div class="muted" style="margin:0 0 8px;">일급: ${esc(wage)} ${esc(unit)}</div>
              <div style="display:flex; gap:8px; align-items:center;">
                <input
                  id="hc_${key}"
                  data-labor-field="headcount"
                  data-labor-key="${key}"
                  type="number"
                  inputmode="numeric"
                  min="0"
                  step="1"
                  placeholder="인원"
                  value="${esc(val)}"
                  style="flex:1; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px;"
                />
                <span class="muted">명</span>
              </div>
            </div>
          `;
        }).join("") || `<div class="muted">인건비 데이터가 없습니다.</div>`
      }
    </div>

    <div id="laborCalcResult"></div>
  `;

  // ---- PPP 링크 ----
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

  const body =
    (view === "nonwork") ? nonWorkTable :
    (view === "laborcalc") ? laborUI :
    (view === "matcalc") ? matCalcUI :
    materialsTable;

  setInfo(title, tabs + body + pppBlock);

  if (view === "matcalc") queueMicrotask(() => updateMatCalcResult());
  if (view === "laborcalc") queueMicrotask(() => updateLaborCalcResult());
}

/* =========================
   Init
========================= */
async function init() {
  setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);

  // countryData 로드 + 로그
  try {
    const { json, url } = await fetchJsonFirstOk(DATA_URLS, "countrydata.json");
    countryData = json || {};
    console.log("[countryData] loaded:", url, "keys:", Object.keys(countryData));
  } catch (e) {
    countryData = {};
    console.warn("[countryData] load failed:", e);
    setInfo("오류", `<div class="muted">데이터 파일을 불러오지 못했습니다. (GitHub Pages 경로/대소문자/배포 확인)</div>`);
  }

  // ✅ 시작 화면: 중동 확대
  map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [51.5, 24.0], // UAE 근처
    zoom: 3.6,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", async () => {
    try {
      const { json, url } = await fetchJsonFirstOk(GEOJSON_URLS, "countries.geojson");
      console.log("[geojson] loaded:", url);
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

        view = "materials";
        renderPanel(isoRaw, name);
      });
    } catch (e) {
      console.warn("geojson load error:", e);
      setInfo("오류", `<div class="muted">지도 데이터를 불러오지 못했습니다. (data/countries.geojson 배포 확인)</div>`);
    }
  });

  // ===== 검색 =====
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

    view = "materials";
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
    view = "materials";

    setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);
    highlightFID(null);
  });

  advancedBtn.addEventListener("click", () => alert(" "));

  const infoEl = document.getElementById("info");

  // 탭/CSV 클릭(이벤트 위임)
  infoEl.addEventListener("click", (e) => {
    const csvBtn = e.target.closest('button[data-action="csv"]');
    if (csvBtn) {
      exportMaterialsAndNonworkCSV();
      return;
    }

    const btn = e.target.closest("button[data-view]");
    if (!btn) return;

    view = btn.dataset.view;
    renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
  });

  // 자재비계산 input
  infoEl.addEventListener("input", (e) => {
    const matField = e.target?.getAttribute?.("data-mat-field");
    if (matField === "qty") {
      const key = e.target.getAttribute("data-mat-key");
      if (key) matCalcState.qty[key] = e.target.value;
      updateMatCalcResult();
      return;
    }

    const laborField = e.target?.getAttribute?.("data-labor-field");
    if (laborField === "days") {
      laborCalcState.days = e.target.value;
      updateLaborCalcResult();
      return;
    }
    if (laborField === "headcount") {
      const key = e.target.getAttribute("data-labor-key");
      if (key) laborCalcState.headcount[key] = e.target.value;
      updateLaborCalcResult();
      return;
    }
  });

  // select 변경
  infoEl.addEventListener("change", (e) => {
    if (e.target && e.target.id === "matPeriod") {
      matCalcState.period = e.target.value;
      updateMatCalcResult();
      return;
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
