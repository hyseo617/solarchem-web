// solar-model.js
// Phase 3 — Solar Model.
// Phase 2의 ObservationConditions와 대기 입력값을 받아 290-400 nm modeled clear-sky
// direct-beam spectral actinic photon flux를 계산한다. 식·계수·단위는 전부
// docs/calculation-notes.md rev.5를 그대로 따른다 (4.1~4.6). 화합물 데이터는
// 전혀 다루지 않는다 — Phase 4에서 이 파일의 출력을 입력으로 받는다.
//
// 중요: 이 파일은 ASTM G173 extraterrestrial spectrum과 ozone cross-section
// 데이터를 내장하지 않는다. calculateSolarSpectrum()의 `data` 인자로 호출자가
// 실제 검증된 데이터를 넘겨야 한다. 이 프로젝트에는 아직 그 데이터 파일이
// 없다 (docs/solar-model.md "데이터 확보 상태" 참조) — 임의 수치를 채워 넣지 않는다.
//
// 입력 contract: observation은 js/astronomy-data.js의 getObservationConditions()가
// 반환하는 ObservationConditions여야 한다. raw Stellarium key(altitude-geometric,
// distance, airmass 등)는 이 파일에서 절대 참조하지 않는다.

// ---------------------------------------------------------------------------
// 상수 — 전부 calculation-notes.md rev.5 명세값
// ---------------------------------------------------------------------------

const WAVELENGTH_GRID_START_NM = 290;
const WAVELENGTH_GRID_END_NM = 400;
const WAVELENGTH_GRID_STEP_NM = 1.0;

// 290, 291, ..., 400 — 111점. calculation-notes.md 1장.
const WAVELENGTH_GRID_NM = (() => {
  const grid = [];
  for (let nm = WAVELENGTH_GRID_START_NM; nm <= WAVELENGTH_GRID_END_NM; nm += WAVELENGTH_GRID_STEP_NM) {
    grid.push(Math.round(nm * 10) / 10);
  }
  return grid;
})();

const EARTH_RADIUS_KM = 6371; // calculation-notes.md 4.2 오존 경로
// z_O3 = 22 km는 rev.5의 기본값이나 출처가 완전히 닫힌 값은 아니다 (calculation-notes.md
// 4.2 "유효 오존층 고도"). 상수로 분리해 향후 sensitivity test가 가능하게 한다.
const EFFECTIVE_OZONE_LAYER_HEIGHT_KM = 22;

const STATION_PRESSURE_REFERENCE_HPA = 1013.25; // calculation-notes.md 2.3
const STATION_PRESSURE_SCALE_HEIGHT_M = 8434.5; // calculation-notes.md 2.3

const OZONE_DU_TO_MOLECULES_CM2 = 2.6867e16; // calculation-notes.md 4.4, 1000 DU = 1 atm-cm

const PLANCK_CONSTANT_J_S = 6.62607015e-34; // calculation-notes.md 4.6
const SPEED_OF_LIGHT_M_S = 2.99792458e8; // calculation-notes.md 4.6

// SMARTS SUNCOR 범위 (calculation-notes.md 4.3). 벗어나면 거리 입력 자체가 의심스러운 것이다.
const INVERSE_SQUARE_FACTOR_RANGE = [0.966, 1.034];

// calculation-notes.md 2.2 기본값
const DEFAULT_TOTAL_OZONE_DU = 300;
const DEFAULT_ANGSTROM_BETA = 0.10;
const DEFAULT_ANGSTROM_ALPHA = 1.3;
const DEFAULT_OZONE_TEMPERATURE_K = 243;

const LOCATION_ALTITUDE_RANGE_M = [0, 5000]; // calculation-notes.md 2.1과 동일 범위

// solar-model.js 계층에서 발생하는 검증 오류.
// astronomy-data.js의 AstronomyDataError(스키마 검증)와 구분한다 — 이 오류는
// "ObservationConditions/atmosphere/spectrum data가 Solar Model 요건을 만족하지 못함"을 뜻한다.
class SolarModelError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = 'SolarModelError';
    this.issues = issues || [];
  }
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

