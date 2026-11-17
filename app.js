/**
 * ============================================================================
 * 국립공원 로드킬 위험 구간 분석 및 야생동물 보호 지원 AI 대시보드
 * File: app.js
 * Author: Senior Frontend & Data Visualization Engineer
 * ============================================================================
 */

// ----------------------------------------------------------------------------
// 1. 전역 상수 및 15가지 고유 구분 색상 팔레트
// ----------------------------------------------------------------------------
const DEFAULT_CSV_PATH = encodeURI('./data/국립공원공단_국립공원_로드킬_정보_20231220.csv');

// 서로 명확히 구분되는 15가지 고유 색상 팔레트 (Leaflet 마커 & Chart.js 매칭)
const CLUSTER_COLORS = [
  '#E6194B', // 0: Red
  '#3CB44B', // 1: Green
  '#FFE119', // 2: Yellow
  '#4363D8', // 3: Blue
  '#F58231', // 4: Orange
  '#911EB4', // 5: Purple
  '#42D4F4', // 6: Cyan
  '#F032E6', // 7: Magenta
  '#BFEF45', // 8: Lime
  '#FABED4', // 9: Pink
  '#469990', // 10: Teal
  '#DCBEFF', // 11: Lavender
  '#9A6324', // 12: Brown
  '#808000', // 13: Olive
  '#000075'  // 14: Navy
];

// ----------------------------------------------------------------------------
// 2. 애플리케이션 상태 (State)
// ----------------------------------------------------------------------------
const state = {
  rawDataset: [],        // 원본 유효 데이터 배열
  filteredDataset: [],   // 필터 적용 데이터 배열
  parkList: [],          // 고유 국립공원 목록
  selectedPark: 'ALL',   // 선택된 국립공원
  k: 5,                  // K-Means 군집 수 (2~15)
  clusterResult: null,   // 군집화 결과 { clusters, centroids, counts }
  trendViewType: 'year'  // 'year' | 'month' (추이 차트 모드)
};

// Leaflet 및 Chart.js 인스턴스 보관 객체
const mapInstance = {
  map: null,
  markerLayerGroup: null,
  centroidLayerGroup: null,
  layerControl: null
};

const chartInstances = {
  clusterBar: null,
  parkBar: null,
  animalBar: null,
  trendLine: null
};

// ----------------------------------------------------------------------------
// 2.1 시드 기반 유사 난수 생성기 (Mulberry32 알고리즘 - 결정론적 결과 보장)
// ----------------------------------------------------------------------------
class SeededRandom {
  constructor(seed = 42) {
    this.initialSeed = (seed >>> 0) || 42;
    this.seed = this.initialSeed;
  }

