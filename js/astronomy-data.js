// astronomy-data.js
// Phase 2 — Astronomy Data Layer.
// js/stellarium-api.js가 반환하는 결과를 SolarChem 내부 ObservationConditions 형식으로
// 정규화한다. Stellarium raw key(altitude-geometric, distance-km 등)는 이 파일 밖으로
// 내보내지 않는다. 이 파일 아래에서 사용하는 함수/상수는 js/stellarium-api.js가 전역으로
// 제공하는 것을 그대로 재사용한다 (중복 구현하지 않는다). 자세한 내용은
// docs/astronomy-data.md 참조.

const TIME_JD_CONSISTENCY_TOLERANCE_DAYS = 1 / 86400; // 1초 오차까지 허용

// astronomy-data.js 계층에서 발생하는 검증 오류.
// js/stellarium-api.js의 StellariumApiError(통신/API 오류)와 의도적으로 구분한다 —
// 이 오류는 "Stellarium과 통신은 됐지만 SolarChem 내부 스키마 요건을 만족하지 못함"을 뜻한다.
class AstronomyDataError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = 'AstronomyDataError';
    this.issues = issues || [];
  }
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ---------------------------------------------------------------------------
// Location
// ---------------------------------------------------------------------------

// rawLocation: js/stellarium-api.js의 getCurrentLocation()이 반환하는 객체
// ({latitude, longitude, altitude, ...}). raw Stellarium status.location과 키 이름은
// 같지만(같은 Phase 1 계약), 이 함수의 존재 이유는 범위 검증과 명시적 실패다.
function normalizeLocation(rawLocation) {
  const issues = [];
  const latitudeDeg = rawLocation ? rawLocation.latitude : undefined;
  const longitudeDeg = rawLocation ? rawLocation.longitude : undefined;
  const altitudeM = rawLocation ? rawLocation.altitude : undefined;

  if (!isFiniteNumber(latitudeDeg) || latitudeDeg < LATITUDE_RANGE[0] || latitudeDeg > LATITUDE_RANGE[1]) {
    issues.push(`location.latitudeDeg가 유효하지 않습니다 (${LATITUDE_RANGE[0]}~${LATITUDE_RANGE[1]} 범위의 숫자여야 함, 받은 값: ${latitudeDeg})`);
  }
  if (!isFiniteNumber(longitudeDeg) || longitudeDeg < LONGITUDE_RANGE[0] || longitudeDeg > LONGITUDE_RANGE[1]) {
    issues.push(`location.longitudeDeg가 유효하지 않습니다 (${LONGITUDE_RANGE[0]}~${LONGITUDE_RANGE[1]} 범위의 숫자여야 함, 받은 값: ${longitudeDeg})`);
  }
  if (!isFiniteNumber(altitudeM) || altitudeM < ALTITUDE_RANGE_M[0] || altitudeM > ALTITUDE_RANGE_M[1]) {
    issues.push(`location.altitudeM이 유효하지 않습니다 (${ALTITUDE_RANGE_M[0]}~${ALTITUDE_RANGE_M[1]} 범위의 숫자여야 함, 받은 값: ${altitudeM})`);
  }

  return { value: { latitudeDeg, longitudeDeg, altitudeM }, issues };
}

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

