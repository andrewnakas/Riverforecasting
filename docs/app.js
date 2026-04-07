/* ============================================================
   River Forecast Dashboard — Client-side application
   Fetches live data from USGS NWIS & NWS APIs, runs a
   historically-calibrated hydrological forecast, and renders charts.
   ============================================================ */

const USGS_IV  = 'https://waterservices.usgs.gov/nwis/iv/';
const USGS_DV  = 'https://waterservices.usgs.gov/nwis/dv/';
const USGS_SITE = 'https://waterservices.usgs.gov/nwis/site/';
const NWS_BASE  = 'https://api.weather.gov';

const MW_STATES = ['MT','ID','WY','CO','UT','NV','NM','AZ'];

/* ---- State ---- */
var forecastChart = null;
var componentsChart = null;
var map = null;
var markerLayer = null;

/* ---- DOM refs ---- */
var $  = function(id) { return document.getElementById(id); };
var siteInput   = $('site-input');
var goBtn       = $('go-btn');
var statusBar   = $('status-bar');
var stepsEl     = $('steps');
var resultsEl   = $('results');
var warningsEl  = $('warnings');

/* ---- Init map ---- */
function initMap() {
  map = L.map('map', { center: [41.5, -109.5], zoom: 5, zoomControl: true });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://carto.com/">CARTO</a> &copy; <a href="https://www.openstreetmap.org/">OSM</a>',
    maxZoom: 18,
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

async function loadMapSensors() {
  var stateCode = $('map-state-filter').value;
  if (!stateCode) { $('map-count').textContent = 'Select a state'; return; }
  $('map-count').textContent = 'Loading...';
  $('load-map-btn').disabled = true;
  markerLayer.clearLayers();
  try {
    var url = USGS_SITE + '?format=rdb&stateCd=' + stateCode + '&siteType=ST&siteStatus=active&hasDataTypeCd=iv&parameterCd=00060&siteOutput=expanded';
    var text = await (await fetch(url)).text();
    var lines = text.split('\n').filter(function(l) { return !l.startsWith('#') && l.trim(); });
    if (lines.length < 3) { $('map-count').textContent = 'No sites found'; return; }
    var hdr = lines[0].split('\t');
    var siteNoIdx = hdr.indexOf('site_no'), nameIdx = hdr.indexOf('station_nm');
    var latIdx = hdr.indexOf('dec_lat_va'), lonIdx = hdr.indexOf('dec_long_va');
    var daIdx = hdr.indexOf('drain_area_va');
    var count = 0;
    for (var i = 2; i < lines.length; i++) {
      var cols = lines[i].split('\t');
      if (cols.length < Math.max(siteNoIdx, nameIdx, latIdx, lonIdx) + 1) continue;
      var lat = parseFloat(cols[latIdx]), lon = parseFloat(cols[lonIdx]);
      if (isNaN(lat) || isNaN(lon) || lat === 0) continue;
      var siteNo = cols[siteNoIdx], name = cols[nameIdx], da = cols[daIdx] || '';
      var icon = L.divIcon({ className: 'sensor-marker', iconSize: [10, 10], iconAnchor: [5, 5] });
      var marker = L.marker([lat, lon], { icon: icon }).addTo(markerLayer);
      marker.bindPopup(
        '<div class="popup-title">' + name + '</div>' +
        '<div class="popup-detail">Site: ' + siteNo + '</div>' +
        (da ? '<div class="popup-detail">Drainage: ' + parseFloat(da).toLocaleString() + ' sq mi</div>' : '') +
        '<div style="margin-top:0.4rem"><a onclick="selectSite(\'' + siteNo + '\')">Generate Forecast &rarr;</a></div>'
      );
      count++;
    }
    $('map-count').textContent = count + ' sensors';
    if (count > 0) map.fitBounds(markerLayer.getBounds().pad(0.1));
  } catch (e) { $('map-count').textContent = 'Error loading'; }
  $('load-map-btn').disabled = false;
}

function selectSite(siteNo) { siteInput.value = siteNo; map.closePopup(); runForecast(); }
window.selectSite = selectSite;

document.querySelectorAll('.pick').forEach(function(el) {
  el.addEventListener('click', function() { siteInput.value = el.dataset.site; runForecast(); });
});
goBtn.addEventListener('click', runForecast);
siteInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') runForecast(); });
$('load-map-btn').addEventListener('click', loadMapSensors);

/* ============================================================
   Main forecast pipeline — now with historical seasonal data
   ============================================================ */
async function runForecast() {
  var siteNo = siteInput.value.trim();
  if (!siteNo) return;
  goBtn.disabled = true;
  resultsEl.classList.add('hidden');
  warningsEl.innerHTML = '';
  statusBar.classList.add('visible');
  var warnings = [];
  var steps = ['Site Info','Recent Flow','Historical Seasons','Weather','Forecast','Render'];
  renderSteps(steps, 0);

  try {
    renderSteps(steps, 0);
    var site = await fetchSiteInfo(siteNo);

    renderSteps(steps, 1);
    var recent = await fetchRecentDischarge(siteNo, 90);

    /* NEW: fetch same period from past years to learn seasonal pattern */
    renderSteps(steps, 2);
    var historical = null;
    try {
      historical = await fetchHistoricalSeasons(siteNo, 5);
    } catch(e) {
      warnings.push('Historical data unavailable — using model-only forecast.');
    }

    renderSteps(steps, 3);
    var weather = null;
    try {
      weather = await fetchWeather(site.lat, site.lon);
    } catch (e) {
      warnings.push('NWS weather unavailable — using neutral weather. ' + e.message);
      weather = fallbackWeather();
    }

    renderSteps(steps, 4);
    var forecast = computeForecast(site, recent, historical, weather, warnings);

    renderSteps(steps, 5);
    renderResults(site, recent, forecast, weather, warnings);
    renderSteps(steps, 6);
  } catch (err) {
    renderStepError(steps);
    addWarning('Forecast failed: ' + err.message);
  }
  goBtn.disabled = false;
}

/* ============================================================
   Data fetching
   ============================================================ */
async function fetchSiteInfo(siteNo) {
  var url = USGS_SITE + '?format=rdb&sites=' + siteNo + '&siteOutput=expanded&siteStatus=active';
  var text = await (await fetch(url)).text();
  var lines = text.split('\n').filter(function(l) { return !l.startsWith('#') && l.trim(); });
  if (lines.length < 3) throw new Error('Site not found: ' + siteNo);
  var hdr = lines[0].split('\t');
  var vals = lines[2].split('\t');
  var col = function(name) { return vals[hdr.indexOf(name)] || ''; };
  return {
    siteNo: col('site_no'), name: col('station_nm'),
    lat: parseFloat(col('dec_lat_va')) || 0, lon: parseFloat(col('dec_long_va')) || 0,
    state: col('state_cd'), drainArea: parseFloat(col('drain_area_va')) || null,
    huc: col('huc_cd'),
  };
}

async function fetchRecentDischarge(siteNo, days) {
  var url = USGS_DV + '?format=json&sites=' + siteNo + '&parameterCd=00060&period=P' + days + 'D&siteStatus=active';
  var data = await (await fetch(url)).json();
  var ts = (data && data.value && data.value.timeSeries && data.value.timeSeries[0] &&
            data.value.timeSeries[0].values && data.value.timeSeries[0].values[0] &&
            data.value.timeSeries[0].values[0].value) || [];
  return ts.map(function(v) {
    return { date: new Date(v.dateTime), q: parseFloat(v.value) };
  }).filter(function(v) { return !isNaN(v.q) && v.q >= 0; });
}

/**
 * Fetch the same 30-day window (centered on today's day-of-year)
 * from each of the past N years. Returns an array of daily
 * "typical" flows for day-of-year offsets -15..+15 from today.
 * This tells us: "historically, does flow rise or fall at this
 * time of year, and by how much?"
 */
async function fetchHistoricalSeasons(siteNo, nYears) {
  var now = new Date();
  var results = [];

  /* Fetch each past year in parallel */
  var fetches = [];
  for (var y = 1; y <= nYears; y++) {
    var yearStart = new Date(now.getFullYear() - y, now.getMonth(), now.getDate() - 15);
    var yearEnd   = new Date(now.getFullYear() - y, now.getMonth(), now.getDate() + 20);
    var startStr = yearStart.toISOString().slice(0, 10);
    var endStr   = yearEnd.toISOString().slice(0, 10);
    var url = USGS_DV + '?format=json&sites=' + siteNo + '&parameterCd=00060&startDT=' + startStr + '&endDT=' + endStr;
    fetches.push(fetch(url).then(function(r) { return r.json(); }).catch(function() { return null; }));
  }
  var responses = await Promise.all(fetches);

  /* For each year, extract daily flows and compute the ratio of each day to the "anchor day" (day 15 = today's DOY equivalent) */
  var ratiosByOffset = {};  /* offset -> [ratio1, ratio2, ...] from each year */
  for (var i = 0; i < responses.length; i++) {
    var data = responses[i];
    if (!data) continue;
    var ts = (data && data.value && data.value.timeSeries && data.value.timeSeries[0] &&
              data.value.timeSeries[0].values && data.value.timeSeries[0].values[0] &&
              data.value.timeSeries[0].values[0].value) || [];
    var flows = ts.map(function(v) { return parseFloat(v.value); }).filter(function(v) { return !isNaN(v) && v > 0; });
    if (flows.length < 20) continue;

    /* The anchor is roughly at index 15 (today's DOY in this historical window) */
    var anchorIdx = Math.min(15, flows.length - 1);
    var anchorQ = flows[anchorIdx];
    if (anchorQ <= 0) continue;

    for (var j = 0; j < flows.length; j++) {
      var offset = j - anchorIdx;
      if (offset < -5 || offset > 14) continue;  /* only care about +0..+14 days ahead */
      if (!ratiosByOffset[offset]) ratiosByOffset[offset] = [];
      ratiosByOffset[offset].push(flows[j] / anchorQ);
    }
  }

  /* Compute median ratio for each day offset */
  var medianRatios = {};
  for (var off in ratiosByOffset) {
    medianRatios[off] = median(ratiosByOffset[off]);
  }
  return medianRatios;
}

async function fetchWeather(lat, lon) {
  var ptUrl = NWS_BASE + '/points/' + lat.toFixed(4) + ',' + lon.toFixed(4);
  var ptResp = await fetch(ptUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!ptResp.ok) throw new Error('NWS points lookup failed');
  var ptData = await ptResp.json();
  var props = ptData.properties;
  var fUrl = NWS_BASE + '/gridpoints/' + props.gridId + '/' + props.gridX + ',' + props.gridY;
  var gResp = await fetch(fUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!gResp.ok) throw new Error('NWS gridpoint fetch failed');
  var gData = await gResp.json();
  var gProps = gData.properties || {};
  var tempSeries = expandNWS(gProps.temperature || {});
  var precipSeries = expandNWS(gProps.quantitativePrecipitation || {});
  var tempUnit = ((gProps.temperature || {}).uom || '').toLowerCase();
  var isCelsius = tempUnit.includes('degc') || tempUnit.includes('celsius');

  var today = new Date(); today.setHours(0,0,0,0);
  var days = [];
  for (var d = 0; d < 14; d++) {
    var day = new Date(today); day.setDate(day.getDate() + d);
    var next = new Date(day); next.setDate(next.getDate() + 1);
    var dTemps = tempSeries.filter(function(t) { return t.dt >= day && t.dt < next; }).map(function(t) { return t.v; });
    var hi = dTemps.length ? Math.max.apply(null, dTemps) : NaN;
    var lo = dTemps.length ? Math.min.apply(null, dTemps) : NaN;
    if (isCelsius && !isNaN(hi)) { hi = hi * 9/5 + 32; lo = lo * 9/5 + 32; }
    var dPrecip = precipSeries.filter(function(t) { return t.dt >= day && t.dt < next; }).map(function(t) { return t.v; });
    var precipMm = dPrecip.reduce(function(a,b) { return a + b; }, 0);
    days.push({ date: day, hi: hi, lo: lo, mean: (hi+lo)/2, precipIn: precipMm / 25.4 });
  }
  return days;
}

function expandNWS(prop) {
  var result = [];
  var values = (prop && prop.values) || [];
  for (var j = 0; j < values.length; j++) {
    var entry = values[j];
    var vt = entry.validTime || '';
    if (vt.indexOf('/') < 0) continue;
    var parts = vt.split('/');
    var dt = new Date(parts[0]);
    if (isNaN(dt.getTime())) continue;
    var val = entry.value == null ? NaN : parseFloat(entry.value);
    var hrs = parseDurationHours(parts[1]);
    for (var h = 0; h < hrs; h++) {
      result.push({ dt: new Date(dt.getTime() + h*3600000), v: val });
    }
    if (hrs < 1) result.push({ dt: dt, v: val });
  }
  return result;
}

function parseDurationHours(s) {
  if (!s || s.charAt(0) !== 'P') return 1;
  var hours = 0; s = s.slice(1);
  if (s.indexOf('D') >= 0) { var p = s.split('D'); hours += parseFloat(p[0])*24; s = p[1]||''; }
  if (s.charAt(0) === 'T') s = s.slice(1);
  if (s.indexOf('H') >= 0) { hours += parseFloat(s.split('H')[0]); }
  return hours || 1;
}

function fallbackWeather() {
  var today = new Date(); today.setHours(0,0,0,0);
  var arr = [];
  for (var i = 0; i < 14; i++) {
    var d = new Date(today); d.setDate(d.getDate()+i);
    arr.push({ date: d, hi: 55, lo: 30, mean: 42.5, precipIn: 0 });
  }
  return arr;
}

/* ============================================================
   Hydrological forecast model — V3 (historically calibrated)
   
   APPROACH: Instead of computing absolute snowmelt/rainfall
   runoff volumes (which caused the 500→3000 cfs spike), we:
   
   1. Start at current observed discharge (anchor point)
   2. Use historical same-time-of-year data from past 5 years
      to compute what the TYPICAL daily change rate is
   3. Modulate that historical trend by current weather forecast
      (warmer than average → faster snowmelt ramp-up, etc.)
   4. Add rainfall-event pulses on top as small perturbations
   
   This ensures the forecast smoothly continues from observed
   flow and reflects realistic seasonal patterns.
   ============================================================ */
function computeForecast(site, recent, historical, weather, warnings) {
  var horizon = 14;
  var da = site.drainArea || 100;
  var q = recent.map(function(r) { return r.q; });
  var n = q.length;

  /* Current observed discharge — this is our anchor */
  var currentQ = n > 0 ? q[n - 1] : 100;

  /* ----------------------------------------------------------------
     COMPONENT 1: Historical seasonal trend
     
     "What has this river typically done at this time of year?"
     medianRatios[offset] = median(Q[today+offset] / Q[today])
     across past 5 years. A ratio of 1.05 at offset +7 means
     the river typically rises 5% over the next week.
     ---------------------------------------------------------------- */
  var seasonalFactor = [];  /* multiplier for each forecast day */
  if (historical && Object.keys(historical).length >= 5) {
    for (var i = 0; i < horizon; i++) {
      var r = historical[i];
      if (r !== undefined && r > 0) {
        seasonalFactor.push(r);
      } else {
        /* Extrapolate from last known ratio */
        var lastKnown = seasonalFactor.length > 0 ? seasonalFactor[seasonalFactor.length-1] : 1.0;
        seasonalFactor.push(lastKnown);
      }
    }
  } else {
    /* No historical data — assume flat (no seasonal change) */
    for (var i = 0; i < horizon; i++) seasonalFactor.push(1.0);
  }

  /* Compute the historical seasonal component */
  var seasonalQ = [];
  for (var i = 0; i < horizon; i++) {
    seasonalQ.push(currentQ * seasonalFactor[i]);
  }

  /* ----------------------------------------------------------------
     COMPONENT 2: Recent trend momentum
     
     If the river has been rising/falling over the last 7 days,
     that momentum carries forward (with decay).
     ---------------------------------------------------------------- */
  var recentTrend = 0;
  if (n >= 7) {
    var last7 = q.slice(-7);
    /* Linear trend per day over last 7 days */
    var sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (var i = 0; i < last7.length; i++) {
      sumX += i; sumY += last7[i]; sumXY += i * last7[i]; sumX2 += i * i;
    }
    var nn = last7.length;
    recentTrend = (nn * sumXY - sumX * sumY) / (nn * sumX2 - sumX * sumX);
  }
  
  /* Apply decaying recent momentum */
  var momentumQ = [];
  for (var i = 0; i < horizon; i++) {
    /* Momentum decays by 50% every 5 days */
    var decay = Math.pow(0.5, (i + 1) / 5);
    momentumQ.push(recentTrend * (i + 1) * decay);
  }

  /* ----------------------------------------------------------------
     COMPONENT 3: Weather-driven perturbation
     
     Compare forecast temps to a "typical" spring temp for the 
     region. If warmer than usual → slight upward push (more melt).
     If cooler → slight downward push. This is a PERTURBATION on
     top of the historical trend, not an absolute melt calculation.
     ---------------------------------------------------------------- */
  var typicalMeanF = 45;  /* approximate spring mean for Mountain West */
  var tempPerturbQ = [];
  for (var i = 0; i < horizon; i++) {
    var tmean = (weather[i] && !isNaN(weather[i].mean)) ? weather[i].mean : typicalMeanF;
    /* Each degree above typical → ~0.5% more flow (from enhanced melt)
       Each degree below → ~0.3% less flow (reduced melt) */
    var tempDelta = tmean - typicalMeanF;
    var pctChange;
    if (tempDelta > 0) {
      pctChange = tempDelta * 0.005;  /* warmer: +0.5% per degree */
    } else {
      pctChange = tempDelta * 0.003;  /* cooler: -0.3% per degree */
    }
    tempPerturbQ.push(currentQ * pctChange);
  }

  /* ----------------------------------------------------------------
     COMPONENT 4: Rainfall event pulses
     
     Direct runoff from forecast rain events, but kept small and
     realistic. Uses SCS-CN for depth, but only a small effective
     area contributes to quick response.
     ---------------------------------------------------------------- */
  var CN = da < 50 ? 55 : da < 500 ? 62 : 68;
  var S = 1000/CN - 10;
  var Ia = 0.2 * S;

  /* Very conservative effective area for event response */
  var rainFrac = da < 50 ? 0.15 : da < 500 ? 0.05 : da < 5000 ? 0.02 : 0.005;
  var effectiveRainArea = da * rainFrac;
  var CONV = 26.89;

  var rawRainCfs = [];
  for (var i = 0; i < horizon; i++) {
    var P = (weather[i] && weather[i].precipIn) ? weather[i].precipIn : 0;
    var tmean = (weather[i] && !isNaN(weather[i].mean)) ? weather[i].mean : 42;
    if (tmean < 32) P = P * 0.1;  /* cold precip mostly stored as snow */
    if (P <= Ia) { rawRainCfs.push(0); continue; }
    var excess = P - Ia;
    rawRainCfs.push((excess*excess / (excess + S)) * effectiveRainArea * CONV);
  }

  /* Simple 2-day unit hydrograph to spread rainfall response */
  var rainCfs = new Array(horizon).fill(0);
  for (var i = 0; i < horizon; i++) {
    if (rawRainCfs[i] > 0) {
      rainCfs[i] += rawRainCfs[i] * 0.6;
      if (i + 1 < horizon) rainCfs[i+1] += rawRainCfs[i] * 0.3;
      if (i + 2 < horizon) rainCfs[i+2] += rawRainCfs[i] * 0.1;
    }
  }

  /* ----------------------------------------------------------------
     COMBINE: seasonal base + momentum + weather perturbation + rain
     ---------------------------------------------------------------- */
  var combined = [];
  for (var i = 0; i < horizon; i++) {
    var val = seasonalQ[i] + momentumQ[i] + tempPerturbQ[i] + rainCfs[i];
    combined.push(Math.max(1, val));  /* floor at 1 cfs */
  }

  /* Light smoothing via 3-point moving average */
  var smoothed = [];
  for (var i = 0; i < horizon; i++) {
    if (i === 0) {
      smoothed.push((combined[0] + combined[1]) / 2);
    } else if (i === horizon - 1) {
      smoothed.push((combined[i-1] + combined[i]) / 2);
    } else {
      smoothed.push((combined[i-1] + combined[i] + combined[i+1]) / 3);
    }
  }

  /* ----------------------------------------------------------------
     UNCERTAINTY: widens with lead time, also wider when weather
     is more variable or when historical data is sparse
     ---------------------------------------------------------------- */
  var hasHistory = historical && Object.keys(historical).length >= 5;
  var basePct = hasHistory ? 0.10 : 0.20;  /* tighter with historical cal */
  var maxPct = hasHistory ? 0.40 : 0.55;
  var low = [], high = [];
  for (var i = 0; i < horizon; i++) {
    var pct = basePct + (maxPct - basePct) * i / (horizon - 1);
    /* Widen on rain days (more uncertain) */
    if (rainCfs[i] > 0) pct += 0.05;
    low.push(Math.max(0, smoothed[i] * (1 - pct)));
    high.push(smoothed[i] * (1 + pct));
  }

  var trend = smoothed[smoothed.length-1] - smoothed[0];

  /* Decompose for display:
     - "baseflow" = seasonal component (the dominant driver)
     - "snowmelt" = temperature perturbation (weather-driven melt change)
     - "rainfall" = event rainfall pulses */
  var displayBf = [], displayMelt = [], displayRain = [];
  for (var i = 0; i < horizon; i++) {
    displayBf.push(Math.max(0, seasonalQ[i] + momentumQ[i]));
    displayMelt.push(Math.max(0, tempPerturbQ[i]));
    displayRain.push(Math.max(0, rainCfs[i]));
  }

  return {
    dates: weather.slice(0, horizon).map(function(w) { return w.date; }),
    discharge: smoothed,
    low: low, high: high,
    baseflow: displayBf,
    snowmelt: displayMelt,
    rainfall: displayRain,
    currentQ: currentQ,
    trend: trend,
    hasHistory: hasHistory,
    seasonalFactor: seasonalFactor,
  };
}

function median(arr) {
  var s = arr.slice().sort(function(a,b) { return a-b; });
  var m = Math.floor(s.length/2);
  return s.length % 2 ? s[m] : (s[m-1]+s[m])/2;
}

/* ============================================================
   Rendering
   ============================================================ */
function renderSteps(names, current) {
  stepsEl.innerHTML = names.map(function(name, i) {
    var cls = i < current ? 'step done' : i === current ? 'step active' : 'step';
    var icon = i < current ? '&#10003; ' : i === current ? '&#9679; ' : '';
    return '<span class="' + cls + '">' + icon + name + '</span>';
  }).join('');
}
function renderStepError(names) {
  stepsEl.innerHTML = names.map(function(name) {
    return '<span class="step error">' + name + '</span>';
  }).join('');
}
function addWarning(msg) {
  warningsEl.innerHTML += '<div class="warning">' + msg + '</div>';
}

function renderResults(site, recent, forecast, weather, warnings) {
  resultsEl.classList.remove('hidden');

  $('site-name').textContent = site.name;
  $('site-meta').textContent = 'USGS ' + site.siteNo + '  |  (' + site.lat.toFixed(4) + ', ' + site.lon.toFixed(4) + ')' + (site.drainArea ? '  |  ' + site.drainArea.toLocaleString() + ' sq mi' : '');

  $('card-current').innerHTML = forecast.currentQ != null
    ? '<div class="label">Current Discharge</div><div class="value" style="color:var(--yellow)">' + fmt(forecast.currentQ) + ' cfs</div><div class="sub">Most recent daily mean</div>'
    : '<div class="label">Current Discharge</div><div class="value" style="color:var(--text-dim)">N/A</div>';

  var d7 = forecast.discharge[6] || 0;
  $('card-day7').innerHTML = '<div class="label">Day 7 Forecast</div><div class="value" style="color:var(--accent)">' + fmt(d7) + ' cfs</div><div class="sub">' + fmt(forecast.low[6]) + ' &ndash; ' + fmt(forecast.high[6]) + ' cfs</div>';

  var li = forecast.discharge.length - 1;
  var d14 = forecast.discharge[li];
  $('card-day14').innerHTML = '<div class="label">Day 14 Forecast</div><div class="value" style="color:var(--accent2)">' + fmt(d14) + ' cfs</div><div class="sub">' + fmt(forecast.low[li]) + ' &ndash; ' + fmt(forecast.high[li]) + ' cfs</div>';

  var dir = forecast.trend > 0 ? 'Rising' : forecast.trend < 0 ? 'Falling' : 'Steady';
  var dirColor = forecast.trend > 0 ? 'var(--green)' : forecast.trend < 0 ? 'var(--red)' : 'var(--text-dim)';
  $('card-trend').innerHTML = '<div class="label">14-Day Trend</div><div class="value" style="color:' + dirColor + '">' + dir + '</div><div class="sub">' + (forecast.trend > 0 ? '+' : '') + fmt(forecast.trend) + ' cfs</div>';

  renderForecastChart(recent, forecast);
  renderComponentsChart(forecast);
  renderTable(forecast, weather);
  warnings.forEach(addWarning);
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderForecastChart(recent, forecast) {
  var ctx = $('forecast-chart').getContext('2d');
  if (forecastChart) forecastChart.destroy();

  var recentSlice = recent.slice(-30);
  var recentDates = recentSlice.map(function(r) { return r.date; });
  var recentQ = recentSlice.map(function(r) { return r.q; });
  var fDates = forecast.dates;

  /* KEY FIX: Connect the lines by overlapping the last observed 
     point with the first forecast point */
  var lastObservedQ = recentQ.length > 0 ? recentQ[recentQ.length - 1] : null;
  var allDates = recentDates.concat(fDates);
  var labels = allDates.map(fmtDate);

  /* Observed data: extends through all recent points */
  var observedData = recentQ.concat(new Array(fDates.length).fill(null));
  
  /* Forecast data: starts with last observed point for seamless connection,
     then continues with forecast values */
  var forecastData = new Array(recentQ.length - 1).fill(null);
  forecastData.push(lastObservedQ);  /* overlap point: last observed = first forecast */
  forecastData = forecastData.concat(forecast.discharge);

  /* Confidence bands: also start from the overlap point */
  var highData = new Array(recentQ.length - 1).fill(null);
  highData.push(lastObservedQ);
  highData = highData.concat(forecast.high);

  var lowData = new Array(recentQ.length - 1).fill(null);
  lowData.push(lastObservedQ);
  lowData = lowData.concat(forecast.low);

  forecastChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Observed',
          data: observedData,
          borderColor: '#e2e8f0',
          borderWidth: 2,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: 'Forecast',
          data: forecastData,
          borderColor: '#38bdf8',
          borderWidth: 2.5,
          pointRadius: 0,
          tension: 0.3,
        },
        {
          label: '90% Confidence',
          data: highData,
          borderColor: 'transparent',
          backgroundColor: 'rgba(56,189,248,0.12)',
          fill: '+1',
          pointRadius: 0,
        },
        {
          label: '10% Confidence',
          data: lowData,
          borderColor: 'transparent',
          backgroundColor: 'rgba(56,189,248,0.12)',
          fill: '-1',
          pointRadius: 0,
        },
      ]
    },
    options: chartOpts('Discharge (cfs)'),
  });
}

