/* ============================================================
   River Forecast Benchmarking Engine
   
   Runs hindcast evaluations: for a set of historical dates,
   generates forecasts using only data available at that time,
   then compares to actual observed flows.
   
   Metrics: NSE, RMSE, MAE, MAPE, Bias, Skill Score vs
   climatology and persistence baselines.
   ============================================================ */

var USGS_DV   = 'https://waterservices.usgs.gov/nwis/dv/';
var USGS_SITE = 'https://waterservices.usgs.gov/nwis/site/';
var USGS_STAT = 'https://waterservices.usgs.gov/nwis/stat/';

var $ = function(id) { return document.getElementById(id); };

/* ============================================================
   Skill Metrics — standard hydrology evaluation measures
   ============================================================ */
var Metrics = {
  /** Nash-Sutcliffe Efficiency: 1 = perfect, 0 = as good as mean, <0 = worse than mean */
  nse: function(obs, pred) {
    var meanObs = mean(obs);
    var ssRes = 0, ssTot = 0;
    for (var i = 0; i < obs.length; i++) {
      ssRes += (obs[i] - pred[i]) * (obs[i] - pred[i]);
      ssTot += (obs[i] - meanObs) * (obs[i] - meanObs);
    }
    return ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  },

  /** Root Mean Square Error (cfs) */
  rmse: function(obs, pred) {
    var sum = 0;
    for (var i = 0; i < obs.length; i++) sum += (obs[i]-pred[i])*(obs[i]-pred[i]);
    return Math.sqrt(sum / obs.length);
  },

  /** Mean Absolute Error (cfs) */
  mae: function(obs, pred) {
    var sum = 0;
    for (var i = 0; i < obs.length; i++) sum += Math.abs(obs[i]-pred[i]);
    return sum / obs.length;
  },

  /** Mean Absolute Percentage Error */
  mape: function(obs, pred) {
    var sum = 0, count = 0;
    for (var i = 0; i < obs.length; i++) {
      if (obs[i] > 0) { sum += Math.abs(obs[i]-pred[i]) / obs[i]; count++; }
    }
    return count > 0 ? sum / count * 100 : 0;
  },

  /** Percent Bias: positive = overpredicting, negative = underpredicting */
  pbias: function(obs, pred) {
    var sumErr = 0, sumObs = 0;
    for (var i = 0; i < obs.length; i++) { sumErr += pred[i]-obs[i]; sumObs += obs[i]; }
    return sumObs === 0 ? 0 : sumErr / sumObs * 100;
  },

  /** Skill Score vs a reference (e.g., climatology or persistence)
      SS = 1 - MSE_forecast / MSE_reference. >0 = better than reference */
  skillScore: function(obs, pred, ref) {
    var msePred = 0, mseRef = 0;
    for (var i = 0; i < obs.length; i++) {
      msePred += (obs[i]-pred[i])*(obs[i]-pred[i]);
      mseRef += (obs[i]-ref[i])*(obs[i]-ref[i]);
    }
    return mseRef === 0 ? 0 : 1 - msePred / mseRef;
  },

  /** Log-space NSE — better for high-flow bias, standard in hydrology */
  logNse: function(obs, pred) {
    var lo = [], lp = [];
    for (var i = 0; i < obs.length; i++) {
      if (obs[i] > 0 && pred[i] > 0) {
        lo.push(Math.log(obs[i]));
        lp.push(Math.log(pred[i]));
      }
    }
    return lo.length > 2 ? Metrics.nse(lo, lp) : 0;
  },

  /** Compute all metrics at once */
  all: function(obs, pred, clim, persist) {
    return {
      nse: Metrics.nse(obs, pred),
      logNse: Metrics.logNse(obs, pred),
      rmse: Metrics.rmse(obs, pred),
      mae: Metrics.mae(obs, pred),
      mape: Metrics.mape(obs, pred),
      pbias: Metrics.pbias(obs, pred),
      ssClim: clim ? Metrics.skillScore(obs, pred, clim) : null,
      ssPersist: persist ? Metrics.skillScore(obs, pred, persist) : null,
    };
  }
};

function mean(arr) {
  var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i];
  return arr.length > 0 ? s / arr.length : 0;
}
function median(arr) {
  var s = arr.slice().sort(function(a,b){return a-b;});
  var m = Math.floor(s.length/2);
  return s.length%2 ? s[m] : (s[m-1]+s[m])/2;
}

/* ============================================================
   Data fetching (same as app.js but date-parameterized)
   ============================================================ */
function isoDate(d) { return d.toISOString().slice(0,10); }
function pad2(n) { return n < 10 ? '0'+n : ''+n; }
function pf(s) { var v = parseFloat(s); return isNaN(v) ? null : v; }

async function fetchSiteInfo(siteNo) {
  var url = USGS_SITE + '?format=rdb&sites=' + siteNo + '&siteOutput=expanded&siteStatus=active';
  var text = await (await fetch(url)).text();
  var lines = text.split('\n').filter(function(l){return !l.startsWith('#')&&l.trim();});
  if (lines.length < 3) throw new Error('Site not found');
  var hdr = lines[0].split('\t'), vals = lines[2].split('\t');
  var col = function(n){return vals[hdr.indexOf(n)]||'';};
  return { siteNo:col('site_no'), name:col('station_nm'),
    lat:parseFloat(col('dec_lat_va'))||0, lon:parseFloat(col('dec_long_va'))||0,
    drainArea:parseFloat(col('drain_area_va'))||null };
}

async function fetchDailyStats(siteNo) {
  var url = USGS_STAT + '?format=rdb&sites=' + siteNo + '&statReportType=daily&statTypeCd=all&parameterCd=00060';
  var text = await (await fetch(url)).text();
  var lines = text.split('\n').filter(function(l){return !l.startsWith('#')&&l.trim();});
  if (lines.length < 3) return null;
  var hdr = lines[0].split('\t'), stats = {};
  for (var i = 2; i < lines.length; i++) {
    var cols = lines[i].split('\t');
    if (cols.length < hdr.length) continue;
    var row = {}; for (var j=0;j<hdr.length;j++) row[hdr[j]]=cols[j];
    var m = parseInt(row['month_nu']), d = parseInt(row['day_nu']);
    if (isNaN(m)||isNaN(d)) continue;
    stats[pad2(m)+'-'+pad2(d)] = {
      p10:pf(row['p10_va']),p25:pf(row['p25_va']),p50:pf(row['p50_va']),
      p75:pf(row['p75_va']),p90:pf(row['p90_va']),mean:pf(row['mean_va'])
    };
  }
  return Object.keys(stats).length > 100 ? stats : null;
}

