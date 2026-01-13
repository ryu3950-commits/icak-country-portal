// app.js (Full)
// - GitHub Pages 경로 대응: countrydata.json 우선 로드
// - 탭 순서: 자재비 → 자재비계산 → 인건비계산 → 비작업일수 → CSV
// - 자재비계산: 원유/LNG/구리/알루미늄/철근/시멘트 등 materials 전체 품목 수량*단가 합계
// - 인건비계산: labor 전체 직종에 대해 인원/일수 입력 → 합계
// - ISO 공백/개행/소문자 정규화 + geojson __iso/__fid 주입 + 선택 하이라이트
// - CSV Export(자재비+비작업일수)

const GEOJSON_URLS = [
  "./data/countries.geojson",
  "./countries.geojson",
  "./country-demo/data/countries.geojson",
  "./docs/data/countries.geojson",
];

const DATA_URLS = [
  // ✅ github pages에서 실제 살아있는 경로를 우선
  "./data/countrydata.json",
  "./data/countryData.json",
  "./countrydata.json",
  "./countryData.json",
  "./country-demo/data/countrydata.json",
  "./country-demo/data/countryData.json",
  "./docs/data/countrydata.json",
  "./docs/data/countryData.json",
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

// views: materials | matcalc | laborcalc | nonwork
let view = "materials";

// 계산 상태
let matCalcState = {};   // { idx: "qty" }
let laborCalcState = {}; // { idx: { count:"", days:"" } }

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
    "ISO_A3", "iso_a3",
    "ISO3", "iso3",
    "ADM0_A3", "adm0_a3",
    "SOV_A3", "sov_a3",
    "ISO_A3_EH", "iso_a3_eh",
    "ISO3166_A3",
    "ISO_3", "iso_3",
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
      .trim().toUpperCase();
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
  return "\ufeff" + head + "\n" + body; // Excel BOM
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

  // 자재비
  const matHeaders = ["품목", "가격", "단위"];
  const matRows = (d.materials || []).map(x => [
    pick(x, ["item", "name", "material"], ""),
    pick(x, ["price", "value"], ""),
    pick(x, ["unit"], "")
  ]);
  downloadCSV(`${selectedISO}_자재비.csv`, rowsToCSV(matHeaders, matRows));

  // 비작업일수
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
      month, avgTemp, hiLo,
      isDesert ? storm : rainDays,
      weekend, holiday,
      confirmed, equiv,
      note
    ];
  });

  setTimeout(() => {
    downloadCSV(`${selectedISO}_비작업일수.csv`, rowsToCSV(nwHeaders, nwRows));
  }, 250);
}

