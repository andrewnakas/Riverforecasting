"""Temperature-index (degree-day) snowmelt model.

The degree-day method is the most widely used operational snowmelt model
in the Mountain West. It estimates daily melt as a function of air
temperature above a threshold, scaled by a melt factor.

Reference:
    US Army Corps of Engineers, "Snow Hydrology" (1956)
    Hock, R. (2003). Temperature index melt modelling in mountain areas.
    Journal of Hydrology, 282(1-4), 104-115.
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from riverforecast.constants import DEGREE_DAY_FACTOR, MELT_THRESHOLD_F


class SnowmeltModel:
    """Degree-day snowmelt model for Mountain West watersheds."""

    def __init__(
        self,
        degree_day_factor: float = DEGREE_DAY_FACTOR,
        melt_threshold_f: float = MELT_THRESHOLD_F,
    ):
        """
        Args:
            degree_day_factor: Melt rate in inches SWE per degree-day (°F).
                Typical range: 0.03–0.10 for the Mountain West.
                Lower elevations / exposed sites → higher factor.
            melt_threshold_f: Temperature threshold for melt onset (°F).
        """
        self.ddf = degree_day_factor
        self.threshold = melt_threshold_f

    def compute_melt(
        self,
        temp_mean_f: np.ndarray | list[float],
        swe_initial_in: float,
    ) -> pd.DataFrame:
        """Simulate daily snowmelt given a temperature forecast and initial snowpack.

        Args:
            temp_mean_f: Array of daily mean temperatures (°F), one per day.
            swe_initial_in: Starting snow water equivalent (inches).

        Returns:
            DataFrame with columns:
                - swe_in: Remaining snowpack (inches SWE)
                - melt_in: Daily melt (inches of water)
                - degree_days: Daily degree-days above threshold
        """
        temps = np.asarray(temp_mean_f, dtype=float)
        n = len(temps)
        swe = np.zeros(n)
        melt = np.zeros(n)
        dd = np.zeros(n)

        current_swe = swe_initial_in

        for i in range(n):
            # Degree-days above melt threshold
            dd[i] = max(0.0, temps[i] - self.threshold)

            # Potential melt
            potential_melt = self.ddf * dd[i]

            # Actual melt limited by available snowpack
            actual_melt = min(potential_melt, max(0.0, current_swe))

            melt[i] = actual_melt
            current_swe -= actual_melt
            current_swe = max(0.0, current_swe)
            swe[i] = current_swe

        return pd.DataFrame({"swe_in": swe, "melt_in": melt, "degree_days": dd})

    def melt_to_runoff(
        self,
        melt_in: np.ndarray,
        drainage_area_sq_mi: float,
    ) -> np.ndarray:
        """Convert inches of snowmelt over a watershed to cubic feet per second.

        Uses the standard USGS conversion:
            Q (cfs) = melt (inches) × area (sq mi) × 26.89 / 1 day

        The factor 26.89 converts (inches × sq mi / day) to cfs.
        Actually: 1 inch over 1 sq mi in 1 day = 26.89 cfs (exact: 5280^2 * 12 / 86400 ≈ 26.89).

        Args:
            melt_in: Daily melt in inches of water.
            drainage_area_sq_mi: Contributing drainage area (square miles).

        Returns:
            Daily runoff from melt in cfs.
        """
        INCH_SQMI_DAY_TO_CFS = 26.89
        return np.asarray(melt_in) * drainage_area_sq_mi * INCH_SQMI_DAY_TO_CFS

    def estimate_ddf_from_elevation(self, elevation_ft: float) -> float:
        """Rough empirical estimate of degree-day factor based on elevation.

        Higher elevations tend to have lower melt rates due to colder
        conditions and often higher albedo snowpack.

        Returns:
            Estimated degree-day factor (inches SWE per °F-day).
        """
        # Linear interpolation: ~0.08 at 5000 ft, ~0.04 at 12000 ft
        ddf = 0.08 - (elevation_ft - 5000) * (0.04 / 7000)
        return np.clip(ddf, 0.03, 0.10)