// rawTime: js/stellarium-api.js의 status.time 형태 ({jday, utc, ...}).
// options.timeZone: 호출자가 명시적으로 전달한 경우에만 사용한다. Stellarium이 돌려주는
// time.timeZone(시뮬레이션 표시용 타임존)은 사용자 입력 IANA 타임존과 다른 개념이므로
// 여기서 절대 읽지 않는다 (docs/astronomy-data.md 5장 원칙).
function normalizeTime(rawTime, options = {}) {
  const issues = [];
  const julianDay = rawTime ? rawTime.jday : undefined;
  const utcIso = rawTime ? rawTime.utc : undefined;

  if (!isFiniteNumber(julianDay)) {
    issues.push(`time.julianDay가 유효한 숫자가 아닙니다 (받은 값: ${julianDay})`);
  }

  const parsedEpochMs = typeof utcIso === 'string' ? Date.parse(utcIso) : NaN;
  if (typeof utcIso !== 'string' || Number.isNaN(parsedEpochMs)) {
    issues.push(`time.utcIso가 유효한 UTC 시각 문자열이 아닙니다 (받은 값: ${utcIso})`);
  }

  let jdFromUtc = null;
  let jdConsistencyDiffDays = null;
  if (isFiniteNumber(julianDay) && !Number.isNaN(parsedEpochMs)) {
    jdFromUtc = utcEpochMsToJulianDay(parsedEpochMs);
    jdConsistencyDiffDays = Math.abs(jdFromUtc - julianDay);
    if (jdConsistencyDiffDays > TIME_JD_CONSISTENCY_TOLERANCE_DAYS) {
      issues.push(`time.julianDay와 time.utcIso가 같은 순간을 가리키지 않습니다 (차이 ${jdConsistencyDiffDays.toFixed(8)} day)`);
    }
  }

  const timeZone = typeof options.timeZone === 'string' && options.timeZone.trim() !== '' ? options.timeZone : null;

  return {
    value: { julianDay, utcIso, timeZone },
    issues,
    diagnostics: { jdFromUtc, jdConsistencyDiffDays },
  };
}

// ---------------------------------------------------------------------------
// Sun
// ---------------------------------------------------------------------------

