// app.js (Full, GitHub Pages 경로문제까지 해결판)
// - countrydata/countryData 대소문자 모두 시도
// - ./, ../, ../../ + repo base(/<repo>/) 기준까지 시도 (docs/나 country-demo/에서 열어도 OK)
// - ISO 공백/개행/소문자 정규화
// - 로드 실패 시 어떤 URL이 실패했는지 UI + 콘솔에 표시
// - CSV Export + 공사비 분석 버튼 유지

// ====== URL 후보 생성 (GitHub Pages 하위폴더에서도 찾기) ======
const repoBase = (() => {
  // project pages: https://<user>.github.io/<repo>/...
  // pathname 첫 토큰이 repo일 확률이 높음
  const parts = window.location.pathname.split("/").filter(Boolean);
  return parts.length ? `/${parts[0]}/` : "/";
})();

function makeUrlCandidates(relPaths) {
  const prefixes = ["./", "../", "../../", repoBase];
  const out = [];
  for (const p of prefixes) {
    for (const r of relPaths) {
      // prefix가 repoBase(슬래시 포함)면 중복 슬래시 정리
      const url = (p === repoBase) ? `${repoBase}${r}` : `${p}${r}`;
      out.push(url.replace(/\/{2,}/g, "/").replace(":/", "://")); // http(s):// 보호
    }
  }
  // 중복 제거
  return [...new Set(out)];
}

const GEOJSON_URLS = makeUrlCandidates([
  "data/countries.geojson",
  "countries.geojson",
]);

const DATA_URLS = makeUrlCandidates([
  "data/countrydata.json",
  "data/countryData.json",
  "countrydata.json",
  "countryData.json",
]);

const MAP_STYLE = "https://demotiles.maplibre.org/style.json";

// ====== DOM ======
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
let view = "materials";     // materials | nonwork | cost

