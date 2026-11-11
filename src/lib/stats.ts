// Small statistics used by Report and Theo dõi. Pure functions, tested in test/stats.test.ts.

export type Pt = { num: number; den: number | null } | null   // one day of a metric; null = no data

/** Value of one day: num, or num/den when the metric is a ratio. */
export const ptValue = (p: Pt) => p == null ? null : p.den == null ? p.num : p.den > 0 ? p.num / p.den : null

/**
 * Moving average over `w` days ending at each index. Ratios use Σnum/Σden over the window (not the
 * mean of daily ratios); counts use the mean. A window with fewer than 3/4 of its days present → null.
 */
export function movingAvg(pts: Pt[], w: number) {
  const need = Math.ceil(w * 0.75)
  return pts.map((_, i) => {
    if (i + 1 < w) return null
    let n = 0, sn = 0, sd = 0, ratio = false
    for (let j = i - w + 1; j <= i; j++) {
      const p = pts[j]
      if (p == null || (p.den != null && !(p.den > 0))) continue
      n++; sn += p.num
      if (p.den != null) { ratio = true; sd += p.den }
    }
    if (n < need) return null
    return ratio ? sd > 0 ? sn / sd : null : sn / n
  })
}

/** Mean and sample standard deviation of the non-null values. */
export function meanSd(xs: (number | null)[]) {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x))
  if (v.length < 2) return null
  const mean = v.reduce((a, b) => a + b, 0) / v.length
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1))
  return { mean, sd, n: v.length }
}

/** Is the last value outside mean ± k·sd of the `w` days before it? Needs at least 14 of those days. */
export function outlier(values: (number | null)[], w = 28, k = 2) {
  const last = values.at(-1)
  if (last == null) return null
  const ms = meanSd(values.slice(-w - 1, -1))
  if (!ms || ms.n < 14 || ms.sd === 0) return null
  const z = (last - ms.mean) / ms.sd
  return Math.abs(z) > k ? { z, mean: ms.mean, sd: ms.sd } : null
}

/** Chi-square goodness of fit of observed counts against expected weights (SRM check). */
export function chiSquare(observed: number[], weights: number[]) {
  const total = observed.reduce((a, b) => a + b, 0), wsum = weights.reduce((a, b) => a + b, 0)
  let chi2 = 0
  observed.forEach((o, i) => { const e = total * weights[i] / wsum; if (e > 0) chi2 += (o - e) ** 2 / e })
  const df = observed.length - 1
  return { chi2, df, p: df > 0 ? chiSqSurvival(chi2, df) : 1 }
}

/** Two-proportion z-test: p-value (two-sided) that x1/n1 and x2/n2 differ. */
export function twoProp(x1: number, n1: number, x2: number, n2: number) {
  if (n1 <= 0 || n2 <= 0 || x1 < 0 || x2 < 0 || x1 > n1 || x2 > n2) return null // not a proportion
  const p1 = x1 / n1, p2 = x2 / n2, p = (x1 + x2) / (n1 + n2)
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2))
  if (!(se > 0)) return null
  const z = (p2 - p1) / se
  return { p1, p2, z, p: 2 * (1 - normCdf(Math.abs(z))) }
}

export function normCdf(z: number) {
  // Abramowitz & Stegun 7.1.26 on erf; error < 1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2)
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2
}

/** P(X > x) for chi-square with k degrees of freedom: regularized upper incomplete gamma Q(k/2, x/2). */
export function chiSqSurvival(x: number, k: number) {
  if (x <= 0) return 1
  return gammaQ(k / 2, x / 2)
}

function gammaQ(a: number, x: number): number {
  // Numerical Recipes: series for x < a+1, continued fraction otherwise
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break }
    return Math.max(0, 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a)))
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300
    d = 1 / d; const del = d * c; h *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h
}

function lnGamma(z: number): number {
  // Lanczos approximation (g=7, n=9)
  const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z)
  z -= 1
  let x = c[0]
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i)
  const t = z + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}