/* =========================
   계산 업데이트(자재비/인건비)
========================= */
function fmtMoney(n) {
  const num = Number(n);
  if (!isFinite(num)) return "—";
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function updateMatCalcResult() {
  if (view !== "matcalc") return;
  if (!selectedISO) return;

  const d = countryData?.[selectedISO];
  const outEl = document.getElementById("matCalcResult");
  if (!d || !outEl) return;

  const mats = Array.isArray(d.materials) ? d.materials : [];
  if (!mats.length) {
    outEl.innerHTML = `<div class="muted">자재비 데이터가 없습니다.</div>`;
    return;
  }

  let total = 0;

  const rows = mats.map((m, i) => {
    const qtyEl = document.getElementById(`matQty_${i}`);
    const qty = parseFloat(qtyEl?.value || "0") || 0;
    matCalcState[i] = qtyEl?.value ?? "";

    const unitPrice = Number(pick(m, ["price", "value"], 0));
    const amount = (isFinite(unitPrice) ? unitPrice : 0) * qty;
    total += amount;

    const item = pick(m, ["item", "name", "material"], "");
    const unit = pick(m, ["unit"], "");
    return `
      <tr>
        <td>${esc(item)}</td>
        <td class="right">
          <input
            id="matQty_${i}"
            data-mat-idx="${i}"
            type="number"
            inputmode="decimal"
            min="0"
            step="0.01"
            placeholder="수량"
            value="${esc(matCalcState[i] ?? "")}"
            style="width:120px; padding:8px 10px; border:1px solid #e5e7eb; border-radius:12px;"
          />
        </td>
        <td class="right">${fmtMoney(unitPrice)}</td>
        <td>${esc(unit)}</td>
        <td class="right"><b>${fmtMoney(amount)}</b></td>
      </tr>
    `;
  }).join("");

  outEl.innerHTML = `
    <table class="table" style="margin-top:10px;">
      <thead>
        <tr>
          <th>품목</th>
          <th class="right">수량</th>
          <th class="right">단가</th>
          <th>단위</th>
          <th class="right">금액</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        <tr>
          <td colspan="4"><b>합계</b></td>
          <td class="right"><b>${fmtMoney(total)}</b></td>
        </tr>
      </tbody>
    </table>
    <div class="muted" style="margin-top:8px;">
      * 각 품목 수량은 해당 단위(예: $/bbl이면 bbl, $/t이면 t) 기준으로 입력하세요.
    </div>
  `;
}

function updateLaborCalcResult() {
  if (view !== "laborcalc") return;
  if (!selectedISO) return;

  const d = countryData?.[selectedISO];
  const outEl = document.getElementById("laborCalcResult");
  if (!d || !outEl) return;

  const labor = Array.isArray(d.labor) ? d.labor : [];
  if (!labor.length) {
    outEl.innerHTML = `<div class="muted">인건비 데이터가 없습니다.</div>`;
    return;
  }

  let total = 0;

  const rows = labor.map((r, i) => {
    const wage = Number(pick(r, ["wage", "price", "value"], 0));
    const unit = pick(r, ["unit"], "USD/day");

    const countEl = document.getElementById(`laborCount_${i}`);
    const daysEl = document.getElementById(`laborDays_${i}`);

    const count = parseFloat(countEl?.value || "0") || 0;
    const days = parseFloat(daysEl?.value || "0") || 0;

    laborCalcState[i] = laborCalcState[i] || { count: "", days: "" };
    laborCalcState[i].count = countEl?.value ?? "";
    laborCalcState[i].days = daysEl?.value ?? "";

    const amount = (isFinite(wage) ? wage : 0) * count * days;
    total += amount;

    const role = pick(r, ["role", "name"], "");

    return `
      <tr>
        <td>${esc(role)}</td>
        <td class="right">${fmtMoney(wage)}</td>
        <td>${esc(unit)}</td>
        <td class="right">
          <input
            id="laborCount_${i}"
            data-labor-idx="${i}"
            data-labor-field="count"
            type="number"
            inputmode="numeric"
            min="0"
            step="1"
            placeholder="인원"
            value="${esc(laborCalcState[i]?.count ?? "")}"
            style="width:90px; padding:8px 10px; border:1px solid #e5e7eb; border-radius:12px;"
          />
        </td>
        <td class="right">
          <input
            id="laborDays_${i}"
            data-labor-idx="${i}"
            data-labor-field="days"
            type="number"
            inputmode="numeric"
            min="0"
            step="1"
            placeholder="일수"
            value="${esc(laborCalcState[i]?.days ?? "")}"
            style="width:90px; padding:8px 10px; border:1px solid #e5e7eb; border-radius:12px;"
          />
        </td>
        <td class="right"><b>${fmtMoney(amount)}</b></td>
      </tr>
    `;
  }).join("");

  outEl.innerHTML = `
    <table class="table" style="margin-top:10px;">
      <thead>
        <tr>
          <th>직종</th>
          <th class="right">일급</th>
          <th>단위</th>
          <th class="right">인원</th>
          <th class="right">일수</th>
          <th class="right">금액</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
        <tr>
          <td colspan="5"><b>합계</b></td>
          <td class="right"><b>${fmtMoney(total)}</b></td>
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

  // ✅ 탭 순서 요청 반영
  const tabs = `
    <div style="display:flex; gap:8px; margin:10px 0 6px; align-items:center; flex-wrap:wrap;">
      <button data-view="materials"  style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="materials"?"#111827":"#fff"};color:${view==="materials"?"#fff":"#111827"};cursor:pointer;">자재비</button>
      <button data-view="matcalc"    style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="matcalc"?"#111827":"#fff"};color:${view==="matcalc"?"#fff":"#111827"};cursor:pointer;">자재비계산</button>
      <button data-view="laborcalc"  style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="laborcalc"?"#111827":"#fff"};color:${view==="laborcalc"?"#fff":"#111827"};cursor:pointer;">인건비계산</button>
      <button data-view="nonwork"    style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="nonwork"?"#111827":"#fff"};color:${view==="nonwork"?"#fff":"#111827"};cursor:pointer;">비작업일수</button>
      <button data-action="csv"      style="padding:8px 12px;border:1px solid #ddd;border-radius:14px;background:#fff;color:#111827;cursor:pointer;">CSV</button>
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

  // 1) 자재비 테이블
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

  // 2) 비작업일수 테이블
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

  // 3) 자재비 계산 UI (materials 전체 품목)
  const matCalcUI = `
    <div class="muted">자재비 계산(수량 × 단가). 품목별 단위 기준으로 수량을 입력하세요.</div>
    <div id="matCalcResult"></div>
  `;

  // 4) 인건비 계산 UI
  const laborCalcUI = `
    <div class="muted">인건비 계산(일급 × 인원 × 일수)</div>
    <div id="laborCalcResult"></div>
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

  const body =
    (view === "nonwork") ? nonWorkTable :
    (view === "matcalc") ? matCalcUI :
    (view === "laborcalc") ? laborCalcUI :
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

  // 데이터 로드
  try {
    const { json, url } = await fetchJsonFirstOk(DATA_URLS, "countrydata.json");
    countryData = json || {};
    console.log("[countrydata] loaded:", url, "keys:", Object.keys(countryData));
  } catch (e) {
    countryData = {};
    console.warn("[countrydata] load failed:", e);
  }

  // 지도 생성 (✅ 중동 확대 시작)
  map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [54.37, 24.45], // UAE 근처
    zoom: 4.2,
    pitch: 0,
    bearing: 0,
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

        // 국가를 새로 선택하면 기본 탭은 "자재비"
        view = "materials";
        renderPanel(isoRaw, name);
      });

    } catch (e) {
      setInfo("오류", `<div class="muted">지도 데이터를 불러오지 못했습니다.</div>`);
      console.warn(e);
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

  // ===== 패널 버튼/입력 이벤트 위임 =====
  const infoEl = document.getElementById("info");

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

  // 자재비계산 입력 반영
  infoEl.addEventListener("input", (e) => {
    const matIdx = e.target?.getAttribute?.("data-mat-idx");
    if (matIdx !== null && matIdx !== undefined) {
      matCalcState[matIdx] = e.target.value;
      updateMatCalcResult();
      return;
    }

    const laborIdx = e.target?.getAttribute?.("data-labor-idx");
    if (laborIdx !== null && laborIdx !== undefined) {
      laborCalcState[laborIdx] = laborCalcState[laborIdx] || { count: "", days: "" };
      const f = e.target.getAttribute("data-labor-field");
      if (f === "count") laborCalcState[laborIdx].count = e.target.value;
      if (f === "days") laborCalcState[laborIdx].days = e.target.value;
      updateLaborCalcResult();
    }
  });
}

document.addEventListener("DOMContentLoaded", init);
