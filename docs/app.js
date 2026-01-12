// ✅ app.js (ISO 못 찾아도 클릭/음영 되게 수정 + 데이터/geojson 경로 fallback)

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

// ✅ 선택 상태(ISO가 없더라도 fid로 하이라이트)
let selectedISO = null;     // "ARE" 같은 ISO3 (없으면 null)
let selectedFID = null;     // GeoJSON feature id (항상 있음)
let selectedName = null;    // 표시용 국가명
let view = "materials";     // materials | nonwork

// ---- helpers ----
const isIso3 = (v) =>
  typeof v === "string" && /^[A-Z]{3}$/.test(v) && v !== "-99";

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

  // 값 자체 훑기(마지막 방어)
  for (const v of Object.values(props)) {
    if (isIso3(v)) return String(v).toUpperCase();
  }
  return null;
}

// 이름 기반 최소 fallback (UAE/VNM은 무조건 매칭)
function isoFallbackByName(name) {
  const n = norm(name);
  if (n.includes("united arab emirates") || n.includes("uae") || n.includes("아랍에미리트"))
    return "ARE";
  if (n.includes("vietnam") || n.includes("베트남"))
    return "VNM";
  return null;
}

// ✅ ISO가 없어도 클릭/하이라이트 되게: __fid(고유 id)를 무조건 부여
function preprocessCountriesGeo(geo) {
  const features = geo?.features || [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    f.properties = f.properties || {};

    // 표시명
    const name = getName(f.properties) || "Unknown";
    f.properties.__name = name;

    // ISO (없으면 "UNK")
    const iso = getISOFromProps(f.properties) || isoFallbackByName(name) || "UNK";
    f.properties.__iso = iso;

    // 고유 fid (항상 존재)
    // (원래 f.id가 있으면 그걸 쓰고, 없으면 index로)
    const fid = (f.id !== undefined && f.id !== null) ? f.id : i;
    f.properties.__fid = fid;
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

  walk(geometry.coordinates);
  return [
    [minX, minY],
    [maxX, maxY],
  ];
}

// ✅ 하이라이트는 ISO가 아니라 fid로 처리 (ISO 없어도 100% 작동)
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
  // ISO가 UNK면 데이터 매칭을 안 하고 안내만
  const iso = (isIso3(isoRaw) && isoRaw !== "UNK") ? isoRaw : null;
  selectedISO = iso;

  const tabs = `
    <div style="display:flex; gap:8px; margin:10px 0 6px;">
      <button data-view="materials" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:${view==="materials"?"#111827":"#fff"};color:${view==="materials"?"#fff":"#111827"};cursor:pointer;">자재비</button>
      <button data-view="nonwork" style="padding:8px 10px;border:1px solid #ddd;border-radius:10px;background:${view==="nonwork"?"#111827":"#fff"};color:${view==="nonwork"?"#fff":"#111827"};cursor:pointer;">비작업일수</button>
    </div>
  `;

  // 제목
  const title = (iso && countryData?.[iso]?.name_ko) || fallbackName || (isoRaw || "선택 국가");

  // ✅ ISO가 없더라도 "ISO 못찾음" 대신 부드럽게 안내
  if (!iso) {
    setInfo(
      title,
      tabs +
        `<div class="muted">
          이 국가는 지도에서 선택/음영은 되지만, <b>ISO3 매칭이 안돼서</b> countryData.json 데이터가 표시되지 않습니다.<br/>
          (현재는 UAE/베트남만 이름 fallback으로 자동 매칭됩니다)
        </div>`
    );
    return;
  }

  const d = countryData[iso];

  // 데이터 없을 때 안내
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

  // 자재비 테이블
  const matRows = (d.materials || [])
    .map(
      (r) => `
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
  `
    )
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
          nwd
            .map(
              (r) => `
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
        `
            )
            .join("") || `<tr><td colspan="9">데이터 없음</td></tr>`
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
  // 1) countryData 로드(실패해도 지도는 뜨게)
  try {
    const { json, url } = await fetchJsonFirstOk(DATA_URLS, "countryData.json");
    countryData = json || {};
    setInfo("안내", `데이터 로드 성공: <b>${esc(url)}</b><br/>지도에서 국가를 클릭하거나 검색하세요.`);
  } catch (e) {
    countryData = {};
    setInfo(
      "경고",
      `countryData.json 로드 실패(그래도 지도는 표시됩니다).<br/>
       <span class="muted">${esc(e.message || e)}</span><br/>
       <span class="muted">✅ 해결: <b>data 폴더</b>에 <b>countryData.json</b> 또는 <b>countrydata.json</b> 업로드(대소문자 포함) 후 새로고침</span>`
    );
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
      const { json, url } = await fetchJsonFirstOk(GEOJSON_URLS, "countries.geojson");
      countriesGeo = preprocessCountriesGeo(json);

      console.log("GeoJSON loaded from:", url);
      console.log("Sample keys:", Object.keys((countriesGeo.features?.[0]?.properties) || {}));
      console.log("Sample props:", (countriesGeo.features?.[0]?.properties) || {});

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

      // ✅ 선택 음영 (fid 기준이라 ISO 없어도 됨)
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

      const features = countriesGeo?.features || [];
      setInfo(
        "안내",
        `국가 경계 로드 성공: <b>${features.length.toLocaleString()}</b>개 · <b>${esc(url)}</b><br/>
         국가를 클릭하면 음영 표시 + 아래 패널이 갱신됩니다. (UAE/베트남은 데이터 표시)`
      );

      map.on("mouseenter", "countries-fill", () => (map.getCanvas().style.cursor = "pointer"));
      map.on("mouseleave", "countries-fill", () => (map.getCanvas().style.cursor = ""));

      map.on("click", "countries-fill", (e) => {
        const f = e.features?.[0];
        if (!f) return;

        const props = f.properties || {};
        const fid = props.__fid;
        const isoRaw = props.__iso;  // "ARE" 또는 "UNK"
        const name = props.__name || getName(props);

        selectedFID = fid;
        selectedName = name;

        // ✅ 무조건 음영
        highlightFID(fid);

        // 줌인
        if (f.geometry) {
          const bbox = computeBbox(f.geometry);
          map.fitBounds(bbox, { padding: 60, duration: 700 });
        }

        // 탭 초기화
        view = "materials";
        renderPanel(isoRaw, name);
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

  // ===== 검색 =====
  const doSearch = () => {
    const q = searchInput.value.trim();
    if (!q || !countriesGeo?.features?.length) return;

    const qn = norm(q);

    // name/iso로 검색
    const f = countriesGeo.features.find((ft) => {
      const props = ft.properties || {};
      const isoRaw = props.__iso || "UNK";
      const name = props.__name || getName(props);

      // countryData 이름(한글명)도 검색에 포함
      const isoGood = (isIso3(isoRaw) && isoRaw !== "UNK") ? isoRaw : null;
      const dataName = isoGood ? countryData?.[isoGood]?.name_ko : "";

      return norm(name).includes(qn) || norm(isoRaw).includes(qn) || norm(dataName).includes(qn);
    });

    if (!f) {
      setInfo("검색 결과 없음", `“${esc(q)}”에 해당하는 국가를 찾지 못했습니다.`);
      return;
    }

    const props = f.properties || {};
    const fid = props.__fid;
    const isoRaw = props.__iso || "UNK";
    const name = props.__name || getName(props);

    selectedFID = fid;
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
    selectedFID = null;
    selectedName = null;
    setInfo("안내", "지도에서 국가를 클릭하거나 검색하세요.");
    highlightFID(null);
  });

  advancedBtn.addEventListener("click", () => {
    alert("상세검색은 시연용으로 추후 체크박스/드롭다운 패널로 확장하면 됩니다.");
  });

  // info 영역 탭 클릭
  document.getElementById("info").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-view]");
    if (!btn) return;
    view = btn.dataset.view;

    // ✅ ISO가 없어도 화면은 유지되게: 마지막 name/iso로 다시 렌더
    // (selectedISO가 null이면 renderPanel이 안내 메시지 보여줌)
    // isoRaw는 저장해두지 않았으니, 현재 title을 fallback으로 쓰고 iso는 selectedISO로 처리
    renderPanel(selectedISO || "UNK", selectedName || infoTitle.textContent);
  });
}

document.addEventListener("DOMContentLoaded", init);
