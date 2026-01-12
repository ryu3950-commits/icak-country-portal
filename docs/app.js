// ✅ app.js (메시지 간결화 + ISO 없어도 정상 선택/하이라이트 + 치명 오류(따옴표/널참조) 수정)

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

// ✅ 선택 상태
let selectedISO = null;      // "ARE" 같은 ISO3 (없으면 null)
let selectedIsoRaw = "UNK";  // "ARE" or "UNK" (탭 클릭 시 재렌더용)
let selectedFID = null;      // GeoJSON feature id (항상 있음)
let selectedName = null;     // 표시용 국가명
let view = "materials";      // materials | nonwork

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

function showDefault() {
  setInfo("국가를 선택하세요", `<div class="muted">지도에서 국가를 클릭하거나 검색하세요.</div>`);
}

async function fetchJsonFirstOk(urls, label) {
  let lastErr = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) {
        lastErr = new Error(`${label} (${res.status})`);
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

// GeoJSON에서 "표시 이름"
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

// GeoJSON에서 ISO3 최대한 뽑기(가능한 후보를 넓게)
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
  for (const k of candidates) if (isIso3(props[k])) return String(props[k]).toUpperCase();

  for (const v of Object.values(props)) {
    if (isIso3(v)) return String(v).toUpperCase();
  }
  return null;
}

// 이름 기반 최소 fallback (UAE/VNM만 보정)
function isoFallbackByName(name) {
  const n = norm(name);
  if (n.includes("united arab emirates") || n.includes("uae") || n.includes("아랍에미리트")) return "ARE";
  if (n.includes("vietnam") || n.includes("베트남")) return "VNM";
  return null;
}

// ✅ ISO 없어도 클릭/하이라이트 되게: __fid(고유 id)를 무조건 부여
function preprocessCountriesGeo(geo) {
  const features = geo?.features || [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    f.properties = f.properties || {};

    const name = getName(f.properties) || "Unknown";
    f.properties.__name = name;

    const iso = getISOFromProps(f.properties) || isoFallbackByName(name) || "UNK";
    f.properties.__iso = iso;

    const fid = (f.id !== undefined && f.id !== null) ? f.id : i;
    f.properties.__fid = fid;
  }
  return geo;
}

function computeBbox(geometry) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

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

  walk(geometry.coordinates);
  return [[minX, minY], [maxX, maxY]];
}

// ✅ 하이라이트는 fid로 처리 (ISO 없어도 100% 작동)
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

