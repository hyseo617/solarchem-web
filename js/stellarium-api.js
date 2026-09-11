// stellarium-api.js
// Stellarium Remote Control API와의 모든 HTTP 통신을 이 파일에 모은다.
// 다른 코드는 이 파일이 제공하는 함수만 사용하고, raw endpoint를 직접 호출하지 않는다.
// endpoint와 파라미터 형식의 근거는 docs/api-notes.md 참조. 임의로 추측한 필드는 없다.

const STELLARIUM_BASE_URL = 'http://localhost:8090';

const AU_IN_KM = 149597870.7; // IAU 표준 천문단위. calculation-notes.md 3.2, api-notes.md 5.1
const AU_KM_CHECK_TOLERANCE_KM = 5; // 실측 오차 0.3km보다 넉넉한 허용치. api-notes.md 5.1 근거 참조
const ALTITUDE_DIFF_WARNING_DEG = 1.0; // 지평선 굴절 최대치(~0.57°)의 약 2배. api-notes.md 5.2 근거 참조

const LATITUDE_RANGE = [-90, 90];
const LONGITUDE_RANGE = [-180, 180];
const ALTITUDE_RANGE_M = [0, 5000]; // calculation-notes.md 2.1

// Stellarium API와의 통신에서 발생하는 오류를 종류별로 구분한다.
// kind: 'connection' | 'api' | 'invalid-response' | 'invalid-input'
// api-notes.md 6장 참조.
class StellariumApiError extends Error {
  constructor(kind, message, detail) {
    super(message);
    this.name = 'StellariumApiError';
    this.kind = kind;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// 내부 HTTP 헬퍼. 이 아래 함수만 fetch()를 직접 호출한다.
// ---------------------------------------------------------------------------

async function stellariumFetch(path, { method = 'GET', params, body } = {}) {
  let url = STELLARIUM_BASE_URL + path;
  if (params) {
    const qs = new URLSearchParams(params).toString();
    if (qs) {
      url += (url.includes('?') ? '&' : '?') + qs;
    }
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      body: body ? new URLSearchParams(body) : undefined,
    });
  } catch (err) {
    throw new StellariumApiError(
      'connection',
      'Stellarium Remote Control 서버에 연결할 수 없습니다. Stellarium이 실행 중이고 Remote Control 플러그인의 Server enabled가 켜져 있는지 확인하세요.',
      err
    );
  }

  // 응답 형식이 endpoint마다 다르다 (JSON 또는 plain text).
  // 오류 시에도 JSON이 아닌 plain text가 올 수 있으므로(api-notes.md 2.5)
  // 먼저 텍스트로 받고, HTTP status부터 확인한다.
  const text = await response.text();

  if (!response.ok) {
    throw new StellariumApiError(
      'api',
      `Stellarium API 오류 (HTTP ${response.status}): ${text}`,
      { status: response.status, body: text, url }
    );
  }

  // HTTP 200이어도 본문이 "error: ..." 형태인 명령형 endpoint가 있다 (api-notes.md 2.3).
  if (typeof text === 'string' && text.startsWith('error:')) {
    throw new StellariumApiError('api', `Stellarium API 오류: ${text}`, { body: text, url });
  }

  return text;
}

async function stellariumFetchJson(path, options) {
  const text = await stellariumFetch(path, options);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new StellariumApiError(
      'invalid-response',
      'Stellarium 응답을 JSON으로 해석할 수 없습니다.',
      { body: text, parseError: err }
    );
  }
}

// ---------------------------------------------------------------------------
// 연결 확인
// ---------------------------------------------------------------------------

// 별도 ping endpoint가 없으므로 /api/main/status를 한 번 호출해 판단한다.
// api-notes.md 2.1 참조. 이 함수는 UI에서 바로 쓰기 쉽도록 예외를 던지지 않고
// 결과 객체를 돌려준다.
async function checkConnection() {
  try {
    const raw = await stellariumFetchJson('/api/main/status');
    return { connected: true, raw };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof StellariumApiError ? err : new StellariumApiError('connection', String(err), err),
    };
  }
}