function renderComponentsChart(forecast) {
  var ctx = $('components-chart').getContext('2d');
  if (componentsChart) componentsChart.destroy();
  var labels = forecast.dates.map(fmtDate);
  componentsChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Baseflow + Seasonal', data: forecast.baseflow, backgroundColor: 'rgba(56,189,248,0.6)', stack: 'stack' },
        { label: 'Temp/Melt Effect', data: forecast.snowmelt, backgroundColor: 'rgba(129,140,248,0.6)', stack: 'stack' },
        { label: 'Rainfall Events', data: forecast.rainfall, backgroundColor: 'rgba(52,211,153,0.6)', stack: 'stack' },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#94a3b8', usePointStyle: true, padding: 20, font: { size: 11 } } },
        tooltip: { backgroundColor: '#1e293b', borderColor: '#475569', borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#e2e8f0' },
      },
      scales: {
        x: { stacked: true, ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { color: 'rgba(71,85,105,0.3)' } },
        y: { stacked: true, title: { display: true, text: 'Discharge (cfs)', color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(71,85,105,0.3)' } },
      }
    }
  });
}

function chartOpts(yLabel) {
  return {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { labels: { color: '#94a3b8', usePointStyle: true, pointStyle: 'line', padding: 20, font: { size: 11 } } },
      tooltip: { backgroundColor: '#1e293b', borderColor: '#475569', borderWidth: 1, titleColor: '#e2e8f0', bodyColor: '#e2e8f0' },
    },
    scales: {
      x: { ticks: { color: '#94a3b8', maxRotation: 45, font: { size: 10 } }, grid: { color: 'rgba(71,85,105,0.3)' } },
      y: { title: { display: true, text: yLabel, color: '#94a3b8' }, ticks: { color: '#94a3b8' }, grid: { color: 'rgba(71,85,105,0.3)' } },
    }
  };
}

