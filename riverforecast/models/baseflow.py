"""Baseflow separation and recession analysis.

Implements a digital-filter baseflow separation (Lyne & Hollick, 1979)
and recession curve analysis for projecting baseflow into the future.

These are standard techniques in operational hydrology for separating
the slow groundwater component from the fast surface-runoff component
of a hydrograph.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.optimize import curve_fit

from riverforecast.constants import RECESSION_CONSTANT


class BaseflowSeparator:
    """Separate baseflow from total streamflow and project it forward."""

    def __init__(self, recession_k: float = RECESSION_CONSTANT):
        """
        Args:
            recession_k: Daily recession constant (0 < k < 1). Higher values
                         mean slower baseflow recession. Typical range 0.90–0.98.
        """
        self.recession_k = recession_k

    def separate(self, discharge: pd.Series, alpha: float = 0.925) -> pd.DataFrame:
        """Apply the Lyne-Hollick recursive digital filter for baseflow separation.

        Args:
            discharge: Daily mean discharge (cfs), indexed by datetime.
            alpha: Filter parameter (0.9–0.95 typical). Higher = less baseflow.

        Returns:
            DataFrame with columns 'total', 'baseflow', 'quickflow'.
        """
        q = discharge.values.astype(float)
        n = len(q)
        if n == 0:
            return pd.DataFrame(columns=["total", "baseflow", "quickflow"])

        # Forward pass
        qf = np.zeros(n)
        qf[0] = 0.0
        for i in range(1, n):
            qf[i] = alpha * qf[i - 1] + (1 + alpha) / 2 * (q[i] - q[i - 1])
            qf[i] = max(qf[i], 0.0)

        # Backward pass for smoothing
        qf2 = np.zeros(n)
        qf2[-1] = qf[-1]
        for i in range(n - 2, -1, -1):
            qf2[i] = alpha * qf2[i + 1] + (1 + alpha) / 2 * (qf[i] - qf[i + 1])
            qf2[i] = max(qf2[i], 0.0)

        quickflow = np.minimum(qf2, q)
        baseflow = q - quickflow
        # Ensure baseflow doesn't go negative
        baseflow = np.maximum(baseflow, 0.0)

        return pd.DataFrame(
            {"total": q, "baseflow": baseflow, "quickflow": quickflow},
            index=discharge.index,
        )

    def fit_recession(self, baseflow: pd.Series) -> float:
        """Fit the recession constant k from observed baseflow.

        Uses falling limbs of the baseflow hydrograph to estimate
        the exponential decay rate: Q(t) = Q0 * k^t

        Returns:
            Fitted recession constant k.
        """
        q = baseflow.dropna().values.astype(float)
        if len(q) < 5:
            return self.recession_k

        # Find recession segments (consecutive decreasing values)
        recession_pairs: list[tuple[float, float]] = []
        for i in range(1, len(q)):
            if 0 < q[i] < q[i - 1]:
                recession_pairs.append((q[i - 1], q[i]))

        if len(recession_pairs) < 3:
            return self.recession_k

        q_prev = np.array([p[0] for p in recession_pairs])
        q_next = np.array([p[1] for p in recession_pairs])
        ratios = q_next / q_prev
        # Robust estimate: median ratio
        k = float(np.median(ratios))
        return np.clip(k, 0.80, 0.995)

    def project_baseflow(
        self,
        last_baseflow: float,
        days: int,
        recession_k: float | None = None,
    ) -> np.ndarray:
        """Project baseflow forward using exponential recession.

        Args:
            last_baseflow: Most recent baseflow value (cfs).
            days: Number of days to project.
            recession_k: Override recession constant.

        Returns:
            Array of projected daily baseflow values (cfs).
        """
        k = recession_k if recession_k is not None else self.recession_k
        return last_baseflow * k ** np.arange(1, days + 1)