  // 0 이상 1 미만의 균등 분포 부동소수점 난수 생성 (Math.random() 대체)
  next() {
    let t = (this.seed += 0x6D2B79F5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // min 이상 max 미만의 정수 생성
  nextInt(min, max) {
    return Math.floor(this.next() * (max - min)) + min;
  }

  // 시드 초기화
  reset() {
    this.seed = this.initialSeed;
  }
}

// ----------------------------------------------------------------------------
// 3. AI 알고리즘: K-Means 군집화 (K-Means++ 직접 구현 - 고정 시드 재현성 보장)
// ----------------------------------------------------------------------------
class KMeansClustering {
  /**
   * @param {Array<{lat: number, lng: number}>} points 데이터 포인트 목록
   * @param {number} k 군집 수
   * @param {number} maxIterations 최대 반복 횟수
   * @param {number} seed 랜덤 시드 (기본값: 42 - 재계산 시 100% 동일 결과 보장)
   */
  constructor(points, k, maxIterations = 80, seed = 42) {
    this.points = points;
    this.k = Math.max(1, Math.min(k, points.length));
    this.maxIterations = maxIterations;
    this.seed = seed;
    this.rng = new SeededRandom(this.seed);
  }

  // 지리좌표 간 유클리드 거리 (위도/경도 종횡비 코사인 보정)
  distance(p1, p2) {
    const latDiff = p1.lat - p2.lat;
    const avgLatRad = ((p1.lat + p2.lat) / 2) * (Math.PI / 180);
    const lngDiff = (p1.lng - p2.lng) * Math.cos(avgLatRad);
    return Math.sqrt(latDiff * latDiff + lngDiff * lngDiff);
  }

  // K-Means++ 방식 초기 중심점 선택 (고정 시드 난수 적용)
  initializeCentroidsPlusPlus() {
    const centroids = [];
    const n = this.points.length;

    // 1) 첫 번째 중심점: 고정 시드 난수로 결정론적 1개 선택
    const firstIdx = this.rng.nextInt(0, n);
    centroids.push({
      id: 0,
      lat: this.points[firstIdx].lat,
      lng: this.points[firstIdx].lng
    });

    // 2) K-1개의 추가 중심점을 거리 제곱 비례 확률(룰렛 휠)로 선택
    for (let c = 1; c < this.k; c++) {
      const distancesSq = new Float64Array(n);
      let sumDistancesSq = 0;

      for (let i = 0; i < n; i++) {
        let minDist = Infinity;
        for (let j = 0; j < centroids.length; j++) {
          const d = this.distance(this.points[i], centroids[j]);
          if (d < minDist) minDist = d;
        }
        const dSq = minDist * minDist;
        distancesSq[i] = dSq;
        sumDistancesSq += dSq;
      }

      if (sumDistancesSq === 0) {
        const randIdx = this.rng.nextInt(0, n);
        centroids.push({
          id: c,
          lat: this.points[randIdx].lat,
          lng: this.points[randIdx].lng
        });
        continue;
      }

      const threshold = this.rng.next() * sumDistancesSq;
      let cumSum = 0;
      let selectedIdx = n - 1;

      for (let i = 0; i < n; i++) {
        cumSum += distancesSq[i];
        if (cumSum >= threshold) {
          selectedIdx = i;
          break;
        }
      }

      centroids.push({
        id: c,
        lat: this.points[selectedIdx].lat,
        lng: this.points[selectedIdx].lng
      });
    }

    return centroids;
  }

  // K-Means 반복 실행 및 최종 중심점 산출
  run() {
    if (this.points.length === 0) {
      return { clusters: [], centroids: [], counts: {} };
    }

    let centroids = this.initializeCentroidsPlusPlus();
    const assignments = new Int32Array(this.points.length);
    let converged = false;
    let iteration = 0;

    while (!converged && iteration < this.maxIterations) {
      iteration++;

      // 1) Expectation: 각 포인트를 가장 가까운 중심점에 할당
      let assignmentChanged = false;
      for (let i = 0; i < this.points.length; i++) {
        const pt = this.points[i];
        let minDist = Infinity;
        let bestCluster = 0;

        for (let c = 0; c < centroids.length; c++) {
          const d = this.distance(pt, centroids[c]);
          if (d < minDist) {
            minDist = d;
            bestCluster = c;
          }
        }

        if (assignments[i] !== bestCluster) {
          assignments[i] = bestCluster;
          assignmentChanged = true;
        }
      }

      // 2) Maximization: 각 군집 중심점 재계산
      const sumLat = new Float64Array(this.k);
      const sumLng = new Float64Array(this.k);
      const counts = new Int32Array(this.k);

      for (let i = 0; i < this.points.length; i++) {
        const c = assignments[i];
        sumLat[c] += this.points[i].lat;
        sumLng[c] += this.points[i].lng;
        counts[c]++;
      }

      let maxCentroidShift = 0;
      const newCentroids = [];

      for (let c = 0; c < this.k; c++) {
        if (counts[c] === 0) {
          // 빈 군집 발생 시: 고정 시드 난수로 결정론적 재배치
          const randIdx = this.rng.nextInt(0, this.points.length);
          newCentroids.push({
            id: c,
            lat: this.points[randIdx].lat,
            lng: this.points[randIdx].lng,
            count: 0
          });
        } else {
          const newLat = sumLat[c] / counts[c];
          const newLng = sumLng[c] / counts[c];
          const shift = this.distance(centroids[c], { lat: newLat, lng: newLng });
          if (shift > maxCentroidShift) maxCentroidShift = shift;

          newCentroids.push({
            id: c,
            lat: newLat,
            lng: newLng,
            count: counts[c]
          });
        }
      }

      centroids = newCentroids;

      // 수렴 판정: 중심점 이동이 1e-6 미만이거나 할당 변화 없음
      if (maxCentroidShift < 1e-6 || !assignmentChanged) {
        converged = true;
      }
    }

    // 결과 구성: 각 포인트마다 정확히 하나의 군집 ID 부여
    const countsMap = {};
    for (let c = 0; c < this.k; c++) {
      countsMap[c] = 0;
    }

    const clusters = this.points.map((pt, i) => {
      const cId = assignments[i];
      countsMap[cId] = (countsMap[cId] || 0) + 1;
      return {
        ...pt,
        cluster: cId
      };
    });

    // 각 중심점에 최종 카운트 및 고유 색상 매핑
    centroids.forEach(c => {
      c.count = countsMap[c.id] || 0;
      c.color = CLUSTER_COLORS[c.id % CLUSTER_COLORS.length];
    });

    // 3) 전체 데이터 수와 군집별 데이터 수의 합 일치 검증
    const totalPoints = this.points.length;
    let sumOfClusterCounts = 0;
    for (let c = 0; c < this.k; c++) {
      sumOfClusterCounts += (countsMap[c] || 0);
    }
    const centroidsSum = centroids.reduce((sum, c) => sum + (c.count || 0), 0);

    const isMatch = (sumOfClusterCounts === totalPoints) && (centroidsSum === totalPoints);
    if (!isMatch) {
      console.error(`[데이터 정합성 오류] 전체 데이터 수(${totalPoints})와 군집별 합계(${sumOfClusterCounts}, 중심점 합: ${centroidsSum})가 불일치합니다!`);
    } else {
      console.log(`[데이터 무결성 검증 통과] 전체 데이터 수(${totalPoints}) == 군집별 기록 합계(${sumOfClusterCounts}) 일치 확인`);
    }

    return {
      clusters,
      centroids,
      counts: countsMap,
      iterations: iteration,
      isConsistent: isMatch
    };
  }
}

// ----------------------------------------------------------------------------
// 4. 데이터 로드 및 인코딩 처리 (EUC-KR / CP949 지원)
// ----------------------------------------------------------------------------

/**
 * 기본 CSV 파일 로드 및 EUC-KR 디코딩
 */
async function loadDefaultCSV() {
  const statusBadge = document.getElementById('dataStatusText');
  const loadingOverlay = document.getElementById('mapLoading');

  try {
    statusBadge.textContent = 'CSV 파일(EUC-KR) 다운로드 중...';
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    let response;
    try {
      response = await fetch(DEFAULT_CSV_PATH);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (e1) {
      response = await fetch('./data/국립공원공단_국립공원_로드킬_정보_20231220.csv');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }

    // 한국 공공데이터 EUC-KR / CP949 인코딩 처리
    statusBadge.textContent = 'EUC-KR 한글 디코딩 및 파싱 중...';
    const buffer = await response.arrayBuffer();
    const decoder = new TextDecoder('euc-kr');
    const csvText = decoder.decode(buffer);

    parseAndInitialize(csvText, '기본 공공데이터 (로드킬 정보 2023)');
  } catch (err) {
    console.error('기본 CSV 로드 실패:', err);
    statusBadge.textContent = '기본 데이터 로드 실패 (파일 업로드 필요)';
    showNotification('기본 CSV 파일을 로드하지 못했습니다. 좌측에서 파일을 직접 선택해 주세요.', 'error');
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
  }
}

/**
 * 사용자 직접 CSV 업로드 핸들러 (보조 기능)
 */
function setupFileUploader() {
  const fileInput = document.getElementById('csvFileInput');
  const uploadText = document.getElementById('uploadStatusText');

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    uploadText.textContent = file.name;
    const statusBadge = document.getElementById('dataStatusText');
    statusBadge.textContent = `파일 파싱 중: ${file.name}`;

    try {
      const buffer = await file.arrayBuffer();
      let decoder = new TextDecoder('euc-kr');
      let text = decoder.decode(buffer);

      // 깨진 문자 감지 시 UTF-8 폴백
      if ((text.match(/\uFFFD/g) || []).length > 20) {
        decoder = new TextDecoder('utf-8');
        text = decoder.decode(buffer);
      }

      parseAndInitialize(text, file.name);
      showNotification(`"${file.name}" 파일이 성공적으로 로드되었습니다.`, 'success');
    } catch (err) {
      console.error('파일 파싱 에러:', err);
      showNotification('파일을 읽는 도중 오류가 발생했습니다.', 'error');
    }
  });
}

/**
 * PapaParse를 통한 파싱 및 데이터 유효성 검사 (위도/경도 이상치 필터링)
 */
function parseAndInitialize(csvText, sourceName = '') {
  const results = Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false
  });

  if (results.errors && results.errors.length > 0 && results.data.length === 0) {
    console.error('CSV Parse Error:', results.errors);
    showNotification('CSV 파싱 중 오류가 발생했습니다.', 'error');
    return;
  }

  // 필수 컬럼 확인 및 위경도 이상치(숫자 아님, 0 이하) 필터링
  const validData = [];
  const parkSet = new Set();

  results.data.forEach((row, index) => {
    const park = (row['국립공원명'] || '').trim();
    const date = (row['조사일자'] || '').trim();
    const animal = (row['자원명'] || '').trim();
    const rawLat = parseFloat(row['위도']);
    const rawLng = parseFloat(row['경도']);

    if (
      park &&
      !isNaN(rawLat) &&
      !isNaN(rawLng) &&
      rawLat > 0 &&
      rawLng > 0
    ) {
      validData.push({
        id: index,
        국립공원명: park,
        조사일자: date || '미상',
        자원명: animal || '미분류 야생동물',
        lat: rawLat,
        lng: rawLng
      });
      parkSet.add(park);
    }
  });

  state.rawDataset = validData;
  state.parkList = Array.from(parkSet).sort((a, b) => a.localeCompare(b, 'ko'));

  // 사이드바 국립공원 드롭다운 옵션 채우기
  populateParkSelect();

  // 대시보드 상태 뱃지 업데이트
  const statusBadge = document.getElementById('dataStatusText');
  statusBadge.textContent = `${validData.length.toLocaleString()}건 로드 완료 (${sourceName})`;

  // 전체 데이터로 초기 분석 실행
  filterAndRunAnalysis();
}