/** Fetch daily discharge for a specific date range */
async function fetchDischarge(siteNo, startDate, endDate) {
  var url = USGS_DV + '?format=json&sites=' + siteNo + '&parameterCd=00060&startDT='+isoDate(startDate)+'&endDT='+isoDate(endDate);
  var data = await (await fetch(url)).json();
  var ts = [];
  try { ts = data.value.timeSeries[0].values[0].value; } catch(e) {}
  return ts.map(function(v) {
    return { date: new Date(v.dateTime), q: parseFloat(v.value) };
  }).filter(function(v) { return !isNaN(v.q) && v.q >= 0; });
}

function linearSlope(arr) {
  var n=arr.length; if(n<2) return 0;
  var sx=0,sy=0,sxy=0,sx2=0;
  for(var i=0;i<n;i++){sx+=i;sy+=arr[i];sxy+=i*arr[i];sx2+=i*i;}
  return (n*sxy-sx*sy)/(n*sx2-sx*sx);
}

/* ============================================================
   Hindcast Engine — runs the forecast model at a past date
   using only data that would have been available then
   ============================================================ */

/**
 * Run a single hindcast: generate a 14-day forecast as if we were
 * standing on `forecastDate`, then compare to actual observed flows.
 *
 * @param {string} siteNo - USGS site number
 * @param {Date} forecastDate - the date to pretend we're on
 * @param {object} dailyStats - pre-fetched USGS daily statistics
 * @param {number} nAnalogYears - how many past years for KNN
 * @returns {object} hindcast result with forecast, actual, metrics
 */