// ---------------------------------------------------------------------------
// 위치
// ---------------------------------------------------------------------------

async function getCurrentLocation() {
  const raw = await stellariumFetchJson('/api/main/status');
  const loc = raw.location;
  if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') {
    throw new StellariumApiError('invalid-response', 'status 응답에 location 필드가 없습니다.', raw);
  }
  return {
    latitude: loc.latitude,
    longitude: loc.longitude,
    altitude: loc.altitude,
    name: loc.name,
    planet: loc.planet,
    raw,
  };
}

function validateLocationInput({ latitude, longitude, altitude }) {
  const errors = [];
  if (typeof latitude !== 'number' || Number.isNaN(latitude) || latitude < LATITUDE_RANGE[0] || latitude > LATITUDE_RANGE[1]) {
    errors.push(`latitude는 ${LATITUDE_RANGE[0]}~${LATITUDE_RANGE[1]} 범위의 숫자여야 합니다 (입력값: ${latitude})`);
  }
  if (typeof longitude !== 'number' || Number.isNaN(longitude) || longitude < LONGITUDE_RANGE[0] || longitude > LONGITUDE_RANGE[1]) {
    errors.push(`longitude는 ${LONGITUDE_RANGE[0]}~${LONGITUDE_RANGE[1]} 범위의 숫자여야 합니다 (입력값: ${longitude})`);
  }
  if (typeof altitude !== 'number' || Number.isNaN(altitude) || altitude < ALTITUDE_RANGE_M[0] || altitude > ALTITUDE_RANGE_M[1]) {
    errors.push(`altitude는 ${ALTITUDE_RANGE_M[0]}~${ALTITUDE_RANGE_M[1]} m 범위의 숫자여야 합니다 (입력값: ${altitude})`);
  }
  return errors;
}

// latitude/longitude/altitude 중 필요한 값만 넘기면 된다.
// 범위를 벗어나면 API를 호출하지 않고 즉시 오류를 던진다 (api-notes.md 2.2, 4.1 —
// 서버는 범위를 검증하지 않음을 실측으로 확인했다).
async function setLocation({ latitude, longitude, altitude }) {
  const errors = validateLocationInput({ latitude, longitude, altitude });
  if (errors.length > 0) {
    throw new StellariumApiError('invalid-input', `위치 입력값이 올바르지 않습니다: ${errors.join('; ')}`, errors);
  }

  const body = {};
  if (latitude !== undefined) body.latitude = latitude;
  if (longitude !== undefined) body.longitude = longitude;
  if (altitude !== undefined) body.altitude = altitude;

  const resultText = await stellariumFetch('/api/location/setlocationfields', { method: 'POST', body });
  return { ok: resultText.trim() === 'ok', raw: resultText };
}

// ---------------------------------------------------------------------------
// 시각
// ---------------------------------------------------------------------------

async function getCurrentTime() {
  const raw = await stellariumFetchJson('/api/main/status');
  const time = raw.time;
  if (!time || typeof time.jday !== 'number' || typeof time.utc !== 'string') {
    throw new StellariumApiError('invalid-response', 'status 응답에 time 필드가 없습니다.', raw);
  }
  return {
    julianDay: time.jday,
    utcIso: time.utc,
    localDisplay: time.local,
    timeZone: time.timeZone,
    isTimeNow: time.isTimeNow,
    raw,
  };
}

// jsDateToJd와 동일한 식. api-notes.md 4.2, Stellarium 자체 웹클라이언트
// js/api/time.js의 jsDateToJd와 동일하며 JD 2461041.0 <-> 2025-12-31T12:00:00Z로
// 실측 왕복 검증했다.
function utcEpochMsToJulianDay(epochMs) {
  return epochMs / 86400000 + 2440587.5;
}

const FIXED_OFFSET_PATTERN = /^(?:UTC)?([+-])(\d{2}):(\d{2})$/i;

