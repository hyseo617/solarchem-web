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

  // Phase 10E-B. Shown when Stellarium is reachable and accepted the
  // location/time write, but its Sun object has not been recomputed, so the
  // requested condition cannot honestly be called applied. Deliberately NOT
  // 'Stellarium unavailable' - the API is connected and the write succeeded;
  // only Stellarium's own render-frame-tied astronomical state is behind
  // (reports/validation/phase10e-a-hosted-live-state-investigation.md).
  var STALE_SUN_MESSAGE = 'Stellarium connected \u2014 Sun position not refreshed yet; bring the Stellarium window to the foreground and reselect the condition';

  // Phase 10F — Live ALT daily altitude solver (see solveLiveAltitudeTarget()).
  // Coarse scan step across the live local day (25 samples: 00:00 ... 23:00,
  // 23:59:59). setDateTime() takes whole seconds, so 1 s is also the finest
  // time resolution of every refinement below. The clock is paused for the
  // whole search (setTimeRate(0), original rate restored afterward): with it
  // running, Stellarium re-renders the Sun every ~60 ms on the OLD timeline,
  // so "the reading changed" says nothing about the new time (measured on
  // Stellarium 26.2). Paused, a frame is a pure function of the written time,
  // and a Sun reading after a time change is accepted only once its
  // (altitude, azimuth) pair differs from the previous accepted pair; Stellarium recomputes the Sun on a render frame (measured
  // 64-69 ms in the foreground, never while backgrounded - Phase 10E-A), so
  // 30 polls x 50 ms is ~20 frames of headroom before declaring it stale.
  var LIVE_SOLVER_COARSE_STEP_S = 3600;
  var LIVE_SOLVER_LAST_SECOND_OF_DAY = 86399;
  var LIVE_SOLVER_FRESH_POLL_INTERVAL_MS = 50;
  var LIVE_SOLVER_FRESH_POLL_MAX_ATTEMPTS = 30;

  var COMPOUND_IDS = ['benzophenone', 'luteolin', 'quercetin'];
  var COMPOUND_FILES = Object.freeze({
    benzophenone: 'data/derived/compounds/benzophenone-290-400nm.json',
    luteolin: 'data/derived/compounds/luteolin-290-400nm.json',
    quercetin: 'data/derived/compounds/quercetin-290-400nm.json'
  });
  var ASTM_G173_PATH = 'data/derived/solar-spectrum-astm-g173.json';
  var OZONE_CROSS_SECTION_PATH = 'data/derived/ozone-cross-section-243k.json';

  // Phase 10F. Stellarium simulation clock rate (JD per real second: 0 =
  // paused, 1/86400 = real time), used only by the Live ALT solver to hold
  // Stellarium's clock still while sampling the Sun and to put the user's own
  // rate back afterward. js/stellarium-api.js is a protected file whose
  // setDateTime() deliberately never sends `timerate`, so - exactly like
  // scripts/phase5-build-experiment-conditions.js's setSimulationTimerate shim -
  // this thin helper lives outside it and reuses that file's own
  // stellariumFetch() (same base URL, same "error:" body handling) to send
  // ONLY the documented optional `timerate` parameter of /api/main/time
  // (docs/api-notes.md §2.3). It never sends a time or location value.
  function defaultSetTimeRate(rate) {
    if (typeof rate !== 'number' || !isFinite(rate)) {
      return Promise.reject(new Error('timerate must be a finite number, got ' + rate));
    }
    if (typeof global.stellariumFetch !== 'function') {
      return Promise.reject(new Error('stellariumFetch (js/stellarium-api.js) is not loaded'));
    }
    return global.stellariumFetch('/api/main/time', { method: 'POST', body: { timerate: rate } }).then(function (text) {
      return { ok: String(text).trim() === 'ok', raw: text };
    });
  }

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
      setDateTime: deps.setDateTime || global.setDateTime,
      setTimeRate: deps.setTimeRate || defaultSetTimeRate,
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
    // Phase 10F: the Live ALT solver holds Stellarium's clock still while it
    // samples the Sun. pausedTimeRate is the user's ORIGINAL rate for as long
    // as any solve owns the pause; pauseOwnerGeneration is the requestGeneration
    // of the solve responsible for putting it back. A superseding solve takes
    // ownership and inherits the original rate (never the paused 0); a solve
    // superseded by anything else (Connect/Sync, return to Reference) restores
    // the rate itself.
    var pausedTimeRate = null;
    var pauseOwnerGeneration = null;

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
    // options (Phase 10F):
    //   confirmedLiveTarget { conditionId, altitudeDeg } - a Live ALT solve
    //     just left Stellarium at a time whose freshly read Sun altitude
    //     matched the target. It is labelled with that conditionId only if
    //     THIS read still agrees within CANONICAL_MATCH_TOLERANCE.altitudeDeg;
    //     otherwise the state stays CUSTOM with the stale-Sun notice, so a
    //     label is never granted from time alone.
    //   notice { kind, message } - a truthful, still-connected outcome of a
    //     Live ALT request (stale Sun, unreachable target, search failure).
    //   fromLiveSolve - skip the transient 'connecting' render, which would
    //     otherwise repaint the frozen Incheon reference over the user's live
    //     location/date while this re-read runs.
    function sync(options) {
      options = options || {};
      var myGeneration = ++requestGeneration;
      if (!options.fromLiveSolve) {
        setState({ connection: 'connecting', error: null });
      }

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
            var match = conditionMatch || 'custom';
            var notice = options.notice || null;
            var target = options.confirmedLiveTarget;
            if (target) {
              if (Math.abs(observation.sun.altitudeGeometricDeg - target.altitudeDeg) <= CANONICAL_MATCH_TOLERANCE.altitudeDeg) {
                match = target.conditionId;
              } else {
                notice = { kind: 'stellarium-stale-sun', message: STALE_SUN_MESSAGE };
              }
            }
            setState({
              mode: 'live',
              connection: 'connected',
              observation: observation,
              solarSpectrum: {
                wavelengthNm: computed.spectrumResult.spectrum.wavelengthNm,
                directActinicPhotonFlux: computed.spectrumResult.spectrum.directActinicPhotonFlux
              },
              molecular: computed.molecular,
              selectedConditionMatch: match,
              locationDisplay: locationDisplay,
              lastUpdated: Date.now(),
              error: notice
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

    // ---------------------------------------------------------------
    // Phase 10F — Live ALT: Stellarium-driven daily altitude solver.
    //
    // Pre-10F, a Live ALT click applied the frozen Phase 8A Incheon row
    // (setLocation(Incheon, 43 m) + setDateTime on the frozen 2026-08-13
    // reference date at UTC+09:00), moving a user on e.g. London 2026-09-11 back to the
    // reference condition. In live mode an ALT control now changes Stellarium
    // TIME ONLY: location, elevation, the live local calendar date and
    // Stellarium's timezone are never written. Every Sun altitude used below
    // is read back from Stellarium through api.getObservationConditions();
    // Solarchem computes none.
    //
    // Algorithm (all times are whole seconds of the ORIGINAL live local date,
    // written with the live UTC offset label derived from Stellarium's own
    // status.time.gmtShift):
    //   1. Coarse scan: 00:00, 01:00, ... 23:00, 23:59:59 (25 writes).
    //   2. Daily maximum: golden-section search inside the two coarse steps
    //      around the highest sample, down to a 2 s bracket (~18 writes).
    //      MAX targets stop here.
    //   3. Numeric target T: the rising crossing is bracketed by the last
    //      coarse step before the maximum that goes from below T to at/above
    //      T; the setting crossing by the first step after it that goes back
    //      below T. Each is bisected to a 1 s bracket (~12 writes each) and
    //      the endpoint closer to T is kept; it must lie within
    //      CANONICAL_MATCH_TOLERANCE.altitudeDeg. If the maximum itself is
    //      within tolerance of T and no strict crossing exists, the maximum
    //      is the solution.
    //   4. Morning/evening rule: of the solutions found, the one whose time is
    //      nearest the user's ORIGINAL live time wins (tie -> earlier).
    //   5. Stellarium is left at the chosen time, confirmed by a fresh read,
    //      and the user's original clock rate is restored.
    // Stellarium's clock is paused (timerate 0) from just after the original
    // state is read until the search ends, whatever the outcome - the only
    // non-time-value write, always undone (see defaultSetTimeRate above for
    // why sampling a running clock is unsound).
    // Worst case for a numeric target: 25 + ~18 + 24 + 1 time writes.
    //
    // Unreachable target, stale Sun, or any other failure: the original live
    // time is restored (to the second) whenever the observer location was
    // not changed underneath the search, and no canonical data is used.
    // ---------------------------------------------------------------

    function liveTargetFromConditionId(conditionId) {
      if (conditionId === 'ALTMAX') return { conditionId: conditionId, kind: 'max' };
      var m = /^ALT(\d{3})$/.exec(conditionId || '');
      return m ? { conditionId: conditionId, kind: 'altitude', altitudeDeg: Number(m[1]) } : null;
    }

    function pad2(n) {
      return (n < 10 ? '0' : '') + n;
    }

    function formatUtcOffsetLabel(offsetMinutes) {
      var abs = Math.abs(offsetMinutes);
      return 'UTC' + (offsetMinutes < 0 ? '-' : '+') + pad2(Math.floor(abs / 60)) + ':' + pad2(abs % 60);
    }

    function secondOfDayToTime(sec) {
      return pad2(Math.floor(sec / 3600)) + ':' + pad2(Math.floor(sec / 60) % 60) + ':' + pad2(sec % 60);
    }

    function liveSolverError(kind, message, extra) {
      var err = new Error(message);
      err.liveSolverKind = kind;
      if (extra) Object.keys(extra).forEach(function (k) { err[k] = extra[k]; });
      return err;
    }

    function solveLiveAltitudeTarget(canonicalRow, myGeneration) {
      var target = liveTargetFromConditionId(canonicalRow && canonicalRow.conditionId);
      var ctx = null;
      var cache = {};
      // A stale Stellarium frame repeats the previous Sun object byte-for-byte
      // (altitude AND azimuth - Phase 9H-C/10E-A). Two genuinely different
      // times can share an altitude (either side of transit), but not an
      // azimuth, so freshness is judged on the pair, never on altitude alone.
      var lastAccepted = null;
      var physicalSec = null;
      var restoreSafe = true;

      function checkSuperseded() {
        if (myGeneration !== requestGeneration) throw liveSolverError('superseded', 'superseded by a newer request', { superseded: true });
      }

      function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
      }

      function readOriginal() {
        return api.getObservationConditions().then(function (result) {
          var status = result && result.diagnostics && result.diagnostics.raw ? result.diagnostics.raw.status : null;
          var time = status && status.time;
          var m = time && typeof time.local === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(time.local) : null;
          if (!m || typeof time.gmtShift !== 'number' || !isFinite(time.gmtShift)) {
            throw liveSolverError('failed', 'Stellarium did not report its local time and UTC offset');
          }
          if (typeof time.timerate !== 'number' || !isFinite(time.timerate)) {
            throw liveSolverError('failed', 'Stellarium did not report its clock rate');
          }
          var offsetMinutes = Math.round(time.gmtShift * 1440);
          var obs = result.observation;
          ctx = {
            date: m[1] + '-' + m[2] + '-' + m[3],
            originalSec: Number(m[4]) * 3600 + Number(m[5]) * 60 + Number(m[6]),
            offsetLabel: formatUtcOffsetLabel(offsetMinutes),
            dayStartUtcMs: Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - offsetMinutes * 60000,
            latitudeDeg: obs.location.latitudeDeg,
            longitudeDeg: obs.location.longitudeDeg,
            altitudeM: obs.location.altitudeM,
            timeRate: time.timerate
          };
          lastAccepted = { alt: obs.sun.altitudeGeometricDeg, az: obs.sun.azimuthDeg };
        });
      }

      function pairOf(obs) {
        return { alt: obs.sun.altitudeGeometricDeg, az: obs.sun.azimuthDeg };
      }

      function samePair(a, b) {
        return a.alt === b.alt && a.az === b.az;
      }

      // After pausing, Stellarium may still render one last frame (measured:
      // exactly one Sun change right after timerate=0). The baseline for the
      // freshness rule is taken only once two consecutive reads agree.
      function settleBaseline(prev, attemptsLeft) {
        checkSuperseded();
        return api.getObservationConditions().then(function (result) {
          checkSuperseded();
          var pair = pairOf(result.observation);
          if (prev && samePair(prev, pair)) {
            lastAccepted = pair;
            return;
          }
          if (attemptsLeft <= 1) throw liveSolverError('failed', 'Stellarium\'s clock did not settle after pausing it');
          return delay(LIVE_SOLVER_FRESH_POLL_INTERVAL_MS).then(function () {
            return settleBaseline(pair, attemptsLeft - 1);
          });
        });
      }

      function pauseClock() {
        checkSuperseded();
        if (typeof api.setTimeRate !== 'function') throw liveSolverError('failed', 'Stellarium clock-rate control is unavailable');
        if (pausedTimeRate === null) pausedTimeRate = ctx.timeRate;
        pauseOwnerGeneration = myGeneration;
        return api.setTimeRate(0).then(function (res) {
          if (!res || !res.ok) throw liveSolverError('failed', 'Stellarium did not confirm pausing its clock');
          return settleBaseline(null, LIVE_SOLVER_FRESH_POLL_MAX_ATTEMPTS);
        });
      }

      // Resolves to null, or to a note if the original rate could not be put back.
      function restoreClockRate() {
        if (pauseOwnerGeneration !== myGeneration || pausedTimeRate === null) return Promise.resolve(null);
        var rate = pausedTimeRate;
        pausedTimeRate = null;
        pauseOwnerGeneration = null;
        return Promise.resolve().then(function () { return api.setTimeRate(rate); }).then(function () {
          return null;
        }, function (e) {
          return 'the original clock rate could not be restored: ' + (e && e.message ? e.message : String(e));
        });
      }

      function pollFresh(sec, attemptsLeft) {
        checkSuperseded();
        return api.getObservationConditions().then(function (result) {
          checkSuperseded();
          var obs = result.observation;
          if (Math.abs(obs.location.latitudeDeg - ctx.latitudeDeg) > CANONICAL_MATCH_TOLERANCE.locationDeg ||
              Math.abs(obs.location.longitudeDeg - ctx.longitudeDeg) > CANONICAL_MATCH_TOLERANCE.locationDeg ||
              obs.location.altitudeM !== ctx.altitudeM) {
            restoreSafe = false;
            throw liveSolverError('failed', 'the Stellarium observer location changed during the search');
          }
          var timeOk = Math.abs(new Date(obs.time.utcIso).getTime() - (ctx.dayStartUtcMs + sec * 1000)) <= CANONICAL_MATCH_TOLERANCE.timeMs;
          var pair = pairOf(obs);
          if (timeOk && !samePair(pair, lastAccepted)) {
            lastAccepted = pair;
            cache[sec] = pair.alt;
            return pair.alt;
          }
          if (attemptsLeft <= 1) {
            if (timeOk) throw liveSolverError('stale-sun', 'Stellarium reported the requested time but its Sun position did not refresh');
            throw liveSolverError('failed', 'Stellarium did not move to the requested time');
          }
          return delay(LIVE_SOLVER_FRESH_POLL_INTERVAL_MS).then(function () {
            return pollFresh(sec, attemptsLeft - 1);
          });
        });
      }

      // Physically moves Stellarium to `sec` and returns its freshly read Sun altitude.
      function moveTo(sec) {
        checkSuperseded();
        if (physicalSec === sec && cache.hasOwnProperty(sec)) return Promise.resolve(cache[sec]);
        return api.setDateTime(ctx.date, secondOfDayToTime(sec), ctx.offsetLabel).then(function (res) {
          if (!res || !res.ok) throw liveSolverError('failed', 'Stellarium did not confirm the time change');
          physicalSec = sec;
          return pollFresh(sec, LIVE_SOLVER_FRESH_POLL_MAX_ATTEMPTS);
        });
      }

      function altitudeAt(sec) {
        return cache.hasOwnProperty(sec) ? Promise.resolve(cache[sec]) : moveTo(sec);
      }

      function sequence(items, fn) {
        return items.reduce(function (p, item) {
          return p.then(function (acc) { return fn(item).then(function (v) { acc.push(v); return acc; }); });
        }, Promise.resolve([]));
      }

      function coarseSeconds() {
        var secs = [];
        for (var sec = 0; sec < 86400; sec += LIVE_SOLVER_COARSE_STEP_S) secs.push(sec);
        secs.push(LIVE_SOLVER_LAST_SECOND_OF_DAY);
        return secs;
      }

      function findMaximum(coarse, alts) {
        var iMax = 0;
        for (var i = 1; i < alts.length; i += 1) if (alts[i] > alts[iMax]) iMax = i;
        var lo = coarse[Math.max(iMax - 1, 0)];
        var hi = coarse[Math.min(iMax + 1, coarse.length - 1)];
        var invPhi = (Math.sqrt(5) - 1) / 2;
        var a = lo;
        var b = hi;
        var c = b - Math.round((b - a) * invPhi);
        var d = a + Math.round((b - a) * invPhi);

        function step() {
          if (b - a <= 2) return Promise.resolve();
          if (c >= d) c = d - 1;
          return Promise.all([altitudeAt(c)]).then(function () {
            return altitudeAt(d);
          }).then(function () {
            if (cache[c] >= cache[d]) {
              b = d; d = c; c = b - Math.round((b - a) * invPhi);
            } else {
              a = c; c = d; d = a + Math.round((b - a) * invPhi);
            }
            if (c <= a) c = a + 1;
            if (d >= b) d = b - 1;
            return step();
          });
        }

        return step().then(function () {
          var bestSec = null;
          Object.keys(cache).forEach(function (k) {
            var sec = Number(k);
            if (bestSec === null || cache[sec] > cache[bestSec]) bestSec = sec;
          });
          return { sec: bestSec, altitudeDeg: cache[bestSec] };
        });
      }

      // Bisects [lo, hi] (f(lo) and f(hi) on opposite sides of 0) to a 1 s bracket.
      function bisect(lo, hi, loIsBelow, targetDeg) {
        if (hi - lo <= 1) {
          return Promise.all([altitudeAt(lo), altitudeAt(hi)]).then(function () {
            var best = Math.abs(cache[lo] - targetDeg) <= Math.abs(cache[hi] - targetDeg) ? lo : hi;
            if (Math.abs(cache[best] - targetDeg) > CANONICAL_MATCH_TOLERANCE.altitudeDeg) {
              throw liveSolverError('failed', 'the crossing could not be refined to within ' + CANONICAL_MATCH_TOLERANCE.altitudeDeg + ' deg at 1 s resolution');
            }
            return best;
          });
        }
        var mid = Math.floor((lo + hi) / 2);
        return altitudeAt(mid).then(function (alt) {
          var midBelow = alt < targetDeg;
          return midBelow === loIsBelow ? bisect(mid, hi, loIsBelow, targetDeg) : bisect(lo, mid, loIsBelow, targetDeg);
        });
      }

      function findCrossings(coarse, max, targetDeg) {
        var rising = coarse.filter(function (sec) { return sec < max.sec; }).concat([max.sec]);
        var setting = [max.sec].concat(coarse.filter(function (sec) { return sec > max.sec; }));
        var jobs = [];
        for (var i = rising.length - 2; i >= 0; i -= 1) {
          if (cache[rising[i]] < targetDeg && cache[rising[i + 1]] >= targetDeg) {
            jobs.push([rising[i], rising[i + 1], true]);
            break;
          }
        }
        for (var j = 0; j < setting.length - 1; j += 1) {
          if (cache[setting[j]] >= targetDeg && cache[setting[j + 1]] < targetDeg) {
            jobs.push([setting[j], setting[j + 1], false]);
            break;
          }
        }
        return sequence(jobs, function (job) { return bisect(job[0], job[1], job[2], targetDeg); });
      }

      function restoreAfterFailure(err) {
        var timeStep = ctx && restoreSafe && !err.superseded
          ? Promise.resolve().then(function () {
            return api.setDateTime(ctx.date, secondOfDayToTime(ctx.originalSec), ctx.offsetLabel);
          }).then(function () { return null; }, function (e) {
            return 'the original time could not be restored: ' + (e && e.message ? e.message : String(e));
          })
          : Promise.resolve(null);
        return timeStep.then(function (timeNote) {
          return restoreClockRate().then(function (rateNote) {
            var notes = [timeNote, rateNote].filter(Boolean);
            if (notes.length) err.message += ' (' + notes.join('; ') + ')';
            throw err;
          });
        });
      }

      if (!target) {
        return Promise.reject(liveSolverError('failed', 'unsupported live altitude control ' + (canonicalRow && canonicalRow.conditionId)));
      }

      var coarse = coarseSeconds();
      return readOriginal().then(pauseClock).then(function () {
        return sequence(coarse, moveTo);
      }).then(function (alts) {
        return findMaximum(coarse, alts);
      }).then(function (max) {
        if (target.kind === 'max') return { sec: max.sec, altitudeDeg: max.altitudeDeg };
        var tol = CANONICAL_MATCH_TOLERANCE.altitudeDeg;
        if (max.altitudeDeg < target.altitudeDeg - tol) {
          throw liveSolverError('unreachable', target.altitudeDeg + '° is not reached at this location on this date.');
        }
        return findCrossings(coarse, max, target.altitudeDeg).then(function (secs) {
          if (secs.length === 0 && Math.abs(max.altitudeDeg - target.altitudeDeg) <= tol) secs = [max.sec];
          if (secs.length === 0) {
            throw liveSolverError('unreachable', target.altitudeDeg + '° is not reached at this location on this date.');
          }
          secs.sort(function (x, y) {
            var dx = Math.abs(x - ctx.originalSec);
            var dy = Math.abs(y - ctx.originalSec);
            return dx !== dy ? dx - dy : x - y;
          });
          return { sec: secs[0], altitudeDeg: target.altitudeDeg };
        });
      }).then(function (chosen) {
        return moveTo(chosen.sec).then(function (alt) {
          if (Math.abs(alt - chosen.altitudeDeg) > CANONICAL_MATCH_TOLERANCE.altitudeDeg) {
            throw liveSolverError('stale-sun', 'Stellarium\'s Sun at the chosen time does not match the target');
          }
          return restoreClockRate().then(function (rateNote) {
            if (rateNote) throw liveSolverError('failed', rateNote);
            return { conditionId: target.conditionId, altitudeDeg: chosen.altitudeDeg };
          });
        });
      }).catch(restoreAfterFailure);
    }

    // Called from ui-shell.js's existing onConditionChange subscription for
    // an explicit ALT button (docs §4/§18 — reuses the one selection state).
    // A no-op in canonical/Reference mode: the frozen Incheon 2026-08-13
    // ALT010-ALTMAX selection already works without touching Stellarium.
    // In live mode it runs the time-only solver above; it never calls
    // setLocation() and never applies the canonical row's location/date.
    function syncToCondition(canonicalRow) {
      if (state.mode !== 'live') return Promise.resolve();

      var myGeneration = ++requestGeneration;

      return solveLiveAltitudeTarget(canonicalRow, myGeneration).then(function (solved) {
        if (myGeneration !== requestGeneration) return;
        return sync({ confirmedLiveTarget: solved, fromLiveSolve: true });
      }, function (err) {
        if ((err && err.superseded) || myGeneration !== requestGeneration) return;
        var detail = err && err.message ? err.message : String(err);
        logError('live-altitude-solver', detail);
        var notice;
        if (err && err.liveSolverKind === 'stale-sun') {
          notice = { kind: 'stellarium-stale-sun', message: STALE_SUN_MESSAGE };
        } else if (err && err.liveSolverKind === 'unreachable') {
          notice = { kind: 'live-target-unreachable', message: detail };
        } else {
          notice = { kind: 'live-target-failed', message: 'Live altitude search failed: ' + detail };
        }
        return sync({ notice: notice, fromLiveSolve: true });
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
        matchCanonicalCondition: matchCanonicalCondition,
        setTimeRate: api.setTimeRate
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
    // Still-connected live outcomes whose own message replaces
    // 'Stellarium connected' (Phase 10E-B stale Sun; Phase 10F live ALT).
    var LIVE_NOTICE_KINDS = { 'stellarium-stale-sun': true, 'live-target-unreachable': true, 'live-target-failed': true };
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
          // Phase 10F: ui-shell.js's selectCondition() has just painted the
          // clicked frozen Incheon row and pressed its button. While live,
          // put the user's real live state back on screen at once, so no
          // reference location/date and no unconfirmed ALT selection is shown
          // during the Stellarium search.
          if (live.getState().mode === 'live') render(live.getState());
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
        // Phase 10E-B: still connected and still live, but the requested
        // condition was not confirmed because Stellarium's Sun had not
        // refreshed - say exactly that instead of 'Stellarium connected'.
        if (liveState.error && LIVE_NOTICE_KINDS.hasOwnProperty(liveState.error.kind)) {
          messageEl.textContent = liveState.error.message;
          messageEl.classList.add('data-error');
        } else {
          messageEl.textContent = 'Stellarium connected';
          messageEl.classList.remove('data-error');
        }
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