async function runHindcast(siteNo, forecastDate, dailyStats, nAnalogYears) {
  var horizon = 14;
  var fd = new Date(forecastDate); fd.setHours(0,0,0,0);

  /* Fetch 90 days of "recent" data ending on forecastDate */
  var histStart = new Date(fd); histStart.setDate(histStart.getDate() - 90);
  var recent = await fetchDischarge(siteNo, histStart, fd);
  if (recent.length < 14) throw new Error('Insufficient data for ' + isoDate(fd));

  var q = recent.map(function(r) { return r.q; });
  var n = q.length;
  var currentQ = q[n - 1];

  /* Fetch actual observed flows for the 14 days after forecastDate */
  var actualStart = new Date(fd); actualStart.setDate(actualStart.getDate() + 1);
  var actualEnd = new Date(fd); actualEnd.setDate(actualEnd.getDate() + horizon);
  var actualData = await fetchDischarge(siteNo, actualStart, actualEnd);
  var actual = actualData.map(function(r) { return r.q; }).slice(0, horizon);

  /* Build KNN analog traces */
  var analogTraces = await buildAnalogTraces(siteNo, fd, q, nAnalogYears);

  /* ---- Flow regime detection ---- */
  var last7 = q.slice(-7);
  var slope7 = linearSlope(last7) / Math.max(1, currentQ);
  var regime = Math.abs(slope7) < 0.005 ? 0 : (slope7 > 0 ? 1 : -1);

  /* ---- Retrospective bias correction ---- */
  var biasFactor = 1.0;
  if (n >= 21 && dailyStats) {
    var biasLogErrs = [];
    for (var b = 7; b >= 1; b--) {
      var bIdx = n - 1 - b;
      if (bIdx < 1) continue;
      var bDate = new Date(fd); bDate.setDate(bDate.getDate() - b);
      var bKey = pad2(bDate.getMonth()+1) + '-' + pad2(bDate.getDate());
      var bSeasonal = (dailyStats[bKey] && dailyStats[bKey].p50 != null) ? dailyStats[bKey].p50 : q[bIdx];
      var predLog = 0.93 * Math.log(Math.max(1, q[bIdx-1])) + 0.07 * Math.log(Math.max(1, bSeasonal));
      var actualLog = Math.log(Math.max(1, q[bIdx]));
      biasLogErrs.push(actualLog - predLog);
    }
    if (biasLogErrs.length >= 3) {
      var sortedErrs = biasLogErrs.slice().sort(function(a,b){return a-b;});
      var medErr = sortedErrs[Math.floor(sortedErrs.length/2)];
      biasFactor = Math.exp(Math.max(-0.15, Math.min(0.15, medErr)));
    }
  }

  /* ---- Phi estimation with regime adjustment ---- */
  var phi = fitPhi(q);
  var phiAdj = phi;
  if (regime === 1) phiAdj = Math.min(0.99, phi + 0.02);
  else if (regime === 0) phiAdj = Math.max(0.80, phi - 0.01);

  /* ---- Seasonal data with percentile anchoring ---- */
  var seasonalQ = [], seasonalP25 = [], seasonalP75 = [];
  for (var i = 0; i < horizon; i++) {
    var fDate = new Date(fd); fDate.setDate(fDate.getDate() + i + 1);
    var key = pad2(fDate.getMonth()+1) + '-' + pad2(fDate.getDate());
    var ds = dailyStats && dailyStats[key];
    seasonalQ.push(ds && ds.p50 != null ? ds.p50 : currentQ);
    seasonalP25.push(ds && ds.p25 != null ? ds.p25 : currentQ * 0.7);
    seasonalP75.push(ds && ds.p75 != null ? ds.p75 : currentQ * 1.3);
  }

  /* Percentile-anchored target */
  var todayKey = pad2(fd.getMonth()+1) + '-' + pad2(fd.getDate());
  var todayP50 = (dailyStats && dailyStats[todayKey] && dailyStats[todayKey].p50 != null) ? dailyStats[todayKey].p50 : currentQ;
  var todayP25 = (dailyStats && dailyStats[todayKey] && dailyStats[todayKey].p25 != null) ? dailyStats[todayKey].p25 : currentQ * 0.7;
  var todayP75 = (dailyStats && dailyStats[todayKey] && dailyStats[todayKey].p75 != null) ? dailyStats[todayKey].p75 : currentQ * 1.3;

  var pctilePos = 0.5;
  if (currentQ <= todayP25) pctilePos = 0.25;
  else if (currentQ >= todayP75) pctilePos = 0.75;
  else if (currentQ < todayP50) pctilePos = 0.25 + 0.25 * (currentQ - todayP25) / Math.max(1, todayP50 - todayP25);
  else pctilePos = 0.50 + 0.25 * (currentQ - todayP50) / Math.max(1, todayP75 - todayP50);

  var targetQ = [];
  for (var i = 0; i < horizon; i++) {
    var t = i / (horizon - 1);
    var effectivePctile = pctilePos + (0.5 - pctilePos) * t * 0.7;
    if (effectivePctile <= 0.5) {
      var w = Math.max(0, Math.min(1, (effectivePctile - 0.25) / 0.25));
      targetQ.push(seasonalP25[i] + w * (seasonalQ[i] - seasonalP25[i]));
    } else {
      var w = Math.max(0, Math.min(1, (effectivePctile - 0.50) / 0.25));
      targetQ.push(seasonalQ[i] + w * (seasonalP75[i] - seasonalQ[i]));
    }
  }

  /* ---- Method 1: Momentum-aware AR(1) with bias correction ---- */
  var ar1 = [];
  var prevLogQ = Math.log(Math.max(1, currentQ));
  for (var i = 0; i < horizon; i++) {
    var logTarget = Math.log(Math.max(1, targetQ[i]));
    var effPhi = i < 3 ? phiAdj : phi;
    var logF = effPhi * prevLogQ + (1 - effPhi) * logTarget;
    var bcDamp = Math.max(0, 1 - i * 0.12);
    ar1.push(Math.exp(logF) * (1 + (biasFactor - 1) * bcDamp));
    prevLogQ = logF;
  }

  /* ---- Method 2: KNN analog ensemble ---- */
  var knn = runKNN(currentQ, analogTraces, horizon);

  /* ---- Method 3: Climatology (p50) ---- */
  var clim = seasonalQ.slice();

  /* ---- Persistence baseline ---- */
  var persist = [];
  for (var i = 0; i < horizon; i++) persist.push(currentQ);

  /* ---- Dynamic method weighting ---- */
  var ar1Skill = 1.0, knnSkill = 1.0;
  if (n >= 14 && dailyStats) {
    var ar1Errs = [];
    for (var b = 7; b >= 1; b--) {
      var bIdx = n - 1 - b;
      if (bIdx < 1) continue;
      var bDate = new Date(fd); bDate.setDate(bDate.getDate() - b);
      var bKey = pad2(bDate.getMonth()+1) + '-' + pad2(bDate.getDate());
      var bSeas = (dailyStats[bKey] && dailyStats[bKey].p50 != null) ? dailyStats[bKey].p50 : q[bIdx];
      var ar1Pred = Math.exp(phi * Math.log(Math.max(1, q[bIdx-1])) + (1-phi) * Math.log(Math.max(1, bSeas)));
      ar1Errs.push(Math.abs(Math.log(ar1Pred) - Math.log(Math.max(1, q[bIdx]))));
    }
    var ar1MeanErr = ar1Errs.length > 0 ? ar1Errs.reduce(function(a,b){return a+b;},0) / ar1Errs.length : 0.1;
    ar1Skill = 1 / (1 + ar1MeanErr * 5);
    knnSkill = analogTraces && analogTraces.length >= 3 ? 1 / (1 + ar1MeanErr * 3) : 0.5;
  }

  /* ---- Adaptive blending in log-space ---- */
  var logAnomaly = Math.abs(Math.log(Math.max(1,currentQ)) - Math.log(Math.max(1,todayP50)));
  var anomalyFactor = Math.min(1, logAnomaly / 1.0);

  var blended = [];
  for (var i = 0; i < horizon; i++) {
    var t = i / (horizon - 1);
    var wAR1  = 0.50 - 0.40 * t;
    var wKNN  = 0.35 - 0.10 * t;
    var wClim = 0.15 + 0.50 * t;
    var climShift = anomalyFactor * 0.15 * (1 - t*0.5);
    wClim = Math.max(0.05, wClim - climShift);
    wAR1 += climShift * 0.5;
    wKNN += climShift * 0.5;
    var skillTotal = ar1Skill + knnSkill + 0.5;
    var dynAR1 = ar1Skill / skillTotal;
    var dynKNN = knnSkill / skillTotal;
    wAR1 = 0.70 * wAR1 + 0.30 * dynAR1 * (wAR1 + wKNN + wClim);
    wKNN = 0.70 * wKNN + 0.30 * dynKNN * (1 - wClim * 0.70 / (wAR1 + wKNN + wClim));
    var wSum = wAR1 + wKNN + wClim;
    wAR1 /= wSum; wKNN /= wSum; wClim /= wSum;
    var logAR1  = Math.log(Math.max(1, ar1[i]));
    var logKNN  = Math.log(Math.max(1, knn[i]));
    var logClim = Math.log(Math.max(1, targetQ[i]));
    blended.push(Math.max(1, Math.exp(wAR1*logAR1 + wKNN*logKNN + wClim*logClim)));
  }

  /* ---- Smoothing in log-space ---- */
  var smoothed = [];
  var logB = blended.map(function(v){return Math.log(Math.max(1,v));});
  for (var i = 0; i < horizon; i++) {
    var ls;
    if (i <= 2) {
      if (i === 0) ls = (logB[0]*2 + logB[1]) / 3;
      else if (i === horizon-1) ls = (logB[i-1] + logB[i]*2) / 3;
      else ls = (logB[i-1] + logB[i] + logB[i+1]) / 3;
    } else {
      if (i >= 2 && i < horizon-2) ls = (logB[i-2]+logB[i-1]+logB[i]+logB[i+1]+logB[i+2])/5;
      else if (i === horizon-2) ls = (logB[i-1]+logB[i]+logB[i+1])/3;
      else ls = (logB[i-1]+logB[i]*2)/3;
    }
    smoothed.push(Math.max(1, Math.exp(ls)));
  }

  /* Truncate actual to match available length */
  var len = Math.min(smoothed.length, actual.length);
  if (len < 3) throw new Error('Not enough actual data for ' + isoDate(fd));
  var obsSlice = actual.slice(0, len);
  var predSlice = smoothed.slice(0, len);
  var climSlice = clim.slice(0, len);
  var persistSlice = persist.slice(0, len);
  var ar1Slice = ar1.slice(0, len);
  var knnSlice = knn.slice(0, len);

  var metrics = {
    blended: Metrics.all(obsSlice, predSlice, climSlice, persistSlice),
    ar1: Metrics.all(obsSlice, ar1Slice, climSlice, persistSlice),
    knn: Metrics.all(obsSlice, knnSlice, climSlice, persistSlice),
    clim: Metrics.all(obsSlice, climSlice, climSlice, persistSlice),
    persist: Metrics.all(obsSlice, persistSlice, climSlice, persistSlice),
  };

  var leadMetrics = {};
  var ranges = { 'day1_3': [0,3], 'day4_7': [3,7], 'day8_14': [7,14] };
  for (var rname in ranges) {
    var lo = ranges[rname][0], hi = Math.min(ranges[rname][1], len);
    if (hi <= lo) continue;
    var oSub = obsSlice.slice(lo,hi), pSub = predSlice.slice(lo,hi);
    var cSub = climSlice.slice(lo,hi), perSub = persistSlice.slice(lo,hi);
    leadMetrics[rname] = Metrics.all(oSub, pSub, cSub, perSub);
  }

  return {
    forecastDate: fd,
    currentQ: currentQ,
    actual: obsSlice,
    blended: predSlice,
    ar1: ar1Slice,
    knn: knnSlice,
    clim: climSlice,
    persist: persistSlice,
    metrics: metrics,
    leadMetrics: leadMetrics,
    phi: phi,
    nAnalogs: analogTraces ? analogTraces.length : 0,
  };
}

