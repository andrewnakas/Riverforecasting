"""Channel flow routing using the Muskingum method.

The Muskingum method is a standard hydrologic routing technique that
accounts for the travel time and attenuation of flood waves as they
move through a river channel.

Reference:
    Chow, V.T., Maidment, D.R., Mays, L.W. (1988).
    Applied Hydrology, McGraw-Hill. Chapter 8.
"""

from __future__ import annotations

import numpy as np

from riverforecast.constants import ROUTING_K, ROUTING_X


class MuskingumRouter:
    """Muskingum channel routing for downstream flow translation."""

    def __init__(self, k: float = ROUTING_K, x: float = ROUTING_X, dt: float = 1.0):
        """
        Args:
            k: Storage time constant (days). Roughly the travel time through
               the reach. Typical: 0.5–3.0 days.
            x: Weighting factor (0–0.5). x=0 gives maximum attenuation
               (reservoir-like), x=0.5 gives pure translation (no attenuation).
               Typical: 0.1–0.3.
            dt: Time step (days). Should be 1.0 for daily routing.
        """
        self.k = k
        self.x = x
        self.dt = dt
        self._compute_coefficients()

    def _compute_coefficients(self) -> None:
        """Compute Muskingum routing coefficients C0, C1, C2."""
        denom = 2 * self.k * (1 - self.x) + self.dt
        self.c0 = (self.dt - 2 * self.k * self.x) / denom
        self.c1 = (self.dt + 2 * self.k * self.x) / denom
        self.c2 = (2 * self.k * (1 - self.x) - self.dt) / denom

    def route(self, inflow: np.ndarray) -> np.ndarray:
        """Route an inflow hydrograph through a channel reach.

        Args:
            inflow: Array of daily inflow values (cfs).

        Returns:
            Array of routed outflow values (cfs), same length.
        """
        n = len(inflow)
        if n == 0:
            return np.array([])

        outflow = np.zeros(n)
        outflow[0] = inflow[0]  # Initial condition

        for i in range(1, n):
            outflow[i] = (
                self.c0 * inflow[i] + self.c1 * inflow[i - 1] + self.c2 * outflow[i - 1]
            )
            # Ensure non-negative
            outflow[i] = max(0.0, outflow[i])

        return outflow

    def estimate_k_from_area(self, drainage_area_sq_mi: float | None) -> float:
        """Rough estimate of K based on drainage area.

        Larger drainage areas imply longer channels and more travel time.

        Returns:
            Estimated K in days.
        """
        if drainage_area_sq_mi is None:
            return self.k
        # Empirical: K ≈ 0.3 * A^0.3 (days), rough fit for Mountain West
        return 0.3 * drainage_area_sq_mi**0.3