/**
 * 국립공원 드롭다운 메뉴 채우기
 */
function populateParkSelect() {
  const select = document.getElementById('parkSelect');
  select.innerHTML = '<option value="ALL">전체 국립공원 (전국 20개소)</option>';

  const counts = {};
  state.rawDataset.forEach(d => {
    counts[d.국립공원명] = (counts[d.국립공원명] || 0) + 1;
  });

  state.parkList.forEach(park => {
    const opt = document.createElement('option');
    opt.value = park;
    opt.textContent = `${park} 국립공원 (${(counts[park] || 0).toLocaleString()}건)`;
    select.appendChild(opt);
  });
}

// ----------------------------------------------------------------------------
// 5. 분석 파이프라인 (필터링 -> K-Means 계산 -> UI/지도/차트 갱신)
// ----------------------------------------------------------------------------
function filterAndRunAnalysis() {
  const loadingOverlay = document.getElementById('mapLoading');
  const alertBox = document.getElementById('mapAlert');
  const alertText = document.getElementById('mapAlertText');

  if (loadingOverlay) loadingOverlay.classList.remove('hidden');
  if (alertBox) alertBox.classList.add('hidden');

  // 재계산 시 기존 군집 결과 완전 초기화 (잔여 데이터 방지)
  state.clusterResult = null;

  // 1) 국립공원 필터 적용 (각 데이터 포인트의 얕은 복사본을 생성하여 원본 오염 및 중복 누적 방지)
  if (state.selectedPark === 'ALL') {
    state.filteredDataset = state.rawDataset.map(d => ({ ...d }));
  } else {
    state.filteredDataset = state.rawDataset
      .filter(d => d.국립공원명 === state.selectedPark)
      .map(d => ({ ...d }));
  }

  const dataLen = state.filteredDataset.length;

  // 2) K값 유효성 검사 및 안내
  let effectiveK = state.k;
  if (dataLen < state.k) {
    if (dataLen === 0) {
      alertText.textContent = '선택한 국립공원에 해당하는 로드킬 기록이 없습니다.';
      alertBox.classList.remove('hidden');
      state.clusterResult = { clusters: [], centroids: [], counts: {} };
      updateKPIs(0, effectiveK, null);
      updateMap();
      updateCharts();
      updateLegend();
      if (loadingOverlay) loadingOverlay.classList.add('hidden');
      return;
    } else {
      alertText.textContent = `데이터 수(${dataLen}건)가 군집 수(K=${state.k})보다 적어 K=${dataLen}으로 임시 계산합니다.`;
      alertBox.classList.remove('hidden');
      effectiveK = dataLen;
    }
  }

  // 3) K-Means 클러스터링 알고리즘 수행 (랜덤 시드 42 고정으로 항상 100% 동일 결과 재현)
  setTimeout(() => {
    const km = new KMeansClustering(state.filteredDataset, effectiveK, 80, 42);
    const result = km.run();
    state.clusterResult = result;

    // 4) UI 컴포넌트 전체 동기화
    updateKPIs(dataLen, effectiveK, result);
    updateLegend();
    updateMap();
    updateCharts();

    if (loadingOverlay) loadingOverlay.classList.add('hidden');
  }, 30);
}

