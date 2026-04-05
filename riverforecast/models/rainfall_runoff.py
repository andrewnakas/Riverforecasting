"""Simple rainfall-runoff transformation using the SCS Curve Number method.

The NRCS (formerly SCS) Curve Number method is the standard approach
for estimating direct runoff from rainfall in ungauged or semi-gauged
watersheds. It accounts for soil type, land cover, and antecedent
moisture conditions.

Reference:
    USDA-NRCS, National Engineering Handbook, Chapter 10:
    Estimation of Direct Runoff from Storm Rainfall (2004).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from riverforecast.constants import RUNOFF_COEFFICIENT


class RainfallRunoffModel:
    """SCS Curve Number rainfall-runoff model with simple unit hydrograph."""

    def __init__(self, curve_number: float = 70, runoff_coeff: float = RUNOFF_COEFFICIENT):
        """
        Args:
            curve_number: SCS Curve Number (30–100). Higher = more runoff.
                Typical Mountain West forested watershed: 55–75.
                Typical Mountain West rangeland: 65–85.
            runoff_coeff: Simple volumetric runoff coefficient (fallback).
        """
        self.cn = curve_number
        self.runoff_coeff = runoff_coeff

    def compute_runoff_depth(self, precip_in: np.ndarray | list[float]) -> np.ndarray:
        """Compute direct runoff depth (inches) from precipitation using SCS-CN.

        The SCS Curve Number equation:
            S = 1000/CN - 10  (maximum soil retention, inches)
            Ia = 0.2 * S      (initial abstraction)
            Q = (P - Ia)^2 / (P - Ia + S)  if P > Ia, else 0

        Args:
            precip_in: Daily precipitation (inches).

        Returns:
            Daily direct runoff depth (inches).
        """
        P = np.asarray(precip_in, dtype=float)
        S = 1000.0 / self.cn - 10.0
        Ia = 0.2 * S
        excess = np.maximum(P - Ia, 0.0)
        Q = np.where(P > Ia, excess**2 / (excess + S), 0.0)
        return Q

    def runoff_to_discharge(
        self,
        runoff_depth_in: np.ndarray,
        drainage_area_sq_mi: float,
    ) -> np.ndarray:
        """Convert runoff depth (inches) to discharge (cfs).

        Same conversion as snowmelt: 1 inch over 1 sq mi per day ≈ 26.89 cfs.
        """
        INCH_SQMI_DAY_TO_CFS = 26.89
        return np.asarray(runoff_depth_in) * drainage_area_sq_mi * INCH_SQMI_DAY_TO_CFS

    def apply_unit_hydrograph(
        self,
        excess_runoff_cfs: np.ndarray,
        tp_days: float = 1.0,
    ) -> np.ndarray:
        """Apply a simple triangular unit hydrograph to distribute runoff in time.

        This smooths instantaneous runoff pulses into a more realistic
        hydrograph shape with a rising limb and recession.

        Args:
            excess_runoff_cfs: Daily excess runoff (cfs).
            tp_days: Time to peak (days). Controls how quickly runoff
                     reaches the outlet. Larger watersheds → larger tp.

        Returns:
            Routed daily discharge (cfs), same length as input.
        """
        n = len(excess_runoff_cfs)
        # Simple triangular UH with base = 2.67 * tp (SCS standard)
        base = max(int(2.67 * tp_days), 2)
        peak_idx = max(int(tp_days), 1)

        # Build unit hydrograph ordinates
        uh = np.zeros(base)
        for i in range(base):
            if i <= peak_idx:
                uh[i] = i / peak_idx
            else:
                uh[i] = max(0, 1.0 - (i - peak_idx) / (base - peak_idx))
        # Normalize so area = 1
        if uh.sum() > 0:
            uh = uh / uh.sum()

        # Convolve to get routed hydrograph
        routed = np.convolve(excess_runoff_cfs, uh, mode="full")[:n]
        return routed

    def estimate_cn_from_area(self, drainage_area_sq_mi: float | None) -> float:
        """Rough CN estimate based on drainage area (proxy for land cover mix).

        Smaller headwater basins in the Mountain West tend to have more
        forest cover (lower CN), while larger basins include more mixed
        land use (moderate CN).
        """
        if drainage_area_sq_mi is None:
            return self.cn
        if drainage_area_sq_mi < 50:
            return 60.0  # Forested headwaters
        elif drainage_area_sq_mi < 500:
            return 68.0  # Mixed forest/rangeland
        else:
            return 72.0  # Larger mixed basins
