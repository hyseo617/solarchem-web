// photochemistry.js
// Phase 4B — Photochemistry layer.
// Phase 3(js/solar-model.js)가 계산한 q_dir(λ,t)와 Phase 4A가 만든 화합물
// σ_c(λ) derived data(data/derived/compounds/*.json)를 결합해 spectral
// contribution r_abs(λ,t)와 k_abs,dir(t)를 계산한다. 식·단위는
// docs/calculation-notes.md §4.7~4.8, docs/phase4-chemical-model.md §5~6을
// 그대로 따른다. 새 계산 이론을 만들지 않는다.
//
// r_abs(λ,t) = σ_c(λ) · q_dir(λ,t)         단위: s^-1 nm^-1
// k_abs,dir(t) = Σ_{λ=290}^{400} r_abs(λ,t) · Δλ   단위: s^-1
//
// 해석: 광학적으로 얇은 조건에서, 모델 direct-beam photon field에 노출된 한
// 분자가 단위시간에 흡수하는 photon의 기댓값(model quantity)이다.
//
// 절대 다음으로 명명하지 않는다: photolysis rate, J value, degradation rate,
// reaction rate, half-life, SPF (docs/phase4-chemical-model.md §6 금지 목록).
//
// 이 파일은 fetch/네트워크 로딩과 분리되어 있다 — 이미 로드된 compound 객체와
// 이미 생성된 q_dir spectrum 객체를 받아 동작하므로 Node 테스트에서도 동일한
// 계산 core를 그대로 검증할 수 있다.
//
// interpolation, extrapolation, smoothing, normalization, clipping,
// negative→0 보정을 하지 않는다 — wavelength identity가 어긋나면 하드 실패한다.

const PHASE4B_GRID_START_NM = 290;
const PHASE4B_GRID_END_NM = 400;
const PHASE4B_GRID_STEP_NM = 1;
const PHASE4B_GRID_POINTS = 111;

// 290, 291, ..., 400 — 111점.
const PHASE4B_WAVELENGTH_GRID_NM = (() => {
  const grid = [];
  for (let nm = PHASE4B_GRID_START_NM; nm <= PHASE4B_GRID_END_NM; nm += PHASE4B_GRID_STEP_NM) {
    grid.push(nm);
  }
  return grid;
})();

const PHASE4B_SIGMA_UNIT = 'cm^2 molecule^-1';
const PHASE4B_Q_DIR_UNIT = 'photons cm^-2 s^-1 nm^-1';

// photochemistry.js 계층에서 발생하는 검증 오류. solar-model.js의
// SolarModelError, astronomy-data.js의 AstronomyDataError와 같은 패턴이다.
class PhotochemistryError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = 'PhotochemistryError';
    this.issues = issues || [];
  }
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// wavelengthNm 배열이 290..400nm, 1nm 간격, 정확히 111점인 고정 grid와
// index별로 완전히 일치하는지 확인한다. 배열 index만으로 정렬을 가정하지
// 않고 매 index에서 기대 파장과 직접 비교한다 — 이 방식이 point count 불일치,
// 결측 파장, 중복 파장, non-monotonic 파장을 모두 하나의 검사로 잡아낸다.
function validateWavelengthGrid(wavelengths, context, issues) {
  if (!Array.isArray(wavelengths) || wavelengths.length !== PHASE4B_GRID_POINTS) {
    issues.push(
      `${context} point count은 ${PHASE4B_GRID_POINTS}이어야 합니다 (받은 값: ${wavelengths ? wavelengths.length : wavelengths}).`
    );
    return;
  }

  let previous = null;
  wavelengths.forEach((wl, idx) => {
    if (!isFiniteNumber(wl)) {
      issues.push(`${context} wavelength[${idx}]이 유효한 finite 숫자가 아닙니다 (받은 값: ${wl}).`);
      return;
    }
    if (previous !== null && wl <= previous) {
      issues.push(`${context} wavelength가 단조 증가하지 않습니다 (index ${idx}: ${wl} <= ${previous}).`);
    }
    previous = wl;

    const expected = PHASE4B_WAVELENGTH_GRID_NM[idx];
    if (wl !== expected) {
      issues.push(`${context} wavelength[${idx}]은 ${expected} nm이어야 합니다 (받은 값: ${wl}).`);
    }
  });
}

// ---------------------------------------------------------------------------
// A. compound spectral data validation
// ---------------------------------------------------------------------------