// ----------------------------------------------------------------------------
// 6. 요약 지표 카드 (KPIs) 및 범례 업데이트
// ----------------------------------------------------------------------------
function updateKPIs(totalCount, effectiveK, clusterResult) {
  const kpiTotal = document.getElementById('kpiTotalRecords');
  const kpiK = document.getElementById('kpiClusterK');
  const kpiTopCluster = document.getElementById('kpiTopCluster');
  const kpiTopClusterInfo = document.getElementById('kpiTopClusterInfo');
  const kpiScopeText = document.getElementById('kpiScopeText');

  // KPI 1: 전체 기록 수
  kpiTotal.innerHTML = `${totalCount.toLocaleString()} <span class="text-xs font-normal text-slate-500">건</span>`;
  kpiScopeText.textContent = state.selectedPark === 'ALL' ? '전국 20개 국립공원' : `${state.selectedPark} 국립공원`;

  // KPI 2: 군집 수
  kpiK.innerHTML = `${effectiveK} <span class="text-xs font-normal text-slate-500">개 구역</span>`;

  // KPI 3: 최다 군집 번호 및 건수
  if (!clusterResult || !clusterResult.centroids || clusterResult.centroids.length === 0) {
    kpiTopCluster.textContent = '-';
    kpiTopClusterInfo.textContent = '데이터 없음';
    return;
  }

  // 전체 데이터 수와 군집별 데이터 수 합계 검증
  const clusterCountsSum = clusterResult.centroids.reduce((sum, c) => sum + (c.count || 0), 0);
  if (clusterCountsSum !== totalCount) {
    console.warn(`[정합성 경고] 전체 기록 수(${totalCount})와 군집별 합계(${clusterCountsSum}) 불일치`);
  }

  let maxCluster = clusterResult.centroids[0];
  clusterResult.centroids.forEach(c => {
    if (c.count > (maxCluster ? maxCluster.count : 0)) {
      maxCluster = c;
    }
  });

  if (maxCluster && totalCount > 0) {
    const pct = ((maxCluster.count / totalCount) * 100).toFixed(1);
    kpiTopCluster.innerHTML = `군집 #${maxCluster.id} <span class="text-sm font-semibold text-slate-700">(${maxCluster.count.toLocaleString()}건)</span>`;
    kpiTopClusterInfo.innerHTML = `<span class="inline-block w-2.5 h-2.5 rounded-full mr-1" style="background:${maxCluster.color}"></span>전체의 ${pct}% 집중 밀집 구간`;
  } else {
    kpiTopCluster.textContent = '-';
    kpiTopClusterInfo.textContent = '군집 미생성';
  }
}