/* ---- Model components ---- */

function fitPhi(q) {
  var n = q.length;
  if (n < 14) return 0.95;
  var logQ = [];
  for (var i = 0; i < n; i++) logQ.push(Math.log(Math.max(1, q[i])));
  var pairs = [];
  for (var i = 1; i < logQ.length; i++) pairs.push([logQ[i-1], logQ[i]]);
  if (pairs.length < 7) return 0.95;
  var mx=0,my=0;
  for (var i=0;i<pairs.length;i++){mx+=pairs[i][0];my+=pairs[i][1];}
  mx/=pairs.length; my/=pairs.length;
  var num=0,den=0;
  for (var i=0;i<pairs.length;i++){
    num+=(pairs[i][0]-mx)*(pairs[i][1]-my);
    den+=(pairs[i][0]-mx)*(pairs[i][0]-mx);
  }
  return den > 0 ? Math.max(0.80, Math.min(0.98, num/den)) : 0.95;
}

function runKNN(currentQ, analogTraces, horizon) {
  if (!analogTraces || analogTraces.length < 2) {
    var flat = []; for (var i=0;i<horizon;i++) flat.push(currentQ); return flat;
  }
  var result = [];
  for (var d = 0; d < horizon; d++) {
    var wsum = 0;
    for (var k = 0; k < analogTraces.length; k++) {
      var ratio = analogTraces[k].trace[d] || 1.0;
      wsum += currentQ * ratio * analogTraces[k].weight;
    }
    result.push(wsum);
  }
  return result;
}

async function buildAnalogTraces(siteNo, forecastDate, recentQ, nYears) {
  var currentQ = recentQ[recentQ.length-1];
  if (currentQ <= 0) return null;
  var last7 = recentQ.slice(-7);
  var slope = linearSlope(last7) / currentQ;

  /* Acceleration and variability features */
  var accel = 0;
  if (recentQ.length >= 14) {
    var prev7 = recentQ.slice(-14, -7);
    var prevSlope = linearSlope(prev7) / Math.max(1, recentQ[recentQ.length-8]);
    accel = slope - prevSlope;
  }
  var cv = 0;
  if (recentQ.length >= 14) {
    var r14 = recentQ.slice(-14);
    var m14 = r14.reduce(function(a,b){return a+b;},0) / r14.length;
    var v14 = r14.reduce(function(a,b){return a+(b-m14)*(b-m14);},0) / r14.length;
    cv = m14 > 0 ? Math.sqrt(v14) / m14 : 0;
  }

  var fetches = [];
  for (var y = 1; y <= nYears; y++) {
    var start = new Date(forecastDate.getFullYear()-y, forecastDate.getMonth(), forecastDate.getDate()-14);
    var end   = new Date(forecastDate.getFullYear()-y, forecastDate.getMonth(), forecastDate.getDate()+16);
    var url = USGS_DV + '?format=json&sites='+siteNo+'&parameterCd=00060&startDT='+isoDate(start)+'&endDT='+isoDate(end);
    fetches.push(fetch(url).then(function(r){return r.json();}).catch(function(){return null;}));
  }
  var responses = await Promise.all(fetches);

  var candidates = [];
  for (var i = 0; i < responses.length; i++) {
    var data = responses[i]; if (!data) continue;
    var ts = [];
    try { ts = data.value.timeSeries[0].values[0].value; } catch(e){continue;}
    var flows = ts.map(function(v){return parseFloat(v.value);}).filter(function(v){return !isNaN(v)&&v>0;});
    if (flows.length < 20) continue;
    var anchorIdx = Math.min(14, flows.length-15);
    if (anchorIdx < 7) continue;
    var anchorQ = flows[anchorIdx];
    if (anchorQ <= 0) continue;

    var flowDiff = Math.log(currentQ/anchorQ);
    var hist7 = flows.slice(Math.max(0,anchorIdx-6), anchorIdx+1);
    var histSlope = linearSlope(hist7) / anchorQ;
    var slopeDiff = slope - histSlope;

    var histAccel = 0;
    if (anchorIdx >= 14) {
      var hp7 = flows.slice(anchorIdx-13, anchorIdx-6);
      var hps = linearSlope(hp7) / Math.max(1, flows[anchorIdx-7]);
      histAccel = histSlope - hps;
    }
    var accelDiff = accel - histAccel;

    var hr14 = flows.slice(Math.max(0,anchorIdx-13), anchorIdx+1);
    var hm = hr14.reduce(function(a,b){return a+b;},0) / hr14.length;
    var hv = hr14.reduce(function(a,b){return a+(b-hm)*(b-hm);},0) / hr14.length;
    var hcv = hm > 0 ? Math.sqrt(hv) / hm : 0;
    var cvDiff = cv - hcv;

    var dist = Math.sqrt(5.0*flowDiff*flowDiff + 1.5*slopeDiff*slopeDiff + 0.8*accelDiff*accelDiff + 0.5*cvDiff*cvDiff);

    var trace = [];
    for (var d=1;d<=14;d++){
      var idx=anchorIdx+d;
      trace.push(idx<flows.length ? flows[idx]/anchorQ : (trace.length>0?trace[trace.length-1]:1));
    }
    candidates.push({distance:dist, trace:trace, year:forecastDate.getFullYear()-i-1});
  }
  if (candidates.length < 2) return null;
  candidates.sort(function(a,b){return a.distance-b.distance;});
  var K = Math.min(7, candidates.length);
  var topK = candidates.slice(0, K);
  var totalW = 0;
  for (var i=0;i<K;i++){topK[i].weight=1/((topK[i].distance+0.01)*(topK[i].distance+0.01));totalW+=topK[i].weight;}
  for (var i=0;i<K;i++) topK[i].weight/=totalW;
  return topK;
}

