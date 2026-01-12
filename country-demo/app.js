const GEOJSON_URL = "./data/countries.geojson";
const DATA_URL = "./data/countryData.json";
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
let ISO_FIELD = null;

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

function detectIsoField(features) {
  const candidates = ["ISO_A3", "iso_a3", "ISO3", "iso3", "ADM0_A3", "adm0_a3", "SOV_A3", "sov_a3"];
  for (const key of candidates) {
    for (const f of features) {
      const v = f?.properties?.[key];
      if (isIso3(v)) return key;
    }
  }
  // fallback: properties 안의 값 중 ISO3처럼 생긴 걸 찾기
  for (const f of features) {
    const p = f?.properties || {};
    for (const [k, v] of Object.entries(p)) {
      if (isIso3(v) && /iso|a3/i.test(k)) return k;
    }
  }
  return null;
}

function getISO(props = {}) {
  if (ISO_FIELD && isIso3(props[ISO_FIELD])) return props[ISO_FIELD];

  // 마지막 fallback: 값 자체를 훑어서 ISO3 같은 걸 찾기
  for (const v of Object.values(props)) {
    if (isIso3(v)) return v;
  }
  return null;
}

function getName(props = {}) {
  return props.ADMIN || props.NAME_KO || props.NAME_EN || props.NAME || props.name || "";
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

  // 탭 UI
  const tabs = `
    <div style="display:flex; gap:8px; margin:10px 0 6px;">
      <button data-view="materials" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:${view==="materials"?"#111827":"#fff"};color:${view==="materials"?"#fff":"#111827"};cursor:pointer;">자재비</button>
      <button data-view="nonwork" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:${view==="nonwork"?"#111827":"#fff"};color:${view==="nonwork"?"#fff":"#111827"};cursor:pointer;">비작업일수</button>
    </div>
  `;

  if (!iso) {
    setInfo(fallbackName || "선택 국가", tabs + `<div class="muted">ISO 코드를 찾지 못했어요. countries.geojson 속성명을 확인해야 합니다.</div>`);
    return;
  }

  const d = countryData[iso];
  const title = (d?.name_ko) || fallbackName || iso;

  // 데이터 없을 때 안내(여기가 “아무것도 안 뜬다” 착각 포인트)
  if (!d) {
    const available = Object.keys(countryData).join(", ");
    setInfo(
      title,
      tabs +
        `<div>이 국가는 아직 예시 데이터가 없습니다.</div>
         <div class="muted">현재 countryData.json에 들어있는 ISO3: <b>${esc(available || "-")}</b></div>
         <div class="muted">테스트는 UAE(ARE) / 베트남(VNM)을 클릭해보세요.</div>`
    );
    return;
  }

  const updated = d.materialsUpdated || "—";

  // 자재비
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

  // PPP 버튼(제도/현황)
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

async function init() {
  try {
    // 데이터 로드
    const [dataRes] = await Promise.all([fetch(DATA_URL)]);
    if (!dataRes.ok) throw new Error(`countryData.json 로드 실패 (${dataRes.status})`);
    countryData = await dataRes.json();
  } catch (e) {
    setInfo("오류", `countryData.json을 못 읽었어요: ${esc(e.message)}<br/>경로가 <b>./data/countryData.json</b> 맞는지 확인!`);
    return;
  }

  map = new maplibregl.Map({ container: "map", style: MAP_STYLE, center: [20, 20], zoom: 1.4 });
  map.addControl(new maplibregl.NavigationControl(), "top-right");

  map.on("load", async () => {
    try {
      const geoRes = await fetch(GEOJSON_URL);
      if (!geoRes.ok) throw new Error(`countries.geojson 로드 실패 (${geoRes.status})`);
      countriesGeo = await geoRes.json();
    } catch (e) {
      setInfo("오류", `countries.geojson을 못 읽었어요: ${esc(e.message)}<br/>경로가 <b>./data/countries.geojson</b> 맞는지 확인!`);
      return;
    }

    const features = countriesGeo?.features || [];
    ISO_FIELD = detectIsoField(features);

    // 로딩 상태를 info에 찍어줌(디버그용)
    setInfo("안내", `국가 경계 로드: <b>${features.length.toLocaleString()}</b>개 · ISO필드: <b>${esc(ISO_FIELD || "자동탐지 실패")}</b><br/>UAE(ARE) / Vietnam(VNM)을 클릭해 테스트하세요.`);

    map.addSource("countries", { type: "geojson", data: countriesGeo });

    map.addLayer({ id: "countries-fill", type: "fill", source: "countries", paint: { "fill-opacity": 0.08 } });
    map.addLayer({ id: "countries-line", type: "line", source: "countries", paint: { "line-width": 1, "line-opacity": 0.45 } });

    // 선택 하이라이트(ISO_FIELD 있을 때만)
    map.addLayer({
      id: "countries-selected",
      type: "fill",
      source: "countries",
      paint: { "fill-opacity": 0.35 },
      filter: ["==", 1, 0]
    });

    map.on("mouseenter", "countries-fill", () => (map.getCanvas().style.cursor = "pointer"));
    map.on("mouseleave", "countries-fill", () => (map.getCanvas().style.cursor = ""));

    map.on("click", "countries-fill", (e) => {
      const f = e.features?.[0];
      if (!f) return;

      const props = f.properties || {};
      const iso = getISO(props);
      const name = getName(props);

      if (ISO_FIELD && iso && map.getLayer("countries-selected")) {
        map.setFilter("countries-selected", ["==", ["get", ISO_FIELD], iso]);
      }

      // 클릭할 때 기본은 자재비 탭으로
      view = "materials";
      renderPanel(iso, name);
    });
  });

  // 검색
  const doSearch = () => {
    const q = searchInput.value.trim();
    if (!q || !countriesGeo?.features?.length) return;

    const f = countriesGeo.features.find(ft => {
      const props = ft.properties || {};
      const iso = getISO(props);
      const name = getName(props);
      const qn = norm(q);
      return norm(name).includes(qn) || norm(iso).includes(qn) || (countryData[iso]?.name_ko && norm(countryData[iso].name_ko).includes(qn));
    });

    if (!f) {
      setInfo("검색 결과 없음", `“${esc(q)}”에 해당하는 국가를 찾지 못했습니다.`);
      return;
    }

    const bbox = computeBbox(f.geometry);
    map.fitBounds(bbox, { padding: 60, duration: 800 });

    const iso = getISO(f.properties || {});
    const name = getName(f.properties || {});
    view = "materials";
    renderPanel(iso, name);

    if (ISO_FIELD && iso && map.getLayer("countries-selected")) {
      map.setFilter("countries-selected", ["==", ["get", ISO_FIELD], iso]);
    }
  };

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doSearch(); });

  clearBtn.addEventListener("click", () => {
    searchInput.value = "";
    selectedISO = null;
    setInfo("안내", "지도에서 국가를 클릭하거나 검색하세요.");
    if (map?.getLayer("countries-selected")) map.setFilter("countries-selected", ["==", 1, 0]);
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