/**
 * 사이드바 군집 범례 업데이트
 */
function updateLegend() {
  const container = document.getElementById('clusterLegendList');
  const tag = document.getElementById('clusterCountTag');
  const res = state.clusterResult;

  if (!res || !res.centroids || res.centroids.length === 0) {
    container.innerHTML = '<div class="text-xs text-slate-400 py-3 text-center">군집 결과 없음</div>';
    tag.textContent = '0개 군집';
    return;
  }

  tag.textContent = `${res.centroids.length}개 군집`;
  const total = state.filteredDataset.length;

  const sortedCentroids = [...res.centroids].sort((a, b) => b.count - a.count);

  let html = '';
  sortedCentroids.forEach(c => {
    const pct = total > 0 ? ((c.count / total) * 100).toFixed(1) : 0;
    html += `
      <div class="legend-item flex items-center justify-between p-2 rounded-lg border border-slate-100 hover:border-slate-300" 
           onclick="focusOnCluster(${c.id}, ${c.lat}, ${c.lng})" title="클릭 시 지도에서 해당 군집으로 이동">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-3.5 h-3.5 rounded-full flex-shrink-0 shadow-xs" style="background-color: ${c.color}"></span>
          <span class="text-xs font-bold text-slate-700 truncate">군집 #${c.id}</span>
        </div>
        <div class="text-right flex-shrink-0">
          <span class="text-xs font-semibold text-slate-800">${c.count.toLocaleString()}건</span>
          <span class="text-[10px] text-slate-400 ml-1">(${pct}%)</span>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

/**
 * 범례 클릭 시 해당 군집 중심으로 부드럽게 줌/이동
 */
window.focusOnCluster = function(clusterId, lat, lng) {
  if (!mapInstance.map) return;
  mapInstance.map.flyTo([lat, lng], 11, {
    animate: true,
    duration: 0.8
  });
};

// ----------------------------------------------------------------------------
// 7. 지도 시각화 (Leaflet.js 기반 — 위성 지도 & 일반 도로 지도 레이어 컨트롤)
// ----------------------------------------------------------------------------
function initMap() {
  // Leaflet 맵 초기화 (3,000건 이상 데이터 렌더링을 위해 preferCanvas: true 적용)
  const map = L.map('map', {
    preferCanvas: true,
    zoomControl: true,
    attributionControl: true
  }).setView([36.5, 127.8], 7);

  // 1) 위성 지도 (산림·지형 확인): Esri World Imagery (기본 활성화)
  const esriSatellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18,
    attribution: 'Tiles &copy; Esri &mdash; Source: Esri, i-cubed, USDA, USGS, AEX, GeoEye, Getmapping, Aerogrid, IGN, IGP, UPR-EGP, and the GIS User Community'
  }).addTo(map);

  // 2) 일반 도로 지도: OpenStreetMap
  const openStreetMap = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  });

  // 레이어 그룹 생성
  const markerLayerGroup = L.layerGroup().addTo(map);
  const centroidLayerGroup = L.layerGroup().addTo(map);

  // 우측 상단 배경지도 및 오버레이 컨트롤러 (API 키 불필요)
  const baseMaps = {
    "위성 지도 (산림·지형)": esriSatellite,
    "일반 도로 지도": openStreetMap
  };

  const overlayMaps = {
    "군집 중심점 핀": centroidLayerGroup,
    "개별 사고 위치 마커": markerLayerGroup
  };

  const layerControl = L.control.layers(baseMaps, overlayMaps, {
    position: 'topright',
    collapsed: false
  }).addTo(map);

  mapInstance.map = map;
  mapInstance.markerLayerGroup = markerLayerGroup;
  mapInstance.centroidLayerGroup = centroidLayerGroup;
  mapInstance.layerControl = layerControl;
}

/**
 * 지도 마커 및 중심점 핀 렌더링
 */
function updateMap() {
  if (!mapInstance.map) return;

  const { markerLayerGroup, centroidLayerGroup, map } = mapInstance;
  markerLayerGroup.clearLayers();
  centroidLayerGroup.clearLayers();

  const res = state.clusterResult;
  if (!res || !res.clusters || res.clusters.length === 0) return;

  const bounds = L.latLngBounds();

  // 1) 개별 사고 위치 마커 (L.circleMarker)
  res.clusters.forEach(pt => {
    bounds.extend([pt.lat, pt.lng]);
    const color = CLUSTER_COLORS[pt.cluster % CLUSTER_COLORS.length];

    const marker = L.circleMarker([pt.lat, pt.lng], {
      radius: 5,
      fillColor: color,
      color: '#ffffff',
      weight: 1,
      opacity: 0.9,
      fillOpacity: 0.75
    });

    const popupHtml = `
      <div class="popup-card">
        <div class="popup-header">
          <span class="popup-badge" style="background:${color}">군집 #${pt.cluster}</span>
          <span class="text-[10px] font-semibold text-slate-400">${pt.국립공원명}</span>
        </div>
        <div class="popup-title">
          <i class="fa-solid fa-paw text-xs" style="color:${color}"></i>
          <span>${pt.자원명}</span>
        </div>
        <div class="popup-row">
          <span>조사일자:</span>
          <strong>${pt.조사일자}</strong>
        </div>
        <div class="popup-row">
          <span>위치 좌표:</span>
          <span>${pt.lat.toFixed(4)}, ${pt.lng.toFixed(4)}</span>
        </div>
      </div>
    `;
    marker.bindPopup(popupHtml);
    markerLayerGroup.addLayer(marker);
  });

  // 2) 각 군집의 최종 중심점(Centroids) 강조 핀 마커 (L.marker) 및 라벨
  if (res.centroids) {
    res.centroids.forEach(c => {
      bounds.extend([c.lat, c.lng]);

      const centroidIcon = L.divIcon({
        className: 'custom-centroid-marker',
        html: `
          <div class="centroid-pulse" style="background-color: ${c.color}"></div>
          <div class="centroid-pin" style="background-color: ${c.color}">
            <div class="centroid-pin-inner">#${c.id}</div>
          </div>
          <div class="centroid-badge-label" style="border-color: ${c.color}">군집 #${c.id} 중심 (${c.count.toLocaleString()}건)</div>
        `,
        iconSize: [40, 52],
        iconAnchor: [20, 36],
        popupAnchor: [0, -36]
      });

      const pinMarker = L.marker([c.lat, c.lng], {
        icon: centroidIcon,
        zIndexOffset: 1000
      });

      const tooltipText = `군집 #${c.id} 중심 (총 ${c.count.toLocaleString()}건)`;
      pinMarker.bindTooltip(tooltipText, {
        direction: 'top',
        offset: [0, -36],
        className: 'font-bold text-xs bg-slate-900 text-white rounded px-2 py-1 shadow'
      });

      const popupHtml = `
        <div class="centroid-popup-card">
          <div class="flex items-center gap-2 mb-2 pb-1 border-b border-slate-100">
            <span class="w-3 h-3 rounded-full" style="background:${c.color}"></span>
            <h4 class="font-bold text-sm text-slate-800">군집 #${c.id} 위험 후보 중심점</h4>
          </div>
          <p class="text-xs text-slate-600 mb-1">
            <strong>총 기록 건수:</strong> <span class="text-emerald-700 font-bold text-sm">${c.count.toLocaleString()}건</span>
          </p>
          <p class="text-xs text-slate-600 mb-1">
            <strong>중심 좌표:</strong> ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}
          </p>
          <p class="text-[10px] text-amber-700 bg-amber-50 rounded p-1.5 mt-2 border border-amber-200">
            ※ 해당 군집 중심점 인근 도로에 야생동물 유도 울타리 또는 생태통로 조사가 권장됩니다.
          </p>
        </div>
      `;
      pinMarker.bindPopup(popupHtml);
      centroidLayerGroup.addLayer(pinMarker);
    });
  }

  // 지도가 데이터 영역에 맞춰 자동으로 줌/이동되도록 설정 (fitBounds)
  if (bounds.isValid()) {
    map.fitBounds(bounds, {
      padding: [45, 45],
      maxZoom: 13
    });
  }
}

