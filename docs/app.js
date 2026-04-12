/* ============================================================
   River Forecast Dashboard v4 — Best-practices hydrology
   
   Techniques from operational forecasting:
   1. USGS daily statistics (percentiles by DOY) for bounds
   2. AR(1) persistence in log-space reverting to seasonal median
   3. KNN historical analog ensemble (5 nearest-neighbor years)
   4. Temperature perturbation from NWS forecast
   5. Climatological blending at longer lead times
   6. Percentile-based uncertainty from real distribution
   ============================================================ */

var USGS_DV   = 'https://waterservices.usgs.gov/nwis/dv/';
var USGS_SITE = 'https://waterservices.usgs.gov/nwis/site/';
var USGS_STAT = 'https://waterservices.usgs.gov/nwis/stat/';
var NWS_BASE  = 'https://api.weather.gov';

var forecastChart = null;
var componentsChart = null;
var map = null;
var markerLayer = null;

var $ = function(id) { return document.getElementById(id); };
var siteInput = $('site-input');
var goBtn = $('go-btn');
var statusBar = $('status-bar');
var stepsEl = $('steps');
var resultsEl = $('results');
var warningsEl = $('warnings');

/* ---- Map ---- */
function initMap() {
  map = L.map('map', { center: [41.5, -109.5], zoom: 5 });
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; CARTO &copy; OSM', maxZoom: 18
  }).addTo(map);
  markerLayer = L.layerGroup().addTo(map);
}

async function loadMapSensors() {
  var sc = $('map-state-filter').value;
  if (!sc) { $('map-count').textContent = 'Select a state'; return; }
  $('map-count').textContent = 'Loading...';
  $('load-map-btn').disabled = true;
  markerLayer.clearLayers();
  try {
    var url = USGS_SITE + '?format=rdb&stateCd=' + sc + '&siteType=ST&siteStatus=active&hasDataTypeCd=iv&parameterCd=00060&siteOutput=expanded';
    var text = await (await fetch(url)).text();
    var lines = text.split('\n').filter(function(l) { return !l.startsWith('#') && l.trim(); });
    if (lines.length < 3) { $('map-count').textContent = 'None found'; return; }
    var h = lines[0].split('\t');
    var si = h.indexOf('site_no'), ni = h.indexOf('station_nm');
    var li = h.indexOf('dec_lat_va'), oi = h.indexOf('dec_long_va'), di = h.indexOf('drain_area_va');
    var count = 0;
    for (var i = 2; i < lines.length; i++) {
      var c = lines[i].split('\t');
      var lat = parseFloat(c[li]), lon = parseFloat(c[oi]);
      if (isNaN(lat) || lat === 0) continue;
      var sn = c[si], nm = c[ni], da = c[di] || '';
      var ic = L.divIcon({ className: 'sensor-marker', iconSize: [10,10], iconAnchor: [5,5] });
      L.marker([lat,lon], {icon:ic}).addTo(markerLayer).bindPopup(
        '<div class="popup-title">'+nm+'</div><div class="popup-detail">Site: '+sn+'</div>'+
        (da ? '<div class="popup-detail">Drainage: '+parseFloat(da).toLocaleString()+' sq mi</div>' : '')+
        '<div style="margin-top:0.4rem"><a onclick="selectSite(\''+sn+'\')">Generate Forecast &rarr;</a></div>'
      );
      count++;
    }
    $('map-count').textContent = count + ' sensors';
    if (count > 0) map.fitBounds(markerLayer.getBounds().pad(0.1));
  } catch(e) { $('map-count').textContent = 'Error'; }
  $('load-map-btn').disabled = false;
}
function selectSite(s) { siteInput.value = s; map.closePopup(); runForecast(); }
window.selectSite = selectSite;

document.querySelectorAll('.pick').forEach(function(el) {
  el.addEventListener('click', function() { siteInput.value = el.dataset.site; runForecast(); });
});
goBtn.addEventListener('click', runForecast);
siteInput.addEventListener('keydown', function(e) { if (e.key==='Enter') runForecast(); });
$('load-map-btn').addEventListener('click', loadMapSensors);

/* ============================================================
   Pipeline — 6 data-fetch steps then model
   ============================================================ */