/* ============================================================
   Benchmark Orchestration — runs batches of hindcasts across
   multiple sites and dates, aggregates results
   ============================================================ */

var BENCHMARK_SITES = [
  { id: '09380000', name: 'Colorado R. at Lees Ferry, AZ',       state: 'AZ' },
  { id: '09251000', name: 'Yampa R. near Maybell, CO',           state: 'CO' },
  { id: '13011000', name: 'Snake R. near Moran, WY',             state: 'WY' },
  { id: '12340000', name: 'Blackfoot R. near Bonner, MT',        state: 'MT' },
  { id: '10109000', name: 'Logan R. above State Dam, UT',        state: 'UT' },
  { id: '13185000', name: 'Boise R. near Twin Springs, ID',      state: 'ID' },
  { id: '09066510', name: 'Gore Creek at Mouth near Minturn, CO', state: 'CO' },
  { id: '06191500', name: 'Yellowstone R. at Corwin Springs, MT', state: 'MT' },
];

/**
 * Generate an array of test dates (1st of each month) going back nMonths
 * from a reference date, skipping recent months that lack verification data.
 */
function generateTestDates(nMonths, referenceDate) {
  var ref = referenceDate || new Date();
  var dates = [];
  /* Start 30 days back to ensure 14-day verification data exists */
  var cursor = new Date(ref);
  cursor.setDate(1);
  cursor.setMonth(cursor.getMonth() - 1); // skip current month
  for (var i = 0; i < nMonths; i++) {
    dates.push(new Date(cursor));
    cursor.setMonth(cursor.getMonth() - 1);
  }
  return dates;
}

/**
 * Run a full benchmark: iterate over sites × dates, calling runHindcast
 * for each combination, collecting and aggregating results.
 *
 * @param {Array} sites - list of {id, name} objects
 * @param {Array} testDates - Date objects to hindcast from
 * @param {Function} onProgress - callback(completed, total, currentSite, currentDate, result)
 * @returns {object} aggregated benchmark results
 */
async function runBenchmarkSuite(sites, testDates, onProgress) {
  var total = sites.length * testDates.length;
  var completed = 0;
  var allResults = [];
  var siteResults = {};

  for (var s = 0; s < sites.length; s++) {
    var site = sites[s];
    siteResults[site.id] = { site: site, hindcasts: [], dailyStats: null };

    /* Fetch daily stats once per site */
    try {
      siteResults[site.id].dailyStats = await fetchDailyStats(site.id);
    } catch(e) {
      /* If stats fail, skip this site */
      completed += testDates.length;
      if (onProgress) onProgress(completed, total, site.name, null, { error: 'No daily stats' });
      continue;
    }

    for (var d = 0; d < testDates.length; d++) {
      var testDate = testDates[d];
      try {
        var result = await runHindcast(site.id, testDate, siteResults[site.id].dailyStats, 15);
        result.siteName = site.name;
        result.siteId = site.id;
        siteResults[site.id].hindcasts.push(result);
        allResults.push(result);
        completed++;
        if (onProgress) onProgress(completed, total, site.name, testDate, result);
      } catch(e) {
        completed++;
        if (onProgress) onProgress(completed, total, site.name, testDate, { error: e.message });
      }

      /* Small delay to avoid hammering USGS API */
      await new Promise(function(r) { setTimeout(r, 300); });
    }
  }

  return aggregateResults(allResults, siteResults);
}

/**
 * Aggregate individual hindcast results into summary statistics
 */
function aggregateResults(allResults, siteResults) {
  if (allResults.length === 0) return { error: 'No successful hindcasts' };

  /* Overall metrics across all hindcasts */
  var overall = aggregateMetrics(allResults);

  /* Per-site metrics */
  var bySite = {};
  for (var siteId in siteResults) {
    var sr = siteResults[siteId];
    if (sr.hindcasts.length > 0) {
      bySite[siteId] = {
        site: sr.site,
        n: sr.hindcasts.length,
        metrics: aggregateMetrics(sr.hindcasts)
      };
    }
  }

  /* By season */
  var bySeason = { winter: [], spring: [], summer: [], fall: [] };
  for (var i = 0; i < allResults.length; i++) {
    var m = allResults[i].forecastDate.getMonth();
    if (m >= 11 || m <= 1)      bySeason.winter.push(allResults[i]);
    else if (m >= 2 && m <= 4)  bySeason.spring.push(allResults[i]);
    else if (m >= 5 && m <= 7)  bySeason.summer.push(allResults[i]);
    else                        bySeason.fall.push(allResults[i]);
  }
  var seasonMetrics = {};
  for (var s in bySeason) {
    if (bySeason[s].length > 0) seasonMetrics[s] = aggregateMetrics(bySeason[s]);
  }

  /* Lead-time breakdown */
  var leadTimeMetrics = aggregateLeadMetrics(allResults);

  return {
    nHindcasts: allResults.length,
    overall: overall,
    bySite: bySite,
    bySeason: seasonMetrics,
    byLeadTime: leadTimeMetrics,
    allResults: allResults,
  };
}