// ----------------------------------------------------------------------------
// 8. 통계 시각화 차트 (Chart.js 4종)
// ----------------------------------------------------------------------------

/**
 * 4개의 인터랙티브 차트 전체 초기화/업데이트
 */
function updateCharts() {
  renderClusterBarChart();
  renderParkBarChart();
  renderAnimalBarChart();
  renderTrendLineChart();
}

/**
 * 1) 군집별 로드킬 기록 수 비교 (내림차순 막대 그래프 - 지도 색상 매칭)
 */
function renderClusterBarChart() {
  const ctx = document.getElementById('clusterBarChart').getContext('2d');
  if (chartInstances.clusterBar) chartInstances.clusterBar.destroy();

  const res = state.clusterResult;
  if (!res || !res.centroids || res.centroids.length === 0) return;

  const sorted = [...res.centroids].sort((a, b) => b.count - a.count);

  const labels = sorted.map(c => `군집 #${c.id}`);
  const data = sorted.map(c => c.count);
  const bgColors = sorted.map(c => c.color);

  chartInstances.clusterBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '기록 수 (건)',
        data: data,
        backgroundColor: bgColors,
        borderColor: '#ffffff',
        borderWidth: 1.5,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` 사고 건수: ${ctx.parsed.y.toLocaleString()}건`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 11, weight: 'bold' } }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f1f5f9' },
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