// parsedSun: js/stellarium-api.js의 parseSunInfo()가 반환하는 객체
// ({found, altitudeApparentDeg, altitudeGeometricDeg, azimuthDeg, azimuthGeometricDeg,
//   aboveHorizon, distanceAu, distanceKm}). airmass는 애초에 이 객체에 없다
// (js/stellarium-api.js parseSunInfo 참조, docs/astronomy-data.md 6장 — architecture rule).
function normalizeSunInfo(parsedSun) {
  const issues = [];
  if (!parsedSun || parsedSun.found !== true) {
    issues.push('sun.found가 true가 아닙니다. Stellarium이 Sun object를 찾지 못했습니다.');
    return { value: null, issues };
  }

  const aboveHorizon = parsedSun.aboveHorizon;
  const altitudeApparentDeg = parsedSun.altitudeApparentDeg;
  const altitudeGeometricDeg = parsedSun.altitudeGeometricDeg;
  const azimuthDeg = parsedSun.azimuthDeg;
  const azimuthGeometricDeg = parsedSun.azimuthGeometricDeg;
  const distanceAu = parsedSun.distanceAu;
  const distanceKm = parsedSun.distanceKm;

  if (typeof aboveHorizon !== 'boolean') {
    issues.push(`sun.aboveHorizon이 boolean이 아닙니다 (받은 값: ${aboveHorizon})`);
  }
  if (!isFiniteNumber(altitudeApparentDeg)) {
    issues.push(`sun.altitudeApparentDeg가 유효한 숫자가 아닙니다 (받은 값: ${altitudeApparentDeg})`);
  }
  if (!isFiniteNumber(altitudeGeometricDeg)) {
    issues.push(`sun.altitudeGeometricDeg가 유효한 숫자가 아닙니다 (받은 값: ${altitudeGeometricDeg})`);
  }
  if (!isFiniteNumber(azimuthDeg)) {
    issues.push(`sun.azimuthDeg가 유효한 숫자가 아닙니다 (받은 값: ${azimuthDeg})`);
  }
  if (!isFiniteNumber(azimuthGeometricDeg)) {
    issues.push(`sun.azimuthGeometricDeg가 유효한 숫자가 아닙니다 (받은 값: ${azimuthGeometricDeg})`);
  }
  if (!isFiniteNumber(distanceAu) || distanceAu <= 0) {
    issues.push(`sun.distanceAu가 유효한 양수가 아닙니다 (받은 값: ${distanceAu})`);
  }
  if (!isFiniteNumber(distanceKm) || distanceKm <= 0) {
    issues.push(`sun.distanceKm이 유효한 양수가 아닙니다 (받은 값: ${distanceKm})`);
  }

  // airmass 키는 여기서 절대 추가하지 않는다 (architecture rule, docs/astronomy-data.md 6장).
  return {
    value: { aboveHorizon, altitudeApparentDeg, altitudeGeometricDeg, azimuthDeg, azimuthGeometricDeg, distanceAu, distanceKm },
    issues,
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// {location, time, sun}: normalizeLocation/normalizeTime/normalizeSunInfo의 반환값 그대로.
// 4가지 진단 항목을 만든다 — tests/astronomy-data-test.html의 표시 항목과 1:1 대응.
function validateObservationConditions({ location, time, sun }) {
  const requiredFieldIssues = [...location.issues, ...time.issues, ...sun.issues];
  const requiredFields = {
    status: requiredFieldIssues.length === 0 ? 'PASS' : 'FAIL',
    issues: requiredFieldIssues,
  };

  let auConsistency = {
    status: 'FAIL',
    expectedKm: null,
    reportedKm: null,
    differenceKm: null,
    toleranceKm: AU_KM_CHECK_TOLERANCE_KM,
  };
  if (sun.value && isFiniteNumber(sun.value.distanceAu) && isFiniteNumber(sun.value.distanceKm)) {
    const check = checkAuConsistency(sun.value.distanceAu, sun.value.distanceKm);
    auConsistency = {
      status: check.status,
      expectedKm: check.expectedKm,
      reportedKm: check.actualKm,
      differenceKm: check.diffKm,
      toleranceKm: check.toleranceKm,
    };
  }

  const airmassExcluded = {
    status: sun.value && !Object.prototype.hasOwnProperty.call(sun.value, 'airmass') ? 'PASS' : 'FAIL',
  };

  const internalSchema = {
    status: requiredFields.status === 'PASS' && auConsistency.status === 'PASS' && airmassExcluded.status === 'PASS'
      ? 'PASS'
      : 'FAIL',
  };

  return { requiredFields, auConsistency, airmassExcluded, internalSchema };
}

// ---------------------------------------------------------------------------
// Orchestration — API 호출과 정규화를 여기서만 결합한다.
// ---------------------------------------------------------------------------

// options.timeZone: 호출자가 명시적으로 알고 있는 IANA 타임존/고정 오프셋 문자열일 때만
// 전달한다. 전달하지 않으면 ObservationConditions.time.timeZone은 null이 된다 (5장 원칙).
//
// getCurrentLocation()의 raw는 /api/main/status 전체 응답이므로 그 안의 raw.time을
// 재사용한다 — /api/main/status를 두 번 호출하지 않고, 위치와 시각이 같은 스냅샷에서
// 나오도록 한다.
async function getObservationConditions(options = {}) {
  const locationRaw = await getCurrentLocation();
  const timeRaw = locationRaw.raw.time;
  const sunRaw = await getSunInfo();

  const locationResult = normalizeLocation(locationRaw);
  const timeResult = normalizeTime(timeRaw, { timeZone: options.timeZone });
  const sunResult = normalizeSunInfo(sunRaw.data);

  const validation = validateObservationConditions({ location: locationResult, time: timeResult, sun: sunResult });

  if (validation.requiredFields.status !== 'PASS' || validation.auConsistency.status !== 'PASS' || validation.airmassExcluded.status !== 'PASS') {
    const auIssue = validation.auConsistency.status !== 'PASS'
      ? [`AU consistency 검산 실패: expected ${validation.auConsistency.expectedKm} km, reported ${validation.auConsistency.reportedKm} km, diff ${validation.auConsistency.differenceKm} km (tolerance ${validation.auConsistency.toleranceKm} km)`]
      : [];
    throw new AstronomyDataError(
      'ObservationConditions를 생성할 수 없습니다 (validation 실패).',
      [...validation.requiredFields.issues, ...auIssue]
    );
  }

  const observation = {
    location: locationResult.value,
    time: timeResult.value,
    sun: sunResult.value,
    source: { engine: 'Stellarium' },
  };

  return {
    observation,
    diagnostics: {
      validation,
      raw: { status: locationRaw.raw, sun: sunRaw.raw },
    },
  };
}