// 타임존 문자열을 UTC 오프셋(분)으로 변환한다.
// "UTC+09:00" / "+09:00" / "-05:30" 형태는 고정 오프셋으로 직접 파싱한다 (DST 없음, 모호함 없음).
// 그 외 문자열은 IANA 타임존 이름으로 간주하고, referenceUtcDate 시점에서의 실제 오프셋을
// Intl.DateTimeFormat 왕복 변환으로 역산한다 (외부 라이브러리 없이 표준 API만 사용).
// api-notes.md 4.2 참조. DST 전환 경계의 극히 일부 순간에서는 근사 오차가 있을 수 있음을
// 문서에 명시했다 — Phase 1은 과학 계산이 아니라 연결 시연이므로 허용한다.
function resolveTimeZoneOffsetMinutes(timeZone, referenceUtcDate) {
  const fixed = FIXED_OFFSET_PATTERN.exec(timeZone.trim());
  if (fixed) {
    const sign = fixed[1] === '-' ? -1 : 1;
    const hours = Number(fixed[2]);
    const minutes = Number(fixed[3]);
    return sign * (hours * 60 + minutes);
  }
  if (/^UTC$/i.test(timeZone.trim())) {
    return 0;
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch (err) {
    throw new StellariumApiError('invalid-input', `알 수 없는 timezone입니다: "${timeZone}". IANA 타임존 이름(예: Asia/Seoul) 또는 UTC 오프셋(예: UTC+09:00)을 입력하세요.`, err);
  }

  const parts = formatter.formatToParts(referenceUtcDate).reduce((acc, p) => {
    acc[p.type] = p.value;
    return acc;
  }, {});
  const asIfUtcMs = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return (asIfUtcMs - referenceUtcDate.getTime()) / 60000;
}

function validateDateTimeInput(date, time, timeZone) {
  const errors = [];
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    errors.push(`date는 YYYY-MM-DD 형식이어야 합니다 (입력값: ${date})`);
  }
  if (typeof time !== 'string' || !/^\d{2}:\d{2}(:\d{2})?$/.test(time)) {
    errors.push(`time은 HH:MM 또는 HH:MM:SS 형식이어야 합니다 (입력값: ${time})`);
  }
  if (typeof timeZone !== 'string' || timeZone.trim() === '') {
    errors.push('timeZone을 입력해야 합니다 (브라우저 로컬 타임존을 암묵적으로 사용하지 않음)');
  }
  return errors;
}

// date: "YYYY-MM-DD", time: "HH:MM" 또는 "HH:MM:SS", timeZone: IANA 이름 또는 고정 오프셋 문자열.
// 변환 과정은 api-notes.md 4.2에 기록되어 있다.
async function setDateTime(date, time, timeZone) {
  const errors = validateDateTimeInput(date, time, timeZone);
  if (errors.length > 0) {
    throw new StellariumApiError('invalid-input', `날짜/시각 입력값이 올바르지 않습니다: ${errors.join('; ')}`, errors);
  }

  const [year, month, day] = date.split('-').map(Number);
  const timeParts = time.split(':').map(Number);
  const [hour, minute] = timeParts;
  const second = timeParts.length > 2 ? timeParts[2] : 0;

  // 1차 추정: 벽시계 값을 UTC로 잘못 해석
  const guessUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMinutes = resolveTimeZoneOffsetMinutes(timeZone, guessUtc);
  const actualUtcMs = guessUtc.getTime() - offsetMinutes * 60000;

  const julianDay = utcEpochMsToJulianDay(actualUtcMs);

  const resultText = await stellariumFetch('/api/main/time', {
    method: 'POST',
    body: { time: julianDay },
  });

  return {
    ok: resultText.trim() === 'ok',
    julianDay,
    utcIso: new Date(actualUtcMs).toISOString(),
    raw: resultText,
  };
}

// ---------------------------------------------------------------------------
// Sun 정보
// ---------------------------------------------------------------------------