/**
 * 2) 국립공원별 로드킬 발생 건수 (내림차순 막대 그래프)
 */
function renderParkBarChart() {
  const ctx = document.getElementById('parkBarChart').getContext('2d');
  if (chartInstances.parkBar) chartInstances.parkBar.destroy();

  const data = state.filteredDataset;
  if (!data || data.length === 0) return;

  const counts = {};
  data.forEach(d => {
    counts[d.국립공원명] = (counts[d.국립공원명] || 0) + 1;
  });

  const sortedParks = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  const topParks = sortedParks.slice(0, 12);
  const labels = topParks;
  const values = topParks.map(p => counts[p]);

  chartInstances.parkBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '발생 건수',
        data: values,
        backgroundColor: '#0d9488', // Teal 600
        hoverBackgroundColor: '#0f766e',
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` 발생 건수: ${ctx.parsed.y.toLocaleString()}건`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            font: { size: 10 },
            maxRotation: 45,
            minRotation: 25
          }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f1f5f9' },
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

/**
 * 3) 주요 피해 야생동물(자원명) TOP 10 (가로 막대 그래프)
 */
function renderAnimalBarChart() {
  const ctx = document.getElementById('animalBarChart').getContext('2d');
  if (chartInstances.animalBar) chartInstances.animalBar.destroy();

  const data = state.filteredDataset;
  if (!data || data.length === 0) return;

  const counts = {};
  data.forEach(d => {
    const animal = d.자원명 || '기타';
    counts[animal] = (counts[animal] || 0) + 1;
  });

  const sortedAnimals = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 10);
  const labels = sortedAnimals;
  const values = sortedAnimals.map(a => counts[a]);

  labels.reverse();
  values.reverse();

  chartInstances.animalBar = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: '피해 건수',
        data: values,
        backgroundColor: '#d97706', // Amber 600
        hoverBackgroundColor: '#b45309',
        borderRadius: 5
      }]
    },
    options: {
      indexAxis: 'y', // 가로 막대 그래프
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` 피해 건수: ${ctx.parsed.x.toLocaleString()}건`
          }
        }
      },
      scales: {
        x: {
          beginAtZero: true,
          grid: { color: '#f1f5f9' },
          ticks: { font: { size: 10 } }
        },
        y: {
          grid: { display: false },
          ticks: { font: { size: 11, weight: 'bold' } }
        }
      }
    }
  });
}

/**
 * 4) 조사일자(연도/월별) 로드킬 발생 추이 (꺾은선 그래프)
 */
function renderTrendLineChart() {
  const ctx = document.getElementById('trendLineChart').getContext('2d');
  if (chartInstances.trendLine) chartInstances.trendLine.destroy();

  const data = state.filteredDataset;
  if (!data || data.length === 0) return;

  const counts = {};

  if (state.trendViewType === 'year') {
    data.forEach(d => {
      const year = d.조사일자 ? d.조사일자.substring(0, 4) : '기타';
      if (year && !isNaN(parseInt(year, 10))) {
        counts[year] = (counts[year] || 0) + 1;
      }
    });
  } else {
    for (let m = 1; m <= 12; m++) {
      counts[`${m}월`] = 0;
    }
    data.forEach(d => {
      if (d.조사일자 && d.조사일자.length >= 7) {
        const monthNum = parseInt(d.조사일자.substring(5, 7), 10);
        if (!isNaN(monthNum) && monthNum >= 1 && monthNum <= 12) {
          counts[`${monthNum}월`] = (counts[`${monthNum}월`] || 0) + 1;
        }
      }
    });
  }

  const labels = Object.keys(counts).sort((a, b) => {
    if (state.trendViewType === 'month') {
      return parseInt(a, 10) - parseInt(b, 10);
    }
    return a.localeCompare(b);
  });
  const values = labels.map(k => counts[k]);

  const gradient = ctx.createLinearGradient(0, 0, 0, 240);
  gradient.addColorStop(0, 'rgba(37, 99, 235, 0.35)');
  gradient.addColorStop(1, 'rgba(37, 99, 235, 0.0)');

  chartInstances.trendLine = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: state.trendViewType === 'year' ? '연도별 발생 건수' : '월별 발생 건수',
        data: values,
        borderColor: '#2563eb',
        backgroundColor: gradient,
        borderWidth: 2.5,
        fill: true,
        tension: 0.3,
        pointRadius: 4,
        pointBackgroundColor: '#2563eb',
        pointHoverRadius: 6,
        pointHoverBackgroundColor: '#1d4ed8'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => ` 발생 건수: ${ctx.parsed.y.toLocaleString()}건`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { font: { size: 10 } }
        },
        y: {
          beginAtZero: true,
          grid: { color: '#f1f5f9' },
          ticks: { font: { size: 10 } }
        }
      }
    }
  });
}

