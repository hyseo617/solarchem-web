// live-integration.js
// Phase 8B-6 Step 2 — Live Stellarium integration orchestration.
//
// Connects the already-validated scientific layers (js/stellarium-api.js,
// js/astronomy-data.js, js/solar-model.js, js/photochemistry.js) to the
// production UI. This file adds no new scientific calculation — every
// number here comes from calling those modules' existing exported
// functions with real inputs. It owns exactly one thing: the live/canonical
// mode lifecycle and the single explicit state object described in
// docs (mode, connection, observation, solarSpectrum, molecular,
// selectedConditionMatch, lastUpdated, error).
//
// Dependency injection: createLiveIntegration(deps) accepts the scientific
// functions as an object so this module can be exercised in Node tests
// (via the same vm-sandbox export-shim pattern already used by
// tests/phase4b-photochemistry-test.js) without a browser or a running
// Stellarium. Production wiring below calls createLiveIntegration() with
// no args, which falls back to the real global functions attached to
// `window` by the classic (non-module) scientific <script> tags.
//
// RAbs is intentionally NOT computed here (docs §17/§19 — no live ALTMAX
// denominator pipeline exists yet in this step). Only k_abs,dir per
// compound is exposed as the live molecular result.

(function (global) {
  'use strict';

  // Fixed physical parameters — identical to the values already used to
  // generate the frozen Phase 6B canonical dataset
  // (data/derived/experiment/phase6b/phase6b-run-metadata-2026-08-13.json
  // "fixedPhysicalParameters"), and identical to js/solar-model.js's own
  // DEFAULT_* constants. Not a new arbitrary value — restated here so the
  // live pipeline's atmosphere input is explicit and auditable rather than
  // relying on solar-model.js's implicit defaults.
  var LIVE_ATMOSPHERE = Object.freeze({
    totalOzoneDu: 300,
    angstromBeta: 0.10,
    angstromAlpha: 1.3,
    ozoneTemperatureK: 243
  });

  // Tolerance used only to decide whether a live ObservationConditions
  // snapshot corresponds to one of the 13 frozen Phase 8A canonical rows
  // (docs §24). Looser than the Stellarium/JPL Horizons internal
  // cross-check tolerance in the Phase 8A CSV itself (~1e-3 deg / ~1e-6 AU)
  // because this comparison also has to absorb one extra live HTTP
  // round-trip's worth of clock/float drift, not just two ephemeris
  // sources computed from the same instant.
  var CANONICAL_MATCH_TOLERANCE = Object.freeze({
    altitudeDeg: 0.01,
    distanceAu: 1e-4,
    locationDeg: 0.01,
    timeMs: 2000
  });

  var STELLARIUM_SET_VERIFY_MAX_ATTEMPTS = 5;
  var STELLARIUM_SET_VERIFY_INTERVAL_MS = 300;

  var COMPOUND_IDS = ['benzophenone', 'luteolin', 'quercetin'];
  var COMPOUND_FILES = Object.freeze({
    benzophenone: 'data/derived/compounds/benzophenone-290-400nm.json',
    luteolin: 'data/derived/compounds/luteolin-290-400nm.json',
    quercetin: 'data/derived/compounds/quercetin-290-400nm.json'
  });
  var ASTM_G173_PATH = 'data/derived/solar-spectrum-astm-g173.json';
  var OZONE_CROSS_SECTION_PATH = 'data/derived/ozone-cross-section-243k.json';

  function defaultFetchJson(path) {
    return fetch(path).then(function (response) {
      if (!response.ok) {
        throw new Error('Failed to fetch ' + path + ' (HTTP ' + response.status + ')');
      }
      return response.json();
    });
  }

  function initialState() {
    return {
      mode: 'canonical',
      connection: 'unknown',
      observation: null,
      solarSpectrum: null,
      molecular: null,
      selectedConditionMatch: null,
      locationDisplay: null,
      lastUpdated: null,
      error: null
    };
  }

  // Display-only metadata straight from Stellarium's own /api/main/status
  // response — never inferred, never guessed. Kept entirely separate from
  // ObservationConditions.time.timeZone (which js/astronomy-data.js's
  // normalizeTime() deliberately leaves null for calculation-facing code,
  // see docs/astronomy-data.md 5/7) since this is for on-screen display
  // only and never feeds any scientific computation. Each field is null
  // when Stellarium's response doesn't include it, so the UI can show a
  // truthful "unavailable" message instead of a fabricated value.
  function extractLocationDisplay(observationConditionsResult) {
    var status = observationConditionsResult && observationConditionsResult.diagnostics && observationConditionsResult.diagnostics.raw
      ? observationConditionsResult.diagnostics.raw.status
      : null;
    var loc = status && status.location;
    var time = status && status.time;
    return {
      name: loc && typeof loc.name === 'string' && loc.name.trim() !== '' ? loc.name : null,
      timeZone: time && typeof time.timeZone === 'string' && time.timeZone.trim() !== '' ? time.timeZone : null,
      local: time && typeof time.local === 'string' && time.local.trim() !== '' ? time.local : null
    };
  }

  // deps: optional overrides for every external call this module makes.
  // Production omits deps entirely; tests inject mocks/sandboxed functions.
  function createLiveIntegration(deps) {
    deps = deps || {};

    var api = {
      checkConnection: deps.checkConnection || global.checkConnection,
      getObservationConditions: deps.getObservationConditions || global.getObservationConditions,
      setLocation: deps.setLocation || global.setLocation,
      setDateTime: deps.setDateTime || global.setDateTime,
      buildSolarSpectrumData: deps.buildSolarSpectrumData || global.buildSolarSpectrumData,
      calculateSolarSpectrum: deps.calculateSolarSpectrum || global.calculateSolarSpectrum,
      computeSpectralAbsorption: deps.computeSpectralAbsorption || global.computeSpectralAbsorption,
      computeDirectPhotonAbsorptionRate: deps.computeDirectPhotonAbsorptionRate || global.computeDirectPhotonAbsorptionRate,
      fetchJson: deps.fetchJson || defaultFetchJson,
      loadPhase8AEphemeris: deps.loadPhase8AEphemeris || function () {
        return global.SolarChemCanonicalData.loadPhase8AEphemeris();
      }
    };

    var state = initialState();
    var listeners = [];
    var requestGeneration = 0;
    var referenceDataPromise = null;

    function subscribe(callback) {
      listeners.push(callback);
    }

    function emit() {
      var snapshot = Object.freeze(Object.assign({}, state));
      listeners.forEach(function (callback) {
        callback(snapshot);
      });
    }

    function setState(patch) {
      state = Object.assign({}, state, patch);
      emit();
    }

    // Step 3B fix: the UI shows one short, non-technical message
    // ("Stellarium unavailable") regardless of error kind — it never
    // concatenates a second copy of that same phrase, and never surfaces
    // raw error/network detail to the page. The full detail (kind +
    // underlying message) still goes to the console for anyone debugging.
    function logError(kind, message) {
      if (typeof console !== 'undefined' && console.error) {
        console.error('[live-integration] ' + kind + ': ' + message);
      }
    }

    function loadReferenceData() {
      if (referenceDataPromise) return referenceDataPromise;
      referenceDataPromise = Promise.all([
        api.fetchJson(ASTM_G173_PATH),
        api.fetchJson(OZONE_CROSS_SECTION_PATH),
        api.fetchJson(COMPOUND_FILES.benzophenone),
        api.fetchJson(COMPOUND_FILES.luteolin),
        api.fetchJson(COMPOUND_FILES.quercetin)
      ]).then(function (results) {
        return {
          spectrumData: api.buildSolarSpectrumData(results[0], results[1]),
          compounds: {
            benzophenone: results[2],
            luteolin: results[3],
            quercetin: results[4]
          }
        };
      }).catch(function (err) {
        referenceDataPromise = null; // allow retry on next sync() rather than caching a failure forever
        throw err;
      });
      return referenceDataPromise;
    }

    // observation -> { spectrumResult, molecular } — pure combination of
    // Phase 3 (solar-model.js) and Phase 4B (photochemistry.js) outputs.
    // No RAbs here (docs §17/§19).
    function computeLiveResult(observation, referenceData) {
      var spectrumResult = api.calculateSolarSpectrum(observation, LIVE_ATMOSPHERE, referenceData.spectrumData);
      var qDirSpectrum = {
        wavelengthNm: spectrumResult.spectrum.wavelengthNm,
        directActinicPhotonFlux: spectrumResult.spectrum.directActinicPhotonFlux
      };

      var molecular = {};
      COMPOUND_IDS.forEach(function (compoundId) {
        var spectralAbsorption = api.computeSpectralAbsorption(referenceData.compounds[compoundId], qDirSpectrum);
        var kAbsDir = api.computeDirectPhotonAbsorptionRate(spectralAbsorption);
        molecular[compoundId] = { kAbsDir: kAbsDir, spectralAbsorption: spectralAbsorption };
      });

      return { spectrumResult: spectrumResult, molecular: molecular };
    }

    // Returns a canonical conditionId string if `observation` matches one of
    // the 13 frozen Phase 8A rows within CANONICAL_MATCH_TOLERANCE, else null.
    // Never widens the tolerance to force a match (docs §24).
    function matchCanonicalCondition(observation) {
      return api.loadPhase8AEphemeris().then(function (rows) {
        for (var i = 0; i < rows.length; i += 1) {
          var row = rows[i];
          var altDiff = Math.abs(Number(row.stellariumAltitudeGeometricDeg) - observation.sun.altitudeGeometricDeg);
          var distDiff = Math.abs(Number(row.stellariumDistanceAu) - observation.sun.distanceAu);
          var latDiff = Math.abs(Number(row.latitudeDeg) - observation.location.latitudeDeg);
          var lonDiff = Math.abs(Number(row.longitudeDeg) - observation.location.longitudeDeg);
          var timeDiff = Math.abs(new Date(row.utcDateTime).getTime() - new Date(observation.time.utcIso).getTime());
          if (
            altDiff <= CANONICAL_MATCH_TOLERANCE.altitudeDeg &&
            distDiff <= CANONICAL_MATCH_TOLERANCE.distanceAu &&
            latDiff <= CANONICAL_MATCH_TOLERANCE.locationDeg &&
            lonDiff <= CANONICAL_MATCH_TOLERANCE.locationDeg &&
            timeDiff <= CANONICAL_MATCH_TOLERANCE.timeMs
          ) {
            return row.conditionId;
          }
        }
        return null;
      }).catch(function () {
        return null; // matching is best-effort UI context, never blocks the live result itself
      });
    }

    // Runs the full pipeline (connection check -> ObservationConditions ->
    // reference data -> solar model -> photochemistry -> canonical match)
    // and commits to `state` only if every step succeeds (docs §10 — no
    // partial live state is ever exposed to the UI).
    function sync() {
      var myGeneration = ++requestGeneration;
      setState({ connection: 'connecting', error: null });

      return api.checkConnection().then(function (connResult) {
        if (myGeneration !== requestGeneration) return;
        if (!connResult.connected) {
          logError('connection', 'checkConnection() reported not connected');
          setState(Object.assign(initialState(), {
            connection: 'error',
            error: { kind: 'connection', message: 'Stellarium unavailable' }
          }));
          return;
        }

        return Promise.all([api.getObservationConditions(), loadReferenceData()]).then(function (results) {
          if (myGeneration !== requestGeneration) return;
          var observation = results[0].observation;
          var referenceData = results[1];
          var computed = computeLiveResult(observation, referenceData);
          var locationDisplay = extractLocationDisplay(results[0]);

          return matchCanonicalCondition(observation).then(function (conditionMatch) {
            if (myGeneration !== requestGeneration) return;
            setState({
              mode: 'live',
              connection: 'connected',
              observation: observation,
              solarSpectrum: {
                wavelengthNm: computed.spectrumResult.spectrum.wavelengthNm,
                directActinicPhotonFlux: computed.spectrumResult.spectrum.directActinicPhotonFlux
              },
              molecular: computed.molecular,
              selectedConditionMatch: conditionMatch || 'custom',
              locationDisplay: locationDisplay,
              lastUpdated: Date.now(),
              error: null
            });
          });
        });
      }).catch(function (err) {
        if (myGeneration !== requestGeneration) return;
        var detail = err && err.message ? err.message : String(err);
        logError('sync', detail);
        setState({
          connection: 'error',
          error: { kind: 'sync', message: 'Stellarium unavailable' },
          lastUpdated: Date.now()
        });
      });
    }

    // Bounded retry: re-reads ObservationConditions until it converges on
    // the requested canonical row's location/time, or gives up. Never polls
    // indefinitely (docs §21).
    function verifyConditionApplied(targetRow) {
      function attempt(remaining) {
        return api.getObservationConditions().then(function (result) {
          var obs = result.observation;
          var latOk = Math.abs(obs.location.latitudeDeg - Number(targetRow.latitudeDeg)) <= CANONICAL_MATCH_TOLERANCE.locationDeg;
          var lonOk = Math.abs(obs.location.longitudeDeg - Number(targetRow.longitudeDeg)) <= CANONICAL_MATCH_TOLERANCE.locationDeg;
          var timeOk = Math.abs(new Date(obs.time.utcIso).getTime() - new Date(targetRow.utcDateTime).getTime()) <= CANONICAL_MATCH_TOLERANCE.timeMs;
          if (latOk && lonOk && timeOk) return obs;
          if (remaining <= 0) {
            throw new Error('Stellarium did not converge to the requested condition within the retry budget');
          }
          return new Promise(function (resolve) {
            setTimeout(resolve, STELLARIUM_SET_VERIFY_INTERVAL_MS);
          }).then(function () {
            return attempt(remaining - 1);
          });
        });
      }
      return attempt(STELLARIUM_SET_VERIFY_MAX_ATTEMPTS - 1);
    }

    // canonicalRow: the exact object ui-shell.js's onConditionChange already
    // passes (a Phase 8A CSV row) — location/date/time are read from it, not
    // re-typed here (docs §20).
    function setLocationAndTimeForCondition(canonicalRow) {
      var localMatch = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(canonicalRow.localDateTimeKst || '');
      if (!localMatch) {
        return Promise.reject(new Error('canonical row is missing a parseable localDateTimeKst'));
      }
      var date = localMatch[1];
      var time = localMatch[2];

      return api.setLocation({
        latitude: Number(canonicalRow.latitudeDeg),
        longitude: Number(canonicalRow.longitudeDeg),
        altitude: Number(canonicalRow.observerAltitudeM)
      }).then(function (locationResult) {
        if (!locationResult.ok) {
          throw new Error('Stellarium setLocation did not confirm ok');
        }
        return api.setDateTime(date, time, 'UTC+09:00');
      }).then(function (timeResult) {
        if (!timeResult.ok) {
          throw new Error('Stellarium setDateTime did not confirm ok');
        }
        return verifyConditionApplied(canonicalRow);
      });
    }

    // Called from ui-shell.js's existing onConditionChange subscription
    // (docs §4/§18 — reuses the one selection state, never adds a second).
    // A no-op in canonical mode: canonical altitude selection already works
    // without touching Stellarium.
    function syncToCondition(canonicalRow) {
      if (state.mode !== 'live') return Promise.resolve();

      var myGeneration = ++requestGeneration;
      setState({ connection: 'connecting', error: null });

      return setLocationAndTimeForCondition(canonicalRow).then(function () {
        if (myGeneration !== requestGeneration) return;
        return sync();
      }).catch(function (err) {
        if (myGeneration !== requestGeneration) return;
        var detail = err && err.message ? err.message : String(err);
        logError('stellarium-set', detail);
        setState({
          connection: 'error',
          error: { kind: 'stellarium-set', message: 'Stellarium unavailable' },
          lastUpdated: Date.now()
        });
      });
    }

    // Explicit return path to frozen canonical mode (docs §13). Invalidates
    // any in-flight sync/syncToCondition so a late response can't silently
    // re-enable live mode after the user opted out of it.
    function enterCanonicalMode() {
      requestGeneration += 1;
      setState(Object.assign(initialState(), { connection: 'unknown' }));
    }

    function getState() {
      return Object.freeze(Object.assign({}, state));
    }

    return {
      sync: sync,
      syncToCondition: syncToCondition,
      enterCanonicalMode: enterCanonicalMode,
      subscribe: subscribe,
      getState: getState,
      __internal: {
        LIVE_ATMOSPHERE: LIVE_ATMOSPHERE,
        CANONICAL_MATCH_TOLERANCE: CANONICAL_MATCH_TOLERANCE,
        computeLiveResult: computeLiveResult,
        matchCanonicalCondition: matchCanonicalCondition
      }
    };
  }

  global.SolarChemLiveIntegration = {
    create: createLiveIntegration
  };

  // ---------------------------------------------------------------
  // Production DOM wiring. Skipped in non-browser environments (Node
  // tests load this file for createLiveIntegration only) and left inert
  // if the expected UI hooks are missing — never throws, never blocks
  // canonical mode (docs §5/§25).
  // ---------------------------------------------------------------

  if (typeof document === 'undefined') {
    return;
  }

  document.addEventListener('DOMContentLoaded', function () {
    var statusEl = document.querySelector('[data-live-status]');
    var connectButton = document.querySelector('[data-live-connect]');
    var returnButton = document.querySelector('[data-live-return]');
    var sourceValueEl = document.querySelector('[data-live-source]');
    var messageEl = document.querySelector('[data-live-message]');
    var provenanceEl = document.querySelector('[data-chart-provenance="solar-spectrum"]');
    var molecularStatusEl = document.querySelector('[data-live-molecular]');
    var molecularAltEl = document.querySelector('[data-live-molecular-altitude]');
    var spectrumContainer = document.getElementById('chart-solar-spectrum');
    var kAbsEls = {};
    document.querySelectorAll('[data-live-kabs]').forEach(function (el) {
      kAbsEls[el.getAttribute('data-live-kabs')] = el;
    });

    if (!statusEl || !connectButton || !sourceValueEl || !messageEl) {
      return; // required hooks missing — stay silently in canonical mode
    }

    var REFERENCE_PROVENANCE_TEXT = 'Reference dataset';
    var live = createLiveIntegration();

    // Step 3 real-E2E fix: restoreCanonicalSpectrumChart() (below) restores
    // the frozen curve by calling ui-shell.js's notifyConditionChange() for
    // the currently selected condition — the exact same pub/sub this
    // subscriber listens on. Without this guard, any render() that isn't
    // "live connected" (e.g. the 'connecting' state sync()/syncToCondition()
    // itself sets at the very start of every attempt) calls
    // restoreCanonicalSpectrumChart() -> notifyConditionChange() ->
    // this subscriber -> syncToCondition() -> setState('connecting') ->
    // render() -> restoreCanonicalSpectrumChart() ... synchronously forever
    // (discovered via real Stellarium E2E testing — Uncaught RangeError:
    // Maximum call stack size exceeded). The flag distinguishes "this
    // notification came from our own canonical restore" from "this
    // notification is a genuine ALT-button click".
    var isRestoringCanonicalSpectrum = false;
    if (global.SolarChemUIShell && typeof global.SolarChemUIShell.onConditionChange === 'function') {
      // Phase 9H-D fix: a real Windows E2E run found that clicking an
      // Ephemeris row (a read-only reference/comparison table) while live
      // silently overwrote the user's actual Stellarium condition, because
      // every selectCondition() call - regardless of source - reached this
      // same subscriber and unconditionally called syncToCondition(),
      // which writes location/time to Stellarium. options.allowStellariumSync
      // is only true for the Experiment section's own ALT010-ALTMAX
      // buttons (js/ui-shell.js's selectCondition() doc comment) - the one
      // control whose whole purpose is changing the Stellarium condition.
      // For every other (passive/browsing) selection while live, no
      // Stellarium write happens; instead the true live state is
      // immediately re-rendered so the shared Experiment fields - just
      // overwritten with that row's REFERENCE data by the same
      // selectCondition() call - never keep silently showing reference
      // values as if they were the live condition (see
      // reports/validation/phase9h-d-live-state-ownership-validation.md).
      global.SolarChemUIShell.onConditionChange(function (condition, options) {
        if (isRestoringCanonicalSpectrum) return;
        if (options && options.allowStellariumSync) {
          live.syncToCondition(condition);
          return;
        }
        if (live.getState().mode === 'live') {
          render(live.getState());
        }
      });
    }

    // Step 3B fix: Experiment's Latitude/Longitude/Site/ephemeris fields were
    // never updated in live mode — they kept showing whatever the last ALT
    // click had rendered (only invisible when the live location happened to
    // coincide with a canonical row's, e.g. every canonical ALT sweep during
    // Step 3; it was caught by testing a real non-Incheon live location).
    // Delegates the actual DOM writes to js/ui-shell.js's
    // renderLiveExperimentDetail(), reusing its existing Format helpers and
    // element references rather than duplicating that formatting here.
    function renderLiveExperimentDetail(liveState) {
      if (!global.SolarChemUIShell || typeof global.SolarChemUIShell.renderLiveExperimentDetail !== 'function') return;
      var label = liveState.selectedConditionMatch && liveState.selectedConditionMatch !== 'custom'
        ? liveState.selectedConditionMatch
        : 'CUSTOM';
      global.SolarChemUIShell.renderLiveExperimentDetail(liveState.observation, label, liveState.locationDisplay);
    }

    // Draws the CURRENT live q_dir array on the Solar Spectrum chart, reusing
    // js/charts.js's existing renderSolarSpectrumChart() unchanged — only the
    // point array's source differs from canonical mode. The fixed log-y
    // domain is read from js/ui-shell.js's canonical binding (the same
    // domain the frozen curve uses) so switching between live and canonical
    // never re-scales the axis; it is never recomputed from the live curve
    // alone (that would be exactly the kind of arbitrary rescaling this
    // correction must not introduce).
    function renderLiveSpectrumChart(liveState) {
      if (!spectrumContainer || !global.SolarChemCharts || !liveState.solarSpectrum) return;
      var yDomainLog10 = global.SolarChemUIShell && typeof global.SolarChemUIShell.getSpectrumYDomain === 'function'
        ? global.SolarChemUIShell.getSpectrumYDomain()
        : null;
      if (!yDomainLog10) return; // canonical baseline domain not loaded yet — nothing safe to draw against

      var wavelengthNm = liveState.solarSpectrum.wavelengthNm;
      var directActinicPhotonFlux = liveState.solarSpectrum.directActinicPhotonFlux;
      var points = wavelengthNm.map(function (wl, idx) {
        return { wavelengthNm: wl, qDir: directActinicPhotonFlux[idx] };
      });

      global.SolarChemCharts.renderSolarSpectrumChart(spectrumContainer, points, yDomainLog10);
      spectrumContainer.setAttribute('aria-label', 'Live solar spectrum chart from Stellarium');
    }

    // Hands rendering back to js/ui-shell.js's existing canonical binding
    // (re-notifies it of whatever condition is currently selected) instead
    // of duplicating the frozen-curve rendering logic here.
    function restoreCanonicalSpectrumChart() {
      if (global.SolarChemUIShell && typeof global.SolarChemUIShell.restoreCanonicalSelection === 'function') {
        isRestoringCanonicalSpectrum = true;
        try {
          global.SolarChemUIShell.restoreCanonicalSelection();
        } finally {
          isRestoringCanonicalSpectrum = false;
        }
      }
    }

    function updateLiveAltitudeGuide(liveState) {
      if (!global.SolarChemUIShell || typeof global.SolarChemUIShell.getMolecularChartApi !== 'function') return;
      var chartApi = global.SolarChemUIShell.getMolecularChartApi();
      if (!chartApi) return;
      if (liveState.mode === 'live' && liveState.observation) {
        chartApi.setLiveAltitudeGuide(liveState.observation.sun.altitudeGeometricDeg);
      } else {
        chartApi.clearLiveAltitudeGuide();
      }
    }

    function render(liveState) {
      statusEl.setAttribute('data-live-status', liveState.mode);
      if (returnButton) returnButton.hidden = liveState.mode !== 'live';

      if (liveState.mode === 'live' && liveState.connection === 'connected') {
        sourceValueEl.textContent = 'Live Stellarium';
        connectButton.textContent = 'Sync Stellarium';
        connectButton.disabled = false;
        messageEl.textContent = 'Stellarium connected';
        messageEl.classList.remove('data-error');
        if (provenanceEl) provenanceEl.textContent = 'Live Stellarium';
        renderLiveSpectrumChart(liveState);
        renderLiveExperimentDetail(liveState);
        if (global.SolarChemUIShell && typeof global.SolarChemUIShell.setLiveAltitudeSelectorMatch === 'function') {
          var matchedConditionId = liveState.selectedConditionMatch && liveState.selectedConditionMatch !== 'custom'
            ? liveState.selectedConditionMatch
            : null;
          global.SolarChemUIShell.setLiveAltitudeSelectorMatch(matchedConditionId);
        }

        if (molecularStatusEl) {
          molecularStatusEl.hidden = false;
          if (molecularAltEl) {
            molecularAltEl.textContent = '태양 기하학적 고도 ' + liveState.observation.sun.altitudeGeometricDeg.toFixed(4) + '°' +
              (liveState.selectedConditionMatch && liveState.selectedConditionMatch !== 'custom'
                ? ' · ' + liveState.selectedConditionMatch
                : ' · 사용자 지정 조건');
          }
          COMPOUND_IDS.forEach(function (compoundId) {
            if (kAbsEls[compoundId] && liveState.molecular) {
              kAbsEls[compoundId].textContent = liveState.molecular[compoundId].kAbsDir.toExponential(4) + ' s⁻¹';
            }
          });
        }
      } else if (liveState.connection === 'connecting') {
        sourceValueEl.textContent = 'Reference data';
        connectButton.disabled = true;
        messageEl.textContent = 'Connecting to Stellarium…';
        messageEl.classList.remove('data-error');
        if (provenanceEl) provenanceEl.textContent = REFERENCE_PROVENANCE_TEXT;
        restoreCanonicalSpectrumChart();
      } else if (liveState.connection === 'error') {
        sourceValueEl.textContent = 'Reference data';
        connectButton.textContent = 'Connect Stellarium';
        connectButton.disabled = false;
        messageEl.textContent = 'Stellarium unavailable';
        messageEl.classList.add('data-error');
        if (provenanceEl) provenanceEl.textContent = REFERENCE_PROVENANCE_TEXT;
        if (molecularStatusEl) molecularStatusEl.hidden = true;
        restoreCanonicalSpectrumChart();
      } else {
        sourceValueEl.textContent = 'Reference data';
        connectButton.textContent = 'Connect Stellarium';
        connectButton.disabled = false;
        messageEl.textContent = '';
        messageEl.classList.remove('data-error');
        if (provenanceEl) provenanceEl.textContent = REFERENCE_PROVENANCE_TEXT;
        if (molecularStatusEl) molecularStatusEl.hidden = true;
        restoreCanonicalSpectrumChart();
      }

      updateLiveAltitudeGuide(liveState);
    }

    live.subscribe(render);
    render(live.getState());

    // Phase 8B-7 — show the connection-status dialog only as a direct
    // result of the user's own Connect/Sync click (never on the silent
    // initial page-load state, and never for an ALT-button-triggered
    // syncToCondition() re-sync — those go through render() only, not
    // through this click handler).
    connectButton.addEventListener('click', function () {
      live.sync().then(function () {
        if (!global.SolarChemUIShell || typeof global.SolarChemUIShell.showConnectionDialog !== 'function') return;
        var connection = live.getState().connection;
        if (connection === 'connected') {
          global.SolarChemUIShell.showConnectionDialog('connected', 4000);
        } else if (connection === 'error') {
          global.SolarChemUIShell.showConnectionDialog('error', undefined, 'localhost:8090');
        }
      });
    });

    if (returnButton) {
      returnButton.addEventListener('click', function () {
        live.enterCanonicalMode();
      });
    }

    global.SolarChemLiveIntegration.instance = live; // debugging / future E2E hook only
  });
})(window);