// ---------------------------------------------------------------------------
// 4.1 태양 기하 — solar geometry
// ---------------------------------------------------------------------------

// observation.sun.altitudeGeometricDeg만 사용한다 (calculation-notes.md 3.1, 4.1).
// altitudeApparentDeg는 계산 입력으로 쓰지 않는다.
function calculateSolarGeometry(observation) {
  const altitudeGeometricDeg = observation.sun.altitudeGeometricDeg;
  const solarZenithDeg = 90 - altitudeGeometricDeg;
  // μ_0 = cos θ_z = sin h_geom (calculation-notes.md 4.1)
  const mu0 = Math.sin(degToRad(altitudeGeometricDeg));
  return {
    solarAltitudeGeometricDeg: altitudeGeometricDeg,
    solarZenithDeg,
    mu0,
    sunBelowHorizon: altitudeGeometricDeg <= 0,
  };
}

// ---------------------------------------------------------------------------
// 4.2 공기질량 — Young (1994), ozone 구면층, aerosol = m
// ---------------------------------------------------------------------------

// z = true(굴절 미보정) 천정각(deg). apparent 천정각 입력 금지, Kasten-Young 1989 아님.
// references.md 2.1, calculation-notes.md 4.2.
function calculateYoungAirMass(zenithDeg) {
  const z = degToRad(zenithDeg);
  const cosZ = Math.cos(z);
  const numerator = 1.002432 * cosZ * cosZ + 0.148386 * cosZ + 0.0096467;
  const denominator = cosZ * cosZ * cosZ + 0.149864 * cosZ * cosZ + 0.0102963 * cosZ + 0.000303978;
  return numerator / denominator;
}

// 단일 구면층 기하. calculation-notes.md 4.2 오존 경로. altitudeM은 관측지 고도(m).
function calculateOzoneAirMass(zenithDeg, altitudeM) {
  const zS = altitudeM / 1000;
  const zO3 = EFFECTIVE_OZONE_LAYER_HEIGHT_KM;
  const sinZ = Math.sin(degToRad(zenithDeg));
  const ratio = (EARTH_RADIUS_KM + zS) / (EARTH_RADIUS_KM + zO3);
  const term = ratio * ratio * sinZ * sinZ;
  return Math.pow(1 - term, -0.5);
}

// m_a = m. 의도된 근사다 (calculation-notes.md 4.2 "에어로졸 경로", SMARTS 예제 근거).
// SMARTS 전용 에어로졸 광학질량을 새로 추정하지 않는다.
function calculateAerosolOpticalMass(youngAirMass) {
  return youngAirMass;
}

// ---------------------------------------------------------------------------
// station pressure — Rayleigh 경로 전용
// ---------------------------------------------------------------------------

// calculation-notes.md 2.3. 이 값은 Rayleigh optical depth에만 쓴다 — Young air mass,
// ozone, aerosol 어디에도 넣지 않는다.
function calculateStationPressureHpa(altitudeM) {
  return STATION_PRESSURE_REFERENCE_HPA * Math.exp(-altitudeM / STATION_PRESSURE_SCALE_HEIGHT_M);
}

// ---------------------------------------------------------------------------
// 4.3 대기권 밖 분광 복사조도 — 역제곱 보정
// ---------------------------------------------------------------------------