async function runForecast() {
  var siteNo = siteInput.value.trim();
  if (!siteNo) return;
  goBtn.disabled = true;
  resultsEl.classList.add('hidden');
  warningsEl.innerHTML = '';
  statusBar.classList.add('visible');
  var warnings = [];
  var steps = ['Site Info','Recent Flow','Historical Stats','Analog Years','Weather','Model','Render'];
  renderSteps(steps, 0);

  try {
    renderSteps(steps, 0);
    var site = await fetchSiteInfo(siteNo);

    renderSteps(steps, 1);
    var recent = await fetchRecentDischarge(siteNo, 90);
    if (recent.length < 7) { warnings.push('Fewer than 7 days of recent data.'); }

    renderSteps(steps, 2);
    var dailyStats = null;
    try { dailyStats = await fetchDailyStats(siteNo); }
    catch(e) { warnings.push('USGS daily statistics unavailable.'); }

    renderSteps(steps, 3);
    var analogTraces = null;
    try { analogTraces = await fetchAnalogTraces(siteNo, recent, 15); }
    catch(e) { warnings.push('Historical analog data unavailable.'); }

    renderSteps(steps, 4);
    var weather = null;
    try { weather = await fetchWeather(site.lat, site.lon); }
    catch(e) { warnings.push('NWS weather unavailable.'); weather = fallbackWeather(); }

    renderSteps(steps, 5);
    var forecast = computeForecastV4(site, recent, dailyStats, analogTraces, weather, warnings);

    renderSteps(steps, 6);
    renderResults(site, recent, forecast, weather, warnings);
    renderSteps(steps, 7);
  } catch(err) {
    renderStepError(steps);
    addWarning('Forecast failed: ' + err.message);
    console.error(err);
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
  var hdr = lines[0].split('\t'), vals = lines[2].split('\t');
  var col = function(n) { return vals[hdr.indexOf(n)] || ''; };
  return {
    siteNo: col('site_no'), name: col('station_nm'),
    lat: parseFloat(col('dec_lat_va'))||0, lon: parseFloat(col('dec_long_va'))||0,
    state: col('state_cd'), drainArea: parseFloat(col('drain_area_va'))||null, huc: col('huc_cd'),
  };
}

async function fetchRecentDischarge(siteNo, days) {
  var url = USGS_DV + '?format=json&sites=' + siteNo + '&parameterCd=00060&period=P' + days + 'D&siteStatus=active';
  var data = await (await fetch(url)).json();
  var ts = [];
  try { ts = data.value.timeSeries[0].values[0].value; } catch(e) {}
  return ts.map(function(v) {
    return { date: new Date(v.dateTime), q: parseFloat(v.value) };
  }).filter(function(v) { return !isNaN(v.q) && v.q >= 0; });
}

/**
 * Fetch USGS daily statistics: historical percentiles for each day-of-year.
 * Returns object keyed by "MM-DD" with {p10, p25, p50, p75, p90, mean, min, max, count}.
 */
async function fetchDailyStats(siteNo) {
  var url = USGS_STAT + '?format=rdb&sites=' + siteNo + '&statReportType=daily&statTypeCd=all&parameterCd=00060';
  var text = await (await fetch(url)).text();
  var lines = text.split('\n').filter(function(l) { return !l.startsWith('#') && l.trim(); });
  if (lines.length < 3) return null;
  var hdr = lines[0].split('\t');
  var stats = {};
  for (var i = 2; i < lines.length; i++) {
    var cols = lines[i].split('\t');
    if (cols.length < hdr.length) continue;
    var row = {};
    for (var j = 0; j < hdr.length; j++) row[hdr[j]] = cols[j];
    var month = parseInt(row['month_nu']), day = parseInt(row['day_nu']);
    if (isNaN(month) || isNaN(day)) continue;
    var key = pad2(month) + '-' + pad2(day);
    stats[key] = {
      p10: pf(row['p10_va']), p25: pf(row['p25_va']),
      p50: pf(row['p50_va']), p75: pf(row['p75_va']),
      p90: pf(row['p90_va']), mean: pf(row['mean_va']),
      min: pf(row['min_va']), max: pf(row['max_va']),
      count: parseInt(row['count_nu']) || 0,
    };
  }
  return Object.keys(stats).length > 100 ? stats : null;
}

function pad2(n) { return n < 10 ? '0'+n : ''+n; }
function pf(s) { var v = parseFloat(s); return isNaN(v) ? null : v; }

/**
 * KNN Analog Ensemble: fetch the same 35-day window from past N years,
 * find the K nearest neighbors (by flow level + trajectory similarity),
 * and return their forward 14-day traces as ratios to anchor-day flow.
 */
async function fetchAnalogTraces(siteNo, recent, nYears) {
  var now = new Date();
  var q = recent.map(function(r) { return r.q; });
  if (q.length < 7) return null;
  var currentQ = q[q.length - 1];
  if (currentQ <= 0) return null;

  /* Compute current 7-day trajectory (normalized slope) */
  var last7 = q.slice(-7);
  var slope = linearSlope(last7) / currentQ;

  /* Fetch each past year */
  var fetches = [];
  for (var y = 1; y <= nYears; y++) {
    var start = new Date(now.getFullYear()-y, now.getMonth(), now.getDate()-10);
    var end   = new Date(now.getFullYear()-y, now.getMonth(), now.getDate()+16);
    var url = USGS_DV + '?format=json&sites=' + siteNo + '&parameterCd=00060&startDT=' + isoDate(start) + '&endDT=' + isoDate(end);
    fetches.push(fetch(url).then(function(r){return r.json();}).catch(function(){return null;}));
  }
  var responses = await Promise.all(fetches);

  /* Build candidate analogs */
  var candidates = [];
  for (var i = 0; i < responses.length; i++) {
    var data = responses[i];
    if (!data) continue;
    var ts = [];
    try { ts = data.value.timeSeries[0].values[0].value; } catch(e) { continue; }
    var flows = ts.map(function(v){return parseFloat(v.value);}).filter(function(v){return !isNaN(v)&&v>0;});
    if (flows.length < 20) continue;

    /* Anchor point is at index ~10 (today's DOY equivalent) */
    var anchorIdx = Math.min(10, flows.length - 15);
    if (anchorIdx < 3) continue;
    var anchorQ = flows[anchorIdx];
    if (anchorQ <= 0) continue;

    /* Compute this year's trajectory at the anchor point */
    var hist7 = flows.slice(Math.max(0, anchorIdx-6), anchorIdx+1);
    var histSlope = linearSlope(hist7) / anchorQ;

    /* Similarity: weighted Euclidean distance */
    var flowRatioDiff = Math.log(currentQ / anchorQ);  /* log-space flow similarity */
    var slopeDiff = slope - histSlope;
    var distance = Math.sqrt(4*flowRatioDiff*flowRatioDiff + slopeDiff*slopeDiff);

    /* Extract forward 14-day trace as ratios */
    var trace = [];
    for (var d = 1; d <= 14; d++) {
      var idx = anchorIdx + d;
      if (idx < flows.length) {
        trace.push(flows[idx] / anchorQ);
      } else {
        trace.push(trace.length > 0 ? trace[trace.length-1] : 1.0);
      }
    }
    candidates.push({ distance: distance, trace: trace, year: now.getFullYear()-i-1 });
  }

  if (candidates.length < 3) return null;

  /* Sort by distance and take K=7 nearest (more analogs → smoother ensemble) */
  candidates.sort(function(a,b) { return a.distance - b.distance; });
  var K = Math.min(7, candidates.length);
  var topK = candidates.slice(0, K);

  /* Weight by inverse distance */
  var totalW = 0;
  for (var i = 0; i < K; i++) {
    topK[i].weight = 1 / (topK[i].distance + 0.01);
    totalW += topK[i].weight;
  }
  for (var i = 0; i < K; i++) topK[i].weight /= totalW;

  return topK;
}

function linearSlope(arr) {
  var n = arr.length;
  if (n < 2) return 0;
  var sx=0, sy=0, sxy=0, sx2=0;
  for (var i=0; i<n; i++) { sx+=i; sy+=arr[i]; sxy+=i*arr[i]; sx2+=i*i; }
  return (n*sxy - sx*sy) / (n*sx2 - sx*sx);
}

function isoDate(d) { return d.toISOString().slice(0,10); }

async function fetchWeather(lat, lon) {
  var ptUrl = NWS_BASE + '/points/' + lat.toFixed(4) + ',' + lon.toFixed(4);
  var ptResp = await fetch(ptUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!ptResp.ok) throw new Error('NWS points failed');
  var ptData = await ptResp.json();
  var props = ptData.properties;
  var fUrl = NWS_BASE + '/gridpoints/' + props.gridId + '/' + props.gridX + ',' + props.gridY;
  var gResp = await fetch(fUrl, { headers: { 'User-Agent': '(RiverForecastDashboard)' } });
  if (!gResp.ok) throw new Error('NWS gridpoint failed');
  var gData = await gResp.json();
  var gProps = gData.properties || {};
  var tempSeries = expandNWS(gProps.temperature || {});
  var precipSeries = expandNWS(gProps.quantitativePrecipitation || {});
  var isCelsius = ((gProps.temperature||{}).uom||'').toLowerCase().indexOf('degc') >= 0;

  var today = new Date(); today.setHours(0,0,0,0);
  var days = [];
  for (var d = 0; d < 14; d++) {
    var day = new Date(today); day.setDate(day.getDate()+d);
    var next = new Date(day); next.setDate(next.getDate()+1);
    var dT = tempSeries.filter(function(t){return t.dt>=day&&t.dt<next;}).map(function(t){return t.v;});
    var hi = dT.length ? Math.max.apply(null,dT) : NaN;
    var lo = dT.length ? Math.min.apply(null,dT) : NaN;
    if (isCelsius && !isNaN(hi)) { hi=hi*9/5+32; lo=lo*9/5+32; }
    var dP = precipSeries.filter(function(t){return t.dt>=day&&t.dt<next;}).map(function(t){return t.v;});
    var pmm = dP.reduce(function(a,b){return a+b;}, 0);
    days.push({ date: day, hi:hi, lo:lo, mean:(hi+lo)/2, precipIn: pmm/25.4 });
  }
  return days;
}

function expandNWS(prop) {
  var result = [], values = (prop&&prop.values)||[];
  for (var j=0; j<values.length; j++) {
    var e = values[j], vt = e.validTime||'';
    if (vt.indexOf('/')<0) continue;
    var parts = vt.split('/'), dt = new Date(parts[0]);
    if (isNaN(dt.getTime())) continue;
    var val = e.value==null ? NaN : parseFloat(e.value);
    var hrs = parseDurH(parts[1]);
    for (var h=0; h<hrs; h++) result.push({dt:new Date(dt.getTime()+h*3600000), v:val});
    if (hrs<1) result.push({dt:dt, v:val});
  }
  return result;
}
function parseDurH(s) {
  if (!s||s[0]!=='P') return 1;
  var h=0; s=s.slice(1);
  if (s.indexOf('D')>=0){var p=s.split('D');h+=parseFloat(p[0])*24;s=p[1]||'';}
  if (s[0]==='T') s=s.slice(1);
  if (s.indexOf('H')>=0) h+=parseFloat(s.split('H')[0]);
  return h||1;
}
function fallbackWeather() {
  var today=new Date(); today.setHours(0,0,0,0);
  var a=[];
  for(var i=0;i<14;i++){var d=new Date(today);d.setDate(d.getDate()+i);a.push({date:d,hi:55,lo:30,mean:42.5,precipIn:0});}
  return a;
}

/* ============================================================
   V4 Forecast Model — Multi-method ensemble
   
   Combines three independent forecast methods and blends with
   climatological percentiles as lead time increases.
   
   Method 1: AR(1) persistence in log-space
   Method 2: KNN historical analog ensemble
   Method 3: Seasonal median trajectory (from USGS daily stats)
   
   Final = weighted blend that shifts from AR(1)/KNN at short
   lead times toward climatology at long lead times.
   ============================================================ */
function computeForecastV4(site, recent, dailyStats, analogTraces, weather, warnings) {
  var horizon = 14;
  var q = recent.map(function(r) { return r.q; });
  var n = q.length;
  var currentQ = n > 0 ? q[n-1] : 100;
  var today = new Date(); today.setHours(0,0,0,0);
  var currentMonth = today.getMonth(); /* 0-11 */

  /* ================================================================
     METHOD 1: AR(1) persistence in log-space

     ln(Q_{t+1}) = phi * ln(Q_t) + (1-phi) * ln(Q_seasonal)

     Most accurate at 1-3 day lead times. Naturally reverts toward
     the seasonal median. Phi estimated via Yule-Walker in log-space.
     Bounds tightened to 0.80-0.98 per operational hydrology literature.
     ================================================================ */
  var phi = 0.95;
  if (n >= 14) {
    var logQ = [];
    for (var i = 0; i < n; i++) logQ.push(Math.log(Math.max(1, q[i])));
    var pairs = [];
    for (var i = 1; i < logQ.length; i++) pairs.push([logQ[i-1], logQ[i]]);
    if (pairs.length >= 7) {
      var mx = 0, my = 0;
      for (var i = 0; i < pairs.length; i++) { mx += pairs[i][0]; my += pairs[i][1]; }
      mx /= pairs.length; my /= pairs.length;
      var num = 0, den = 0;
      for (var i = 0; i < pairs.length; i++) {
        num += (pairs[i][0]-mx)*(pairs[i][1]-my);
        den += (pairs[i][0]-mx)*(pairs[i][0]-mx);
      }
      if (den > 0) phi = Math.max(0.80, Math.min(0.98, num/den));
    }
  }

  /* Get seasonal medians for forecast days */
  var seasonalQ = [];
  for (var i = 0; i < horizon; i++) {
    var fDate = new Date(today); fDate.setDate(fDate.getDate() + i + 1);
    var key = pad2(fDate.getMonth()+1) + '-' + pad2(fDate.getDate());
    if (dailyStats && dailyStats[key] && dailyStats[key].p50 != null) {
      seasonalQ.push(dailyStats[key].p50);
    } else {
      seasonalQ.push(currentQ);
    }
  }

  /* AR(1) forecast */
  var ar1 = [];
  var prevLogQ = Math.log(Math.max(1, currentQ));
  for (var i = 0; i < horizon; i++) {
    var logSeasonal = Math.log(Math.max(1, seasonalQ[i]));
    var logForecast = phi * prevLogQ + (1 - phi) * logSeasonal;
    ar1.push(Math.exp(logForecast));
    prevLogQ = logForecast;
  }

  /* ================================================================
     METHOD 2: KNN Analog ensemble

     Weighted average of the K nearest historical traces,
     scaled by current flow level.
     ================================================================ */
  var knnMedian = [];
  var knnTraces = [];
  if (analogTraces && analogTraces.length >= 3) {
    for (var d = 0; d < horizon; d++) {
      var weightedSum = 0;
      var traceVals = [];
      for (var k = 0; k < analogTraces.length; k++) {
        var ratio = analogTraces[k].trace[d] || 1.0;
        var val = currentQ * ratio;
        weightedSum += val * analogTraces[k].weight;
        traceVals.push(val);
      }
      knnMedian.push(weightedSum);
      knnTraces.push(traceVals);
    }
  } else {
    for (var d = 0; d < horizon; d++) {
      knnMedian.push(ar1[d]);
      knnTraces.push([ar1[d]]);
    }
  }

  /* ================================================================
     METHOD 3: Climatological seasonal trajectory (p50 for each DOY)
     ================================================================ */
  /* seasonalQ already computed above */

  /* ================================================================
     ADAPTIVE BLENDING in log-space

     Key improvements over simple linear blending:
     1. Blend in log-space to prevent high-flow bias
     2. Adapt weights based on flow anomaly — when current conditions
        are far from seasonal norm, weight dynamic methods higher;
        when near normal, trust climatology more
     3. Refined weight curves based on operational forecast research

     Base weights:
       Short (day 1-3): 50% AR(1) + 35% KNN + 15% climatology
       Medium (day 4-7): 30% AR(1) + 35% KNN + 35% climatology
       Long (day 8-14): 10% AR(1) + 25% KNN + 65% climatology
     ================================================================ */
  /* Compute flow anomaly: how far current flow is from seasonal */
  var todayKey = pad2(today.getMonth()+1) + '-' + pad2(today.getDate());
  var todayP50 = (dailyStats && dailyStats[todayKey] && dailyStats[todayKey].p50 != null)
    ? dailyStats[todayKey].p50 : currentQ;
  var logAnomaly = Math.abs(Math.log(Math.max(1,currentQ)) - Math.log(Math.max(1,todayP50)));
  /* anomalyFactor: 0 when at median, approaches 1 when far from median */
  var anomalyFactor = Math.min(1, logAnomaly / 1.0);

  var blended = [];
  for (var i = 0; i < horizon; i++) {
    var t = i / (horizon - 1);  /* 0 at day 1, 1 at day 14 */

    /* Base weights */
    var wAR1  = 0.50 - 0.40 * t;   /* 0.50 → 0.10 */
    var wKNN  = 0.35 - 0.10 * t;   /* 0.35 → 0.25 */
    var wClim = 0.15 + 0.50 * t;   /* 0.15 → 0.65 */

    /* Adaptive adjustment: when flow is anomalous, reduce climatology weight
       and increase dynamic methods (AR1+KNN), especially at medium leads */
    var climShift = anomalyFactor * 0.15 * (1 - t*0.5);
    wClim = Math.max(0.05, wClim - climShift);
    wAR1 += climShift * 0.5;
    wKNN += climShift * 0.5;

    /* Blend in log-space to prevent high-flow bias */
    var logAR1  = Math.log(Math.max(1, ar1[i]));
    var logKNN  = Math.log(Math.max(1, knnMedian[i]));
    var logClim = Math.log(Math.max(1, seasonalQ[i]));
    var logBlend = wAR1 * logAR1 + wKNN * logKNN + wClim * logClim;
    blended.push(Math.exp(logBlend));
  }

  /* ================================================================
     WEATHER PERTURBATION — Season-aware temperature response

     Spring (Mar-Jun): High sensitivity — snowmelt amplifies response
     Summer (Jul-Sep): Moderate — evapotranspiration effects
     Fall/Winter (Oct-Feb): Low — baseflow dominated, less temp-sensitive
     ================================================================ */
  var seasonalSensitivity;
  if (currentMonth >= 2 && currentMonth <= 5) {
    seasonalSensitivity = { warm: 0.006, cool: 0.004 };  /* Spring: high */
  } else if (currentMonth >= 6 && currentMonth <= 8) {
    seasonalSensitivity = { warm: 0.003, cool: 0.002 };  /* Summer: moderate */
  } else {
    seasonalSensitivity = { warm: 0.002, cool: 0.001 };  /* Fall/Winter: low */
  }

  var typicalMeanF = 45;
  for (var i = 0; i < horizon; i++) {
    var tmean = (weather[i] && !isNaN(weather[i].mean)) ? weather[i].mean : typicalMeanF;
    var tempDelta = tmean - typicalMeanF;
    var pctAdj = tempDelta > 0 ? tempDelta * seasonalSensitivity.warm : tempDelta * seasonalSensitivity.cool;
    /* Dampen weather perturbation at longer leads (less reliable) */
    var leadDampen = 1 - (i / horizon) * 0.6;  /* 1.0 at day 1, 0.4 at day 14 */
    blended[i] *= (1 + pctAdj * leadDampen);
    /* Rain events: attenuated pulse */
    var precip = (weather[i] && weather[i].precipIn) ? weather[i].precipIn : 0;
    if (precip > 0.1 && tmean > 32) {
      blended[i] += precip * currentQ * 0.015 * leadDampen;
    }
  }

  /* Adaptive smoothing: light at short leads (preserve signal), heavier at long leads */
  var smoothed = [];
  for (var i = 0; i < horizon; i++) {
    if (i <= 2) {
      /* Days 1-3: 3-point smooth (preserve short-term signal) */
      if (i === 0) smoothed.push((blended[0]*2 + blended[1]) / 3);
      else if (i === horizon-1) smoothed.push((blended[i-1] + blended[i]*2) / 3);
      else smoothed.push((blended[i-1] + blended[i] + blended[i+1]) / 3);
    } else {
      /* Days 4+: 5-point smooth where possible (reduce noise at longer leads) */
      if (i >= 2 && i < horizon-2) {
        smoothed.push((blended[i-2] + blended[i-1] + blended[i] + blended[i+1] + blended[i+2]) / 5);
      } else if (i === horizon-2) {
        smoothed.push((blended[i-1] + blended[i] + blended[i+1]) / 3);
      } else {
        smoothed.push((blended[i-1] + blended[i]*2) / 3);
      }
    }
  }

  /* Floor at 1 cfs */
  for (var i = 0; i < horizon; i++) smoothed[i] = Math.max(1, smoothed[i]);

  /* ================================================================
     UNCERTAINTY from multiple sources:
     1. KNN trace spread (real historical variability)
     2. Climatological percentiles (p10, p90 for each DOY)
     3. Minimum model spread that widens with lead time
     ================================================================ */
  var low = [], high = [];
  var climP10 = [], climP25 = [], climP50 = [], climP75 = [], climP90 = [];
  for (var i = 0; i < horizon; i++) {
    var fDate = new Date(today); fDate.setDate(fDate.getDate() + i + 1);
    var key = pad2(fDate.getMonth()+1) + '-' + pad2(fDate.getDate());
    var ds = dailyStats && dailyStats[key];

    /* Climatological percentiles for this day */
    var cp10 = ds && ds.p10 != null ? ds.p10 : smoothed[i] * 0.5;
    var cp25 = ds && ds.p25 != null ? ds.p25 : smoothed[i] * 0.7;
    var cp50 = ds && ds.p50 != null ? ds.p50 : smoothed[i];
    var cp75 = ds && ds.p75 != null ? ds.p75 : smoothed[i] * 1.3;
    var cp90 = ds && ds.p90 != null ? ds.p90 : smoothed[i] * 1.5;
    climP10.push(cp10); climP25.push(cp25); climP50.push(cp50);
    climP75.push(cp75); climP90.push(cp90);

    /* KNN trace spread */
    var knnLo = smoothed[i], knnHi = smoothed[i];
    if (knnTraces[i] && knnTraces[i].length > 1) {
      var sorted = knnTraces[i].slice().sort(function(a,b){return a-b;});
      knnLo = sorted[0];
      knnHi = sorted[sorted.length - 1];
    }

    /* Blend uncertainty sources: KNN at short lead, climatology at long */
    var t = i / (horizon - 1);
    var wKnnU = 1 - t;      /* 1.0 → 0.0 */
    var wClimU = t;          /* 0.0 → 1.0 */

    var lo = wKnnU * knnLo + wClimU * cp10;
    var hi = wKnnU * knnHi + wClimU * cp90;

    /* Minimum spread: ±10% at day 1, ±35% at day 14 */
    var minPct = 0.10 + 0.25 * t;
    lo = Math.min(lo, smoothed[i] * (1 - minPct));
    hi = Math.max(hi, smoothed[i] * (1 + minPct));

    low.push(Math.max(0, lo));
    high.push(hi);
  }

  var trend = smoothed[horizon-1] - smoothed[0];

  /* Components for display */
  return {
    dates: weather.slice(0, horizon).map(function(w) { return w.date; }),
    discharge: smoothed,
    low: low, high: high,
    /* Breakdown for components chart */
    ar1: ar1,
    knn: knnMedian,
    seasonal: seasonalQ,
    /* Climatological envelope */
    climP10: climP10, climP25: climP25, climP50: climP50,
    climP75: climP75, climP90: climP90,
    currentQ: currentQ,
    trend: trend,
    phi: phi,
    nAnalogs: analogTraces ? analogTraces.length : 0,
    analogYears: analogTraces ? analogTraces.map(function(a){return a.year;}) : [],
  };
}

function median(arr) {
  var s = arr.slice().sort(function(a,b){return a-b;});
  var m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}

/* ============================================================
   Rendering — updated for v4 outputs
   ============================================================ */
function renderSteps(names, current) {
  stepsEl.innerHTML = names.map(function(name,i) {
    var cls = i<current?'step done':i===current?'step active':'step';
    var icon = i<current?'&#10003; ':i===current?'&#9679; ':'';
    return '<span class="'+cls+'">'+icon+name+'</span>';
  }).join('');
}
function renderStepError(names) {
  stepsEl.innerHTML = names.map(function(n){return '<span class="step error">'+n+'</span>';}).join('');
}
function addWarning(msg) { warningsEl.innerHTML += '<div class="warning">'+msg+'</div>'; }

function renderResults(site, recent, forecast, weather, warnings) {
  resultsEl.classList.remove('hidden');
  $('site-name').textContent = site.name;
  var metaText = 'USGS ' + site.siteNo + '  |  (' + site.lat.toFixed(4)+', '+site.lon.toFixed(4)+')';
  if (site.drainArea) metaText += '  |  '+site.drainArea.toLocaleString()+' sq mi';
  metaText += '  |  AR(1) \u03C6=' + forecast.phi.toFixed(3);
  if (forecast.nAnalogs > 0) metaText += '  |  ' + forecast.nAnalogs + ' analogs (' + forecast.analogYears.join(', ') + ')';
  $('site-meta').textContent = metaText;

  /* Cards */
  $('card-current').innerHTML = '<div class="label">Current Discharge</div><div class="value" style="color:var(--yellow)">'+fmt(forecast.currentQ)+' cfs</div><div class="sub">Most recent daily mean</div>';

  var d7 = forecast.discharge[6]||0;
  $('card-day7').innerHTML = '<div class="label">Day 7 Forecast</div><div class="value" style="color:var(--accent)">'+fmt(d7)+' cfs</div><div class="sub">'+fmt(forecast.low[6])+' \u2013 '+fmt(forecast.high[6])+' cfs</div>';

  var li = forecast.discharge.length-1;
  $('card-day14').innerHTML = '<div class="label">Day 14 Forecast</div><div class="value" style="color:var(--accent2)">'+fmt(forecast.discharge[li])+' cfs</div><div class="sub">'+fmt(forecast.low[li])+' \u2013 '+fmt(forecast.high[li])+' cfs</div>';

  var dir = forecast.trend>0?'Rising':forecast.trend<0?'Falling':'Steady';
  var dc = forecast.trend>0?'var(--green)':forecast.trend<0?'var(--red)':'var(--text-dim)';
  $('card-trend').innerHTML = '<div class="label">14-Day Trend</div><div class="value" style="color:'+dc+'">'+dir+'</div><div class="sub">'+(forecast.trend>0?'+':'')+fmt(forecast.trend)+' cfs</div>';

  renderForecastChart(recent, forecast);
  renderComponentsChart(forecast);
  renderTable(forecast, weather);
  warnings.forEach(addWarning);
  resultsEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderForecastChart(recent, forecast) {
  var ctx = $('forecast-chart').getContext('2d');
  if (forecastChart) forecastChart.destroy();

  var slice = recent.slice(-30);
  var rDates = slice.map(function(r){return r.date;});
  var rQ = slice.map(function(r){return r.q;});
  var fDates = forecast.dates;
  var lastQ = rQ.length > 0 ? rQ[rQ.length-1] : null;

  /* Connect observed → forecast by overlapping last point */
  var allDates = rDates.concat(fDates);
  var labels = allDates.map(fmtDate);

  var obsData = rQ.concat(new Array(fDates.length).fill(null));

  var fPad = new Array(rQ.length-1).fill(null);
  var forecastData = fPad.concat([lastQ]).concat(forecast.discharge);
  var highData = fPad.concat([lastQ]).concat(forecast.high);
  var lowData = fPad.concat([lastQ]).concat(forecast.low);

  /* Climatological envelope */
  var climHiData = fPad.concat([lastQ]).concat(forecast.climP75);
  var climLoData = fPad.concat([lastQ]).concat(forecast.climP25);
  var climMedData = fPad.concat([null]).concat(forecast.climP50);

  forecastChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label:'Observed', data:obsData, borderColor:'#e2e8f0', borderWidth:2, pointRadius:0, tension:0.3 },
        { label:'Forecast', data:forecastData, borderColor:'#38bdf8', borderWidth:2.5, pointRadius:0, tension:0.3 },
        { label:'90% Conf.', data:highData, borderColor:'transparent', backgroundColor:'rgba(56,189,248,0.10)', fill:'+1', pointRadius:0 },
        { label:'10% Conf.', data:lowData, borderColor:'transparent', backgroundColor:'rgba(56,189,248,0.10)', fill:'-1', pointRadius:0 },
        { label:'Hist. p75', data:climHiData, borderColor:'rgba(251,191,36,0.3)', borderWidth:1, borderDash:[4,4], pointRadius:0, fill:false },
        { label:'Hist. p25', data:climLoData, borderColor:'rgba(251,191,36,0.3)', borderWidth:1, borderDash:[4,4], pointRadius:0, fill:false },
        { label:'Hist. Median', data:climMedData, borderColor:'rgba(251,191,36,0.5)', borderWidth:1.5, borderDash:[6,3], pointRadius:0, fill:false },
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
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label:'Blended Forecast', data:forecast.discharge, borderColor:'#38bdf8', borderWidth:2.5, pointRadius:0, tension:0.3 },
        { label:'AR(1) Persistence', data:forecast.ar1, borderColor:'#f87171', borderWidth:1.5, borderDash:[4,4], pointRadius:0, tension:0.3 },
        { label:'KNN Analogs', data:forecast.knn, borderColor:'#34d399', borderWidth:1.5, borderDash:[4,4], pointRadius:0, tension:0.3 },
        { label:'Seasonal Median', data:forecast.seasonal, borderColor:'#fbbf24', borderWidth:1.5, borderDash:[6,3], pointRadius:0, tension:0.3 },
      ]
    },
    options: chartOpts('Discharge (cfs)'),
  });
}

