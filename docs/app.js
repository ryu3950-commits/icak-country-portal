// app.js (지도 유지 + 비작업일수 옆 CSV Export 추가 버전)

const GEOJSON_URLS = [
  "./data/countries.geojson",
  "./country-demo/data/countries.geojson",
  "./docs/data/countries.geojson",
  "./countries.geojson",
];

const DATA_URLS = [
  "./data/countryData.json",
  "./data/countrydata.json",
  "./country-demo/data/countryData.json",
  "./country-demo/data/countrydata.json",
  "./docs/data/countryData.json",
  "./docs/data/countrydata.json",
  "./countryData.json",
  "./countrydata.json",
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
let view = "materials";     // materials | nonwork

// ---- helpers ----
const isIso3 = (v) => typeof v === "string" && /^[A-Z]{3}$/.test(v) && v !== "-99";
const norm = (s) => (s || "").toString().trim().toLowerCase();
const esc = (s) =>
  String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

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

// ISO3 뽑기
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
    if (isIso3(v)) return String(v).toUpperCase();
  }

  // 값 자체 훑기(마지막 방어)
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

// ✅ __name / __iso / __fid 를 강제로 넣어서 “클릭-하이라이트-검색” 안정화
function preprocessCountriesGeo(geo) {
  const features = geo?.features || [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    f.properties = f.properties || {};

    const name = getName(f.properties) || "Unknown";
    const iso = getISOFromProps(f.properties) || isoFallbackByName(name) || "UNK";

    // fid(항상 존재)
    const fid = (f.id !== undefined && f.id !== null) ? f.id : i;

    f.properties.__name = name;
    f.properties.__iso = iso;
    f.properties.__fid = fid;

    // (선택) feature.id도 넣어두면 디버깅/호환에 도움
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
   CSV Export (자재비 + 비작업일수)
   - app.js만으로 동작 (index.html 수정 X)
========================= */
function csvEscape(v){
  const s = String(v ?? "");
  return /[,"\n\r]/.test(s) ? `"${s.replaceAll('"','""')}"` : s;
}
function rowsToCSV(headers, rows){
  const head = headers.map(csvEscape).join(",");
  const body = rows.map(r => r.map(csvEscape).join(",")).join("\n");
  return "\ufeff" + head + "\n" + body; // Excel BOM
}
function downloadCSV(filename, csvText){
  const blob = new Blob([csvText], { type:"text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function exportMaterialsAndNonworkCSV(){
  if (!selectedISO){
    alert("먼저 국가를 선택하세요.");
    return;
  }
  const d = countryData?.[selectedISO];
  if (!d){
    alert(`데이터가 없습니다: ${selectedISO}`);
    return;
  }

  // 1) 자재비 CSV
  const matHeaders = ["품목","가격","단위","업데이트"];
  const matRows = (d.materials || []).map(x => [
    x.item ?? "",
    x.price ?? "",
    x.unit ?? "",
    d.materialsUpdated || d.updated || ""
  ]);
  const matCSV = rowsToCSV(matHeaders, matRows);

  // 2) 비작업일수 CSV
  const nwd = d.nonWorkDays || [];
  if (!nwd.length){
    downloadCSV(`${selectedISO}_자재비.csv`, matCSV);
    alert("비작업일수 데이터가 없어 자재비만 다운로드합니다.");
    return;
  }

  const isUAE = d.nonWorkSchema === "UAE"; // 네 렌더 기준 그대로
  const nwHeaders = isUAE
    ? ["월","평균기온(°C)","평균최고/최저(°C)","모래폭풍(회/월)","주말(토+일)","공휴일(평일)","확정 비작업일","등가 비작업일(8h)","비고"]
    : ["월","평균기온(°C)","평균최고/최저(°C)","강우일(일/월,>=1mm)","주말(토+일)","공휴일(평일)","확정 비작업일","등가 비작업일(8h)","비고"];

  // ✅ renderPanel에서 쓰는 키 이름과 동일하게 뽑음(avgTemp/avgHiLo/sandstorm/rainDays/...)
  const nwRows = nwd.map(r => ([
    r.month ?? "",
    r.avgTemp ?? "",
    r.avgHiLo ?? "",
    isUAE ? (r.sandstorm ?? "") : (r.rainDays ?? ""),
    r.weekend ?? "",
    r.holidayWeekday ?? "",
    r.confirmedOff ?? "",
    r.equivOff8h ?? "",
    r.note ?? ""
  ]));

  const nwCSV = rowsToCSV(nwHeaders, nwRows);

  // ✅ 2개 파일 연속 다운로드(브라우저가 막으면 “다중 다운로드 허용” 설정 필요할 수 있음)
  downloadCSV(`${selectedISO}_자재비.csv`, matCSV);
  setTimeout(() => downloadCSV(`${selectedISO}_비작업일수.csv`, nwCSV), 250);
}

// ===== 패널 렌더 =====
function renderPanel(isoRaw, fallbackName) {
  selectedIsoRaw = isoRaw || "UNK";
  const iso = (isIso3(selectedIsoRaw) && selectedIsoRaw !== "UNK") ? selectedIsoRaw : null;
  selectedISO = iso;

  // ✅ 탭 + CSV 버튼 (비작업일수 옆)
  const tabs = `
    <div style="display:flex; gap:8px; margin:10px 0 6px; align-items:center; flex-wrap:wrap;">
      <button data-view="materials"
        style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;
               background:${view==="materials"?"#111827":"#fff"};
               color:${view==="materials"?"#fff":"#111827"};
               cursor:pointer;">자재비</button>

      <button data-view="nonwork"
        style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;
               background:${view==="nonwork"?"#111827":"#fff"};
               color:${view==="nonwork"?"#fff":"#111827"};
               cursor:pointer;">비작업일수</button>

      <button data-action="csv"
        style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:#fff;color:#111827;cursor:pointer;">
        CSV
      </button>
    </div>
  `;

  // 제목: ARE/VNM은 JSON의 name(한글)만 사용, 그 외는 기존대로
  let title = fallbackName || (isoRaw || "선택 국가");

  if (iso && countryData?.[iso]) {
    if (iso === "ARE" || iso === "VNM") {
      title = countryData[iso].name;
    } else {
      title = countryData[iso].name || title;
    }
  }

  // ISO가 없거나(UNK) 데이터가 없으면: 안내
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

  // 자재비 테이블
  const matRows = (d.materials || []).map((r) => `
    <tr>
      <td>${esc(r.item)}</td>
      <td class="right">${
        typeof r.price === "number"
          ? r.price.toLocaleString(undefined, { maximumFractionDigits: 3 })
          : esc(r.price)
      }</td>
      <td>${esc(r.unit)}</td>
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

  // 비작업일수
  const nwd = d.nonWorkDays || [];
  const isUAE = d.nonWorkSchema === "UAE";
  const thirdColName = isUAE ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";

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
          nwd.map((r) => `
            <tr>
              <td>${esc(r.month)}</td>
              <td class="right">${esc(r.avgTemp)}</td>
              <td class="right">${esc(r.avgHiLo)}</td>
              <td class="right">${esc(isUAE ? r.sandstorm : r.rainDays)}</td>
              <td class="right">${esc(r.weekend)}</td>
              <td class="right">${esc(r.holidayWeekday)}</td>
              <td class="right">${esc(r.confirmedOff)}</td>
              <td class="right">${esc(r.equivOff8h)}</td>
              <td>${esc(r.note)}</td>
            </tr>
          `).join("") || `<tr><td colspan="9">데이터 없음</td></tr>`
        }
      </tbody>
    </table>
  `;

  // PPP 링크
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

  const body = (view === "nonwork") ? nonWorkTable : materialsTable;
  setInfo(title, tabs + body + pppBlock);
}

// ===== Init =====
async function init() {
  // 초기 안내
  setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);

  // 1) countryData 로드(실패해도 지도는 뜨게)
  try {
    const { json } = await fetchJsonFirstOk(DATA_URLS, "countryData.json");
    countryData = json || {};
  } catch (e) {
    countryData = {};
  }

  // 2) 지도 생성
  map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [20, 20],
    zoom: 1.4,
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", async () => {
    // 3) GeoJSON 로드
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

      // 선택 음영
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

        if (f.geometry) {
          const bbox = computeBbox(f.geometry);
          if (isFinite(bbox?.[0]?.[0])) map.fitBounds(bbox, { padding: 60, duration: 700 });
        }

        view = "materials";
        renderPanel(isoRaw, name);
      });
    } catch (e) {
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
      const isoRaw = props.__iso || "UNK";
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
    const isoRaw = props.__iso || "UNK";
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
    setInfo("국가를 선택하세요", `<div class="muted">지도를 클릭하면 아래에 정보가 표시됩니다.</div>`);
    highlightFID(null);
  });

  advancedBtn.addEventListener("click", () => {
    alert(" ");
  });

  // info 영역 탭/CSV 클릭 (✅ 여기서 CSV 먼저 처리!)
  document.getElementById("info").addEventListener("click", (e) => {
    // CSV 버튼
    const csvBtn = e.target.closest('button[data-action="csv"]');
    if (csvBtn){
      exportMaterialsAndNonworkCSV();
      return;
    }

    // 탭 버튼
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    view = btn.dataset.view;

    // 마지막 선택 국가 기준으로 다시 렌더
    renderPanel(selectedIsoRaw, selectedName || infoTitle.textContent);
  });
}

document.addEventListener("DOMContentLoaded", init);