// distanceAu는 이미 AU 단위이므로 km 변환을 중간에 넣지 않는다 (calculation-notes.md 4.3).
// 결과가 SMARTS SUNCOR 범위(0.966~1.034)를 벗어나면 WARNING을 함께 반환한다 — 강제 clamp하지 않는다.
function calculateInverseSquareFactor(distanceAu) {
  if (!isFiniteNumber(distanceAu) || distanceAu <= 0) {
    return {
      value: null,
      status: 'FAIL',
      message: `distanceAu가 유효한 양수가 아닙니다 (받은 값: ${distanceAu})`,
    };
  }
  const value = 1 / (distanceAu * distanceAu);
  const inRange = value >= INVERSE_SQUARE_FACTOR_RANGE[0] && value <= INVERSE_SQUARE_FACTOR_RANGE[1];
  return {
    value,
    status: inRange ? 'PASS' : 'WARNING',
    message: inRange
      ? null
      : `inverseSquareFactor(${value})가 SMARTS SUNCOR 범위 [${INVERSE_SQUARE_FACTOR_RANGE[0]}, ${INVERSE_SQUARE_FACTOR_RANGE[1]}]를 벗어났습니다.`,
  };
}

// ---------------------------------------------------------------------------
// 4.4 Rayleigh — Bodhaine et al. (1999) 표준기압 광학두께
// ---------------------------------------------------------------------------

// τ_R,0(λ). λ는 반드시 µm으로 변환해 대입한다 (calculation-notes.md 4.4, references.md 4.1).
// 이 함수 자체는 압력을 모른다 — 압력 보정은 calculateRayleighOpticalDepth()에서 1회만 한다.
function calculateRayleighOpticalDepthStandard(wavelengthNm) {
  const lambdaUm = wavelengthNm / 1000;
  const lambda2 = lambdaUm * lambdaUm;
  const lambdaInv2 = 1 / lambda2;
  const numerator = 1.0455996 - 341.29061 * lambdaInv2 - 0.9023085 * lambda2;
  const denominator = 1 + 0.0027059889 * lambdaInv2 - 85.968563 * lambda2;
  return 0.002152 * (numerator / denominator);
}

// τ_R(λ,p) = (p/1013.25) × τ_R,0(λ). 압력 보정은 여기서 딱 한 번.
// pressureRatio는 이 함수 안에서만 참조되는 지역 변수다 — ozone/aerosol에 넘기지 않는다
// (calculation-notes.md 4.4 "구현 지시").
function calculateRayleighOpticalDepth(wavelengthNm, pressureHpa) {
  const tau0 = calculateRayleighOpticalDepthStandard(wavelengthNm);
  const pressureRatio = pressureHpa / STATION_PRESSURE_REFERENCE_HPA;
  return tau0 * pressureRatio;
}

// T_R(λ) = exp[-τ_R(λ,p) × m]. m은 기압 미보정 상대 공기질량 (Young 1994).
function calculateRayleighTransmission(wavelengthNm, pressureHpa, youngAirMass) {
  const tauR = calculateRayleighOpticalDepth(wavelengthNm, pressureHpa);
  return Math.exp(-tauR * youngAirMass);
}

// ---------------------------------------------------------------------------
// 4.4 오존 투과율
// ---------------------------------------------------------------------------

// N_O3 = DU × 2.6867e16 [molecule cm^-2]. 기압 보정 없음 (이미 총 기둥량).
function calculateOzoneColumnMoleculesCm2(totalOzoneDu) {
  return totalOzoneDu * OZONE_DU_TO_MOLECULES_CM2;
}

// T_O3(λ) = exp[-σ_O3(λ) × N_O3 × m_O3]. sigmaO3Cm2는 cm^2 molecule^-1 단위,
// 호출자(실제 Serdyuchenko/Gorshelev 데이터)가 제공해야 한다. 기압 보정 없음.
function calculateOzoneTransmission(sigmaO3Cm2, ozoneColumnMoleculesCm2, ozoneAirMass) {
  return Math.exp(-sigmaO3Cm2 * ozoneColumnMoleculesCm2 * ozoneAirMass);
}

// ---------------------------------------------------------------------------
// 4.4 에어로졸 투과율
// ---------------------------------------------------------------------------

// τ_a(λ) = β × λ^-α, λ는 µm. 기압 보정 없음, β/α에 임의 보정 추가하지 않는다.
function calculateAerosolOpticalDepth(wavelengthNm, angstromBeta, angstromAlpha) {
  const lambdaUm = wavelengthNm / 1000;
  return angstromBeta * Math.pow(lambdaUm, -angstromAlpha);
}