/**
 * Compute average metrics across a list of hindcast results
 */
function aggregateMetrics(results) {
  var methods = ['blended', 'ar1', 'knn', 'clim', 'persist'];
  var agg = {};
  for (var mi = 0; mi < methods.length; mi++) {
    var method = methods[mi];
    var vals = { nse:[], logNse:[], rmse:[], mae:[], mape:[], pbias:[], ssClim:[], ssPersist:[] };
    for (var i = 0; i < results.length; i++) {
      var m = results[i].metrics[method];
      if (!m) continue;
      for (var k in vals) {
        if (m[k] != null && isFinite(m[k])) vals[k].push(m[k]);
      }
    }
    agg[method] = {};
    for (var k in vals) {
      agg[method][k] = vals[k].length > 0 ? {
        mean: mean(vals[k]),
        median: median(vals[k]),
        min: Math.min.apply(null, vals[k]),
        max: Math.max.apply(null, vals[k]),
        n: vals[k].length
      } : null;
    }
  }
  return agg;
}

/**
 * Aggregate lead-time-specific metrics across all hindcasts
 */
function aggregateLeadMetrics(results) {
  var ranges = ['day1_3', 'day4_7', 'day8_14'];
  var agg = {};
  for (var ri = 0; ri < ranges.length; ri++) {
    var rname = ranges[ri];
    var vals = { nse:[], logNse:[], rmse:[], mae:[], mape:[], ssClim:[], ssPersist:[] };
    for (var i = 0; i < results.length; i++) {
      var lm = results[i].leadMetrics[rname];
      if (!lm) continue;
      for (var k in vals) {
        if (lm[k] != null && isFinite(lm[k])) vals[k].push(lm[k]);
      }
    }
    agg[rname] = {};
    for (var k in vals) {
      agg[rname][k] = vals[k].length > 0 ? {
        mean: mean(vals[k]),
        median: median(vals[k]),
        n: vals[k].length
      } : null;
    }
  }
  return agg;
}

/* ============================================================
   Benchmark Rendering — charts, tables, and summary display
   ============================================================ */

var benchChart1 = null; // method comparison bar chart
var benchChart2 = null; // lead-time skill decay
var benchChart3 = null; // site comparison
var benchChart4 = null; // seasonal comparison

function renderBenchmarkResults(results) {
  if (results.error) {
    $('bench-output').innerHTML = '<div class="warning">' + results.error + '</div>';
    return;
  }
  $('bench-output').classList.remove('hidden');

  renderSummaryCards(results);
  renderMethodComparisonChart(results);
  renderLeadTimeChart(results);
  renderSiteTable(results);
  renderSeasonTable(results);
  renderDetailTable(results);
  renderDiagnostics(results);
}

/* ---- Summary cards ---- */
function renderSummaryCards(results) {
  var ov = results.overall;
  var bl = ov.blended;
  $('bench-card-n').innerHTML =
    '<div class="label">Hindcasts Run</div>' +
    '<div class="value">' + results.nHindcasts + '</div>' +
    '<div class="sub">' + Object.keys(results.bySite).length + ' sites × multiple dates</div>';
  $('bench-card-nse').innerHTML =
    '<div class="label">Blended NSE</div>' +
    '<div class="value">' + fmtMetric(bl.nse, 3) + '</div>' +
    '<div class="sub">Median: ' + fmtMetricMed(bl.nse) + '</div>';
  $('bench-card-mape').innerHTML =
    '<div class="label">Blended MAPE</div>' +
    '<div class="value">' + fmtMetric(bl.mape, 1) + '%</div>' +
    '<div class="sub">Median: ' + fmtMetricMed(bl.mape) + '%</div>';
  $('bench-card-skill').innerHTML =
    '<div class="label">Skill vs Climatology</div>' +
    '<div class="value">' + fmtMetric(bl.ssClim, 3) + '</div>' +
    '<div class="sub">Median: ' + fmtMetricMed(bl.ssClim) + '</div>';
}

function fmtMetric(m, dec) {
  if (!m || m.mean == null) return '—';
  return m.mean.toFixed(dec);
}
function fmtMetricMed(m) {
  if (!m || m.median == null) return '—';
  return m.median.toFixed(3);
}

/* ---- Method Comparison Bar Chart ---- */
function renderMethodComparisonChart(results) {
  var ctx = $('bench-chart-methods').getContext('2d');
  if (benchChart1) benchChart1.destroy();

  var methods = ['blended', 'ar1', 'knn', 'clim', 'persist'];
  var labels = ['Blended', 'AR(1)', 'KNN', 'Climatology', 'Persistence'];
  var colors = ['#38bdf8', '#818cf8', '#34d399', '#fbbf24', '#f87171'];
  var ov = results.overall;

  var nseData = [], mapeData = [], ssData = [];
  for (var i = 0; i < methods.length; i++) {
    var m = ov[methods[i]];
    nseData.push(m.nse ? m.nse.mean : 0);
    mapeData.push(m.mape ? m.mape.mean : 0);
    ssData.push(m.ssClim ? m.ssClim.mean : 0);
  }

  benchChart1 = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'NSE (higher=better)', data: nseData, backgroundColor: colors.map(function(c){return c+'cc';}), borderColor: colors, borderWidth: 1 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e2e8f0' } }, title: { display: true, text: 'Nash-Sutcliffe Efficiency by Method', color: '#e2e8f0' } },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' }, suggestedMin: -0.5, suggestedMax: 1 }
      }
    }
  });
}

