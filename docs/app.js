// ✅ app.js (오류 수정 버전) — data 파일 404여도 지도는 뜨게 + 경로/대소문자 fallback

const GEOJSON_URLS = [
  "./data/countries.geojson",
  "./country-demo/data/countries.geojson",
  "./docs/data/countries.geojson",
];

const DATA_URLS = [
  "./data/countrydata.json",
  "./data/countrydata.json",
  "./country-demo/data/countrydata.json",
  "./country-demo/data/countrydata.json",
  "./docs/data/countryData.json",
  "./docs/data/countrydata.json",
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
let selectedISO = null;
let view = "materials"; // materials | nonwork

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

// GeoJSON 속성에서 이름/ISO3 최대한 뽑아서 __name/__iso를 만들어버림(하이라이트 안정화)
function getName(props = {}) {
  return props.ADMIN || props.NAME_KO || props.NAME_EN || props.NAME || props.name || props.SOVEREIGNT || "";
}

function getISOFromProps(props = {}) {
  const candidates = ["ISO_A3", "iso_a3", "ISO3", "iso3", "ADM0_A3", "adm0_a3", "SOV_A3", "sov_a3"];
  for (const k of candidates) if (isIso3(props[k])) return props[k];
  // 값 자체를 훑어서 ISO3 같은 걸 찾기
  for (const v of Object.values(props)) if (isIso3(v)) return v;
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
  for (const f of features) {
    f.properties = f.properties || {};
    const name = getName(f.properties) || "Unknown";
    const iso = getISOFromProps(f.properties) || isoFallbackByName(name) || null;
    f.properties.__name = name;
    if (iso) f.properties.__iso = iso;
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
  walk(geometry.coordinates);
  return [[minX, minY], [maxX, maxY]];
}

function renderPanel(iso, fallbackName) {
  selectedISO = iso || null;

  const tabs = `
    <div style="display:flex; gap:8px; margin:10px 0 6px;">
      <button data-view="materials" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:${view==="materials"?"#111827":"#fff"};color:${view==="materials"?"#fff":"#111827"};cursor:pointer;">자재비</button>
      <button data-view="nonwork" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:${view==="nonwork"?"#111827":"#fff"};color:${view==="nonwork"?"#fff":"#111827"};cursor:pointer;">비작업일수</button>
    </div>
  `;

  if (!iso) {
    setInfo(fallbackName || "선택 국가", tabs + `<div class="muted">ISO 코드를 찾지 못했어요. (countries.geojson 속성 확인 필요)</div>`);
    return;
  }

  const d = countryData[iso];
  const title = (d?.name_ko) || fallbackName || iso;

  if (!d) {
    const available = Object.keys(countryData).join(", ");
    setInfo(
      title,
      tabs +
        `<div>이 국가는 아직 데이터가 없습니다.</div>
         <div class="muted">countryData.json에 들어있는 ISO3: <b>${esc(available || "-")}</b></div>
         <div class="muted">테스트는 UAE(ARE) / 베트남(VNM)을 클릭해보세요.</div>`
    );
    return;
  }

  const updated = d.materialsUpdated || d.updated || "—";

  const matRows = (d.materials || []).map(r => `
    <tr>
      <td>${esc(r.item)}</td>
      <td class="right">${(typeof r.price==="number") ? r.price.toLocaleString(undefined,{maximumFractionDigits:3}) : esc(r.price)}</td>
      <td>${esc(r.unit)}</td>
      <td>${esc(r.asOf || "-")}</td>
    </tr>
  `).join("");

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
        ${nwd.map(r => `
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
        `).join("") || `<tr><td colspan="9">데이터 없음</td></tr>`}
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

  const body = (view === "nonwork") ? nonWorkTable : materialsTable;
  setInfo(title, tabs + body + pppBlock);
}

function highlightISO(iso) {
  if (!map?.getLayer("countries-selected")) return;
  if (!iso) {
    map.setFilter("countries-selected", ["==", 1, 0]);
    map.setFilter("countries-selected-outline", ["==", 1, 0]);
    return;
  }
  map.setFilter("countries-selected", ["==", ["get", "__iso"], iso]);
  map.setFilter("countries-selected-outline", ["==", ["get", "__iso"], iso]);
}

async function init() {
  // 1) countryData: 실패해도 지도는 뜨게(중요)
  try {
    const { json, url } = await fetchJsonFirstOk(DATA_URLS, "countryData.json");
    countryData = json || {};
    // 디버그용: 어떤 경로로 로드됐는지 표시
    setInfo("안내", `데이터 로드 성공: <b>${esc(url)}</b><br/>지도에서 국가를 클릭하거나 검색하세요.`);
  } catch (e) {
    countryData = {};
    setInfo(
      "경고",
      `countryData.json 로드 실패(그래도 지도는 표시됩니다).<br/>
       <span class="muted">${esc(e.message || e)}</span><br/>
       <span class="muted">✅ 해결: <b>data 폴더</b>에 <b>countryData.json</b> (대소문자 정확히) 업로드하거나, 파일명을 코드와 맞추세요.</span>`
    );
  }

  // 2) 지도는 무조건 생성
  map = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [20, 20],
    zoom: 1.4
  });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", async () => {
    // 3) GeoJSON 로드(경계)
    try {
      const { json, url } = await fetchJsonFirstOk(GEOJSON_URLS, "countries.geojson");
      countriesGeo = preprocessCountriesGeo(json);

      // 경계 소스/레이어
      map.addSource("countries", { type: "geojson", data: countriesGeo });

      map.addLayer({
        id: "countries-fill",
        type: "fill",
        source: "countries",
        paint: { "fill-color": "#7c8794", "fill-opacity": 0.08 }
      });

      map.addLayer({
        id: "countries-line",
        type: "line",
        source: "countries",
        paint: { "line-color": "#6b7280", "line-width": 1, "line-opacity": 0.45 }
      });

      // ✅ 선택 음영(fill + outline)
      map.addLayer({
        id: "countries-selected",
        type: "fill",
        source: "countries",
        paint: { "fill-color": "#0ea5a5", "fill-opacity": 0.35 },
        filter: ["==", 1, 0]
      });

      map.addLayer({
        id: "countries-selected-outline",
        type: "line",
        source: "countries",
        paint: { "line-color": "#0ea5a5", "line-width": 2 },
        filter: ["==", 1, 0]
      });

      const features = countriesGeo?.features || [];
      setInfo(
        "안내",
        `국가 경계 로드 성공: <b>${features.length.toLocaleString()}</b>개 · <b>${esc(url)}</b><br/>
         UAE(ARE) / Vietnam(VNM)을 클릭해 테스트하세요.`
      );

      map.on("mouseenter", "countries-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "countries-fill", () => (map.getCanvas().style.cursor = ""));

      map.on("click", "countries-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;

        const props = f.properties || {};
        const iso = isIso3(props.__iso) ? props.__iso : null;
        const name = props.__name || getName(props);

        view = "materials";
        renderPanel(iso, name);
        highlightISO(iso);

        // 국가 클릭 시 줌인(있으면)
        if (f.geometry) {
          const bbox = computeBbox(f.geometry);
          map.fitBounds(bbox, { padding: 60, duration: 700 });
        }
      });

    } catch (e) {
      setInfo(
        "오류",
        `countries.geojson 로드 실패.<br/>
         <span class="muted">${esc(e.message || e)}</span><br/>
         <span class="muted">✅ 해결: data 폴더에 <b>countries.geojson</b> 업로드 + 경로가 코드와 같은지 확인</span>`
      );
    }
  });

  // --- 검색 ---
  const doSearch = () => {
    const q = searchInput.value.trim();
    if (!q || !countriesGeo?.features?.length) return;

    const qn = norm(q);

    const f = countriesGeo.features.find(ft => {
      const props = ft.properties || {};
      const iso = props.__iso || getISOFromProps(props);
      const name = props.__name || getName(props);
      return norm(name).includes(qn) || norm(iso).includes(qn) || (countryData[iso]?.name_ko && norm(countryData[iso].name_ko).includes(qn));
    });

    if (!f) {
      setInfo("검색 결과 없음", `“${esc(q)}”에 해당하는 국가를 찾지 못했습니다.`);
      return;
    }

    const props = f.properties || {};
    const iso = props.__iso || getISOFromProps(props);
    const name = props.__name || getName(props);

    if (f.geometry) {
      const bbox = computeBbox(f.geometry);
      map.fitBounds(bbox, { padding: 60, duration: 700 });
    }

    view = "materials";
    renderPanel(iso, name);
    highlightISO(iso);
  };

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    selectedISO = null;
    setInfo("안내", "지도에서 국가를 클릭하거나 검색하세요.");
    highlightISO(null);
  });

  advancedBtn.addEventListener("click", () => {
    alert("상세검색은 시연용으로 추후 체크박스/드롭다운 패널로 확장하면 됩니다.");
  });

  // info 영역 탭 클릭
  document.getElementById("info").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    view = btn.dataset.view;
    renderPanel(selectedISO, infoTitle.textContent);
  });
}

document.addEventListener("DOMContentLoaded", init);

