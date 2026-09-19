// ui-shell.js
// Presentation interaction shell for the final analysis website.
// Phase 8B-2 — canonical condition/ephemeris data binding added below
// (display formatting only; no scientific computation; reads
// js/canonical-data.js output, never queries Stellarium/JPL live).
// Phase 8B-3 — Solar Spectrum / Molecular Response chart binding reuses
// the same selectedConditionId via the onConditionChange subscriber list
// below, instead of introducing a second altitude/condition state.

(function () {
  'use strict';

  // ---------------------------------------------------------------
  // Shared condition-selection pub/sub. initCanonicalEphemerisBinding()
  // owns selectedConditionId and is the only place that calls
  // notifyConditionChange(); other init functions in this file (e.g. the
  // Phase 8B-3 chart binding) subscribe via onConditionChange() rather than
  // tracking their own copy of "which condition is selected".
  // ---------------------------------------------------------------

  var conditionChangeListeners = [];
  function onConditionChange(callback) {
    conditionChangeListeners.push(callback);
  }
  // Phase 9H-D fix: options.allowStellariumSync tells subscribers (namely
  // js/live-integration.js's onConditionChange handler) whether this
  // notification came from an explicit user action whose PURPOSE is to
  // change the Stellarium condition (the Experiment section's ALT010-ALTMAX
  // buttons) versus a passive/browsing selection (an Ephemeris drawer row
  // click/keydown, the canonical restore-to-reference path, or the
  // page-load default selection) that must never write to Stellarium. See
  // reports/validation/phase9h-d-live-state-ownership-validation.md — a
  // real Windows E2E run found that clicking an Ephemeris row while live
  // silently overwrote the user's actual Stellarium condition with the
  // clicked row's reference location/time, because every selectCondition()
  // call (regardless of source) fed the same pub/sub that
  // live-integration.js always turned into a Stellarium write.
  function notifyConditionChange(condition, options) {
    conditionChangeListeners.forEach(function (cb) { cb(condition, options); });
  }

  // Phase 8B-6 Step 2 — minimal read-only surface for js/live-integration.js.
  // It reuses this file's existing selection pub/sub instead of tracking a
  // second condition state (see file header); molecularChartApiRef,
  // spectrumYDomainRef, and restoreCanonicalSpectrumFn are set once the
  // relevant init functions below have run, so live-integration.js can (a)
  // move its x-only altitude guide, (b) draw the live Solar Spectrum curve
  // on the same fixed log-y domain the canonical curve uses, and (c)
  // restore the canonical curve for whatever condition is currently
  // selected when returning from live mode — all without this file taking
  // any dependency on live-integration.js itself.
  var molecularChartApiRef = null;
  var spectrumYDomainRef = null;
  var restoreCanonicalSpectrumFn = null;
  window.SolarChemUIShell = {
    onConditionChange: onConditionChange,
    getMolecularChartApi: function () { return molecularChartApiRef; },
    getSpectrumYDomain: function () { return spectrumYDomainRef; },
    restoreCanonicalSelection: function () {
      if (restoreCanonicalSpectrumFn) restoreCanonicalSpectrumFn();
    }
  };

  // ---------------------------------------------------------------
  // Canonical page readiness for deterministic print/PDF capture.
  // "true" means every production dataset required by the current page has
  // loaded and rendered: Phase 8A ephemeris, Phase 6B solar spectrum,
  // Phase 7B molecular response, and Phase 7G Final Tables 1/2.
  // ---------------------------------------------------------------

  var canonicalBindingStatus = {
    ephemeris: 'pending',
    spectralMolecular: 'pending',
    finalTable1: 'pending',
    finalTable2: 'pending'
  };
  var pageReadyResolve = null;
  var pageReadySettled = false;

  function canonicalReadySummary(status, error) {
    return Object.freeze({
      status: status,
      bindings: Object.freeze(Object.assign({}, canonicalBindingStatus)),
      error: error || null
    });
  }

  function setCanonicalReadyState(status, error) {
    document.documentElement.dataset.canonicalReady = status;
    if (!pageReadySettled && (status === 'true' || status === 'error')) {
      pageReadySettled = true;
      if (pageReadyResolve) pageReadyResolve(canonicalReadySummary(status, error));
    }
  }

  function markCanonicalBinding(name, status, error) {
    if (!Object.prototype.hasOwnProperty.call(canonicalBindingStatus, name)) return;
    canonicalBindingStatus[name] = status;

    var states = Object.keys(canonicalBindingStatus).map(function (key) {
      return canonicalBindingStatus[key];
    });

    if (states.indexOf('error') !== -1) {
      setCanonicalReadyState('error', error || name + ' failed');
      return;
    }

    if (states.every(function (state) { return state === 'ready'; })) {
      setCanonicalReadyState('true', null);
      return;
    }

    setCanonicalReadyState('pending', null);
  }

  document.documentElement.dataset.canonicalReady = 'pending';
  window.SolarChemPageReady = new Promise(function (resolve) {
    pageReadyResolve = resolve;
  });

  // ---------------------------------------------------------------
  // Display-only formatters. These format already-canonical values;
  // they never compute, round-and-store, or derive new scientific
  // quantities. Rounding happens here, at render time, only.
  // ---------------------------------------------------------------

  var Format = {
    // "2026-08-13T08:25:06+09:00" -> "08:25:06 KST"
    localTime: function (localDateTimeKst) {
      var match = /T(\d{2}:\d{2}:\d{2})/.exec(localDateTimeKst || '');
      return match ? match[1] + ' KST' : 'DATA UNAVAILABLE';
    },
    // "2026-08-13T08:25:06+09:00" -> "2026.08.13"
    localDate: function (localDateTimeKst) {
      var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(localDateTimeKst || '');
      return match ? match[1] + '.' + match[2] + '.' + match[3] : 'DATA UNAVAILABLE';
    },
    // "2026-08-13T08:25:06+09:00" -> "2026-08-13" (for <input type="date">)
    localDateInputValue: function (localDateTimeKst) {
      var match = /^(\d{4}-\d{2}-\d{2})/.exec(localDateTimeKst || '');
      return match ? match[1] : '';
    },
    // "2026-08-13T08:25:06+09:00" -> "08:25:06" (for <input type="time">)
    localTimeInputValue: function (localDateTimeKst) {
      var match = /T(\d{2}:\d{2}:\d{2})/.exec(localDateTimeKst || '');
      return match ? match[1] : '';
    },
    // "2026-08-12T23:25:06.000Z" -> "2026-08-12 23:25:06 UTC"
    utc: function (utcDateTime) {
      var match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(utcDateTime || '');
      return match ? match[1] + ' ' + match[2] + ' UTC' : 'DATA UNAVAILABLE';
    },
    degrees: function (value) {
      var n = Number(value);
      return isFinite(n) ? n.toFixed(4) + '°' : 'DATA UNAVAILABLE';
    },
    au: function (value) {
      var n = Number(value);
      return isFinite(n) ? n.toFixed(6) + ' AU' : 'DATA UNAVAILABLE';
    },
    decimal: function (value, digits) {
      var n = Number(value);
      return isFinite(n) ? n.toFixed(digits) : 'DATA UNAVAILABLE';
    },
    scientific: function (value, digits) {
      var n = Number(value);
      if (!isFinite(n)) return 'DATA UNAVAILABLE';
      return n.toExponential(digits).replace('e+', 'e');
    },
    wavelengthMean: function (value) {
      var n = Number(value);
      return isFinite(n) ? n.toFixed(2) : 'DATA UNAVAILABLE';
    },
    wavelengthGrid: function (value) {
      var n = Number(value);
      return isFinite(n) ? String(Math.round(n)) : 'DATA UNAVAILABLE';
    },
    latLon: function (value, positiveSuffix, negativeSuffix) {
      var n = Number(value);
      if (!isFinite(n)) return 'DATA UNAVAILABLE';
      return Math.abs(n).toFixed(4) + '° ' + (n >= 0 ? positiveSuffix : negativeSuffix);
    },
    // Phase 10L: "51.5074° N, 0.1278° W" - a live observer's own coordinates.
    latLonPair: function (latitudeDeg, longitudeDeg) {
      return Format.latLon(latitudeDeg, 'N', 'S') + ', ' + Format.latLon(longitudeDeg, 'E', 'W');
    },
    elevation: function (value) {
      var n = Number(value);
      return isFinite(n) ? n.toFixed(0) + ' m' : 'DATA UNAVAILABLE';
    },
    // Stellarium's own status.location.name, verbatim — never inferred.
    stellariumLocationName: function (name) {
      return (typeof name === 'string' && name.trim() !== '') ? name : 'Location unavailable';
    },
    // Stellarium's own status.time.timeZone label ("UTC+09:00", an IANA
    // name, etc.), verbatim — never inferred from latitude/longitude, never
    // defaulted to the browser/system timezone.
    stellariumTimeZone: function (timeZone) {
      return (typeof timeZone === 'string' && timeZone.trim() !== '') ? timeZone : 'Timezone unavailable';
    },
    // "2026-09-10T20:51:50.706" + "UTC+09:00" -> "2026-09-10 20:51:50 (UTC+09:00)".
    // Pure string slicing of Stellarium's own status.time.local — never
    // reparsed as a JS Date (that would silently reinterpret it in the
    // browser's local timezone; see docs/astronomy-data.md 5).
    stellariumLocalTime: function (localStr, timeZone) {
      var match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/.exec(localStr || '');
      if (!match) return 'Local time unavailable';
      var tzSuffix = (typeof timeZone === 'string' && timeZone.trim() !== '') ? ' (' + timeZone + ')' : '';
      return match[1] + ' ' + match[2] + tzSuffix;
    },
    // Stellarium's own status.time.local, sliced (never reparsed as a Date)
    // for the native <input type="date">/<input type="time"> pair in
    // Experiment -> Date/Time. Empty string when unavailable — the native
    // control just renders blank, and the adjacent Timezone/UTC text
    // fields still carry the truthful "unavailable" message.
    stellariumLocalDateInputValue: function (localStr) {
      var match = /^(\d{4}-\d{2}-\d{2})/.exec(localStr || '');
      return match ? match[1] : '';
    },
    stellariumLocalTimeInputValue: function (localStr) {
      var match = /T(\d{2}:\d{2}:\d{2})/.exec(localStr || '');
      return match ? match[1] : '';
    }
  };

  function setFieldValue(el, text, isError) {
    if (!el) return;
    el.textContent = text;
    el.classList.remove('data-slot', 'data-value', 'data-error');
    el.classList.add(isError ? 'data-error' : 'data-value');
  }

  // ---------------------------------------------------------------
  // Phase 8B-2 canonical ephemeris/condition binding.
  //
  // Single source of truth: selectedConditionId. Every consumer
  // (Experiment detail, footer mini rail, drawer table + selected row,
  // altitude selector aria-pressed state) re-renders from it — nothing
  // re-derives or guesses the selection independently. Kept here (not
  // in js/canonical-data.js) because it is UI state, not data loading.
  // ---------------------------------------------------------------

  function initCanonicalEphemerisBinding() {
    if (!window.SolarChemCanonicalData) {
      markCanonicalBinding('ephemeris', 'error', 'SolarChemCanonicalData unavailable');
      return;
    }

    var altitudeButtons = Array.prototype.slice.call(
      document.querySelectorAll('.altitude-index [data-condition-id]')
    );
    var drawerRows = Array.prototype.slice.call(
      document.querySelectorAll('.ephemeris-drawer__table tbody tr[data-ephemeris-row]')
    );
    if (!altitudeButtons.length || !drawerRows.length) {
      markCanonicalBinding('ephemeris', 'error', 'required ephemeris UI hooks missing');
      return;
    }

    var experimentFields = {};
    document.querySelectorAll('#ephemeris [data-ephemeris-field]').forEach(function (el) {
      experimentFields[el.getAttribute('data-ephemeris-field')] = el;
    });

    var miniFields = {};
    document.querySelectorAll('[data-mini-ephemeris]').forEach(function (el) {
      miniFields[el.getAttribute('data-mini-ephemeris')] = el;
    });

    var drawerDateEl = document.querySelector('[data-ephemeris-meta="date"]');
    var dateInput = document.querySelector('[data-frozen-field="date"]');
    var timeInput = document.querySelector('[data-frozen-field="time"]');
    var utcInput = document.querySelector('[data-frozen-field="utc"]');
    var latitudeInput = document.querySelector('[data-frozen-field="latitude"]');
    var longitudeInput = document.querySelector('[data-frozen-field="longitude"]');
    var elevationInput = document.querySelector('[data-frozen-field="elevation"]');
    var timezoneInput = document.querySelector('[data-frozen-field="timezone"]');
    var siteInput = document.querySelector('input[name="site"]');
    var SITE_FROZEN_TEXT = siteInput ? siteInput.value : '';
    // Phase 10L: the bottom rail's site label was hard-coded "Incheon" in
    // index.html and never updated, so a live London state showed
    // "Incheon · <London UTC> · Sun <London altitude>". Live mode now shows the
    // live observer's own coordinates (no geocoding); Reference restores this.
    var miniSiteEl = document.querySelector('[data-mini-site]');
    var MINI_SITE_FROZEN_TEXT = miniSiteEl ? miniSiteEl.textContent : '';
    var TIMEZONE_FROZEN_TEXT = timezoneInput ? timezoneInput.value : '';

    var conditionsById = {};
    var selectedConditionId = null;

    // Exposed via window.SolarChemUIShell.restoreCanonicalSelection() so
    // js/live-integration.js can restore the full canonical Experiment
    // display (Latitude/Longitude/Site/date/time, ephemeris fields), the
    // frozen Solar Spectrum curve, and (through the existing
    // onConditionChange subscriber) the Molecular Response marker — for
    // whatever condition is currently selected — without re-implementing
    // canonical rendering itself. Re-invokes the same selectCondition()
    // an ALT-button click already calls (idempotent for an unchanged
    // selection), rather than only the chart/molecular notify.
    restoreCanonicalSpectrumFn = function () {
      if (siteInput) siteInput.value = SITE_FROZEN_TEXT;
      if (timezoneInput) timezoneInput.value = TIMEZONE_FROZEN_TEXT;
      if (miniSiteEl) miniSiteEl.textContent = MINI_SITE_FROZEN_TEXT;
      if (selectedConditionId && conditionsById[selectedConditionId]) {
        // renderFrozenContext() restores Latitude/Longitude/Elevation from
        // the canonical condition — live mode overwrites these three with
        // the Stellarium observer's own values, so returning to reference
        // must put them back (this previously only affected
        // Latitude/Longitude before Elevation existed; folding Elevation's
        // restore into the same call keeps both consistent).
        renderFrozenContext(conditionsById[selectedConditionId]);
        selectCondition(selectedConditionId, { allowStellariumSync: false });
      }
    };

    // Step 3B — live Experiment display. Reuses the same Format helpers and
    // element references as the canonical render functions above; the only
    // difference is the input shape (a real ObservationConditions object,
    // not a Phase 8A CSV row).
    //
    // Phase 9H fix: Site/local-time/timezone previously showed hard-coded
    // placeholders ("Live Stellarium location" / "See UTC") regardless of
    // what Stellarium actually reported, based on a mistaken assumption
    // that this metadata was unavailable. Stellarium's /api/main/status
    // does include location.name and time.timeZone/time.local — this now
    // displays those verbatim (via locationDisplay, built by
    // js/live-integration.js's extractLocationDisplay() straight from the
    // raw status response) when Stellarium provides them, and an honest
    // "unavailable" message otherwise. This still never infers a timezone
    // from latitude/longitude or hardcodes Korea/KST for live mode — see
    // js/astronomy-data.js's normalizeTime()/docs/astronomy-data.md 5/7,
    // which is about a different, calculation-facing field
    // (ObservationConditions.time.timeZone) and is unchanged by this fix.
    function renderLiveExperimentDetail(observation, conditionLabel, locationDisplay) {
      if (latitudeInput) latitudeInput.value = Format.latLon(observation.location.latitudeDeg, 'N', 'S');
      if (longitudeInput) longitudeInput.value = Format.latLon(observation.location.longitudeDeg, 'E', 'W');
      if (elevationInput) elevationInput.value = Format.elevation(observation.location.altitudeM);
      if (siteInput) siteInput.value = Format.stellariumLocationName(locationDisplay && locationDisplay.name);
      if (dateInput) dateInput.value = Format.stellariumLocalDateInputValue(locationDisplay && locationDisplay.local);
      if (timeInput) timeInput.value = Format.stellariumLocalTimeInputValue(locationDisplay && locationDisplay.local);
      if (timezoneInput) timezoneInput.value = Format.stellariumTimeZone(locationDisplay && locationDisplay.timeZone);
      if (utcInput) utcInput.value = Format.utc(observation.time.utcIso);
      setFieldValue(experimentFields.condition, conditionLabel, false);
      setFieldValue(experimentFields['local-time'], Format.stellariumLocalTime(locationDisplay && locationDisplay.local, locationDisplay && locationDisplay.timeZone), false);
      setFieldValue(experimentFields.utc, Format.utc(observation.time.utcIso), false);
      setFieldValue(experimentFields.altitude, Format.degrees(observation.sun.altitudeGeometricDeg), false);
      setFieldValue(experimentFields.azimuth, Format.degrees(observation.sun.azimuthDeg), false);
      setFieldValue(experimentFields.distance, Format.au(observation.sun.distanceAu), false);
      setFieldValue(miniFields['local-time'], Format.utc(observation.time.utcIso), false);
      setFieldValue(miniFields.altitude, Format.degrees(observation.sun.altitudeGeometricDeg), false);
      if (miniSiteEl) miniSiteEl.textContent = Format.latLonPair(observation.location.latitudeDeg, observation.location.longitudeDeg);
    }

    window.SolarChemUIShell.renderLiveExperimentDetail = renderLiveExperimentDetail;

    // Phase 9H-C fix: selectCondition() (below) sets a button's aria-pressed
    // synchronously at click time, based on the REQUESTED condition — it
    // never learns whether Stellarium's live state actually converged to
    // that condition afterward. js/live-integration.js already computes the
    // truthful answer (selectedConditionMatch, via matchCanonicalCondition()
    // comparing the live sun altitude/location/time against each canonical
    // row) and already renders it as the "Condition" text (e.g. "CUSTOM"),
    // but nothing previously reconciled the ALT-button selector against
    // that same answer — so a button could stay visually "selected" for a
    // condition the live state had already determined was NOT confirmed
    // (see reports/validation/phase9h-c-alt-selector-consistency-validation.md
    // for the root cause: this was never a Solarchem calculation bug, it
    // reproduces whenever Stellarium's own Sun-position query is stale,
    // e.g. because Stellarium lost window focus — a characteristic already
    // documented since Phase 9A). Called from live-integration.js's
    // render() on every live state change, so the selector always reflects
    // the last CONFIRMED condition, never a stale or merely-requested one.
    function setLiveAltitudeSelectorMatch(matchedConditionId) {
      altitudeButtons.forEach(function (btn) {
        btn.setAttribute('aria-pressed', btn.getAttribute('data-condition-id') === matchedConditionId ? 'true' : 'false');
      });
    }

    window.SolarChemUIShell.setLiveAltitudeSelectorMatch = setLiveAltitudeSelectorMatch;

    function renderExperimentDetail(condition) {
      setFieldValue(experimentFields.condition, condition.conditionId, false);
      setFieldValue(experimentFields['local-time'], Format.localTime(condition.localDateTimeKst), false);
      setFieldValue(experimentFields.utc, Format.utc(condition.utcDateTime), false);
      setFieldValue(experimentFields.altitude, Format.degrees(condition.stellariumAltitudeGeometricDeg), false);
      setFieldValue(experimentFields.azimuth, Format.degrees(condition.stellariumAzimuthDeg), false);
      setFieldValue(experimentFields.distance, Format.au(condition.stellariumDistanceAu), false);
      if (utcInput) utcInput.value = Format.utc(condition.utcDateTime);
    }

    function renderMiniRail(condition) {
      setFieldValue(miniFields['local-time'], Format.localTime(condition.localDateTimeKst), false);
      setFieldValue(miniFields.altitude, Format.degrees(condition.stellariumAltitudeGeometricDeg), false);
    }

    function renderFrozenContext(condition) {
      if (dateInput) dateInput.value = Format.localDateInputValue(condition.localDateTimeKst);
      if (latitudeInput) latitudeInput.value = Format.latLon(condition.latitudeDeg, 'N', 'S');
      if (longitudeInput) longitudeInput.value = Format.latLon(condition.longitudeDeg, 'E', 'W');
      if (elevationInput) elevationInput.value = Format.elevation(condition.observerAltitudeM);
      if (drawerDateEl) setFieldValue(drawerDateEl, Format.localDate(condition.localDateTimeKst), false);
    }

    function renderTimeInput(condition) {
      if (timeInput) timeInput.value = Format.localTimeInputValue(condition.localDateTimeKst);
    }

    function renderDrawerRowValues(row, condition) {
      var cell = function (field) { return row.querySelector('[data-field="' + field + '"]'); };
      setFieldValue(cell('local-time'), Format.localTime(condition.localDateTimeKst), false);
      setFieldValue(cell('utc'), Format.utc(condition.utcDateTime), false);
      setFieldValue(cell('stellarium-altitude'), Format.degrees(condition.stellariumAltitudeGeometricDeg), false);
      setFieldValue(cell('jpl-airless-elevation'), Format.degrees(condition.ephemerisElevationAirlessDeg), false);
      setFieldValue(cell('azimuth'), Format.degrees(condition.stellariumAzimuthDeg), false);
      setFieldValue(cell('distance'), Format.au(condition.stellariumDistanceAu), false);
    }

    // options.allowStellariumSync: only true for the explicit ALT010-ALTMAX
    // button click handler below. Every other caller (Ephemeris row
    // click/keydown, the canonical restore-to-reference path, the
    // page-load default selection) passes false, so
    // js/live-integration.js's onConditionChange subscriber never mistakes
    // a passive/browsing selection for a deliberate "change Stellarium to
    // this condition" request (see notifyConditionChange() above).
    function selectCondition(conditionId, options) {
      var condition = conditionsById[conditionId];
      if (!condition) return;
      selectedConditionId = conditionId;

      altitudeButtons.forEach(function (btn) {
        btn.setAttribute('aria-pressed', btn.getAttribute('data-condition-id') === conditionId ? 'true' : 'false');
      });

      drawerRows.forEach(function (row) {
        row.setAttribute('aria-selected', row.getAttribute('data-ephemeris-row') === conditionId ? 'true' : 'false');
      });

      renderExperimentDetail(condition);
      renderMiniRail(condition);
      renderTimeInput(condition);
      notifyConditionChange(condition, options);
    }

    function setErrorState(message) {
      Object.keys(experimentFields).forEach(function (key) {
        setFieldValue(experimentFields[key], 'DATA UNAVAILABLE', true);
      });
      Object.keys(miniFields).forEach(function (key) {
        setFieldValue(miniFields[key], 'DATA UNAVAILABLE', true);
      });
      if (drawerDateEl) setFieldValue(drawerDateEl, 'DATA UNAVAILABLE', true);
      drawerRows.forEach(function (row) {
        row.querySelectorAll('[data-field]').forEach(function (cell) {
          setFieldValue(cell, 'DATA UNAVAILABLE', true);
        });
      });
      console.error('[canonical-data] ' + message);
    }

    altitudeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        // The only control whose whole purpose is "change Stellarium to
        // this condition" — see selectCondition()'s options doc above.
        selectCondition(btn.getAttribute('data-condition-id'), { allowStellariumSync: true });
      });
    });

    drawerRows.forEach(function (row) {
      // Ephemeris drawer rows are a read-only reference/comparison table
      // (docs: 13-row canonical ALT010-ALTMAX ephemeris). Clicking one to
      // browse/compare must never be treated as a request to change the
      // live Stellarium condition.
      row.addEventListener('click', function () {
        selectCondition(row.getAttribute('data-ephemeris-row'), { allowStellariumSync: false });
      });
      row.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          selectCondition(row.getAttribute('data-ephemeris-row'), { allowStellariumSync: false });
        }
      });
    });

    window.SolarChemCanonicalData.loadPhase8AEphemeris()
      .then(function (conditions) {
        conditions.forEach(function (condition) {
          conditionsById[condition.conditionId] = condition;
        });

        drawerRows.forEach(function (row) {
          var condition = conditionsById[row.getAttribute('data-ephemeris-row')];
          if (condition) renderDrawerRowValues(row, condition);
        });

        renderFrozenContext(conditions[0]);

        var initiallyPressed = altitudeButtons.filter(function (btn) {
          return btn.getAttribute('aria-pressed') === 'true';
        })[0];
        var initialId = initiallyPressed
          ? initiallyPressed.getAttribute('data-condition-id')
          : 'ALT010';

        // Automatic page-load default — never a user request to change
        // Stellarium (and mode is still 'canonical' at this point anyway,
        // before any Connect click, but explicit here for clarity/defense
        // in depth alongside the other passive selectCondition() callers).
        selectCondition(initialId, { allowStellariumSync: false });
        markCanonicalBinding('ephemeris', 'ready');
      })
      .catch(function (error) {
        setErrorState(error && error.message ? error.message : String(error));
        markCanonicalBinding('ephemeris', 'error', error && error.message ? error.message : String(error));
      });
  }

  // ---------------------------------------------------------------
  // Phase 8B-3 — Solar Spectrum (q_dir) and Molecular Response (R_abs)
  // chart binding. Reuses the shared onConditionChange() subscription
  // (§ above) instead of a second condition state. Chart drawing itself
  // lives in js/charts.js; this function only loads data, wires
  // selection/emphasis interaction, and formats numbers for display.
  // ---------------------------------------------------------------

  function initCanonicalSpectralMolecularBinding() {
    if (!window.SolarChemCanonicalData || !window.SolarChemCharts) {
      markCanonicalBinding('spectralMolecular', 'error', 'canonical data or chart renderer unavailable');
      return;
    }

    var spectrumContainer = document.getElementById('chart-solar-spectrum');
    var responseContainer = document.getElementById('chart-molecular-response');
    var spectrumContext = document.querySelector('[data-chart-context="solar-spectrum"]');
    var compoundButtons = Array.prototype.slice.call(
      document.querySelectorAll('#molecular-response-compounds [data-compound-id]')
    );
    if (!spectrumContainer || !responseContainer) {
      markCanonicalBinding('spectralMolecular', 'error', 'required chart containers missing');
      return;
    }

    var spectraByCondition = null; // { ALT010: [{wavelengthNm, qDir}, ...111], ... }
    var yDomainLog10 = null;
    var responseByCompound = null; // { benzophenone: [{altitudeGeometricDeg, RAbs}, ...13 sorted], ... }
    var responseByCondition = null; // { ALT010: { benzophenone: RAbs, ... }, ... }
    var altitudeDomain = null;
    var molecularChartApi = null;
    var selectedCompoundId = null;
    var pendingCondition = null;
    var dataReady = false;

    function setChartUnavailable(container, label) {
      window.SolarChemCharts.clearContainer(container);
      container.setAttribute('aria-label', label);
      var span = document.createElement('span');
      span.className = 'chart-area__label data-error text-ko';
      span.lang = 'ko';
      span.textContent = '데이터를 불러올 수 없음';
      container.appendChild(span);
    }

    function markSpectralMolecularReadyIfRendered() {
      if (!dataReady || !pendingCondition) return;
      if (spectrumContainer.querySelector('svg') && responseContainer.querySelector('svg')) {
        markCanonicalBinding('spectralMolecular', 'ready');
      }
    }

    function renderSpectrumForCondition(condition) {
      var points = spectraByCondition[condition.conditionId];
      if (!points) return;
      window.SolarChemCharts.renderSolarSpectrumChart(spectrumContainer, points, yDomainLog10);
      spectrumContainer.setAttribute('aria-label', 'Solar spectrum chart for ' + condition.conditionId);

      if (spectrumContext) {
        var altitude = Number(condition.stellariumAltitudeGeometricDeg);
        spectrumContext.textContent = condition.conditionId + ' · ' + Format.localTime(condition.localDateTimeKst) +
          ' · 태양 고도 ' + altitude.toFixed(4) + '°';
        spectrumContext.classList.remove('data-slot');
        spectrumContext.classList.add('data-value');
      }
    }

    function updateMolecularMarker(condition) {
      if (!molecularChartApi) return;
      var values = responseByCondition[condition.conditionId];
      if (!values) return;
      molecularChartApi.setMarkerAltitude(Number(condition.stellariumAltitudeGeometricDeg), values);
    }

    function handleConditionChange(condition) {
      if (!dataReady) {
        pendingCondition = condition;
        return;
      }
      renderSpectrumForCondition(condition);
      updateMolecularMarker(condition);
      markSpectralMolecularReadyIfRendered();
    }

    onConditionChange(handleConditionChange);

    compoundButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var compoundId = btn.getAttribute('data-compound-id');
        var isAlreadySelected = selectedCompoundId === compoundId;
        selectedCompoundId = isAlreadySelected ? null : compoundId;

        compoundButtons.forEach(function (other) {
          other.setAttribute('aria-pressed', other === btn && !isAlreadySelected ? 'true' : 'false');
        });

        if (molecularChartApi) molecularChartApi.setEmphasis(selectedCompoundId);
      });
    });

    Promise.all([
      window.SolarChemCanonicalData.loadPhase6BSolarSpectra(),
      window.SolarChemCanonicalData.loadPhase7CompoundResponse()
    ])
      .then(function (results) {
        var spectraRows = results[0];
        var responseRows = results[1];

        spectraByCondition = {};
        spectraRows.forEach(function (r) {
          var conditionId = r.sampleId;
          if (!spectraByCondition[conditionId]) spectraByCondition[conditionId] = [];
          spectraByCondition[conditionId].push({ wavelengthNm: Number(r.wavelengthNm), qDir: Number(r.qDir) });
        });
        Object.keys(spectraByCondition).forEach(function (conditionId) {
          spectraByCondition[conditionId].sort(function (a, b) { return a.wavelengthNm - b.wavelengthNm; });
        });
        yDomainLog10 = window.SolarChemCharts.computeGlobalLogDomain(spectraRows);
        spectrumYDomainRef = yDomainLog10;

        responseByCompound = {};
        responseByCondition = {};
        var minAlt = Infinity, maxAlt = -Infinity;
        responseRows.forEach(function (r) {
          var compoundId = r.compoundId;
          var altitude = Number(r.altitudeGeometricDeg);
          var rAbs = Number(r.RAbs);
          if (!responseByCompound[compoundId]) responseByCompound[compoundId] = [];
          responseByCompound[compoundId].push({ altitudeGeometricDeg: altitude, RAbs: rAbs });
          if (!responseByCondition[r.sampleId]) responseByCondition[r.sampleId] = {};
          responseByCondition[r.sampleId][compoundId] = rAbs;
          if (altitude < minAlt) minAlt = altitude;
          if (altitude > maxAlt) maxAlt = altitude;
        });
        Object.keys(responseByCompound).forEach(function (compoundId) {
          responseByCompound[compoundId].sort(function (a, b) { return a.altitudeGeometricDeg - b.altitudeGeometricDeg; });
        });
        altitudeDomain = [minAlt, maxAlt];

        molecularChartApi = window.SolarChemCharts.renderMolecularResponseChart(responseContainer, responseByCompound, altitudeDomain);
        molecularChartApiRef = molecularChartApi;
        responseContainer.setAttribute('aria-label', 'Molecular response chart: normalized photon absorption rate versus solar altitude for three compounds');

        dataReady = true;
        if (pendingCondition) {
          renderSpectrumForCondition(pendingCondition);
          updateMolecularMarker(pendingCondition);
          markSpectralMolecularReadyIfRendered();
        }
      })
      .catch(function (error) {
        setChartUnavailable(spectrumContainer, 'Solar spectrum chart unavailable');
        setChartUnavailable(responseContainer, 'Molecular response chart unavailable');
        if (spectrumContext) {
          spectrumContext.textContent = '데이터를 불러올 수 없음';
          spectrumContext.classList.remove('data-slot');
          spectrumContext.classList.add('data-error');
        }
        console.error('[canonical-data] Phase 8B-3 spectral/molecular binding failed: ' + (error && error.message ? error.message : String(error)));
        markCanonicalBinding('spectralMolecular', 'error', error && error.message ? error.message : String(error));
      });
  }

  // ---------------------------------------------------------------
  // Phase 8B-4 — Final Results / publication table binding. Figures
  // are static frozen Phase 7G PNG assets in index.html; only semantic
  // Table 1 and Table 2 are rendered here from canonical CSV selections.
  // ---------------------------------------------------------------

  function initCanonicalFinalResultsBinding() {
    if (!window.SolarChemCanonicalData) {
      markCanonicalBinding('finalTable1', 'error', 'SolarChemCanonicalData unavailable');
      markCanonicalBinding('finalTable2', 'error', 'SolarChemCanonicalData unavailable');
      return;
    }

    var table1Body = document.querySelector('[data-final-table-body="table1"]');
    var table2Body = document.querySelector('[data-final-table-body="table2"]');
    var boundaryNote = document.querySelector('[data-boundary-note]');
    if (!table1Body) markCanonicalBinding('finalTable1', 'error', 'Final Table 1 body hook missing');
    if (!table2Body) markCanonicalBinding('finalTable2', 'error', 'Final Table 2 body hook missing');

    function clearBody(tbody) {
      while (tbody && tbody.firstChild) {
        tbody.removeChild(tbody.firstChild);
      }
    }

    function appendCell(rowEl, tagName, text, rawValue) {
      var cell = document.createElement(tagName);
      cell.className = 'text-en data-value';
      cell.setAttribute('lang', 'en');
      if (tagName === 'th') cell.setAttribute('scope', 'row');
      if (rawValue !== undefined) cell.setAttribute('data-source-value', rawValue);
      cell.textContent = text;
      rowEl.appendChild(cell);
      return cell;
    }

    function renderUnavailable(tbody, colspan, label, error) {
      if (!tbody) return;
      clearBody(tbody);
      var rowEl = document.createElement('tr');
      var cell = document.createElement('td');
      cell.className = 'text-ko data-error';
      cell.setAttribute('lang', 'ko');
      cell.setAttribute('colspan', String(colspan));
      cell.textContent = '데이터를 불러올 수 없음';
      rowEl.appendChild(cell);
      tbody.appendChild(rowEl);
      console.error('[canonical-data] ' + label + ' failed: ' + (error && error.message ? error.message : String(error)));
    }

    function compoundDisplayName(compoundId) {
      var labels = {
        benzophenone: 'Benzophenone',
        luteolin: 'Luteolin',
        quercetin: 'Quercetin'
      };
      return labels[compoundId] || compoundId;
    }

    function renderTable1(rows) {
      if (!table1Body) return;
      clearBody(table1Body);

      rows.forEach(function (row) {
        var rowEl = document.createElement('tr');
        appendCell(rowEl, 'th', row.sampleId);
        appendCell(rowEl, 'td', Format.decimal(row.altitudeGeometricDeg, 4), row.altitudeGeometricDeg);
        appendCell(rowEl, 'td', Format.scientific(row.qDirIntegrated290to400, 4), row.qDirIntegrated290to400);
        appendCell(rowEl, 'td', Format.decimal(row.rAbs.benzophenone, 6), row.rAbs.benzophenone);
        appendCell(rowEl, 'td', Format.decimal(row.rAbs.luteolin, 6), row.rAbs.luteolin);
        appendCell(rowEl, 'td', Format.decimal(row.rAbs.quercetin, 6), row.rAbs.quercetin);
        table1Body.appendChild(rowEl);
      });
    }

    function renderTable2(rows) {
      if (!table2Body) return;
      clearBody(table2Body);

      var hasBenzophenoneBoundaryCase = rows.some(function (row) {
        return row.sampleId === 'ALT010' &&
          row.compoundId === 'benzophenone' &&
          Number(row.peakContributionWavelengthNm) === 400;
      });

      rows.forEach(function (row) {
        var rowEl = document.createElement('tr');
        var peakText = Format.wavelengthGrid(row.peakContributionWavelengthNm);
        var isBoundaryCase = row.sampleId === 'ALT010' &&
          row.compoundId === 'benzophenone' &&
          Number(row.peakContributionWavelengthNm) === 400;

        appendCell(rowEl, 'th', row.sampleId);
        appendCell(rowEl, 'td', compoundDisplayName(row.compoundId), row.compoundId);
        appendCell(rowEl, 'td', Format.wavelengthMean(row.contributionWeightedMeanWavelengthNm), row.contributionWeightedMeanWavelengthNm);
        appendCell(rowEl, 'td', Format.wavelengthGrid(row.lambda50Nm), row.lambda50Nm);
        appendCell(rowEl, 'td', isBoundaryCase ? peakText + '*' : peakText, row.peakContributionWavelengthNm);
        if (isBoundaryCase) {
          rowEl.setAttribute('data-boundary-case', 'benzophenone-alt010-peak-400');
        }
        table2Body.appendChild(rowEl);
      });

      if (boundaryNote) {
        if (hasBenzophenoneBoundaryCase) {
          boundaryNote.hidden = false;
          boundaryNote.textContent = '* 400 nm는 290-400 nm 분석 구간의 상한 경계이며, 실제 스펙트럼 최댓값으로 해석해서는 안 됨.';
        } else {
          boundaryNote.hidden = true;
          boundaryNote.textContent = '';
        }
      }
    }

    if (table1Body) {
      window.SolarChemCanonicalData.loadPhase7GFinalTable1()
        .then(function (rows) {
          renderTable1(rows);
          markCanonicalBinding('finalTable1', 'ready');
        })
        .catch(function (error) {
          renderUnavailable(table1Body, 6, 'Phase 8B-4 Final Table 1 binding', error);
          markCanonicalBinding('finalTable1', 'error', error && error.message ? error.message : String(error));
        });
    }

    if (table2Body) {
      window.SolarChemCanonicalData.loadPhase7GFinalTable2()
        .then(function (rows) {
          renderTable2(rows);
          markCanonicalBinding('finalTable2', 'ready');
        })
        .catch(function (error) {
          renderUnavailable(table2Body, 5, 'Phase 8B-4 Final Table 2 binding', error);
          if (boundaryNote) {
            boundaryNote.hidden = true;
            boundaryNote.textContent = '';
          }
          markCanonicalBinding('finalTable2', 'error', error && error.message ? error.message : String(error));
        });
    }
  }

  function initExclusiveToggleGroups(selector) {
    document.querySelectorAll(selector).forEach(function (group) {
      var options = group.querySelectorAll('[aria-pressed]');
      options.forEach(function (option) {
        option.addEventListener('click', function () {
          options.forEach(function (other) {
            other.setAttribute('aria-pressed', other === option ? 'true' : 'false');
          });
        });
      });
    });
  }

  function initActiveSectionNav() {
    var sections = document.querySelectorAll('main > section[id]');
    var railLinks = document.querySelectorAll('[data-rail-link]');
    if (!sections.length || !railLinks.length) return;

    if (!('IntersectionObserver' in window)) return;

    var setActive = function (id) {
      railLinks.forEach(function (link) {
        var isActive = link.getAttribute('data-rail-link') === id;
        link.classList.toggle('is-active', isActive);
        if (isActive) {
          link.setAttribute('aria-current', 'location');
        } else {
          link.removeAttribute('aria-current');
        }
      });
    };

    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            setActive(entry.target.id);
          }
        });
      },
      { rootMargin: '-40% 0px -50% 0px', threshold: 0 }
    );

    sections.forEach(function (section) {
      observer.observe(section);
    });
  }

  function initEphemerisDrawer() {
    var drawer = document.getElementById('ephemeris-drawer');
    var backdrop = document.querySelector('[data-drawer-backdrop]');
    var triggers = document.querySelectorAll('[data-drawer-trigger="ephemeris-drawer"]');
    var closeButtons = drawer ? drawer.querySelectorAll('[data-drawer-close]') : [];
    if (!drawer || !backdrop || !triggers.length) return;

    var lastTrigger = null;
    var isOpen = false;

    function focusableElements() {
      return Array.prototype.slice.call(
        drawer.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
    }

    function setTriggerState(expanded) {
      triggers.forEach(function (trigger) {
        trigger.setAttribute('aria-expanded', String(expanded));
        if (trigger.dataset.labelOpen && trigger.dataset.labelClose) {
          trigger.textContent = expanded ? trigger.dataset.labelClose : trigger.dataset.labelOpen;
        }
      });
    }

    function openDrawer(trigger) {
      if (isOpen) return;
      isOpen = true;
      lastTrigger = trigger || null;
      drawer.classList.add('is-open');
      drawer.setAttribute('aria-hidden', 'false');
      backdrop.hidden = false;
      requestAnimationFrame(function () {
        backdrop.classList.add('is-visible');
      });
      document.body.classList.add('drawer-open');
      setTriggerState(true);

      var heading = document.getElementById('ephemeris-drawer-title');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus();
      }

      document.addEventListener('keydown', onKeydown);
    }

    function closeDrawer() {
      if (!isOpen) return;
      isOpen = false;
      drawer.classList.remove('is-open');
      drawer.setAttribute('aria-hidden', 'true');
      backdrop.classList.remove('is-visible');
      document.body.classList.remove('drawer-open');
      setTriggerState(false);
      document.removeEventListener('keydown', onKeydown);

      window.setTimeout(function () {
        if (!isOpen) backdrop.hidden = true;
      }, 320);

      if (lastTrigger) {
        lastTrigger.focus();
      }
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeDrawer();
        return;
      }

      if (event.key === 'Tab') {
        var focusable = focusableElements();
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    triggers.forEach(function (trigger) {
      trigger.addEventListener('click', function () {
        openDrawer(trigger);
      });
    });

    closeButtons.forEach(function (button) {
      button.addEventListener('click', closeDrawer);
    });

    backdrop.addEventListener('click', closeDrawer);

    initLiveEphemerisView(drawer);
    initEphemerisCsvDownload(drawer);
  }

  // ---------------------------------------------------------------
  // Phase 10L — Live Ephemeris view. js/live-integration.js generates the
  // table from Stellarium (generateLiveEphemeris()) and hands it here through
  // window.SolarChemUIShell.setEphemerisView(view); this only renders it.
  //   { source: 'reference' }                 frozen Phase 8A table (unchanged)
  //   { source: 'live', status: 'idle' }      live, nothing generated yet
  //   { source: 'live', status: 'generating' }
  //   { source: 'live', status: 'ready', result }
  //   { source: 'live', status: 'error', message }
  // While live, the frozen Incheon rows are never displayed. Live rows are
  // read-only: selecting one only highlights it (no selectCondition(), no
  // Stellarium write - the Phase 9H-D ownership rule). The JPL Horizons column
  // belongs to the frozen reference validation set and has no live
  // counterpart, so the live table has none.
  // ---------------------------------------------------------------

  var LIVE_EPHEMERIS_STATUS_TEXT = Object.freeze({
    'not-reached': 'Not reached',
    'no-ascending-crossing': 'No ascending crossing'
  });

  function initLiveEphemerisView(drawer) {
    var referenceEls = Array.prototype.slice.call(drawer.querySelectorAll('[data-ephemeris-reference]'));
    var liveMeta = drawer.querySelector('[data-live-ephemeris-meta]');
    var liveStatus = drawer.querySelector('[data-live-ephemeris-status]');
    var liveWrap = drawer.querySelector('[data-live-ephemeris]');
    var liveBody = drawer.querySelector('[data-live-ephemeris-tbody]');
    var csvButton = drawer.querySelector('[data-ephemeris-csv]');
    if (!referenceEls.length || !liveMeta || !liveStatus || !liveWrap || !liveBody) return;

    function clearLiveRows() {
      while (liveBody.firstChild) liveBody.removeChild(liveBody.firstChild);
    }

    function appendCell(rowEl, tagName, text) {
      var cell = document.createElement(tagName);
      cell.className = 'text-en data-value';
      cell.setAttribute('lang', 'en');
      if (tagName === 'th') cell.setAttribute('scope', 'row');
      cell.textContent = text;
      rowEl.appendChild(cell);
    }

    function selectLiveRow(rowEl) {
      Array.prototype.forEach.call(liveBody.querySelectorAll('tr[data-live-ephemeris-row]'), function (r) {
        r.setAttribute('aria-selected', r === rowEl ? 'true' : 'false');
      });
    }

    function renderLiveRows(result) {
      clearLiveRows();
      result.rows.forEach(function (row) {
        var rowEl = document.createElement('tr');
        rowEl.setAttribute('data-live-ephemeris-row', row.conditionId);
        rowEl.setAttribute('data-live-ephemeris-status', row.status);
        rowEl.setAttribute('tabindex', '0');
        rowEl.setAttribute('aria-selected', 'false');
        appendCell(rowEl, 'th', row.conditionId);
        if (row.status === 'reached') {
          appendCell(rowEl, 'td', Format.stellariumLocalTime(row.local, row.timeZone));
          appendCell(rowEl, 'td', Format.utc(row.utcIso));
          appendCell(rowEl, 'td', Format.degrees(row.altitudeGeometricDeg));
          appendCell(rowEl, 'td', Format.degrees(row.azimuthDeg));
          appendCell(rowEl, 'td', Format.au(row.distanceAu));
        } else {
          appendCell(rowEl, 'td', LIVE_EPHEMERIS_STATUS_TEXT[row.status] || 'Unavailable');
          for (var i = 0; i < 4; i += 1) appendCell(rowEl, 'td', '\u2014');
        }
        rowEl.addEventListener('click', function () { selectLiveRow(rowEl); });
        rowEl.addEventListener('keydown', function (event) {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            selectLiveRow(rowEl);
          }
        });
        liveBody.appendChild(rowEl);
      });
    }

    function liveContextText(result) {
      var parts = ['13 conditions', 'Live Stellarium'];
      if (result) {
        parts.push(
          result.localDate,
          Format.latLonPair(result.latitudeDeg, result.longitudeDeg),
          Format.elevation(result.altitudeM),
          Format.stellariumLocationName(result.locationName),
          Format.stellariumTimeZone(result.timeZone)
        );
      }
      return parts.join(' \u00b7 ');
    }

    window.SolarChemUIShell.setEphemerisView = function (view) {
      var isLive = !!view && view.source === 'live';
      var status = isLive ? view.status : null;
      var ready = status === 'ready' && view.result;
      referenceEls.forEach(function (el) { el.hidden = isLive; });
      liveMeta.hidden = !isLive;
      liveMeta.textContent = isLive ? liveContextText(ready ? view.result : null) : '';
      liveWrap.hidden = !ready;
      if (ready) {
        renderLiveRows(view.result);
        liveWrap.setAttribute('data-live-ephemeris-date', view.result.localDate);
      } else {
        clearLiveRows();
        liveWrap.removeAttribute('data-live-ephemeris-date');
      }
      var statusText = status === 'generating' ? 'Generating live ephemeris\u2026' : status === 'error' ? view.message : '';
      liveStatus.textContent = statusText || '';
      liveStatus.hidden = !statusText;
      liveStatus.classList.toggle('data-error', status === 'error');
      if (csvButton) csvButton.disabled = isLive && !ready;
    };
  }

  // Exports exactly what the full ephemeris table already shows — reads
  // rendered cell text from the DOM, computes nothing, converts no units.
  // A header cell's own <br> (e.g. "Stellarium" / "기하학적 고도" on two
  // lines) becomes a single space in the exported column label, since a
  // literal line break inside one CSV field would need embedded quoting
  // for no benefit here.
  function cellText(el) {
    var parts = [];
    el.childNodes.forEach(function (node) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent);
      } else if (node.nodeName === 'BR') {
        parts.push(' ');
      } else {
        parts.push(node.textContent);
      }
    });
    return parts.join('').replace(/\s+/g, ' ').trim();
  }

  function csvField(value) {
    return '"' + String(value).replace(/"/g, '""') + '"';
  }

  // Phase 10L: exports whichever table is displayed - the frozen reference
  // table, or the generated Live table (its rows, "Not reached" included,
  // exactly as shown). Nothing is recalculated or re-queried.
  function displayedEphemerisTable(drawer) {
    return Array.prototype.slice.call(drawer.querySelectorAll('.ephemeris-drawer__table')).filter(function (table) {
      var wrap = table.closest('.table-scroll');
      return !(wrap && wrap.hidden);
    })[0] || null;
  }

  function initEphemerisCsvDownload(drawer) {
    var button = drawer.querySelector('[data-ephemeris-csv]');
    if (!button || !displayedEphemerisTable(drawer)) return;

    button.addEventListener('click', function () {
      var table = displayedEphemerisTable(drawer);
      if (!table) return;
      var liveWrap = table.closest('[data-live-ephemeris]');
      var headerCells = Array.prototype.slice.call(table.querySelectorAll('thead th'));
      var rows = Array.prototype.slice.call(table.querySelectorAll('tbody tr[data-ephemeris-row], tbody tr[data-live-ephemeris-row]'));
      if (!headerCells.length || !rows.length) return;

      var lines = [headerCells.map(cellText).map(csvField).join(',')];
      rows.forEach(function (row) {
        var cells = Array.prototype.slice.call(row.querySelectorAll('th, td'));
        lines.push(cells.map(cellText).map(csvField).join(','));
      });

      var dateMeta = document.querySelector('[data-ephemeris-meta="date"]');
      var dateSlug = dateMeta ? cellText(dateMeta).replace(/[^0-9A-Za-z-]/g, '') : '';
      var filename = 'solarchem-ephemeris' + (dateSlug ? '-' + dateSlug : '') + '.csv';
      if (liveWrap) {
        var liveDate = (liveWrap.getAttribute('data-live-ephemeris-date') || '').replace(/[^0-9A-Za-z-]/g, '');
        filename = 'solarchem-live-ephemeris' + (liveDate ? '-' + liveDate : '') + '.csv';
      }

      var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    });
  }

  // ---------------------------------------------------------------
  // Phase 8B-7 — small centered info dialogs (How to use / Stellarium
  // connection status). Reuses the ephemeris drawer's focus-trap / ESC /
  // backdrop-click pattern above instead of a second implementation; the
  // only structural difference is .info-dialog's centered-popup CSS
  // instead of the drawer's slide-up panel.
  // ---------------------------------------------------------------

  function initInfoDialog(dialogEl, backdropEl, triggers) {
    if (!dialogEl || !backdropEl) return null;

    var lastTrigger = null;
    var isOpen = false;

    function focusableElements() {
      return Array.prototype.slice.call(
        dialogEl.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      );
    }

    function setTriggerState(expanded) {
      triggers.forEach(function (trigger) {
        trigger.setAttribute('aria-expanded', String(expanded));
      });
    }

    function open(trigger) {
      if (isOpen) return;
      isOpen = true;
      lastTrigger = trigger || document.activeElement;
      dialogEl.classList.add('is-open');
      dialogEl.setAttribute('aria-hidden', 'false');
      backdropEl.hidden = false;
      requestAnimationFrame(function () {
        backdropEl.classList.add('is-visible');
      });
      setTriggerState(true);

      var heading = dialogEl.querySelector('[id$="-title"]');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus();
      }

      document.addEventListener('keydown', onKeydown);
    }

    function close() {
      if (!isOpen) return;
      isOpen = false;
      dialogEl.classList.remove('is-open');
      dialogEl.setAttribute('aria-hidden', 'true');
      backdropEl.classList.remove('is-visible');
      setTriggerState(false);
      document.removeEventListener('keydown', onKeydown);

      window.setTimeout(function () {
        if (!isOpen) backdropEl.hidden = true;
      }, 320);

      if (lastTrigger && typeof lastTrigger.focus === 'function') {
        lastTrigger.focus();
      }
    }

    function onKeydown(event) {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }

      if (event.key === 'Tab') {
        var focusable = focusableElements();
        if (!focusable.length) return;
        var first = focusable[0];
        var last = focusable[focusable.length - 1];

        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    }

    triggers.forEach(function (trigger) {
      trigger.addEventListener('click', function () {
        open(trigger);
      });
    });

    dialogEl.querySelectorAll('[data-drawer-close]').forEach(function (button) {
      button.addEventListener('click', close);
    });

    backdropEl.addEventListener('click', close);

    return { open: open, close: close, isOpen: function () { return isOpen; } };
  }

  function initHowToUseDialog() {
    var dialogEl = document.getElementById('how-to-use-dialog');
    var backdropEl = document.querySelector('[data-drawer-backdrop="how-to-use"]');
    var triggers = Array.prototype.slice.call(document.querySelectorAll('[data-drawer-trigger="how-to-use"]'));
    initInfoDialog(dialogEl, backdropEl, triggers);

    // Packaged Electron builds auto-start the local server, so Step 2 must
    // not tell the user to run python3 -m http.server themselves. A hosted
    // deployment (e.g. GitHub Pages) is already "running" the moment the
    // page loads over a real HTTPS origin, so it must show neither the
    // Electron nor the manual-local-server instructions — it also needs an
    // extra one-time Stellarium CORS-origin step the other two runtimes
    // don't (Phase 10C).
    var isElectron = /electron/i.test(navigator.userAgent);
    var isLoopback = location.protocol === 'file:' || /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(location.hostname);
    var runtime = isElectron ? 'packaged' : (isLoopback ? 'browser' : 'hosted');

    ['packaged', 'browser', 'hosted'].forEach(function (name) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-howto-runtime="' + name + '"]'), function (el) {
        el.hidden = runtime !== name;
      });
    });

    if (runtime === 'hosted') {
      Array.prototype.forEach.call(document.querySelectorAll('[data-hosted-url]'), function (el) {
        el.textContent = location.origin + location.pathname;
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-hosted-cors-origin]'), function (el) {
        el.textContent = location.origin;
      });
    }
  }

  // Revision 2 — replaces the removed .ssc download link / one-shot "Copy
  // script template" button. Fetches the same template file (still the
  // single source of truth for the shipped script content — see
  // scripts/solarchem-condition-template.ssc) into an editable <textarea>
  // instead of triggering a file download, so a person edits location/
  // date/time inline and copies the result, never downloads a file. "전체
  // 복사" copies whatever is currently in the textarea (including any
  // edits), not the original fetched text — "코드 초기화" restores the
  // original if needed.
  function initScriptEditorDialog() {
    var dialogEl = document.getElementById('script-editor-dialog');
    var backdropEl = document.querySelector('[data-drawer-backdrop="script-editor"]');
    var triggers = Array.prototype.slice.call(document.querySelectorAll('[data-drawer-trigger="script-editor"]'));
    initInfoDialog(dialogEl, backdropEl, triggers);

    var textarea = document.querySelector('[data-script-editor-textarea]');
    var copyButton = document.querySelector('[data-script-copy]');
    var resetButton = document.querySelector('[data-script-reset]');
    var statusEl = document.querySelector('[data-script-copy-status]');
    if (!textarea) return;

    var originalText = null;
    var loadPromise = null;

    function loadTemplate() {
      if (loadPromise) return loadPromise;
      loadPromise = fetch('scripts/solarchem-condition-template.ssc')
        .then(function (response) {
          if (!response.ok) throw new Error('fetch failed');
          return response.text();
        })
        .then(function (text) {
          originalText = text;
          if (!textarea.value) textarea.value = text;
          return text;
        })
        .catch(function () {
          if (statusEl) statusEl.textContent = '코드를 불러오지 못했습니다.';
        });
      return loadPromise;
    }

    triggers.forEach(function (trigger) {
      trigger.addEventListener('click', loadTemplate);
    });

    if (copyButton) {
      copyButton.addEventListener('click', function () {
        navigator.clipboard.writeText(textarea.value)
          .then(function () {
            if (statusEl) statusEl.textContent = '복사 완료';
          })
          .catch(function () {
            if (statusEl) statusEl.textContent = '복사하지 못했습니다 — 직접 선택해 복사해 주세요.';
          });
      });
    }

    if (resetButton) {
      resetButton.addEventListener('click', function () {
        if (originalText !== null) {
          textarea.value = originalText;
          if (statusEl) statusEl.textContent = '코드 초기화됨';
        }
      });
    }
  }

  // Exposed so js/live-integration.js can show the connection-result
  // dialog after a user-initiated Connect/Sync click, without this file
  // taking any dependency on live-integration.js (same pattern as
  // restoreCanonicalSelection() above). Content for both states is fixed,
  // author-written markup built here with createElement/textContent only
  // (no innerHTML) — showConnectionDialog() takes a `kind` flag, never an
  // HTML string, so there is no injection surface even if a future caller
  // passed through something Stellarium-supplied.
  function initConnectionDialog() {
    var dialogEl = document.getElementById('connection-dialog');
    var backdropEl = document.querySelector('[data-drawer-backdrop="connection"]');
    var controller = initInfoDialog(dialogEl, backdropEl, []);
    if (!controller) return;

    var titleEl = document.querySelector('[data-connection-dialog-title]');
    var bodyEl = document.querySelector('[data-connection-dialog-body]');

    function clearBody() {
      while (bodyEl && bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild);
    }

    function paragraph(text) {
      var p = document.createElement('p');
      p.className = 'text-ko';
      p.lang = 'ko';
      p.textContent = text;
      return p;
    }

    function buildConnectedBody() {
      clearBody();
      bodyEl.appendChild(paragraph('Solarchem이 Stellarium에서 현재 위치, 시간, 태양 위치를 실시간으로 받고 있습니다.'));
    }

    // defaultEndpoint: plain text only (inserted via textContent, never
    // HTML) — passed in by the caller rather than hardcoded here, so this
    // file's own source never mentions Stellarium's live endpoint
    // directly (kept out of js/ui-shell.js by the same architectural rule
    // tests/phase8b4-final-results-binding-test.js already enforces: no
    // live Stellarium endpoint reference in this file).
    function buildNotConnectedBody(defaultEndpoint) {
      clearBody();
      bodyEl.appendChild(paragraph('Solarchem이 Stellarium에 연결하지 못했습니다. 연결하려면:'));
      var ol = document.createElement('ol');
      ol.className = 'connection-dialog__steps';
      [
        'Stellarium 실행',
        'Remote Control 활성화 (설정 → 플러그인 → Remote Control → 서버 활성화)',
        'Remote Control 서버 실행 확인',
        'Solarchem으로 복귀',
        'Connect Stellarium(또는 Sync Stellarium) 다시 선택'
      ].forEach(function (text) {
        var li = document.createElement('li');
        li.appendChild(paragraph(text));
        ol.appendChild(li);
      });
      bodyEl.appendChild(ol);
      if (defaultEndpoint) {
        bodyEl.appendChild(paragraph('기본 연결: ' + defaultEndpoint));
      }
    }

    window.SolarChemUIShell.showConnectionDialog = function (kind, autoCloseMs, defaultEndpoint) {
      if (!dialogEl || !bodyEl) return;
      if (kind === 'connected') {
        if (titleEl) titleEl.textContent = 'Stellarium connected';
        buildConnectedBody();
      } else {
        if (titleEl) titleEl.textContent = 'Stellarium not connected';
        buildNotConnectedBody(defaultEndpoint);
      }
      controller.open(document.querySelector('[data-live-connect]'));
      if (autoCloseMs) {
        window.setTimeout(function () {
          controller.close();
        }, autoCloseMs);
      }
    };
  }

  document.addEventListener('DOMContentLoaded', function () {
    // #molecular-response-compounds is excluded here — its aria-pressed
    // toggling and click behavior is fully owned by
    // initCanonicalSpectralMolecularBinding() (compound emphasis + toggle
    // are the same click), so it isn't double-bound.
    initExclusiveToggleGroups('.option-list:not(#molecular-response-compounds)');
    initActiveSectionNav();
    initEphemerisDrawer();
    initHowToUseDialog();
    initScriptEditorDialog();
    initConnectionDialog();
    initCanonicalEphemerisBinding();
    initCanonicalSpectralMolecularBinding();
    initCanonicalFinalResultsBinding();
  });
})();