// ===== 패널 렌더 =====
function renderPanel(isoRaw, fallbackName) {
  // ISO가 UNK면 데이터 매칭은 안 하고 "데이터 없음"만 표시
  const iso = (isIso3(isoRaw) && isoRaw !== "UNK") ? isoRaw : null;
  selectedISO = iso;

  const tabs = `
    <div style="display:flex; gap:8px; margin:10px 0 6px;">
      <button data-view="materials" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:${view==="materials"?"#111827":"#fff"};color:${view==="materials"?"#fff":"#111827"};cursor:pointer;">자재비</button>
      <button data-view="nonwork" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:${view==="nonwork"?"#111827":"#fff"};color:${view==="nonwork"?"#fff":"#111827"};cursor:pointer;">비작업일수</button>
    </div>
  `;

  const title =
    (iso && countryData?.[iso]?.name_ko) ||
    fallbackName ||
    "국가를 선택하세요";

  if (!iso) {
    setInfo(title, tabs + `<div class="muted">데이터가 없습니다.</div>`);
    return;
  }

  const d = countryData?.[iso];
  if (!d) {
    setInfo(title, tabs + `<div class="muted">데이터가 없습니다.</div>`);
    return;
  }

  const updated = d.materialsUpdated || d.updated || "—";

  // 자재비 테이블
  const matRows = (d.materials || [])
    .map((r) => `
      <tr>
        <td>${esc(r.item)}</td>
        <td class="right">${
          typeof r.price === "number"
            ? r.price.toLocaleString(undefined, { maximumFractionDigits: 3 })
            : esc(r.price)
        }</td>
        <td>${esc(r.unit)}</td>
        <td>${esc(r.asOf || "-")}</td>
      </tr>
    `)
    .join("");

  const labor = d.labor || {};
  const laborBlock = `
    <div class="muted" style="margin-top:8px;">
      인건비(예시): 단순 <b>$${esc(labor.unskilled_day_usd ?? "-")}</b>/day · 숙련 <b>$${esc(labor.skilled_day_usd ?? "-")}</b>/day
    </div>
  `;

  const materialsTable = `
    <div class="muted">자재비 업데이트: ${esc(updated)}</div>
    <table class="table">
      <thead>
        <tr><th>품목</th><th class="right">가격</th><th>단위</th><th>기준일</th></tr>
      </thead>
      <tbody>${matRows || `<tr><td colspan="4">데이터 없음</td></tr>`}</tbody>
    </table>
    ${laborBlock}
  `;

  // 비작업일수
  const nwd = d.nonWorkDays || [];
  const isUAE = d.nonWorkSchema === "UAE";
  const thirdColName = isUAE ? "모래폭풍(회/월)" : "강우일(일/월,>=1mm)";

  const nonWorkTable = `
    <table class="table">
      <thead>
        <tr>
          <th>월</th><th class="right">평균기온</th><th class="right">평균최고/최저</th>
          <th class="right">${thirdColName}</th><th class="right">주말</th><th class="right">공휴일(평일)</th>
          <th class="right">확정 비작업일</th><th class="right">등가 비작업일(8h)</th><th>비고</th>
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

  // PPP 링크(제도/현황)
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

  const body = view === "nonwork" ? nonWorkTable : materialsTable;
  setInfo(title, tabs + body + pppBlock);
}

// ===== Init =====
async function init() {
  // 기본 안내 먼저
  showDefault();

  // 1) countryData 로드 (실패해도 진행)
  try {
    const { json } = await fetchJsonFirstOk(DATA_URLS, "countryData.json");
    countryData = json || {};
  } catch {
    countryData = {};
    // 실패해도 화면 문구는 간결하게 유지
    showDefault();
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

      // ✅ 선택 음영 (fid 기준)
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

      // ✅ 안내는 항상 간결하게
      showDefault();

      map.on("mouseenter", "countries-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "countries-fill", () => (map.getCanvas().style.cursor = ""));

      map.on("click", "countries-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;

        const props = f.properties || {};
        const fid = props.__fid;
        const isoRaw = props.__iso || "UNK";
        const name = props.__name || getName(props);

        selectedFID = fid;
        selectedIsoRaw = isoRaw;
        selectedName = name;

        highlightFID(fid);

        if (f.geometry) {
          const bbox = computeBbox(f.geometry);
          map.fitBounds(bbox, { padding: 60, duration: 700 });
        }

        view = "materials";
        renderPanel(isoRaw, name);
      });
    } catch (e) {
      setInfo("오류", `<div class="muted">${esc(e.message || e)}</div>`);
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
      const dataName = isoGood ? countryData?.[isoGood]?.name_ko : "";

      return norm(name).includes(qn) || norm(isoRaw).includes(qn) || norm(dataName).includes(qn);
    });

    if (!f) {
      setInfo("검색 결과 없음", `<div class="muted">해당 국가를 찾지 못했습니다.</div>`);
      return;
    }

    const props = f.properties || {};
    const fid = props.__fid;
    const isoRaw = props.__iso || "UNK";
    const name = props.__name || getName(props);

    selectedFID = fid;
    selectedIsoRaw = isoRaw;
    selectedName = name;

    highlightFID(fid);

    if (f.geometry) {
      const bbox = computeBbox(f.geometry);
      map.fitBounds(bbox, { padding: 60, duration: 700 });
    }

    view = "materials";
    renderPanel(isoRaw, name);
  };

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    selectedISO = null;
    selectedIsoRaw = "UNK";
    selectedFID = null;
    selectedName = null;
    showDefault();
    highlightFID(null);
  });

  advancedBtn.addEventListener("click", () => {
    alert("상세검색은 시연용입니다.");
  });

  // info 영역 탭 클릭
  document.getElementById("info").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;

    view = btn.dataset.view;

    // ✅ 마지막 선택 국가로 다시 렌더 (ISO 없어도 isoRaw 기준으로)
    if (!selectedName) return;
    renderPanel(selectedIsoRaw, selectedName);
  });
}

document.addEventListener("DOMContentLoaded", init);