// compound: data/derived/compounds/*.json을 파싱한 객체
// ({ compoundId, name, solvent, sigmaUnit, interpolation?, data: [{wavelengthNm, sigmaCm2Molecule}, ...] }).
// 이미 로드된 객체를 받는다 — 이 함수는 fetch/fs를 하지 않는다.
function validateCompoundSpectrum(compound) {
  if (!compound || typeof compound !== 'object') {
    throw new PhotochemistryError('compound spectrum이 객체가 아닙니다.', ['compound must be an object']);
  }

  const issues = [];
  const compoundId = compound.compoundId;
  if (typeof compoundId !== 'string' || compoundId.length === 0) {
    issues.push('compoundId가 비어있지 않은 문자열이어야 합니다.');
  }

  if (compound.sigmaUnit !== PHASE4B_SIGMA_UNIT) {
    issues.push(`sigmaUnit은 '${PHASE4B_SIGMA_UNIT}'이어야 합니다 (받은 값: ${compound.sigmaUnit}).`);
  }
  if (compound.interpolation !== undefined && compound.interpolation !== null && compound.interpolation !== 'none') {
    issues.push(`interpolation은 'none'이어야 합니다 (받은 값: ${compound.interpolation}).`);
  }

  if (!Array.isArray(compound.data)) {
    issues.push('compound.data는 배열이어야 합니다.');
    throw new PhotochemistryError(`compound spectrum(${compoundId || '<unknown>'}) 검증 실패`, issues);
  }

  const wavelengthNm = [];
  const sigmaCm2Molecule = [];
  compound.data.forEach((point, idx) => {
    if (!point || typeof point !== 'object') {
      issues.push(`data[${idx}]가 객체가 아닙니다.`);
      wavelengthNm.push(undefined);
      sigmaCm2Molecule.push(undefined);
      return;
    }
    const wl = point.wavelengthNm;
    const sigma = point.sigmaCm2Molecule;
    if (!isFiniteNumber(sigma)) {
      issues.push(`data[${idx}].sigmaCm2Molecule이 유효한 finite 숫자가 아닙니다 (받은 값: ${sigma}).`);
    } else if (sigma < 0) {
      issues.push(`data[${idx}].sigmaCm2Molecule이 음수입니다 (받은 값: ${sigma}).`);
    }
    wavelengthNm.push(wl);
    sigmaCm2Molecule.push(sigma);
  });

  validateWavelengthGrid(wavelengthNm, 'compound.data', issues);

  if (issues.length > 0) {
    throw new PhotochemistryError(`compound spectrum(${compoundId || '<unknown>'}) 검증 실패`, issues);
  }

  return {
    compoundId,
    name: compound.name,
    solvent: compound.solvent,
    wavelengthNm,
    sigmaCm2Molecule,
  };
}

// ---------------------------------------------------------------------------
// B. photon-flux spectrum validation
// ---------------------------------------------------------------------------

// qDirSpectrum: Phase 3 calculateSolarSpectrum()의 result.spectrum과 동일한 필드명
// ({ wavelengthNm: number[111], directActinicPhotonFlux: number[111], unit? }).
// 필드명을 그대로 받는다 — Phase 3 output을 별도 adapter 없이 바로 사용할 수 있게
// 하기 위함이다(js/solar-model.js의 spectrum.directActinicPhotonFlux는 이미
// photons cm^-2 s^-1 nm^-1 단위다).
function validatePhotonFluxSpectrum(qDirSpectrum) {
  if (!qDirSpectrum || typeof qDirSpectrum !== 'object') {
    throw new PhotochemistryError('q_dir spectrum이 객체가 아닙니다.', ['q_dir spectrum must be an object']);
  }

  const issues = [];
  if (qDirSpectrum.unit !== undefined && qDirSpectrum.unit !== null && qDirSpectrum.unit !== PHASE4B_Q_DIR_UNIT) {
    issues.push(`q_dir unit은 '${PHASE4B_Q_DIR_UNIT}'이어야 합니다 (받은 값: ${qDirSpectrum.unit}).`);
  }

  const wavelengthNm = qDirSpectrum.wavelengthNm;
  const qValues = qDirSpectrum.directActinicPhotonFlux;

  if (!Array.isArray(wavelengthNm)) {
    issues.push('q_dir spectrum.wavelengthNm은 배열이어야 합니다.');
  }
  if (!Array.isArray(qValues)) {
    issues.push('q_dir spectrum.directActinicPhotonFlux는 배열이어야 합니다.');
  }
  if (issues.length > 0) {
    throw new PhotochemistryError('q_dir spectrum 검증 실패', issues);
  }
  if (wavelengthNm.length !== qValues.length) {
    issues.push(`wavelengthNm 길이(${wavelengthNm.length})와 directActinicPhotonFlux 길이(${qValues.length})가 다릅니다.`);
    throw new PhotochemistryError('q_dir spectrum 검증 실패', issues);
  }

  validateWavelengthGrid(wavelengthNm, 'q_dir', issues);

  const validatedQ = [];
  qValues.forEach((q, idx) => {
    if (!isFiniteNumber(q)) {
      issues.push(`q_dir[${idx}]이 유효한 finite 숫자가 아닙니다 (받은 값: ${q}).`);
    } else if (q < 0) {
      issues.push(`q_dir[${idx}]이 음수입니다 (받은 값: ${q}).`);
    }
    validatedQ.push(q);
  });

  if (issues.length > 0) {
    throw new PhotochemistryError('q_dir spectrum 검증 실패', issues);
  }

  return {
    wavelengthNm: wavelengthNm.slice(),
    directActinicPhotonFlux: validatedQ,
  };
}

