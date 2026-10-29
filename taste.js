// 내 점수: learns, from the 셀렉 the user already made, which pictures they
// pick over others *within the same 칸* (same name = same prompt).
//
// Each picture is its fingerprint from the aesthetic model (the features
// right before its classification head) plus the general 미적 점수. The model
// is linear on standardized features, trained with a pairwise logistic loss
// (RankNet) over pairs inside one 칸: 채택 > B컷 > 미분류 > 탈락. Pairs with a
// 미분류 count half (the user may not have looked at it closely), and every
// 칸 weighs the same however many pictures it has. The L2 strength is chosen
// by cross-validation over whole 칸, and the out-of-fold predictions give an
// honest "how well would this have picked your 채택" against the general score.
(function initTaste(root) {
  "use strict";

  const RANK = { pick: 3, hold: 2, none: 1, reject: 0 };

  // groups: [{ key, items: [{ id, label, x: Float32Array, base: number }] }]
  // → training set with standardized features (last feature = base score).
  function prepare(groups) {
    const usable = groups.filter((g) => g.items.length >= 3 && g.items.some((it) => it.label === "pick") && g.items.some((it) => it.label !== "pick"));
    const items = usable.flatMap((g) => g.items);
    if (!items.length) return null;
    const d = items[0].x.length + 1;
    const n = items.length;
    const X = new Float32Array(n * d);
    items.forEach((it, i) => {
      X.set(it.x, i * d);
      X[i * d + d - 1] = it.base;
    });
    const mean = new Float64Array(d);
    const std = new Float64Array(d);
    for (let i = 0; i < n; i += 1) for (let k = 0; k < d; k += 1) mean[k] += X[i * d + k];
    for (let k = 0; k < d; k += 1) mean[k] /= n;
    for (let i = 0; i < n; i += 1) for (let k = 0; k < d; k += 1) { const v = X[i * d + k] - mean[k]; std[k] += v * v; }
    for (let k = 0; k < d; k += 1) std[k] = Math.sqrt(std[k] / Math.max(1, n - 1)) || 1;
    for (let i = 0; i < n; i += 1) for (let k = 0; k < d; k += 1) X[i * d + k] = (X[i * d + k] - mean[k]) / std[k];
    // pairs per 칸, each 칸 summing to weight 1
    let offset = 0;
    const groupIdx = [];
    const pairs = []; // [a, b, w, group] meaning a should score above b
    usable.forEach((g, gi) => {
      const idx = g.items.map((_, j) => offset + j);
      groupIdx.push(idx);
      const local = [];
      for (let a = 0; a < g.items.length; a += 1) {
        for (let b = 0; b < g.items.length; b += 1) {
          const ra = RANK[g.items[a].label] ?? 1;
          const rb = RANK[g.items[b].label] ?? 1;
          if (ra <= rb) continue;
          const w = g.items[a].label === "none" || g.items[b].label === "none" ? 0.5 : 1;
          local.push([idx[a], idx[b], w]);
        }
      }
      const total = local.reduce((s, p) => s + p[2], 0) || 1;
      for (const [a, b, w] of local) pairs.push([a, b, w / total, gi]);
      offset += g.items.length;
    });
    return { X, n, d, mean, std, pairs, groupIdx, groups: usable, items };
  }

  // Fits θ on the pairs whose 칸 is in `use` (a Set of group indices).
  function fit(set, lambda, use, { iters = 250, init = null } = {}) {
    const { X, n, d, pairs } = set;
    const P = pairs.filter((p) => use.has(p[3]));
    const groupsUsed = use.size || 1;
    const theta = init ? Float64Array.from(init) : new Float64Array(d);
    const s = new Float64Array(n);
    const coef = new Float64Array(n);
    const grad = new Float64Array(d);
    const m = new Float64Array(d);
    const v = new Float64Array(d);
    const lr = 0.05;
    for (let t = 1; t <= iters; t += 1) {
      // scores
      for (let i = 0; i < n; i += 1) {
        let acc = 0;
        const o = i * d;
        for (let k = 0; k < d; k += 1) acc += theta[k] * X[o + k];
        s[i] = acc;
      }
      coef.fill(0);
      for (const [a, b, w] of P) {
        const z = s[a] - s[b];
        const g = -w / (1 + Math.exp(z)); // d/dz log(1+e^-z)
        coef[a] += g;
        coef[b] -= g;
      }
      grad.fill(0);
      for (let i = 0; i < n; i += 1) {
        const c = coef[i];
        if (!c) continue;
        const o = i * d;
        for (let k = 0; k < d; k += 1) grad[k] += c * X[o + k];
      }
      for (let k = 0; k < d; k += 1) {
        const gk = grad[k] / groupsUsed + lambda * theta[k];
        m[k] = 0.9 * m[k] + 0.1 * gk;
        v[k] = 0.999 * v[k] + 0.001 * gk * gk;
        const mh = m[k] / (1 - 0.9 ** t);
        const vh = v[k] / (1 - 0.999 ** t);
        theta[k] -= (lr * mh) / (Math.sqrt(vh) + 1e-8);
      }
    }
    return theta;
  }
  function scoreRows(set, theta, rows) {
    const { X, d } = set;
    return rows.map((i) => {
      let acc = 0;
      for (let k = 0; k < d; k += 1) acc += theta[k] * X[i * d + k];
      return acc;
    });
  }

  // Where each 채택 lands in its 칸's order: 0 = top, 1 = bottom.
  function pickRanks(set, groupList, scoreOf) {
    const ranks = [];
    let pairsRight = 0;
    let pairsAll = 0;
    for (const gi of groupList) {
      const idx = set.groupIdx[gi];
      const items = set.groups[gi].items;
      const sc = idx.map((i) => scoreOf(i));
      const order = idx.map((_, j) => j).sort((a, b) => sc[b] - sc[a]);
      items.forEach((it, j) => {
        if (it.label !== "pick") return;
        ranks.push(order.indexOf(j) / Math.max(1, idx.length - 1));
        items.forEach((other, k) => {
          if (other.label === "pick") return;
          pairsAll += 1;
          if (sc[j] > sc[k]) pairsRight += 1;
          else if (sc[j] === sc[k]) pairsRight += 0.5;
        });
      });
    }
    const share = (f) => (ranks.length ? Math.round((ranks.filter(f).length / ranks.length) * 1000) / 10 : 0);
    return {
      picks: ranks.length,
      top30: share((r) => r <= 0.3),
      lost: { 30: share((r) => r > 0.7), 50: share((r) => r > 0.5), 70: share((r) => r > 0.3) },
      pairAcc: pairsAll ? Math.round((pairsRight / pairsAll) * 1000) / 10 : 0,
    };
  }

  // Grouped k-fold CV over λ, then a final fit on everything.
  function train(groups, { lambdas = [0.0003, 0.003, 0.03, 0.3], folds = 4, iters = 250, cvIters = 150, onProgress = null, seed = 7 } = {}) {
    const set = prepare(groups);
    if (!set || set.groups.length < 8) return { ok: false, reason: "few", groups: set ? set.groups.length : 0 };
    const G = set.groups.length;
    // shuffled fold assignment (stable)
    let r = seed;
    const rand = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
    const order = [...Array(G).keys()].sort(() => rand() - 0.5);
    const foldOf = new Int32Array(G);
    order.forEach((g, i) => { foldOf[g] = i % folds; });
    const total = lambdas.length * folds + 1;
    let done = 0;
    const tick = () => { done += 1; onProgress?.(done / total); };
    let best = null;
    for (const lambda of lambdas) {
      const oof = new Float64Array(set.n);
      for (let f = 0; f < folds; f += 1) {
        const use = new Set([...Array(G).keys()].filter((g) => foldOf[g] !== f));
        const theta = fit(set, lambda, use, { iters: Math.min(iters, cvIters) });
        const testGroups = [...Array(G).keys()].filter((g) => foldOf[g] === f);
        for (const g of testGroups) {
          const idx = set.groupIdx[g];
          scoreRows(set, theta, idx).forEach((v, j) => { oof[idx[j]] = v; });
        }
        tick();
      }
      const all = [...Array(G).keys()];
      const metrics = pickRanks(set, all, (i) => oof[i]);
      if (!best || metrics.pairAcc > best.metrics.pairAcc) best = { lambda, metrics };
    }
    const all = [...Array(G).keys()];
    const baseCol = set.d - 1;
    const generic = pickRanks(set, all, (i) => set.X[i * set.d + baseCol]);
    const theta = fit(set, best.lambda, new Set(all), { iters });
    tick();
    // 0–100 scale: quantiles of the training pictures' scores
    const sc = scoreRows(set, theta, [...Array(set.n).keys()]).sort((a, b) => a - b);
    const quantiles = [];
    for (let q = 0; q <= 100; q += 1) quantiles.push(sc[Math.min(sc.length - 1, Math.round((q / 100) * (sc.length - 1)))]);
    return {
      ok: true,
      model: { theta: Array.from(theta), mean: Array.from(set.mean), std: Array.from(set.std), quantiles, lambda: best.lambda },
      personal: best.metrics,
      generic,
      groups: G,
      pictures: set.n,
      better: best.metrics.pairAcc > generic.pairAcc,
    };
  }

  // Score one picture with a trained model → 0–100.
  function apply(model, x, base) {
    const d = model.theta.length;
    let acc = 0;
    for (let k = 0; k < d - 1; k += 1) acc += model.theta[k] * ((x[k] - model.mean[k]) / model.std[k]);
    acc += model.theta[d - 1] * ((base - model.mean[d - 1]) / model.std[d - 1]);
    const q = model.quantiles;
    if (acc <= q[0]) return 0;
    if (acc >= q[100]) return 100;
    let lo = 0;
    let hi = 100;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (q[mid] <= acc) lo = mid;
      else hi = mid;
    }
    const span = q[hi] - q[lo] || 1;
    return Math.round((lo + (acc - q[lo]) / span) * 10) / 10;
  }

  const api = { train, apply, prepare, pickRanks, RANK };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.Taste = api;
})(typeof self !== "undefined" ? self : globalThis);
