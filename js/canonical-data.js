// canonical-data.js
// Phase 8B-2/8B-3/8B-4 — canonical data loading layer.
//
// Read-only: fetches and parses frozen canonical CSVs (Phase 8A ephemeris,
// Phase 6B solar spectra, Phase 7B compound/altitude response, and Phase 7G
// final table source CSVs). Performs no astronomical/photochemical
// calculation, no recomputation, no live Stellarium/JPL query, no
// interpolation, no curve fitting. Display formatting and chart/table
// rendering live in js/ui-shell.js and js/charts.js, not here — this module
// only loads, parses, selects rows by canonical keys, and validates the
// source of truth.

(function (global) {
  'use strict';

  var PHASE8A_CSV_PATH = 'data/derived/ephemeris/phase8a-solar-ephemeris-2026-08-13.csv';
  // q_dir(λ) direct-beam actinic photon flux, 13 conditions x 111 wavelengths
  // (290-400nm, 1nm step) — unit "photons cm^-2 s^-1 nm^-1" per this file's
  // own Phase 6B run metadata (data/derived/experiment/phase6b/phase6b-run-metadata-2026-08-13.json).
  var PHASE6B_SOLAR_SPECTRA_CSV_PATH = 'data/derived/experiment/phase6b/phase6b-solar-spectra-2026-08-13.csv';
  // R_abs(h) normalized photon absorption response, 13 conditions x 3 compounds,
  // paired with the same Stellarium geometric altitude already used by the
  // Phase 8A ephemeris binding (no separate altitude source introduced).
  var PHASE7B_COMPOUND_RESPONSE_CSV_PATH = 'data/derived/analysis/phase7/phase7b-compound-altitude-response-2026-08-13.csv';
  var PHASE7A_SOLAR_ALTITUDE_SUMMARY_CSV_PATH = 'data/derived/analysis/phase7/phase7a-solar-altitude-summary-2026-08-13.csv';
  var PHASE7C_SPECTRAL_CONTRIBUTION_SUMMARY_CSV_PATH = 'data/derived/analysis/phase7/phase7c-spectral-contribution-summary-2026-08-13.csv';

  var EXPECTED_CONDITION_IDS = [
    'ALT010', 'ALT015', 'ALT020', 'ALT025', 'ALT030', 'ALT035',
    'ALT040', 'ALT045', 'ALT050', 'ALT055', 'ALT060', 'ALT065', 'ALTMAX'
  ];

  var EXPECTED_COMPOUND_IDS = ['benzophenone', 'luteolin', 'quercetin'];
  var FINAL_TABLE_1_CONDITION_IDS = ['ALT010', 'ALT030', 'ALT050', 'ALTMAX'];
  var FINAL_TABLE_2_CONDITION_IDS = ['ALT010', 'ALTMAX'];

  // Minimal RFC4180-style CSV parser (quoted fields, embedded commas,
  // doubled-quote escaping). No external library.
  function parseCsv(text) {
    var rows = [];
    var row = [];
    var field = '';
    var inQuotes = false;
    var i = 0;
    var len = text.length;

    function pushField() {
      row.push(field);
      field = '';
    }
    function pushRow() {
      pushField();
      rows.push(row);
      row = [];
    }

    while (i < len) {
      var ch = text.charAt(i);

      if (inQuotes) {
        if (ch === '"') {
          if (text.charAt(i + 1) === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += ch;
        i += 1;
        continue;
      }

      if (ch === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }
      if (ch === ',') {
        pushField();
        i += 1;
        continue;
      }
      if (ch === '\r') {
        i += 1;
        continue;
      }
      if (ch === '\n') {
        pushRow();
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
    }
    if (field.length > 0 || row.length > 0) {
      pushRow();
    }
    return rows.filter(function (r) { return !(r.length === 1 && r[0] === ''); });
  }

  function rowsToObjects(rows) {
    if (!rows.length) return [];
    var header = rows[0];
    return rows.slice(1).map(function (cells) {
      var obj = {};
      header.forEach(function (key, idx) {
        obj[key] = cells[idx] !== undefined ? cells[idx] : '';
      });
      return obj;
    });
  }

  function isFiniteNumberString(value) {
    if (value === undefined || value === null || value === '') return false;
    var n = Number(value);
    return isFinite(n) && !isNaN(n);
  }

  function validateConditions(conditions) {
    var errors = [];

    if (conditions.length !== 13) {
      errors.push('Expected exactly 13 conditions, found ' + conditions.length + '.');
    }

    var seenIds = {};
    conditions.forEach(function (c) {
      if (seenIds[c.conditionId]) {
        errors.push('Duplicate conditionId: ' + c.conditionId);
      }
      seenIds[c.conditionId] = true;
    });

    EXPECTED_CONDITION_IDS.forEach(function (id) {
      if (!seenIds[id]) {
        errors.push('Missing expected conditionId: ' + id);
      }
    });

    conditions.forEach(function (c) {
      var label = c.conditionId || '(unknown row)';
      if (!c.localDateTimeKst) errors.push(label + ': missing localDateTimeKst');
      if (!c.utcDateTime) errors.push(label + ': missing utcDateTime');
      if (!isFiniteNumberString(c.stellariumAltitudeGeometricDeg)) errors.push(label + ': stellariumAltitudeGeometricDeg not finite');
      if (!isFiniteNumberString(c.ephemerisElevationAirlessDeg)) errors.push(label + ': ephemerisElevationAirlessDeg not finite');
      if (!isFiniteNumberString(c.stellariumAzimuthDeg)) errors.push(label + ': stellariumAzimuthDeg not finite');
      if (!isFiniteNumberString(c.stellariumDistanceAu)) errors.push(label + ': stellariumDistanceAu not finite');
      if (!isFiniteNumberString(c.latitudeDeg)) errors.push(label + ': latitudeDeg not finite');
      if (!isFiniteNumberString(c.longitudeDeg)) errors.push(label + ': longitudeDeg not finite');
      if (!c.source) errors.push(label + ': missing source metadata');
    });

    if (errors.length) {
      throw new Error('Canonical ephemeris validation failed:\n' + errors.join('\n'));
    }
  }

  function fetchCsv(path) {
    return fetch(path).then(function (response) {
      if (!response.ok) {
        throw new Error('Failed to fetch ' + path + ' (HTTP ' + response.status + ')');
      }
      return response.text();
    });
  }

  function freezeRows(rows) {
    return Object.freeze(rows.map(function (r) { return Object.freeze(r); }));
  }

  // Preserves CSV row order (ALT010 ... ALTMAX) rather than re-sorting.
  function loadPhase8AEphemeris() {
    return fetchCsv(PHASE8A_CSV_PATH).then(function (text) {
      var conditions = rowsToObjects(parseCsv(text));
      validateConditions(conditions);
      return freezeRows(conditions);
    });
  }

  function validateSolarSpectra(rows) {
    var errors = [];

    if (rows.length !== 13 * 111) {
      errors.push('Expected 13 x 111 = 1443 solar spectrum rows, found ' + rows.length + '.');
    }

    var countByCondition = {};
    var wavelengthsByCondition = {};
    rows.forEach(function (r) {
      var id = r.sampleId;
      countByCondition[id] = (countByCondition[id] || 0) + 1;
      wavelengthsByCondition[id] = wavelengthsByCondition[id] || {};
      wavelengthsByCondition[id][r.wavelengthNm] = true;
      if (!isFiniteNumberString(r.wavelengthNm)) errors.push(id + ': non-finite wavelengthNm ' + r.wavelengthNm);
      if (!isFiniteNumberString(r.qDir)) errors.push(id + ': non-finite qDir at ' + r.wavelengthNm + 'nm');
    });

    EXPECTED_CONDITION_IDS.forEach(function (id) {
      if (countByCondition[id] !== 111) {
        errors.push(id + ': expected 111 wavelength points, found ' + (countByCondition[id] || 0));
        return;
      }
      var wl = wavelengthsByCondition[id];
      if (!wl['290']) errors.push(id + ': missing 290nm boundary point');
      if (!wl['400']) errors.push(id + ': missing 400nm boundary point');
      for (var w = 290; w <= 400; w += 1) {
        if (!wl[String(w)]) errors.push(id + ': missing ' + w + 'nm sample (1nm grid not contiguous)');
      }
    });

    if (errors.length) {
      throw new Error('Canonical solar spectrum validation failed:\n' + errors.join('\n'));
    }
  }

  // Returns a flat, frozen array of {sampleId, wavelengthNm, qDir} row objects
  // (still strings — js/ui-shell.js / js/charts.js convert with Number() at
  // render time). Grouping by condition happens in the caller, not here.
  function loadPhase6BSolarSpectra() {
    return fetchCsv(PHASE6B_SOLAR_SPECTRA_CSV_PATH).then(function (text) {
      var rows = rowsToObjects(parseCsv(text));
      validateSolarSpectra(rows);
      return freezeRows(rows);
    });
  }

  function validateCompoundResponse(rows) {
    var errors = [];
    var expectedCount = EXPECTED_CONDITION_IDS.length * EXPECTED_COMPOUND_IDS.length;

    if (rows.length !== expectedCount) {
      errors.push('Expected ' + expectedCount + ' (13 conditions x 3 compounds) rows, found ' + rows.length + '.');
    }

    var seenPairs = {};
    rows.forEach(function (r) {
      var key = r.sampleId + '|' + r.compoundId;
      if (seenPairs[key]) errors.push('Duplicate condition/compound pair: ' + key);
      seenPairs[key] = true;

      if (EXPECTED_COMPOUND_IDS.indexOf(r.compoundId) === -1) {
        errors.push(r.sampleId + ': unexpected compoundId "' + r.compoundId + '"');
      }
      if (!isFiniteNumberString(r.altitudeGeometricDeg)) errors.push(key + ': non-finite altitudeGeometricDeg');
      if (!isFiniteNumberString(r.RAbs)) errors.push(key + ': non-finite RAbs');
    });

    EXPECTED_CONDITION_IDS.forEach(function (conditionId) {
      EXPECTED_COMPOUND_IDS.forEach(function (compoundId) {
        if (!seenPairs[conditionId + '|' + compoundId]) {
          errors.push('Missing row for ' + conditionId + ' / ' + compoundId);
        }
      });
    });

    if (errors.length) {
      throw new Error('Canonical compound/altitude response validation failed:\n' + errors.join('\n'));
    }
  }

  // Returns a flat, frozen array of {sampleId, altitudeGeometricDeg,
  // compoundId, kAbsDir, RAbs} row objects (39 rows: 13 conditions x 3
  // compounds).
  function loadPhase7CompoundResponse() {
    return fetchCsv(PHASE7B_COMPOUND_RESPONSE_CSV_PATH).then(function (text) {
      var rows = rowsToObjects(parseCsv(text));
      validateCompoundResponse(rows);
      return freezeRows(rows);
    });
  }

  function indexBy(rows, keyFn) {
    var index = {};
    rows.forEach(function (row) {
      index[keyFn(row)] = row;
    });
    return index;
  }

  function requireRow(index, key, context) {
    var row = index[key];
    if (!row) {
      throw new Error(context + ': missing canonical row for ' + key);
    }
    return row;
  }

  function validateSolarAltitudeSummary(rows) {
    var errors = [];

    if (rows.length !== EXPECTED_CONDITION_IDS.length) {
      errors.push('Expected ' + EXPECTED_CONDITION_IDS.length + ' solar altitude rows, found ' + rows.length + '.');
    }

    var seen = {};
    rows.forEach(function (r) {
      if (seen[r.sampleId]) errors.push('Duplicate solar altitude sampleId: ' + r.sampleId);
      seen[r.sampleId] = true;
      if (!isFiniteNumberString(r.altitudeGeometricDeg)) errors.push(r.sampleId + ': non-finite altitudeGeometricDeg');
      if (!isFiniteNumberString(r.qDirIntegrated290to400)) errors.push(r.sampleId + ': non-finite qDirIntegrated290to400');
    });

    EXPECTED_CONDITION_IDS.forEach(function (id) {
      if (!seen[id]) errors.push('Missing solar altitude row: ' + id);
    });

    if (errors.length) {
      throw new Error('Canonical solar altitude summary validation failed:\n' + errors.join('\n'));
    }
  }

  function loadPhase7SolarAltitudeSummary() {
    return fetchCsv(PHASE7A_SOLAR_ALTITUDE_SUMMARY_CSV_PATH).then(function (text) {
      var rows = rowsToObjects(parseCsv(text));
      validateSolarAltitudeSummary(rows);
      return freezeRows(rows);
    });
  }

  function validateSpectralContributionSummary(rows) {
    var errors = [];
    var expectedCount = EXPECTED_CONDITION_IDS.length * EXPECTED_COMPOUND_IDS.length;

    if (rows.length !== expectedCount) {
      errors.push('Expected ' + expectedCount + ' spectral contribution summary rows, found ' + rows.length + '.');
    }

    var seenPairs = {};
    rows.forEach(function (r) {
      var key = r.sampleId + '|' + r.compoundId;
      if (seenPairs[key]) errors.push('Duplicate spectral contribution summary pair: ' + key);
      seenPairs[key] = true;

      if (EXPECTED_COMPOUND_IDS.indexOf(r.compoundId) === -1) {
        errors.push(r.sampleId + ': unexpected compoundId "' + r.compoundId + '"');
      }
      if (!isFiniteNumberString(r.altitudeGeometricDeg)) errors.push(key + ': non-finite altitudeGeometricDeg');
      if (!isFiniteNumberString(r.contributionWeightedMeanWavelengthNm)) errors.push(key + ': non-finite contributionWeightedMeanWavelengthNm');
      if (!isFiniteNumberString(r.lambda50Nm)) errors.push(key + ': non-finite lambda50Nm');
      if (!isFiniteNumberString(r.peakContributionWavelengthNm)) errors.push(key + ': non-finite peakContributionWavelengthNm');
    });

    EXPECTED_CONDITION_IDS.forEach(function (conditionId) {
      EXPECTED_COMPOUND_IDS.forEach(function (compoundId) {
        if (!seenPairs[conditionId + '|' + compoundId]) {
          errors.push('Missing spectral contribution summary row for ' + conditionId + ' / ' + compoundId);
        }
      });
    });

    if (errors.length) {
      throw new Error('Canonical spectral contribution summary validation failed:\n' + errors.join('\n'));
    }
  }

  function loadPhase7SpectralContributionSummary() {
    return fetchCsv(PHASE7C_SPECTRAL_CONTRIBUTION_SUMMARY_CSV_PATH).then(function (text) {
      var rows = rowsToObjects(parseCsv(text));
      validateSpectralContributionSummary(rows);
      return freezeRows(rows);
    });
  }

  // Phase 7G Final Table 1: exact condition selection + key-based join from
  // frozen Phase 7A/7B CSV fields. No integrated-qDir/RAbs recomputation.
  function loadPhase7GFinalTable1() {
    return Promise.all([
      loadPhase7SolarAltitudeSummary(),
      loadPhase7CompoundResponse()
    ]).then(function (results) {
      var solarBySample = indexBy(results[0], function (r) { return r.sampleId; });
      var responseByPair = indexBy(results[1], function (r) { return r.sampleId + '|' + r.compoundId; });

      return Object.freeze(FINAL_TABLE_1_CONDITION_IDS.map(function (conditionId) {
        var solarRow = requireRow(solarBySample, conditionId, 'Phase 7G Final Table 1 solar source');
        var rAbsByCompound = {};

        EXPECTED_COMPOUND_IDS.forEach(function (compoundId) {
          var responseRow = requireRow(responseByPair, conditionId + '|' + compoundId, 'Phase 7G Final Table 1 RAbs source');
          rAbsByCompound[compoundId] = responseRow.RAbs;
        });

        return Object.freeze({
          sampleId: conditionId,
          altitudeGeometricDeg: solarRow.altitudeGeometricDeg,
          qDirIntegrated290to400: solarRow.qDirIntegrated290to400,
          rAbs: Object.freeze(rAbsByCompound)
        });
      }));
    });
  }

  // Phase 7G Final Table 2: exact condition/compound row selection from the
  // frozen Phase 7C summary. No weighted-mean/lambda50/peak derivation.
  function loadPhase7GFinalTable2() {
    return loadPhase7SpectralContributionSummary().then(function (rows) {
      var summaryByPair = indexBy(rows, function (r) { return r.sampleId + '|' + r.compoundId; });
      var selectedRows = [];

      FINAL_TABLE_2_CONDITION_IDS.forEach(function (conditionId) {
        EXPECTED_COMPOUND_IDS.forEach(function (compoundId) {
          var sourceRow = requireRow(summaryByPair, conditionId + '|' + compoundId, 'Phase 7G Final Table 2 source');
          selectedRows.push(Object.freeze({
            sampleId: conditionId,
            compoundId: compoundId,
            contributionWeightedMeanWavelengthNm: sourceRow.contributionWeightedMeanWavelengthNm,
            lambda50Nm: sourceRow.lambda50Nm,
            peakContributionWavelengthNm: sourceRow.peakContributionWavelengthNm
          }));
        });
      });

      return Object.freeze(selectedRows);
    });
  }

  global.SolarChemCanonicalData = {
    PHASE8A_CSV_PATH: PHASE8A_CSV_PATH,
    PHASE6B_SOLAR_SPECTRA_CSV_PATH: PHASE6B_SOLAR_SPECTRA_CSV_PATH,
    PHASE7B_COMPOUND_RESPONSE_CSV_PATH: PHASE7B_COMPOUND_RESPONSE_CSV_PATH,
    PHASE7A_SOLAR_ALTITUDE_SUMMARY_CSV_PATH: PHASE7A_SOLAR_ALTITUDE_SUMMARY_CSV_PATH,
    PHASE7C_SPECTRAL_CONTRIBUTION_SUMMARY_CSV_PATH: PHASE7C_SPECTRAL_CONTRIBUTION_SUMMARY_CSV_PATH,
    EXPECTED_CONDITION_IDS: EXPECTED_CONDITION_IDS,
    EXPECTED_COMPOUND_IDS: EXPECTED_COMPOUND_IDS,
    FINAL_TABLE_1_CONDITION_IDS: FINAL_TABLE_1_CONDITION_IDS,
    FINAL_TABLE_2_CONDITION_IDS: FINAL_TABLE_2_CONDITION_IDS,
    loadPhase8AEphemeris: loadPhase8AEphemeris,
    loadPhase6BSolarSpectra: loadPhase6BSolarSpectra,
    loadPhase7CompoundResponse: loadPhase7CompoundResponse,
    loadPhase7SolarAltitudeSummary: loadPhase7SolarAltitudeSummary,
    loadPhase7SpectralContributionSummary: loadPhase7SpectralContributionSummary,
    loadPhase7GFinalTable1: loadPhase7GFinalTable1,
    loadPhase7GFinalTable2: loadPhase7GFinalTable2
  };
})(window);