// ---------------------------------------------------------------------------
// C. wavelength alignment validation
// ---------------------------------------------------------------------------

// compound와 q_dir 모두 이미 검증된(validateCompoundSpectrum/validatePhotonFluxSpectrum을
// 거친) spectrum 객체를 받는다. 배열 index만으로 정렬을 가정하지 않고 각 point에서
// compound wavelength === q_dir wavelength를 확인한다.
function validateWavelengthAlignment(compoundSpectrum, photonFluxSpectrum) {
  const a = compoundSpectrum.wavelengthNm;
  const b = photonFluxSpectrum.wavelengthNm;
  if (a.length !== b.length) {
    throw new PhotochemistryError('compound/q_dir wavelength grid 길이가 다릅니다.', [`compound=${a.length} q_dir=${b.length}`]);
  }

  const issues = [];
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      issues.push(`index ${i}: compound=${a[i]} nm, q_dir=${b[i]} nm`);
    }
  }
  if (issues.length > 0) {
    throw new PhotochemistryError('compound/q_dir wavelength mismatch', issues);
  }
}

// ---------------------------------------------------------------------------
// D. spectral contribution calculation
// ---------------------------------------------------------------------------

// r_abs(λ,t) = σ_c(λ) · q_dir(λ,t) — 단위 s^-1 nm^-1.
// compound/qDirSpectrum은 아직 검증되지 않은 원본 객체를 받아도 된다(내부에서
// validateCompoundSpectrum/validatePhotonFluxSpectrum/validateWavelengthAlignment를
// 순서대로 호출한다).
function computeSpectralAbsorption(compound, qDirSpectrum) {
  const compoundSpectrum = validateCompoundSpectrum(compound);
  const photonFluxSpectrum = validatePhotonFluxSpectrum(qDirSpectrum);
  validateWavelengthAlignment(compoundSpectrum, photonFluxSpectrum);

  return compoundSpectrum.wavelengthNm.map((wavelengthNm, idx) => {
    const sigmaCm2Molecule = compoundSpectrum.sigmaCm2Molecule[idx];
    const qDirPhotonsCm2SNm = photonFluxSpectrum.directActinicPhotonFlux[idx];
    const absorptionRateS1Nm1 = sigmaCm2Molecule * qDirPhotonsCm2SNm;
    if (!isFiniteNumber(absorptionRateS1Nm1) || absorptionRateS1Nm1 < 0) {
      throw new PhotochemistryError(`r_abs(${wavelengthNm} nm) 계산 결과가 유효하지 않습니다.`, [`value=${absorptionRateS1Nm1}`]);
    }
    return { wavelengthNm, sigmaCm2Molecule, qDirPhotonsCm2SNm, absorptionRateS1Nm1 };
  });
}

// ---------------------------------------------------------------------------
// E. total k_abs_dir calculation
// ---------------------------------------------------------------------------

// k_abs,dir(t) = Σ σ_c(λ)·q_dir(λ,t)·Δλ — 단위 s^-1. spectralAbsorption은
// computeSpectralAbsorption()의 반환값(111점, wavelengthNm 오름차순)이어야 한다.
//
// summation 전략: 111개의 nonnegative term을 합산한다. Codex Python 독립 오라클
// (math.fsum)과 대조한 결과 일반 순차합(plain sum)과 fsum 사이에 오차가 없었다
// (reports/validation/phase4b-integration-validation.md 참조). 따라서 Kahan/보정
// 합산을 도입하지 않고 일반 reduce 순차합을 쓴다. 중간에 rounding하지 않는다.
function computeDirectPhotonAbsorptionRate(spectralAbsorption, deltaNm) {
  const delta = deltaNm === undefined ? PHASE4B_GRID_STEP_NM : deltaNm;
  if (!isFiniteNumber(delta) || delta !== PHASE4B_GRID_STEP_NM) {
    throw new PhotochemistryError(`deltaNm은 ${PHASE4B_GRID_STEP_NM}이어야 합니다 (받은 값: ${deltaNm}).`, []);
  }
  if (!Array.isArray(spectralAbsorption) || spectralAbsorption.length !== PHASE4B_GRID_POINTS) {
    throw new PhotochemistryError(
      `spectralAbsorption point count은 ${PHASE4B_GRID_POINTS}이어야 합니다.`,
      [`받은 길이: ${spectralAbsorption ? spectralAbsorption.length : spectralAbsorption}`]
    );
  }

  return spectralAbsorption.reduce((sum, point, idx) => {
    const rate = point ? point.absorptionRateS1Nm1 : undefined;
    if (!isFiniteNumber(rate) || rate < 0) {
      throw new PhotochemistryError(`spectralAbsorption[${idx}].absorptionRateS1Nm1이 유효하지 않습니다.`, [`value=${rate}`]);
    }
    return sum + rate * delta;
  }, 0);
}
