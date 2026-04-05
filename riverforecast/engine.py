"""Forecast engine — orchestrates data retrieval and model execution.

This is the main entry point for generating a 14-day river forecast.
It pulls data from USGS, NWS, and SNOTEL, runs the hydrological models,
and assembles the final forecast with uncertainty bounds.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

import numpy as np
import pandas as pd

from riverforecast.constants import FORECAST_HORIZON_DAYS, MOUNTAIN_WEST_STATES
from riverforecast.data.usgs import SiteInfo, USGSClient
from riverforecast.data.nws import NWSClient, WeatherForecast
from riverforecast.data.snotel import SnotelClient
from riverforecast.models.baseflow import BaseflowSeparator
from riverforecast.models.snowmelt import SnowmeltModel
from riverforecast.models.rainfall_runoff import RainfallRunoffModel
from riverforecast.models.routing import MuskingumRouter

logger = logging.getLogger(__name__)


@dataclass
class ForecastResult:
    """Complete 14-day river flow forecast."""

    site: SiteInfo
    generated_at: datetime
    dates: list[datetime]
    # Primary forecast
    discharge_cfs: list[float]  # Best-estimate daily mean discharge (cfs)
    # Components (all in cfs)
    baseflow_cfs: list[float]
    snowmelt_runoff_cfs: list[float]
    rainfall_runoff_cfs: list[float]
    # Uncertainty envelope
    discharge_low_cfs: list[float]  # ~10th percentile
    discharge_high_cfs: list[float]  # ~90th percentile
    # Metadata
    current_discharge_cfs: float | None = None
    current_swe_in: float | None = None
    weather_forecast: WeatherForecast | None = None
    warnings: list[str] = field(default_factory=list)

    def to_dataframe(self) -> pd.DataFrame:
        """Convert to a pandas DataFrame for easy analysis."""
        return pd.DataFrame(
            {
                "discharge_cfs": self.discharge_cfs,
                "baseflow_cfs": self.baseflow_cfs,
                "snowmelt_runoff_cfs": self.snowmelt_runoff_cfs,
                "rainfall_runoff_cfs": self.rainfall_runoff_cfs,
                "discharge_low_cfs": self.discharge_low_cfs,
                "discharge_high_cfs": self.discharge_high_cfs,
            },
            index=pd.DatetimeIndex(self.dates, name="date"),
        )

    @property
    def horizon_days(self) -> int:
        return len(self.dates)


class ForecastEngine:
    """Main engine for generating 14-day streamflow forecasts.

    Usage:
        engine = ForecastEngine()
        result = engine.forecast("09380000")  # Colorado River at Lees Ferry
        print(result.to_dataframe())
    """

    def __init__(self, horizon: int = FORECAST_HORIZON_DAYS):
        self.horizon = horizon
        self.usgs = USGSClient()
        self.nws = NWSClient()
        self.snotel = SnotelClient()
        self.baseflow = BaseflowSeparator()
        self.snowmelt = SnowmeltModel()
        self.rainfall_runoff = RainfallRunoffModel()
        self.router = MuskingumRouter()

    def forecast(self, site_no: str) -> ForecastResult:
        """Generate a 14-day streamflow forecast for a USGS site.

        Args:
            site_no: USGS site number (e.g. '09380000').

        Returns:
            ForecastResult with daily forecast, components, and uncertainty.
        """
        warnings: list[str] = []

        # ------------------------------------------------------------ #
        # Step 1: Get site metadata
        # ------------------------------------------------------------ #
        logger.info("Fetching site info for %s", site_no)
        site = self.usgs.get_site_info(site_no)
        self._validate_mountain_west(site)

        # ------------------------------------------------------------ #
        # Step 2: Get recent observed discharge (30 days)
        # ------------------------------------------------------------ #
        logger.info("Fetching recent discharge history")
        try:
            recent_q = self.usgs.get_recent_discharge(site_no, days=90)
        except Exception as e:
            logger.warning("Failed to fetch discharge history: %s", e)
            recent_q = pd.Series(dtype=float)
            warnings.append(f"Could not retrieve recent discharge: {e}")

        current_q = float(recent_q.iloc[-1]) if len(recent_q) > 0 else None

        # ------------------------------------------------------------ #
        # Step 3: Get weather forecast
        # ------------------------------------------------------------ #
        logger.info("Fetching weather forecast for (%.4f, %.4f)", site.latitude, site.longitude)
        try:
            weather = self.nws.get_forecast(site.latitude, site.longitude)
            wx_df = weather.to_dataframe()
        except Exception as e:
            logger.warning("Failed to fetch weather forecast: %s", e)
            weather = None
            wx_df = self._fallback_weather()
            warnings.append(f"Using fallback weather (NWS unavailable): {e}")

        # Extend to full horizon if NWS only gives 7 days
        wx_df = self._extend_weather(wx_df, self.horizon)

        # ------------------------------------------------------------ #
        # Step 4: Get current snowpack from SNOTEL
        # ------------------------------------------------------------ #
        logger.info("Checking SNOTEL snowpack near site")
        try:
            swe = self.snotel.get_current_swe(site.latitude, site.longitude)
        except Exception as e:
            logger.warning("Failed to get SNOTEL data: %s", e)
            swe = None
            warnings.append(f"Could not retrieve SNOTEL data: {e}")

        if swe is None:
            swe = 0.0
            warnings.append("No SNOTEL data available; assuming SWE=0.")

        # ------------------------------------------------------------ #
        # Step 5: Baseflow separation and projection
        # ------------------------------------------------------------ #
        logger.info("Computing baseflow projection")
        if len(recent_q) >= 10:
            separated = self.baseflow.separate(recent_q)
            last_bf = separated["baseflow"].iloc[-1]
            recession_k = self.baseflow.fit_recession(separated["baseflow"])
        else:
            last_bf = current_q if current_q else 100.0
            recession_k = 0.95
            warnings.append("Insufficient history for recession analysis; using defaults.")

        projected_bf = self.baseflow.project_baseflow(last_bf, self.horizon, recession_k)

        # ------------------------------------------------------------ #
        # Step 6: Snowmelt runoff
        # ------------------------------------------------------------ #
        logger.info("Computing snowmelt contribution (SWE=%.1f in)", swe)
        temp_mean = wx_df["temp_mean_f"].values

        # Adjust DDF by elevation if we can estimate it
        if site.drainage_area_sq_mi and site.latitude > 35:
            # Rough elevation proxy from latitude in Mountain West
            est_elev = 5000 + (site.latitude - 35) * 300
            self.snowmelt.ddf = self.snowmelt.estimate_ddf_from_elevation(est_elev)

        melt_df = self.snowmelt.compute_melt(temp_mean[: self.horizon], swe)
        da = site.drainage_area_sq_mi or 100.0  # Default if unknown

        melt_runoff_cfs = self.snowmelt.melt_to_runoff(
            melt_df["melt_in"].values, da
        )

        # ------------------------------------------------------------ #
        # Step 7: Rainfall runoff (SCS-CN method)
        # ------------------------------------------------------------ #
        logger.info("Computing rainfall runoff")
        cn = self.rainfall_runoff.estimate_cn_from_area(site.drainage_area_sq_mi)
        self.rainfall_runoff.cn = cn
        precip = wx_df["precip_in"].values[: self.horizon]
        runoff_depth = self.rainfall_runoff.compute_runoff_depth(precip)
        rain_runoff_cfs = self.rainfall_runoff.runoff_to_discharge(runoff_depth, da)

        # Apply unit hydrograph
        tp = max(0.5, 0.5 * da**0.2)  # Time to peak scales with area
        rain_runoff_cfs = self.rainfall_runoff.apply_unit_hydrograph(rain_runoff_cfs, tp)

        # ------------------------------------------------------------ #
        # Step 8: Combine components and route
        # ------------------------------------------------------------ #
        logger.info("Assembling and routing final forecast")
        total = projected_bf + melt_runoff_cfs[: self.horizon] + rain_runoff_cfs[: self.horizon]

        # Route through channel
        k = self.router.estimate_k_from_area(site.drainage_area_sq_mi)
        self.router.k = k
        self.router._compute_coefficients()
        routed = self.router.route(total)

        # ------------------------------------------------------------ #
        # Step 9: Uncertainty estimation
        # ------------------------------------------------------------ #
        low, high = self._compute_uncertainty(routed, self.horizon)

        # ------------------------------------------------------------ #
        # Build result
        # ------------------------------------------------------------ #
        dates = wx_df.index[: self.horizon].tolist()

        return ForecastResult(
            site=site,
            generated_at=datetime.utcnow(),
            dates=dates,
            discharge_cfs=[round(v, 1) for v in routed],
            baseflow_cfs=[round(v, 1) for v in projected_bf],
            snowmelt_runoff_cfs=[round(v, 1) for v in melt_runoff_cfs[: self.horizon]],
            rainfall_runoff_cfs=[round(v, 1) for v in rain_runoff_cfs[: self.horizon]],
            discharge_low_cfs=[round(v, 1) for v in low],
            discharge_high_cfs=[round(v, 1) for v in high],
            current_discharge_cfs=round(current_q, 1) if current_q else None,
            current_swe_in=round(swe, 1) if swe else None,
            weather_forecast=weather,
            warnings=warnings,
        )

    # ------------------------------------------------------------------ #
    #  Helpers
    # ------------------------------------------------------------------ #

    @staticmethod
    def _validate_mountain_west(site: SiteInfo) -> None:
        """Warn if the site might not be in the Mountain West."""
        # USGS state codes are FIPS numeric; we check by coordinates
        if not (31.0 <= site.latitude <= 49.0 and -120.0 <= site.longitude <= -103.0):
            logger.warning(
                "Site %s (%.2f, %.2f) may be outside the Mountain West.",
                site.site_no,
                site.latitude,
                site.longitude,
            )

    @staticmethod
    def _fallback_weather() -> pd.DataFrame:
        """Generate a neutral weather forecast when NWS is unavailable."""
        from datetime import timedelta

        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        dates = [today + timedelta(days=i) for i in range(14)]
        return pd.DataFrame(
            {
                "temp_max_f": [55.0] * 14,
                "temp_min_f": [30.0] * 14,
                "temp_mean_f": [42.5] * 14,
                "precip_in": [0.0] * 14,
                "snow_in": [0.0] * 14,
            },
            index=pd.DatetimeIndex(dates, name="date"),
        )

    @staticmethod
    def _extend_weather(wx_df: pd.DataFrame, horizon: int) -> pd.DataFrame:
        """Extend weather forecast to the full horizon by repeating the last day."""
        if len(wx_df) >= horizon:
            return wx_df.iloc[:horizon]
        n_extra = horizon - len(wx_df)
        last = wx_df.iloc[-1]
        from datetime import timedelta

        extra_dates = [wx_df.index[-1] + timedelta(days=i + 1) for i in range(n_extra)]
        extra = pd.DataFrame([last] * n_extra, index=pd.DatetimeIndex(extra_dates, name="date"))
        return pd.concat([wx_df, extra])

    @staticmethod
    def _compute_uncertainty(
        forecast: np.ndarray, horizon: int
    ) -> tuple[np.ndarray, np.ndarray]:
        """Compute uncertainty bounds that widen with forecast lead time.

        Uncertainty increases roughly as a function of sqrt(lead time),
        which is consistent with standard hydrologic forecast skill decay.

        Returns:
            (low_bound, high_bound) arrays.
        """
        # Base uncertainty: ±15% at day 1, growing to ±50% at day 14
        pct = np.linspace(0.15, 0.50, horizon)
        low = forecast * (1 - pct)
        high = forecast * (1 + pct)
        # Floor at zero
        low = np.maximum(low, 0.0)
        return low, high