/* ---- Lead-Time Skill Decay Chart ---- */
function renderLeadTimeChart(results) {
  var ctx = $('bench-chart-leadtime').getContext('2d');
  if (benchChart2) benchChart2.destroy();

  var lt = results.byLeadTime;
  var labels = ['Day 1-3', 'Day 4-7', 'Day 8-14'];
  var ranges = ['day1_3', 'day4_7', 'day8_14'];

  var nseVals = [], mapeVals = [], ssVals = [];
  for (var i = 0; i < ranges.length; i++) {
    var lm = lt[ranges[i]];
    nseVals.push(lm && lm.nse ? lm.nse.mean : 0);
    mapeVals.push(lm && lm.mape ? lm.mape.mean : 0);
    ssVals.push(lm && lm.ssClim ? lm.ssClim.mean : 0);
  }

  benchChart2 = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        { label: 'NSE', data: nseVals, borderColor: '#38bdf8', backgroundColor: 'rgba(56,189,248,0.1)', fill: true, tension: 0.3 },
        { label: 'Skill vs Clim', data: ssVals, borderColor: '#34d399', backgroundColor: 'rgba(52,211,153,0.1)', fill: true, tension: 0.3 },
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e2e8f0' } }, title: { display: true, text: 'Forecast Skill Decay with Lead Time', color: '#e2e8f0' } },
      scales: {
        x: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' }, suggestedMin: -0.5, suggestedMax: 1 }
      }
    }
  });
}

/* ---- Site comparison table ---- */
function renderSiteTable(results) {
  var tbody = $('bench-site-tbody');
  tbody.innerHTML = '';
  for (var siteId in results.bySite) {
    var s = results.bySite[siteId];
    var bl = s.metrics.blended;
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + s.site.name + '</td>' +
      '<td>' + s.n + '</td>' +
      '<td>' + fmtMetric(bl.nse, 3) + '</td>' +
      '<td>' + fmtMetric(bl.logNse, 3) + '</td>' +
      '<td>' + fmtMetric(bl.mape, 1) + '%</td>' +
      '<td>' + fmtMetric(bl.pbias, 1) + '%</td>' +
      '<td>' + fmtMetric(bl.ssClim, 3) + '</td>' +
      '<td>' + fmtMetric(bl.ssPersist, 3) + '</td>';
    tbody.appendChild(tr);
  }
}

/* ---- Season comparison table ---- */
function renderSeasonTable(results) {
  var tbody = $('bench-season-tbody');
  tbody.innerHTML = '';
  var seasons = ['winter', 'spring', 'summer', 'fall'];
  var seasonLabels = ['Winter (Dec-Feb)', 'Spring (Mar-May)', 'Summer (Jun-Aug)', 'Fall (Sep-Nov)'];
  for (var i = 0; i < seasons.length; i++) {
    var sm = results.bySeason[seasons[i]];
    if (!sm) continue;
    var bl = sm.blended;
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + seasonLabels[i] + '</td>' +
      '<td>' + fmtMetric(bl.nse, 3) + '</td>' +
      '<td>' + fmtMetric(bl.logNse, 3) + '</td>' +
      '<td>' + fmtMetric(bl.mape, 1) + '%</td>' +
      '<td>' + fmtMetric(bl.pbias, 1) + '%</td>' +
      '<td>' + fmtMetric(bl.ssClim, 3) + '</td>';
    tbody.appendChild(tr);
  }
}

/* ---- Detailed per-hindcast table ---- */
function renderDetailTable(results) {
  var tbody = $('bench-detail-tbody');
  tbody.innerHTML = '';
  var all = results.allResults.slice().sort(function(a,b) {
    return a.forecastDate - b.forecastDate;
  });
  for (var i = 0; i < all.length; i++) {
    var r = all[i];
    var bl = r.metrics.blended;
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (r.siteName || r.siteId) + '</td>' +
      '<td>' + isoDate(r.forecastDate) + '</td>' +
      '<td>' + r.currentQ.toFixed(0) + '</td>' +
      '<td>' + bl.nse.toFixed(3) + '</td>' +
      '<td>' + bl.mape.toFixed(1) + '%</td>' +
      '<td>' + bl.pbias.toFixed(1) + '%</td>' +
      '<td>' + (bl.ssClim != null ? bl.ssClim.toFixed(3) : '—') + '</td>' +
      '<td>' + r.phi.toFixed(3) + '</td>';
    tbody.appendChild(tr);
  }
}