// T_a(λ) = exp[-τ_a(λ) × m_a]. m_a = m (calculateAerosolOpticalMass의 결과).
function calculateAerosolTransmission(wavelengthNm, angstromBeta, angstromAlpha, aerosolAirMass) {
  const tauA = calculateAerosolOpticalDepth(wavelengthNm, angstromBeta, angstromAlpha);
  return Math.exp(-tauA * aerosolAirMass);
}

// ---------------------------------------------------------------------------
// 4.4 총 투과율 — clamp 금지, 물리적으로 벗어나면 오류로 탐지
// ---------------------------------------------------------------------------

function calculateTotalTransmission(rayleighT, ozoneT, aerosolT) {
  const total = rayleighT * ozoneT * aerosolT;
  if (!isFiniteNumber(total) || total < 0 || total > 1) {
    throw new SolarModelError(
      'totalTransmission이 물리적으로 유효한 범위(0~1)를 벗어났습니다. 조용히 clamp하지 않고 오류로 보고합니다.',
      [`totalTransmission=${total} (rayleighT=${rayleighT}, ozoneT=${ozoneT}, aerosolT=${aerosolT})`]
    );
  }
  return total;
}

// ---------------------------------------------------------------------------
// 4.3 / 4.5 / 4.6 — 복사량, actinic flux, photon flux
// ---------------------------------------------------------------------------

// E_0(λ,d) = E_0^AU(λ) × (1/distanceAu)²
function calculateExtraterrestrialIrradiance(e0AuWm2nm, inverseSquareFactor) {
  return e0AuWm2nm * inverseSquareFactor;
}

// E_dn(λ) = E_0(λ,d) × T(λ)
function calculateDirectNormalIrradiance(extraterrestrialIrradianceWm2nm, totalTransmission) {
  return extraterrestrialIrradianceWm2nm * totalTransmission;
}

// E_horiz(λ) = μ_0 × E_dn(λ). UI/diagnostics 전용 — Phase 3 핵심 출력(F_act,dir, q_dir)에는
// 절대 곱하지 않는다 (calculation-notes.md 4.5 "왜 μ_0을 곱하지 않는가").
function calculateHorizontalIrradiance(directNormalIrradianceWm2nm, mu0) {
  return mu0 * directNormalIrradianceWm2nm;
}