// raw 응답을 그대로 반환한다. airmass를 포함한 모든 필드가 들어있지만
// SolarChem 내부 형식으로의 선별은 parseSunInfo()가 담당한다.
async function getSunInfo() {
  const raw = await stellariumFetchJson('/api/objects/info', { params: { name: 'Sun', format: 'json' } });
  if (raw.found !== true) {
    throw new StellariumApiError('api', 'Stellarium이 Sun object를 찾지 못했습니다 (found != true).', raw);
  }
  return { data: parseSunInfo(raw), raw };
}

// Stellarium raw 응답 -> SolarChem 내부 형식.
// airmass는 의도적으로 포함하지 않는다 (README, calculation-notes.md 3.1, 3.3 —
// Stellarium 내부 air-mass 모델과 SolarChem 모델을 혼합하지 않기 위함).
// azimuthGeometricDeg, aboveHorizon은 Phase 2 astronomy-data.js의 ObservationConditions.sun이
// 요구하는 필드다. calculation-notes.md 3.1 / references.md 11장에서 이미 확정된 필드이며
// Phase 1 시점에는 사용처가 없어 추출하지 않았다.
function parseSunInfo(raw) {
  const required = ['altitude-geometric', 'distance', 'distance-km'];
  const missing = required.filter((key) => typeof raw[key] !== 'number' || Number.isNaN(raw[key]));
  if (missing.length > 0) {
    throw new StellariumApiError('invalid-response', `Sun 응답에 필수 필드가 없습니다: ${missing.join(', ')}`, raw);
  }

  return {
    found: raw.found === true,
    altitudeApparentDeg: typeof raw.altitude === 'number' ? raw.altitude : null,
    altitudeGeometricDeg: raw['altitude-geometric'],
    azimuthDeg: typeof raw.azimuth === 'number' ? raw.azimuth : null,
    azimuthGeometricDeg: typeof raw['azimuth-geometric'] === 'number' ? raw['azimuth-geometric'] : null,
    aboveHorizon: typeof raw['above-horizon'] === 'boolean' ? raw['above-horizon'] : null,
    distanceAu: raw.distance,
    distanceKm: raw['distance-km'],
  };
}

// ---------------------------------------------------------------------------
// 자체 검산 (api-notes.md 5장)
// ---------------------------------------------------------------------------

// distanceAu * 1 AU(km)가 distanceKm과 일치하는지 검산한다.
// IAU 표준 AU = 149597870.7 km. 정확히 같아야 한다고 강제하지 않고 tolerance를 둔다.
function checkAuConsistency(distanceAu, distanceKm, toleranceKm = AU_KM_CHECK_TOLERANCE_KM) {
  const expectedKm = distanceAu * AU_IN_KM;
  const diffKm = Math.abs(expectedKm - distanceKm);
  return {
    status: diffKm <= toleranceKm ? 'PASS' : 'FAIL',
    expectedKm,
    actualKm: distanceKm,
    diffKm,
    toleranceKm,
  };
}

// altitude(apparent)와 altitude-geometric 필드의 존재 및 비정상적으로 큰 차이만 확인한다.
// 특정 고정값(예: 반드시 1분각)을 강제하지 않는다.
function checkAltitudeSanity(altitudeApparentDeg, altitudeGeometricDeg) {
  if (typeof altitudeApparentDeg !== 'number' || typeof altitudeGeometricDeg !== 'number' ||
      Number.isNaN(altitudeApparentDeg) || Number.isNaN(altitudeGeometricDeg)) {
    return {
      status: 'FAIL',
      reason: 'altitude 또는 altitude-geometric 필드가 없거나 숫자가 아닙니다.',
      altitudeApparentDeg,
      altitudeGeometricDeg,
    };
  }

  const diffDeg = altitudeApparentDeg - altitudeGeometricDeg;
  if (Math.abs(diffDeg) > ALTITUDE_DIFF_WARNING_DEG) {
    return {
      status: 'WARNING',
      reason: `apparent-geometric 차이(${diffDeg.toFixed(4)}°)가 대기굴절로 설명하기엔 비정상적으로 큽니다.`,
      diffDeg,
    };
  }

  return { status: 'PASS', diffDeg };
}