function renderTable(forecast, weather) {
  var tbody = $('forecast-tbody');
  tbody.innerHTML = '';
  for (var i = 0; i < forecast.dates.length; i++) {
    var d = forecast.dates[i];
    var w = weather[i] || {};
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + fmtDateLong(d) + '</td>' +
      '<td style="color:var(--yellow);font-weight:600">' + fmt(forecast.discharge[i]) + '</td>' +
      '<td style="color:var(--text-dim)">' + fmt(forecast.low[i]) + '</td>' +
      '<td style="color:var(--text-dim)">' + fmt(forecast.high[i]) + '</td>' +
      '<td style="color:var(--accent)">' + fmt(forecast.baseflow[i]) + '</td>' +
      '<td style="color:var(--accent2)">' + fmt(forecast.snowmelt[i]) + '</td>' +
      '<td style="color:var(--green)">' + fmt(forecast.rainfall[i]) + '</td>' +
      '<td>' + (isNaN(w.hi) ? '\u2014' : Math.round(w.hi) + '\u00B0') + '</td>' +
      '<td>' + (isNaN(w.lo) ? '\u2014' : Math.round(w.lo) + '\u00B0') + '</td>' +
      '<td>' + ((w.precipIn||0).toFixed(2)) + '"</td>';
    tbody.appendChild(tr);
  }
}

function fmt(v) { return v == null || isNaN(v) ? '\u2014' : v.toLocaleString(undefined, {maximumFractionDigits:1}); }
function fmtDate(d) { return d.toLocaleDateString('en-US', {month:'short', day:'numeric'}); }
function fmtDateLong(d) { return d.toLocaleDateString('en-US', {weekday:'short', month:'short', day:'numeric'}); }

/* ---- Init ---- */
initMap();
loadMapSensors();