// q_dir(λ) = F_act,dir(λ) × λ/(hc) × 10^-4. λ는 m 단위로 변환해서 대입한다.
// F_act,dir = E_dn 이므로 directActinicFluxWm2nm 자리에 E_dn 값을 그대로 넣는다.
function calculatePhotonFlux(directActinicFluxWm2nm, wavelengthNm) {
  const wavelengthM = wavelengthNm * 1e-9;
  return (directActinicFluxWm2nm * wavelengthM) / (PLANCK_CONSTANT_J_S * SPEED_OF_LIGHT_M_S) * 1e-4;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

// Phase 3는 Phase 2의 ObservationConditions를 신뢰하되, solar-model.js가 astronomy-data.js
// 검증을 거치지 않은 객체로 직접 호출될 수도 있으므로(테스트 등) 방어적으로 재검증한다.
function validateObservationForSolarModel(observation) {
  const issues = [];
  const altitudeM = observation && observation.location ? observation.location.altitudeM : undefined;
  const altitudeGeometricDeg = observation && observation.sun ? observation.sun.altitudeGeometricDeg : undefined;
  const distanceAu = observation && observation.sun ? observation.sun.distanceAu : undefined;

  if (!isFiniteNumber(altitudeM) || altitudeM < LOCATION_ALTITUDE_RANGE_M[0] || altitudeM > LOCATION_ALTITUDE_RANGE_M[1]) {
    issues.push(`observation.location.altitudeM이 유효하지 않습니다 (받은 값: ${altitudeM})`);
  }
  if (!isFiniteNumber(altitudeGeometricDeg)) {
    issues.push(`observation.sun.altitudeGeometricDeg가 유효한 숫자가 아닙니다 (받은 값: ${altitudeGeometricDeg})`);
  }
  if (!isFiniteNumber(distanceAu) || distanceAu <= 0) {
    issues.push(`observation.sun.distanceAu가 유효한 양수가 아닙니다 (받은 값: ${distanceAu})`);
  }

  return { issues };
}

// atmosphere: { totalOzoneDu, angstromBeta, angstromAlpha, ozoneTemperatureK }
// ozoneTemperatureK의 실제 오존 데이터셋 호환성은 여기서 검증하지 않는다 — 그 데이터셋이
// 이 프로젝트에 없기 때문이다 (docs/solar-model.md "데이터 확보 상태" 참조). data.ozoneCrossSectionTemperatureK가
// 함께 전달되면 그 값과의 일치만 확인한다 (실제 데이터가 들어왔을 때를 대비한 방어적 검사).
function validateAtmosphereInput(atmosphere) {
  const issues = [];
  const totalOzoneDu = atmosphere ? atmosphere.totalOzoneDu : undefined;
  const angstromBeta = atmosphere ? atmosphere.angstromBeta : undefined;
  const angstromAlpha = atmosphere ? atmosphere.angstromAlpha : undefined;
  const ozoneTemperatureK = atmosphere ? atmosphere.ozoneTemperatureK : undefined;

  if (!isFiniteNumber(totalOzoneDu) || totalOzoneDu <= 0) {
    issues.push(`atmosphere.totalOzoneDu가 유효한 양수가 아닙니다 (받은 값: ${totalOzoneDu})`);
  }
  if (!isFiniteNumber(angstromBeta) || angstromBeta < 0) {
    issues.push(`atmosphere.angstromBeta가 유효한 0 이상의 숫자가 아닙니다 (받은 값: ${angstromBeta})`);
  }
  if (!isFiniteNumber(angstromAlpha)) {
    issues.push(`atmosphere.angstromAlpha가 유효한 숫자가 아닙니다 (받은 값: ${angstromAlpha})`);
  }
  if (!isFiniteNumber(ozoneTemperatureK)) {
    issues.push(`atmosphere.ozoneTemperatureK가 유효한 숫자가 아닙니다 (받은 값: ${ozoneTemperatureK})`);
  }

  return { issues };
}

// data: { extraterrestrialSpectrumWm2nm: number[111], ozoneCrossSectionCm2: number[111],
//         wavelengthGridNm?: number[111], ozoneCrossSectionTemperatureK?: number }
// 형태와 값의 유효성만 확인한다. 데이터의 과학적 정확성(진짜 ASTM G173/Serdyuchenko 값인지)은
// 호출자 책임이다 — 이 함수는 그 사실을 임의로 검증할 수 없다.
function validateSpectrumData(data, atmosphere) {
  const issues = [];
  const n = WAVELENGTH_GRID_NM.length;

  if (!data) {
    issues.push('data가 없습니다. extraterrestrialSpectrumWm2nm, ozoneCrossSectionCm2가 필요합니다.');
    return { issues };
  }

  if (data.wavelengthGridNm) {
    if (data.wavelengthGridNm.length !== n) {
      issues.push(`data.wavelengthGridNm 길이가 ${n}이 아닙니다 (받은 길이: ${data.wavelengthGridNm.length})`);
    } else {
      for (let i = 0; i < n; i += 1) {
        if (Math.abs(data.wavelengthGridNm[i] - WAVELENGTH_GRID_NM[i]) > 1e-9) {
          issues.push(`data.wavelengthGridNm[${i}]=${data.wavelengthGridNm[i]}가 내부 grid ${WAVELENGTH_GRID_NM[i]}와 다릅니다.`);
          break;
        }
      }
    }
  }

  const e0 = data.extraterrestrialSpectrumWm2nm;
  if (!Array.isArray(e0) || e0.length !== n) {
    issues.push(`data.extraterrestrialSpectrumWm2nm은 길이 ${n}의 배열이어야 합니다 (받은 길이: ${e0 ? e0.length : e0})`);
  } else if (e0.some((v) => !isFiniteNumber(v) || v <= 0)) {
    issues.push('data.extraterrestrialSpectrumWm2nm에 finite하지 않거나 양수가 아닌 값이 있습니다.');
  }

  const sigma = data.ozoneCrossSectionCm2;
  if (!Array.isArray(sigma) || sigma.length !== n) {
    issues.push(`data.ozoneCrossSectionCm2는 길이 ${n}의 배열이어야 합니다 (받은 길이: ${sigma ? sigma.length : sigma})`);
  } else if (sigma.some((v) => !isFiniteNumber(v) || v < 0)) {
    issues.push('data.ozoneCrossSectionCm2에 finite하지 않거나 음수인 값이 있습니다.');
  }

  if (
    atmosphere &&
    isFiniteNumber(data.ozoneCrossSectionTemperatureK) &&
    isFiniteNumber(atmosphere.ozoneTemperatureK) &&
    data.ozoneCrossSectionTemperatureK !== atmosphere.ozoneTemperatureK
  ) {
    issues.push(
      `atmosphere.ozoneTemperatureK(${atmosphere.ozoneTemperatureK})가 data.ozoneCrossSectionTemperatureK(${data.ozoneCrossSectionTemperatureK})와 일치하지 않습니다. 임의 보간·최근접 선택을 하지 않습니다.`
    );
  }

  return { issues };
}

// ---------------------------------------------------------------------------
// ASTM G173 derived data 연결
// ---------------------------------------------------------------------------

// astmG173Data: data/derived/solar-spectrum-astm-g173.json을 파싱한 객체
// ({ wavelengthNm: number[111], extraterrestrialIrradianceWm2Nm: number[111], metadata }).
// data/raw/astmg173.xls(원본, 미수정)에서 보간 없이 추출한 값이다 (docs/solar-model.md 참조).
// calculateSolarSpectrum()의 data 인자 중 extraterrestrialSpectrumWm2nm/wavelengthGridNm
// 자리에 그대로 꽂을 수 있는 형태로 변환한다. ozoneCrossSectionCm2는 아직 확보되지 않았으므로
// 여기 포함하지 않는다 — 호출자가 별도로 채워야 calculateSolarSpectrum()이 성공한다.
function buildExtraterrestrialSpectrumInput(astmG173Data) {
  if (!astmG173Data || !Array.isArray(astmG173Data.wavelengthNm) || !Array.isArray(astmG173Data.extraterrestrialIrradianceWm2Nm)) {
    throw new SolarModelError('ASTM G173 derived data 형식이 올바르지 않습니다.', [
      'wavelengthNm, extraterrestrialIrradianceWm2Nm 배열이 필요합니다.',
    ]);
  }
  return {
    wavelengthGridNm: astmG173Data.wavelengthNm.slice(),
    extraterrestrialSpectrumWm2nm: astmG173Data.extraterrestrialIrradianceWm2Nm.slice(),
  };
}

// ---------------------------------------------------------------------------
// ozone cross-section derived data 연결
// ---------------------------------------------------------------------------

// ozoneData: data/derived/ozone-cross-section-243k.json을 파싱한 객체
// ({ wavelengthNm: number[111], ozoneCrossSectionCm2: number[111], metadata: { temperatureK, ... } }).
// data/raw/SerdyuchenkoGorshelev5digits_latest.dat(원본, 미수정)에서 보간 없이 추출한 값이다
// (docs/solar-model.md 참조). calculateSolarSpectrum()의 data 인자 중
// ozoneCrossSectionCm2/wavelengthGridNm/ozoneCrossSectionTemperatureK 자리에 그대로 꽂을 수
// 있는 형태로 변환한다. atmosphere.ozoneTemperatureK와의 일치 여부는 validateSpectrumData()가
// 이미 검증한다 — 여기서는 metadata.temperatureK를 그대로 전달만 한다.
function buildOzoneCrossSectionInput(ozoneData) {
  if (!ozoneData || !Array.isArray(ozoneData.wavelengthNm) || !Array.isArray(ozoneData.ozoneCrossSectionCm2)) {
    throw new SolarModelError('ozone cross-section derived data 형식이 올바르지 않습니다.', [
      'wavelengthNm, ozoneCrossSectionCm2 배열이 필요합니다.',
    ]);
  }
  return {
    wavelengthGridNm: ozoneData.wavelengthNm.slice(),
    ozoneCrossSectionCm2: ozoneData.ozoneCrossSectionCm2.slice(),
    ozoneCrossSectionTemperatureK: ozoneData.metadata ? ozoneData.metadata.temperatureK : undefined,
  };
}

// astmG173Data: data/derived/solar-spectrum-astm-g173.json을 파싱한 객체.
// ozoneData: data/derived/ozone-cross-section-243k.json을 파싱한 객체.
// 두 실제 데이터를 calculateSolarSpectrum()의 단일 data 인자로 합친다 — 기존 정규화 함수를
// 다시 구현하지 않고 얇게 조합만 한다.
function buildSolarSpectrumData(astmG173Data, ozoneData) {
  const extraterrestrialInput = buildExtraterrestrialSpectrumInput(astmG173Data);
  const ozoneInput = buildOzoneCrossSectionInput(ozoneData);
  return Object.assign({}, extraterrestrialInput, ozoneInput);
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// observation: js/astronomy-data.js의 ObservationConditions.
// atmosphere: { totalOzoneDu, angstromBeta, angstromAlpha, ozoneTemperatureK } (기본값은
//   호출자가 명시하지 않으면 이 파일의 DEFAULT_* 상수를 쓴다 — calculation-notes.md 2.2).
// data: { extraterrestrialSpectrumWm2nm, ozoneCrossSectionCm2, wavelengthGridNm?,
//         ozoneCrossSectionTemperatureK? } — 실제 검증된 ASTM G173 Etr, Serdyuchenko/Gorshelev
//   σ_O3 데이터. 이 함수는 이 데이터를 생성하거나 내장하지 않는다.
function calculateSolarSpectrum(observation, atmosphere, data) {
  const resolvedAtmosphere = {
    totalOzoneDu: atmosphere && atmosphere.totalOzoneDu !== undefined ? atmosphere.totalOzoneDu : DEFAULT_TOTAL_OZONE_DU,
    angstromBeta: atmosphere && atmosphere.angstromBeta !== undefined ? atmosphere.angstromBeta : DEFAULT_ANGSTROM_BETA,
    angstromAlpha: atmosphere && atmosphere.angstromAlpha !== undefined ? atmosphere.angstromAlpha : DEFAULT_ANGSTROM_ALPHA,
    ozoneTemperatureK: atmosphere && atmosphere.ozoneTemperatureK !== undefined ? atmosphere.ozoneTemperatureK : DEFAULT_OZONE_TEMPERATURE_K,
  };

  const observationCheck = validateObservationForSolarModel(observation);
  const atmosphereCheck = validateAtmosphereInput(resolvedAtmosphere);
  const dataCheck = validateSpectrumData(data, resolvedAtmosphere);

  const allIssues = [...observationCheck.issues, ...atmosphereCheck.issues, ...dataCheck.issues];
  if (allIssues.length > 0) {
    throw new SolarModelError('Solar Model 입력이 유효하지 않습니다.', allIssues);
  }

  const geometry = calculateSolarGeometry(observation);
  const stationPressureHpa = calculateStationPressureHpa(observation.location.altitudeM);
  const inverseSquare = calculateInverseSquareFactor(observation.sun.distanceAu);
  if (inverseSquare.status === 'FAIL') {
    throw new SolarModelError('Earth-Sun distance 보정 계산에 실패했습니다.', [inverseSquare.message]);
  }

  const n = WAVELENGTH_GRID_NM.length;
  const extraterrestrialIrradiance = new Array(n).fill(0);
  const rayleighTransmission = new Array(n).fill(0);
  const ozoneTransmission = new Array(n).fill(0);
  const aerosolTransmission = new Array(n).fill(0);
  const totalTransmission = new Array(n).fill(0);
  const directNormalIrradiance = new Array(n).fill(0);
  const directActinicPhotonFlux = new Array(n).fill(0);

  let airMass = null;
  let ozoneAirMass = null;
  let aerosolAirMass = null;

  if (!geometry.sunBelowHorizon) {
    // Young air mass는 h_geom > 0(즉 true zenith < 90°)일 때만 계산한다 — 밤에 억지로
    // 적용해 이상값을 만들지 않는다 (calculation-notes.md 4.2, 작업 지시 8장).
    airMass = calculateYoungAirMass(geometry.solarZenithDeg);
    ozoneAirMass = calculateOzoneAirMass(geometry.solarZenithDeg, observation.location.altitudeM);
    aerosolAirMass = calculateAerosolOpticalMass(airMass);

    const ozoneColumnMoleculesCm2 = calculateOzoneColumnMoleculesCm2(resolvedAtmosphere.totalOzoneDu);

    for (let i = 0; i < n; i += 1) {
      const wavelengthNm = WAVELENGTH_GRID_NM[i];
      const e0 = data.extraterrestrialSpectrumWm2nm[i];
      const sigmaO3 = data.ozoneCrossSectionCm2[i];

      extraterrestrialIrradiance[i] = calculateExtraterrestrialIrradiance(e0, inverseSquare.value);
      rayleighTransmission[i] = calculateRayleighTransmission(wavelengthNm, stationPressureHpa, airMass);
      ozoneTransmission[i] = calculateOzoneTransmission(sigmaO3, ozoneColumnMoleculesCm2, ozoneAirMass);
      aerosolTransmission[i] = calculateAerosolTransmission(wavelengthNm, resolvedAtmosphere.angstromBeta, resolvedAtmosphere.angstromAlpha, aerosolAirMass);
      totalTransmission[i] = calculateTotalTransmission(rayleighTransmission[i], ozoneTransmission[i], aerosolTransmission[i]);
      directNormalIrradiance[i] = calculateDirectNormalIrradiance(extraterrestrialIrradiance[i], totalTransmission[i]);
      // F_act,dir(λ) = E_dn(λ) — μ_0을 곱하지 않는다 (calculation-notes.md 4.5).
      directActinicPhotonFlux[i] = calculatePhotonFlux(directNormalIrradiance[i], wavelengthNm);
    }
  }

  return {
    conditions: {
      solarAltitudeGeometricDeg: geometry.solarAltitudeGeometricDeg,
      solarZenithDeg: geometry.solarZenithDeg,
      mu0: geometry.mu0,
      airMass,
      ozoneAirMass,
      aerosolAirMass,
      stationPressureHpa,
      earthSunDistanceAu: observation.sun.distanceAu,
      inverseSquareFactor: inverseSquare.value,
      totalOzoneDu: resolvedAtmosphere.totalOzoneDu,
      angstromBeta: resolvedAtmosphere.angstromBeta,
      angstromAlpha: resolvedAtmosphere.angstromAlpha,
      ozoneTemperatureK: resolvedAtmosphere.ozoneTemperatureK,
    },
    spectrum: {
      wavelengthNm: WAVELENGTH_GRID_NM.slice(),
      extraterrestrialIrradiance,
      rayleighTransmission,
      ozoneTransmission,
      aerosolTransmission,
      totalTransmission,
      directNormalIrradiance,
      directActinicPhotonFlux,
    },
    diagnostics: {
      sunBelowHorizon: geometry.sunBelowHorizon,
      inverseSquareFactorCheck: {
        status: inverseSquare.status,
        value: inverseSquare.value,
        range: INVERSE_SQUARE_FACTOR_RANGE,
        message: inverseSquare.message,
      },
    },
  };
}
