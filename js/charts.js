// charts.js
// Phase 8B-3 — canonical chart rendering (vanilla SVG, no external library).
//
// Draws only what is already in the loaded canonical data. No scientific
// calculation, no interpolation between wavelengths/altitudes, no curve
// fitting or smoothing — curves are straight line segments through the real
// data points only (the same visual convention any plotting library uses
// to connect discrete samples). js/canonical-data.js loads/validates the
// data; js/ui-shell.js owns selection state; this file only draws.

(function (global) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var SUPERSCRIPT_DIGITS = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

  function svgEl(tag, attrs) {
    var el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        el.setAttribute(key, attrs[key]);
      });
    }
    return el;
  }

  function textEl(attrs, text) {
    var el = svgEl('text', attrs);
    el.textContent = text;
    return el;
  }

  function toSuperscript(n) {
    return String(n).split('').map(function (ch) { return SUPERSCRIPT_DIGITS[ch] || ch; }).join('');
  }

  function clearContainer(container) {
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
  }

  // ---------------------------------------------------------------
  // Solar Spectrum: q_dir(lambda), 290-400nm, fixed log-y domain shared
  // across all 13 conditions (so switching condition shows the real
  // magnitude change — not a per-condition autoscale that would hide it).
  // Log scale matches Phase 7's own absolute-spectrum convention
  // (reports/figures/phase7/phase7a_fig01_qdir_absolute_representative.png,
  // "log y" per docs/phase7-analysis.md).
  // ---------------------------------------------------------------

  var SPECTRUM_LAYOUT = {
    width: 1000,
    height: 420,
    marginLeft: 64,
    marginRight: 16,
    marginTop: 16,
    marginBottom: 32
  };

  function renderSolarSpectrumChart(container, points, yDomainLog10) {
    clearContainer(container);

    var L = SPECTRUM_LAYOUT;
    var plotW = L.width - L.marginLeft - L.marginRight;
    var plotH = L.height - L.marginTop - L.marginBottom;
    var xMin = 290, xMax = 400;

    function xPos(wavelength) {
      return L.marginLeft + ((wavelength - xMin) / (xMax - xMin)) * plotW;
    }
    function yPos(qDir) {
      var logV = Math.log10(Math.max(qDir, Math.pow(10, yDomainLog10[0])));
      var t = (logV - yDomainLog10[0]) / (yDomainLog10[1] - yDomainLog10[0]);
      return L.marginTop + (1 - t) * plotH;
    }

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + L.width + ' ' + L.height,
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
      focusable: 'false'
    });
    svg.setAttribute('class', 'chart-svg');

    // axes
    svg.appendChild(svgEl('line', { x1: L.marginLeft, y1: L.marginTop, x2: L.marginLeft, y2: L.marginTop + plotH, class: 'chart-axis' }));
    svg.appendChild(svgEl('line', { x1: L.marginLeft, y1: L.marginTop + plotH, x2: L.marginLeft + plotW, y2: L.marginTop + plotH, class: 'chart-axis' }));

    // x ticks (wavelength, nm)
    [290, 310, 330, 350, 370, 390, 400].forEach(function (wl) {
      var x = xPos(wl);
      svg.appendChild(svgEl('line', { x1: x, y1: L.marginTop + plotH, x2: x, y2: L.marginTop + plotH + 5, class: 'chart-tick' }));
      svg.appendChild(textEl({ x: x, y: L.marginTop + plotH + 20, class: 'chart-tick-label', 'text-anchor': 'middle' }, String(wl)));
    });
    svg.appendChild(textEl({ x: L.marginLeft + plotW / 2, y: L.height - 4, class: 'chart-axis-label', 'text-anchor': 'middle' }, 'Wavelength (nm)'));

    // y ticks (log decades)
    var startDecade = Math.ceil(yDomainLog10[0]);
    var endDecade = Math.floor(yDomainLog10[1]);
    var span = endDecade - startDecade;
    var step = Math.max(1, Math.round(span / 6));
    for (var d = startDecade; d <= endDecade; d += step) {
      var y = yPos(Math.pow(10, d));
      svg.appendChild(svgEl('line', { x1: L.marginLeft - 5, y1: y, x2: L.marginLeft, y2: y, class: 'chart-tick' }));
      svg.appendChild(textEl({ x: L.marginLeft - 9, y: y + 4, class: 'chart-tick-label', 'text-anchor': 'end' }, '10' + toSuperscript(d)));
    }
    svg.appendChild(textEl({
      x: 14, y: L.marginTop + plotH / 2, class: 'chart-axis-label',
      'text-anchor': 'middle', transform: 'rotate(-90 14 ' + (L.marginTop + plotH / 2) + ')'
    }, 'q_dir (photons cm⁻² s⁻¹ nm⁻¹)'));

    // curve — straight segments through the real 111 data points only
    var d = '';
    points.forEach(function (p, i) {
      var x = xPos(p.wavelengthNm);
      var y = yPos(p.qDir);
      d += (i === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
    });
    svg.appendChild(svgEl('path', { d: d.trim(), class: 'chart-line chart-line--spectrum' }));

    container.appendChild(svg);
  }

  function computeGlobalLogDomain(rows) {
    var min = Infinity;
    var max = -Infinity;
    rows.forEach(function (r) {
      var v = Number(r.qDir);
      if (v > 0 && v < min) min = v;
      if (v > max) max = v;
    });
    return [Math.floor(Math.log10(min)), Math.ceil(Math.log10(max))];
  }

  // ---------------------------------------------------------------
  // Molecular Response: R_abs(h) vs. actual Stellarium geometric solar
  // altitude (degrees) — not the categorical button label. 3 compound
  // curves are distinguished by color AND dash pattern AND a direct end
  // label (never color alone). Returns a small API so the caller can move
  // the selected-condition marker / change compound emphasis without a
  // full chart rebuild.
  // ---------------------------------------------------------------

  var RESPONSE_LAYOUT = {
    width: 1000,
    height: 420,
    marginLeft: 48,
    marginRight: 108,
    marginTop: 16,
    marginBottom: 32
  };

  var COMPOUND_STYLE = {
    benzophenone: { className: 'chart-line--benzophenone', label: 'Benzophenone' },
    luteolin: { className: 'chart-line--luteolin', label: 'Luteolin' },
    quercetin: { className: 'chart-line--quercetin', label: 'Quercetin' }
  };

  function renderMolecularResponseChart(container, seriesByCompound, altitudeDomain) {
    clearContainer(container);

    var L = RESPONSE_LAYOUT;
    var plotW = L.width - L.marginLeft - L.marginRight;
    var plotH = L.height - L.marginTop - L.marginBottom;
    var xMin = altitudeDomain[0], xMax = altitudeDomain[1];

    function xPos(altDeg) {
      return L.marginLeft + ((altDeg - xMin) / (xMax - xMin)) * plotW;
    }
    function yPos(rAbs) {
      return L.marginTop + (1 - rAbs) * plotH;
    }

    var svg = svgEl('svg', {
      viewBox: '0 0 ' + L.width + ' ' + L.height,
      width: '100%',
      height: '100%',
      preserveAspectRatio: 'none',
      'aria-hidden': 'true',
      focusable: 'false'
    });
    svg.setAttribute('class', 'chart-svg');

    svg.appendChild(svgEl('line', { x1: L.marginLeft, y1: L.marginTop, x2: L.marginLeft, y2: L.marginTop + plotH, class: 'chart-axis' }));
    svg.appendChild(svgEl('line', { x1: L.marginLeft, y1: L.marginTop + plotH, x2: L.marginLeft + plotW, y2: L.marginTop + plotH, class: 'chart-axis' }));

    // x ticks (actual geometric altitude, rounded to nearest 10 deg within range)
    for (var t = Math.ceil(xMin / 10) * 10; t <= xMax; t += 10) {
      var x = xPos(t);
      svg.appendChild(svgEl('line', { x1: x, y1: L.marginTop + plotH, x2: x, y2: L.marginTop + plotH + 5, class: 'chart-tick' }));
      svg.appendChild(textEl({ x: x, y: L.marginTop + plotH + 20, class: 'chart-tick-label', 'text-anchor': 'middle' }, String(t) + '°'));
    }
    svg.appendChild(textEl({ x: L.marginLeft + plotW / 2, y: L.height - 4, class: 'chart-axis-label', 'text-anchor': 'middle' }, 'Solar geometric altitude (°)'));

    // y ticks 0, 0.5, 1
    [0, 0.5, 1].forEach(function (v) {
      var y = yPos(v);
      svg.appendChild(svgEl('line', { x1: L.marginLeft - 5, y1: y, x2: L.marginLeft, y2: y, class: 'chart-tick' }));
      svg.appendChild(textEl({ x: L.marginLeft - 9, y: y + 4, class: 'chart-tick-label', 'text-anchor': 'end' }, v.toFixed(1)));
    });
    svg.appendChild(textEl({
      x: 14, y: L.marginTop + plotH / 2, class: 'chart-axis-label',
      'text-anchor': 'middle', transform: 'rotate(-90 14 ' + (L.marginTop + plotH / 2) + ')'
    }, 'R_abs'));

    var curveGroups = {};
    var compoundIds = global.SolarChemCanonicalData.EXPECTED_COMPOUND_IDS;

    // End-label vertical positions, decluttered — at ALTMAX all three
    // compounds converge to R_abs = 1 by definition (§ canonical R_abs(h) =
    // k_abs,dir(h)/k_abs,dir(h_max)), so their natural label positions
    // coincide. This only nudges label *text* apart to stay legible; it
    // does not move the curves, the marker dots, or any data point.
    var labelInfo = compoundIds.map(function (compoundId) {
      var series = seriesByCompound[compoundId];
      var last = series[series.length - 1];
      return { compoundId: compoundId, x: xPos(last.altitudeGeometricDeg) + 8, y: yPos(last.RAbs) };
    });
    labelInfo.sort(function (a, b) { return a.y - b.y; });
    var MIN_LABEL_GAP = 15;
    for (var li = 1; li < labelInfo.length; li += 1) {
      if (labelInfo[li].y - labelInfo[li - 1].y < MIN_LABEL_GAP) {
        labelInfo[li].y = labelInfo[li - 1].y + MIN_LABEL_GAP;
      }
    }
    var labelYById = {};
    labelInfo.forEach(function (info) { labelYById[info.compoundId] = info.y; });

    compoundIds.forEach(function (compoundId) {
      var series = seriesByCompound[compoundId];
      var style = COMPOUND_STYLE[compoundId];
      var group = svgEl('g', { class: 'chart-series', 'data-compound-id': compoundId });

      var d = '';
      series.forEach(function (p, i) {
        var x = xPos(p.altitudeGeometricDeg);
        var y = yPos(p.RAbs);
        d += (i === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2) + ' ';
      });
      var path = svgEl('path', { d: d.trim(), class: 'chart-line ' + style.className });
      group.appendChild(path);

      var last = series[series.length - 1];
      var label = textEl({
        x: xPos(last.altitudeGeometricDeg) + 8, y: labelYById[compoundId] + 4,
        class: 'chart-end-label ' + style.className
      }, style.label);
      group.appendChild(label);

      svg.appendChild(group);
      curveGroups[compoundId] = group;
    });

    // selected-condition marker: vertical rule + one dot per compound curve
    var markerGroup = svgEl('g', { class: 'chart-marker', 'aria-hidden': 'true' });
    var markerLine = svgEl('line', { x1: 0, y1: L.marginTop, x2: 0, y2: L.marginTop + plotH, class: 'chart-marker-line' });
    markerGroup.appendChild(markerLine);
    var markerDots = {};
    global.SolarChemCanonicalData.EXPECTED_COMPOUND_IDS.forEach(function (compoundId) {
      var dot = svgEl('circle', { r: 4, class: 'chart-marker-dot ' + COMPOUND_STYLE[compoundId].className });
      markerGroup.appendChild(dot);
      markerDots[compoundId] = dot;
    });
    svg.appendChild(markerGroup);

    container.appendChild(svg);

    return {
      setMarkerAltitude: function (altDeg, valuesByCompound) {
        markerGroup.classList.remove('is-altitude-only');
        var x = xPos(altDeg);
        markerLine.setAttribute('x1', x);
        markerLine.setAttribute('x2', x);
        global.SolarChemCanonicalData.EXPECTED_COMPOUND_IDS.forEach(function (compoundId) {
          var rAbs = valuesByCompound[compoundId];
          if (rAbs === undefined) return;
          markerDots[compoundId].setAttribute('cx', x);
          markerDots[compoundId].setAttribute('cy', yPos(rAbs));
        });
      },
      setEmphasis: function (compoundId) {
        Object.keys(curveGroups).forEach(function (id) {
          var isEmphasized = !compoundId || id === compoundId;
          curveGroups[id].classList.toggle('is-dimmed', !isEmphasized);
          curveGroups[id].classList.toggle('is-emphasized', Boolean(compoundId) && isEmphasized);
        });
      },
      // Phase 8B-6 Step 2 — live mode only. Moves the vertical guide to the
      // current live geometric altitude but hides the per-compound dots:
      // this frozen curve has no live RAbs value to place them at (docs
      // §18 — the guide means x-position only, never a fabricated y-value).
      setLiveAltitudeGuide: function (altDeg) {
        var x = xPos(altDeg);
        markerLine.setAttribute('x1', x);
        markerLine.setAttribute('x2', x);
        markerGroup.classList.add('is-altitude-only');
      },
      clearLiveAltitudeGuide: function () {
        markerGroup.classList.remove('is-altitude-only');
      }
    };
  }

  global.SolarChemCharts = {
    renderSolarSpectrumChart: renderSolarSpectrumChart,
    computeGlobalLogDomain: computeGlobalLogDomain,
    renderMolecularResponseChart: renderMolecularResponseChart,
    clearContainer: clearContainer
  };
})(window);