/* ---- Diagnostics / model tuning suggestions ---- */
function renderDiagnostics(results) {
  var el = $('bench-diagnostics');
  var lines = [];
  var ov = results.overall;

  /* Check overall performance */
  var blNse = ov.blended.nse ? ov.blended.nse.mean : null;
  var ar1Nse = ov.ar1.nse ? ov.ar1.nse.mean : null;
  var knnNse = ov.knn.nse ? ov.knn.nse.mean : null;
  var climNse = ov.clim.nse ? ov.clim.nse.mean : null;

  lines.push('<strong>Model Performance Summary</strong>');
  if (blNse != null) {
    if (blNse > 0.7) lines.push('&#x2705; Blended NSE = ' + blNse.toFixed(3) + ' — Good overall performance');
    else if (blNse > 0.4) lines.push('&#x26A0;&#xFE0F; Blended NSE = ' + blNse.toFixed(3) + ' — Moderate; room for improvement');
    else lines.push('&#x274C; Blended NSE = ' + blNse.toFixed(3) + ' — Poor; model needs significant tuning');
  }

  /* Compare methods */
  if (ar1Nse != null && knnNse != null) {
    if (ar1Nse > knnNse + 0.05) lines.push('AR(1) outperforms KNN by ' + (ar1Nse-knnNse).toFixed(3) + ' NSE — consider increasing AR(1) weight');
    else if (knnNse > ar1Nse + 0.05) lines.push('KNN outperforms AR(1) by ' + (knnNse-ar1Nse).toFixed(3) + ' NSE — consider increasing KNN weight');
    else lines.push('AR(1) and KNN perform similarly — current blending weights are reasonable');
  }

  /* Check skill vs climatology */
  var blSS = ov.blended.ssClim ? ov.blended.ssClim.mean : null;
  if (blSS != null) {
    if (blSS > 0.3) lines.push('&#x2705; Skill score vs climatology = ' + blSS.toFixed(3) + ' — significantly better than climatology');
    else if (blSS > 0) lines.push('&#x26A0;&#xFE0F; Skill score vs climatology = ' + blSS.toFixed(3) + ' — marginal improvement over climatology');
    else lines.push('&#x274C; Skill score vs climatology = ' + blSS.toFixed(3) + ' — no better than climatology');
  }

  /* Bias check */
  var blBias = ov.blended.pbias ? ov.blended.pbias.mean : null;
  if (blBias != null) {
    if (Math.abs(blBias) < 5) lines.push('&#x2705; Percent bias = ' + blBias.toFixed(1) + '% — low bias');
    else if (blBias > 0) lines.push('&#x26A0;&#xFE0F; Percent bias = +' + blBias.toFixed(1) + '% — model over-predicts');
    else lines.push('&#x26A0;&#xFE0F; Percent bias = ' + blBias.toFixed(1) + '% — model under-predicts');
  }

  /* Lead time skill */
  var lt = results.byLeadTime;
  if (lt.day1_3 && lt.day1_3.nse && lt.day8_14 && lt.day8_14.nse) {
    var shortNse = lt.day1_3.nse.mean;
    var longNse = lt.day8_14.nse.mean;
    lines.push('');
    lines.push('<strong>Lead-Time Breakdown</strong>');
    lines.push('Day 1-3 NSE: ' + shortNse.toFixed(3) + ' | Day 8-14 NSE: ' + longNse.toFixed(3));
    var decay = shortNse - longNse;
    if (decay > 0.4) lines.push('&#x26A0;&#xFE0F; Large skill decay (' + decay.toFixed(3) + ') at longer leads — long-range blending needs adjustment');
    else lines.push('Skill decay with lead time: ' + decay.toFixed(3) + ' — acceptable');
  }

  /* Seasonal patterns */
  lines.push('');
  lines.push('<strong>Seasonal Breakdown</strong>');
  for (var s in results.bySeason) {
    var sm = results.bySeason[s];
    if (sm && sm.blended && sm.blended.nse) {
      lines.push(s.charAt(0).toUpperCase() + s.slice(1) + ': NSE=' + sm.blended.nse.mean.toFixed(3) +
        ', MAPE=' + (sm.blended.mape ? sm.blended.mape.mean.toFixed(1) : '?') + '%');
    }
  }

  /* Tuning suggestions */
  lines.push('');
  lines.push('<strong>Tuning Suggestions</strong>');
  var suggestions = [];
  if (blBias != null && blBias > 10) suggestions.push('High positive bias — try reducing AR(1) weight or adding bias correction');
  if (blBias != null && blBias < -10) suggestions.push('High negative bias — check if KNN analog years are too dry');
  if (ar1Nse != null && ar1Nse < 0.3) suggestions.push('AR(1) performs poorly — check phi fitting, consider tightening bounds');
  if (knnNse != null && knnNse < 0.1) suggestions.push('KNN performs poorly — consider increasing K or nAnalogYears');
  if (lt.day8_14 && lt.day8_14.ssClim && lt.day8_14.ssClim.mean < 0) suggestions.push('Long-range forecasts worse than climatology — increase climatology weight at day 8-14');
  if (suggestions.length === 0) suggestions.push('No critical issues detected — model parameters appear well-tuned');
  for (var i = 0; i < suggestions.length; i++) lines.push('• ' + suggestions[i]);

  el.innerHTML = lines.join('<br>');
}

/* ---- Progress bar rendering ---- */
function renderProgress(completed, total, siteName, date, result) {
  var pct = total > 0 ? Math.round(completed/total*100) : 0;
  var bar = $('bench-progress-bar');
  var text = $('bench-progress-text');
  if (bar) bar.style.width = pct + '%';
  if (text) {
    var msg = completed + '/' + total + ' (' + pct + '%)';
    if (siteName) msg += ' — ' + siteName;
    if (date) msg += ' ' + isoDate(date);
    if (result && result.error) msg += ' [Error: ' + result.error + ']';
    text.textContent = msg;
  }
}

/* ---- Button handlers ---- */
async function startBenchmark() {
  var nMonths = parseInt($('bench-months').value) || 12;
  var siteCheckboxes = document.querySelectorAll('.bench-site-check:checked');
  var sites = [];
  siteCheckboxes.forEach(function(cb) {
    var s = BENCHMARK_SITES.find(function(bs) { return bs.id === cb.value; });
    if (s) sites.push(s);
  });
  if (sites.length === 0) {
    alert('Select at least one site');
    return;
  }

  $('bench-run-btn').disabled = true;
  $('bench-run-btn').textContent = 'Running...';
  $('bench-progress').classList.remove('hidden');
  $('bench-output').classList.add('hidden');

  var testDates = generateTestDates(nMonths);
  try {
    var results = await runBenchmarkSuite(sites, testDates, renderProgress);
    renderBenchmarkResults(results);
  } catch(e) {
    $('bench-output').innerHTML = '<div class="warning">Benchmark failed: ' + e.message + '</div>';
    $('bench-output').classList.remove('hidden');
  }

  $('bench-run-btn').disabled = false;
  $('bench-run-btn').textContent = 'Run Benchmark';
}

/* ---- Quick benchmark: fewer sites, fewer dates ---- */
async function startQuickBenchmark() {
  $('bench-run-btn').disabled = true;
  $('bench-run-btn').textContent = 'Running Quick...';
  $('bench-progress').classList.remove('hidden');
  $('bench-output').classList.add('hidden');

  var sites = BENCHMARK_SITES.slice(0, 3);
  var testDates = generateTestDates(6);

  try {
    var results = await runBenchmarkSuite(sites, testDates, renderProgress);
    renderBenchmarkResults(results);
  } catch(e) {
    $('bench-output').innerHTML = '<div class="warning">Benchmark failed: ' + e.message + '</div>';
    $('bench-output').classList.remove('hidden');
  }

  $('bench-run-btn').disabled = false;
  $('bench-run-btn').textContent = 'Run Benchmark';
}

/* Wire up on DOMContentLoaded */
document.addEventListener('DOMContentLoaded', function() {
  /* Populate site checkboxes */
  var container = $('bench-site-list');
  if (container) {
    for (var i = 0; i < BENCHMARK_SITES.length; i++) {
      var s = BENCHMARK_SITES[i];
      var label = document.createElement('label');
      label.className = 'bench-site-label';
      label.innerHTML = '<input type="checkbox" class="bench-site-check" value="'+s.id+'" '+(i<4?'checked':'')+'>'+
        ' <span class="site-id">'+s.id+'</span> '+s.name;
      container.appendChild(label);
    }
  }

  $('bench-run-btn').addEventListener('click', startBenchmark);
  $('bench-quick-btn').addEventListener('click', startQuickBenchmark);
});