// ----------------------------------------------------------------------------
// 9. 사용자 인터랙션 및 이벤트 리스너 등록
// ----------------------------------------------------------------------------
function setupEventListeners() {
  // 1) 국립공원 선택 드롭다운 변경
  const parkSelect = document.getElementById('parkSelect');
  parkSelect.addEventListener('change', (e) => {
    state.selectedPark = e.target.value;
    filterAndRunAnalysis();
  });

  // 2) K값 슬라이더 조작
  const kSlider = document.getElementById('kSlider');
  const kBadge = document.getElementById('kValueBadge');

  kSlider.addEventListener('input', (e) => {
    state.k = parseInt(e.target.value, 10);
    kBadge.textContent = `K = ${state.k}`;
  });

  kSlider.addEventListener('change', () => {
    filterAndRunAnalysis();
  });

  // 3) K-Means 즉시 재계산 버튼
  const runBtn = document.getElementById('runClusterBtn');
  runBtn.addEventListener('click', () => {
    filterAndRunAnalysis();
  });

  // 4) 지도 리셋 / 화면 맞춤 버튼
  const resetBtn = document.getElementById('resetViewBtn');
  const fitBtn = document.getElementById('fitMapBtn');

  const handleFit = () => {
    if (!mapInstance.map || !state.clusterResult || !state.clusterResult.clusters) return;
    const bounds = L.latLngBounds();
    state.clusterResult.clusters.forEach(pt => bounds.extend([pt.lat, pt.lng]));
    if (bounds.isValid()) {
      mapInstance.map.fitBounds(bounds, { padding: [45, 45] });
    }
  };

  if (resetBtn) resetBtn.addEventListener('click', handleFit);
  if (fitBtn) fitBtn.addEventListener('click', handleFit);

  // 5) 추이 차트 모드 토글 (연도별 vs 월별)
  const trendYearBtn = document.getElementById('trendPeriodYearBtn');
  const trendMonthBtn = document.getElementById('trendPeriodMonthBtn');

  if (trendYearBtn && trendMonthBtn) {
    trendYearBtn.addEventListener('click', () => {
      if (state.trendViewType === 'year') return;
      state.trendViewType = 'year';
      trendYearBtn.className = 'text-[10px] px-2 py-0.5 rounded font-semibold bg-blue-600 text-white transition';
      trendMonthBtn.className = 'text-[10px] px-2 py-0.5 rounded font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 transition';
      renderTrendLineChart();
    });

    trendMonthBtn.addEventListener('click', () => {
      if (state.trendViewType === 'month') return;
      state.trendViewType = 'month';
      trendMonthBtn.className = 'text-[10px] px-2 py-0.5 rounded font-semibold bg-blue-600 text-white transition';
      trendYearBtn.className = 'text-[10px] px-2 py-0.5 rounded font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 transition';
      renderTrendLineChart();
    });
  }
}

/**
 * 사용자 피드백 알림 토스트 표시
 */
function showNotification(message, type = 'info') {
  const existing = document.getElementById('appNotificationToast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'appNotificationToast';
  const bgColor = type === 'error' ? 'bg-rose-600' : (type === 'success' ? 'bg-emerald-600' : 'bg-slate-800');
  toast.className = `fixed bottom-5 right-5 z-50 text-white text-xs font-semibold px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2 animate-fade-in ${bgColor}`;
  
  const icon = type === 'error' ? 'fa-circle-xmark' : (type === 'success' ? 'fa-circle-check' : 'fa-circle-info');
  toast.innerHTML = `<i class="fa-solid ${icon}"></i><span>${message}</span>`;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

// ----------------------------------------------------------------------------
// 10. 앱 부트스트랩 (DOMContentLoaded)
// ----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initMap();
  setupEventListeners();
  setupFileUploader();
  loadDefaultCSV();
});
