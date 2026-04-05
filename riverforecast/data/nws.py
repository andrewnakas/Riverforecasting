"""Client for the National Weather Service (NWS) API.

Retrieves gridded forecast data (temperature, precipitation, snowfall)
used to drive the hydrological forecast models.

Reference: https://www.weather.gov/documentation/services-web-api
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta

import numpy as np
import pandas as pd
import requests

from riverforecast.constants import NWS_BASE_URL, NWS_USER_AGENT
from riverforecast.utils import cache
from riverforecast.utils.units import celsius_to_fahrenheit, mm_to_inches

logger = logging.getLogger(__name__)


@dataclass
class WeatherForecast:
    """Structured daily weather forecast used by the hydrology models."""

    dates: list[datetime]
    temp_max_f: list[float]  # Daily max temperature (°F)
    temp_min_f: list[float]  # Daily min temperature (°F)
    precip_in: list[float]  # Daily total liquid precipitation (inches)
    snow_in: list[float]  # Daily snowfall (inches)

    def to_dataframe(self) -> pd.DataFrame:
        return pd.DataFrame(
            {
                "temp_max_f": self.temp_max_f,
                "temp_min_f": self.temp_min_f,
                "temp_mean_f": [
                    (hi + lo) / 2 for hi, lo in zip(self.temp_max_f, self.temp_min_f)
                ],
                "precip_in": self.precip_in,
                "snow_in": self.snow_in,
            },
            index=pd.DatetimeIndex(self.dates, name="date"),
        )


class NWSClient:
    """Fetch weather forecasts from the NWS API for a given lat/lon."""

    TIMEOUT = 20
    HEADERS = {"User-Agent": NWS_USER_AGENT, "Accept": "application/geo+json"}

    def get_forecast(self, lat: float, lon: float) -> WeatherForecast:
        """Get a multi-day weather forecast for a location.

        The NWS API provides ~7 days of detailed forecast. We pull the
        quantitative gridpoint data which includes hourly temperature
        and precipitation totals, then aggregate to daily values.
        """
        gridpoint = self._resolve_gridpoint(lat, lon)
        raw = self._fetch_gridpoint_data(gridpoint)
        return self._parse_gridpoint(raw)

    # ------------------------------------------------------------------ #
    #  Internal
    # ------------------------------------------------------------------ #

    def _resolve_gridpoint(self, lat: float, lon: float) -> str:
        """Resolve lat/lon → NWS grid office/gridX,gridY."""
        url = f"{NWS_BASE_URL}/points/{lat:.4f},{lon:.4f}"
        cached = cache.get(url, None, ttl=86400)  # Cache 24h — grid doesn't change
        if cached:
            props = cached["properties"]
        else:
            resp = requests.get(url, headers=self.HEADERS, timeout=self.TIMEOUT)
            resp.raise_for_status()
            data = resp.json()
            cache.put(url, None, data)
            props = data["properties"]
        office = props["gridId"]
        gx, gy = props["gridX"], props["gridY"]
        return f"{office}/{gx},{gy}"

    def _fetch_gridpoint_data(self, gridpoint: str) -> dict:
        """Fetch the quantitative gridpoint forecast data."""
        url = f"{NWS_BASE_URL}/gridpoints/{gridpoint}"
        cached = cache.get(url, None, ttl=3600)
        if cached:
            return cached
        resp = requests.get(url, headers=self.HEADERS, timeout=self.TIMEOUT)
        resp.raise_for_status()
        data = resp.json()
        cache.put(url, None, data)
        return data

    def _parse_gridpoint(self, raw: dict) -> WeatherForecast:
        """Parse NWS gridpoint JSON into daily WeatherForecast."""
        props = raw.get("properties", {})

        temp_series = self._expand_nws_series(props.get("temperature", {}))
        precip_series = self._expand_nws_series(props.get("quantitativePrecipitation", {}))
        snow_series = self._expand_nws_series(props.get("snowfallAmount", {}))

        # Determine the unit for temperature
        temp_unit = props.get("temperature", {}).get("uom", "")
        is_celsius = "degC" in temp_unit or "celsius" in temp_unit.lower()

        # Build daily aggregates
        today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
        dates, highs, lows, precips, snows = [], [], [], [], []

        for day_offset in range(14):
            day = today + timedelta(days=day_offset)
            next_day = day + timedelta(days=1)

            # Temperature — max and min for the day
            day_temps = [
                v for dt, v in temp_series if day <= dt < next_day and not np.isnan(v)
            ]
            if day_temps:
                hi, lo = max(day_temps), min(day_temps)
                if is_celsius:
                    hi, lo = celsius_to_fahrenheit(hi), celsius_to_fahrenheit(lo)
            else:
                hi, lo = np.nan, np.nan

            # Precipitation (NWS reports mm) and snowfall (mm)
            day_precip = [
                v for dt, v in precip_series if day <= dt < next_day and not np.isnan(v)
            ]
            day_snow = [
                v for dt, v in snow_series if day <= dt < next_day and not np.isnan(v)
            ]

            dates.append(day)
            highs.append(hi)
            lows.append(lo)
            precips.append(mm_to_inches(sum(day_precip)) if day_precip else 0.0)
            snows.append(mm_to_inches(sum(day_snow)) if day_snow else 0.0)

        return WeatherForecast(
            dates=dates,
            temp_max_f=highs,
            temp_min_f=lows,
            precip_in=precips,
            snow_in=snows,
        )

    @staticmethod
    def _expand_nws_series(prop: dict) -> list[tuple[datetime, float]]:
        """Expand NWS ISO-8601 duration-based values into (datetime, value) pairs."""
        values = prop.get("values", [])
        result: list[tuple[datetime, float]] = []
        for entry in values:
            valid_time = entry.get("validTime", "")
            val = entry.get("value")
            if val is None:
                val = float("nan")
            else:
                val = float(val)
            # validTime looks like "2026-04-05T06:00:00+00:00/PT6H"
            if "/" not in valid_time:
                continue
            dt_str, dur_str = valid_time.split("/", 1)
            try:
                dt = pd.to_datetime(dt_str, utc=True).to_pydatetime().replace(tzinfo=None)
            except Exception:
                continue
            # Parse ISO duration (simplified: hours only)
            hours = _parse_iso_duration_hours(dur_str)
            # Create hourly entries spanning the duration
            for h in range(int(hours)):
                result.append((dt + timedelta(hours=h), val))
            if hours < 1:
                result.append((dt, val))
        return result


def _parse_iso_duration_hours(dur: str) -> float:
    """Parse a simple ISO 8601 duration to hours (handles PT1H, PT6H, P1D, etc.)."""
    dur = dur.strip()
    if not dur.startswith("P"):
        return 1.0
    dur = dur[1:]  # Remove 'P'
    hours = 0.0
    if "D" in dur:
        parts = dur.split("D")
        try:
            hours += float(parts[0]) * 24
        except ValueError:
            pass
        dur = parts[1] if len(parts) > 1 else ""
    if dur.startswith("T"):
        dur = dur[1:]
    if "H" in dur:
        parts = dur.split("H")
        try:
            hours += float(parts[0])
        except ValueError:
            pass
    if hours == 0:
        hours = 1.0
    return hours