// 공사비 분석 상태
let costState = {
  period: "",
  rebarT: "",
  concreteM3: "",
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
   공사비 분석
========================= */
function getCostSeries(iso) {
  const s = countryData?.[iso]?.constructionCost?.series;
  return Array.isArray(s) ? s : [];
}
function getDefaultCostPeriod(iso) {
  const series = getCostSeries(iso);
  if (!series.length) return "";
  return series[series.length - 1].period || "";
}
function getCostRow(iso, period) {
  const series = getCostSeries(iso);
  return series.find(x => String(x.period) === String(period)) || null;
}
function fmtMoney(n) {
  const num = Number(n);
  if (!isFinite(num)) return "—";
  return num.toLocaleString(undefined, { maximumFractionDigits: 2 });
}
function updateCostResult() {
  if (view !== "cost") return;
  if (selectedISO !== "ARE") return;

  const periodEl = document.getElementById("costPeriod");
  const rebarEl = document.getElementById("costRebarT");
  const concEl = document.getElementById("costConcreteM3");
  const outEl = document.getElementById("costResult");

  if (!periodEl || !rebarEl || !concEl || !outEl) return;

  const period = periodEl.value || "";
  const rebarT = parseFloat(rebarEl.value || "0");
  const concreteM3 = parseFloat(concEl.value || "0");

  costState.period = period;
  costState.rebarT = rebarEl.value;
  costState.concreteM3 = concEl.value;

  const row = getCostRow("ARE", period);
  if (!row) {
    outEl.innerHTML = `<div class="muted">해당 분기 단가 데이터가 없습니다.</div>`;
    return;
  }

  const rebarUnit = Number(row.rebar_usd_per_t);
  const concUnit = Number(row.concrete_usd_per_m3);

  const rebarCost = (isFinite(rebarT) ? rebarT : 0) * (isFinite(rebarUnit) ? rebarUnit : 0);
  const concCost = (isFinite(concreteM3) ? concreteM3 : 0) * (isFinite(concUnit) ? concUnit : 0);
  const total = rebarCost + concCost;

  outEl.innerHTML = `
    <table class="table" style="margin-top:8px;">
      <thead>
        <tr>
          <th>항목</th>
          <th class="right">수량</th>
          <th class="right">단가</th>
          <th class="right">금액</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>철근</td>
          <td class="right">${isFinite(rebarT) ? fmtMoney(rebarT) : "0"} t</td>
          <td class="right">${fmtMoney(rebarUnit)} USD/t</td>
          <td class="right">${fmtMoney(rebarCost)} USD</td>
        </tr>
        <tr>
          <td>콘크리트</td>
          <td class="right">${isFinite(concreteM3) ? fmtMoney(concreteM3) : "0"} m³</td>
          <td class="right">${fmtMoney(concUnit)} USD/m³</td>
          <td class="right">${fmtMoney(concCost)} USD</td>
        </tr>
        <tr>
          <td colspan="3"><b>합계</b></td>
          <td class="right"><b>${fmtMoney(total)} USD</b></td>
        </tr>
      </tbody>
    </table>
  `;
}

// ===== 패널 렌더 =====
function renderPanel(isoRaw, fallbackName) {
  selectedIsoRaw = (isoRaw ?? "UNK").toString().trim().toUpperCase();
  const iso = (isIso3(selectedIsoRaw) && selectedIsoRaw !== "UNK") ? selectedIsoRaw : null;
  selectedISO = iso;

  const tabs = `
    <div style="display:flex; gap:8px; margin:10px 0 6px; align-items:center; flex-wrap:wrap;">
      <button data-view="materials" style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="materials"?"#111827":"#fff"};color:${view==="materials"?"#fff":"#111827"};cursor:pointer;">자재비</button>
      <button data-view="nonwork" style="padding:8px 10px;border:1px solid #ddd;border-radius:14px;background:${view==="nonwork"?"#111827":"#fff"};color:${view==="nonwork"?"#fff":"#111827"};cursor:pointer;">비작업일수</button>
      <button data-action="csv" style="padding:8px 12px;border:1px solid #ddd;border-radius:14px;background:#fff;color:#111827;cursor:pointer;">CSV</button>
      <button data-action="cost" style="padding:8px 12px;border:1px solid #ddd;border-radius:14px;background:${view==="cost"?"#111827":"#fff"};color:${view==="cost"?"#fff":"#111827"};cursor:pointer;">공사비 분석</button>
    </div>
  `;

  let title = fallbackName || (isoRaw || "선택 국가");
  if (iso && countryData?.[iso]) {
    // ✅ UAE 한글이 안 뜨는 이슈 방지: name_ko → name 순으로
    title = countryData[iso].name_ko || countryData[iso].name || title;
  }

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
            const avgTemp = pick(r, ["avgTemp", "tAvg", "avg_temperature"], "");
            const hiLo = pick(r, ["avgHiLo", "avgHighLow", "avgHighLowC", "avgHighLowStr", "avgHighLow"], "") || buildHiLo(r);

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

  const costSeries = getCostSeries(iso);
  if (!costState.period) costState.period = getDefaultCostPeriod(iso);

  const costUI = `
    <div style="margin-top:8px;">
      ${
        iso !== "ARE"
          ? `<div class="muted">현재 UAE만 지원합니다.</div>`
          : `
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:10px; margin-top:10px;">
              <div style="border:1px solid #e5e7eb; border-radius:14px; padding:10px;">
                <div style="font-weight:700; margin-bottom:6px;">철근</div>
                <div style="display:flex; gap:8px; align-items:center;">
                  <input id="costRebarT" data-cost-field="rebarT" type="number" inputmode="decimal" min="0" step="0.1"
                    placeholder="예: 120" value="${esc(costState.rebarT)}"
                    style="flex:1; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px;" />
                  <span class="muted">t</span>
                </div>
              </div>

              <div style="border:1px solid #e5e7eb; border-radius:14px; padding:10px;">
                <div style="font-weight:700; margin-bottom:6px;">콘크리트</div>
                <div style="display:flex; gap:8px; align-items:center;">
                  <input id="costConcreteM3" data-cost-field="concreteM3" type="number" inputmode="decimal" min="0" step="1"
                    placeholder="예: 850" value="${esc(costState.concreteM3)}"
                    style="flex:1; padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px;" />
                  <span class="muted">m³</span>
                </div>
              </div>
            </div>

            <div style="margin-top:10px; display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
              <div style="font-weight:700;">기준 연도/분기</div>
              <select id="costPeriod" data-cost-field="period"
                style="padding:10px 12px; border:1px solid #e5e7eb; border-radius:14px; background:#fff;">
                ${
                  costSeries.map(r => {
                    const p = String(r.period || "");
                    const sel = p === String(costState.period) ? "selected" : "";
                    return `<option value="${esc(p)}" ${sel}>${esc(p)}</option>`;
                  }).join("")
                }
              </select>
            </div>

            <div id="costResult"></div>
          `
      }
    </div>
  `;

  const body =
    (view === "nonwork") ? nonWorkTable :
    (view === "cost") ? costUI :
    materialsTable;

  setInfo(title, tabs + body + pppBlock);

  if (view === "cost") queueMicrotask(() => updateCostResult());
}

// ===== Init =====
async function init() {
  setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);

  // countryData 로드 + 로그 + 실패시 UI 표시
  try {
    const { json, url } = await fetchJsonFirstOk(DATA_URLS, "countrydata.json");
    countryData = json || {};
    console.log("[countryData] loaded:", url, "keys:", Object.keys(countryData));
  } catch (e) {
    countryData = {};
    console.warn("[countryData] load failed:", e);

    setInfo("오류", `
      <div class="muted">데이터 파일을 불러오지 못했습니다.</div>
      <div class="muted">시도한 경로(일부):</div>
      <pre style="white-space:pre-wrap; font-size:12px; background:#f9fafb; border:1px solid #e5e7eb; padding:10px; border-radius:12px;">${esc(DATA_URLS.slice(0, 12).join("\n"))}</pre>
      <div class="muted">브라우저 개발자도구(F12) → Network에서 countrydata.json 요청이 200인지 확인하세요.</div>
    `);
  }
map = new maplibregl.Map({
  container: "map",
  style: MAP_STYLE,

  // ✅ Middle East start view (UAE 중심)
  center: [54.37, 24.45],   // Abu Dhabi 근처 (경도, 위도)
  zoom: 4.2,                // 3.8~5.0 사이 취향대로

  // (선택) tilt 없게
  pitch: 0,
  bearing: 0
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
      console.warn("[geojson] load failed:", e);
      setInfo("오류", `<div class="muted">지도 데이터를 불러오지 못했습니다.</div>`);
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

  infoEl.addEventListener("click", (e) => {
    const csvBtn = e.target.closest('button[data-action="csv"]');
    if (csvBtn) {
      exportMaterialsAndNonworkCSV();
      return;
    }

    const costBtn = e.target.closest('button[data-action="cost"]');
    if (costBtn) {
      view = "cost";
      renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
      return;
    }

    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    view = btn.dataset.view;

    renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
  });

  infoEl.addEventListener("input", (e) => {
    const field = e.target?.getAttribute?.("data-cost-field");
    if (!field) return;
    if (field === "rebarT") costState.rebarT = e.target.value;
    if (field === "concreteM3") costState.concreteM3 = e.target.value;
    updateCostResult();
  });

  infoEl.addEventListener("change", (e) => {
    const field = e.target?.getAttribute?.("data-cost-field");
    if (!field) return;
    if (field === "period") costState.period = e.target.value;
    updateCostResult();
  });
}

document.addEventListener("DOMContentLoaded", init);