function chartOpts(yLabel) {
  return {
    responsive:true, maintainAspectRatio:false,
    interaction:{mode:'index',intersect:false},
    plugins:{
      legend:{labels:{color:'#94a3b8',usePointStyle:true,pointStyle:'line',padding:20,font:{size:11}}},
      tooltip:{backgroundColor:'#1e293b',borderColor:'#475569',borderWidth:1,titleColor:'#e2e8f0',bodyColor:'#e2e8f0'},
    },
    scales:{
      x:{ticks:{color:'#94a3b8',maxRotation:45,font:{size:10}},grid:{color:'rgba(71,85,105,0.3)'}},
      y:{title:{display:true,text:yLabel,color:'#94a3b8'},ticks:{color:'#94a3b8'},grid:{color:'rgba(71,85,105,0.3)'}},
    }
  };
}

function renderTable(forecast, weather) {
  var tbody = $('forecast-tbody');
  tbody.innerHTML = '';
  for (var i = 0; i < forecast.dates.length; i++) {
    var d = forecast.dates[i], w = weather[i]||{};
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>'+fmtDateLong(d)+'</td>'+
      '<td style="color:var(--yellow);font-weight:600">'+fmt(forecast.discharge[i])+'</td>'+
      '<td style="color:var(--text-dim)">'+fmt(forecast.low[i])+'</td>'+
      '<td style="color:var(--text-dim)">'+fmt(forecast.high[i])+'</td>'+
      '<td style="color:var(--accent)">'+fmt(forecast.ar1[i])+'</td>'+
      '<td style="color:var(--green)">'+fmt(forecast.knn[i])+'</td>'+
      '<td style="color:var(--yellow)">'+fmt(forecast.seasonal[i])+'</td>'+
      '<td>'+(isNaN(w.hi)?'\u2014':Math.round(w.hi)+'\u00B0')+'</td>'+
      '<td>'+(isNaN(w.lo)?'\u2014':Math.round(w.lo)+'\u00B0')+'</td>'+
      '<td>'+((w.precipIn||0).toFixed(2))+'"</td>';
    tbody.appendChild(tr);
  }
}

function fmt(v) { return v==null||isNaN(v)?'\u2014':v.toLocaleString(undefined,{maximumFractionDigits:1}); }
function fmtDate(d) { return d.toLocaleDateString('en-US',{month:'short',day:'numeric'}); }
function fmtDateLong(d) { return d.toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric'}); }

/* Init */
initMap();
loadMapSensors();
