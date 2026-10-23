// The step model on ONNX Runtime Web, with the interface the runner in
// src/bcvm/web.py expects (it calls these from Pyodide):
//
//   await prefill(ids)                          start a script: cache the listing
//   await forward(ids, masks, temperature)      feed ids, cache them, return the
//                                               masked argmax (or a sample) after each
//   truncate(n)                                 keep the listing and n step tokens
//
// The graph is src/bcvm/train/export.py's: caches are token-major
// ([tokens, layers, heads, head_dim]). The listing's cache stays as the session
// returned it (on the GPU under WebGPU); the step's is one growable
// Float32Array, so dropping rejected draft tokens is just a length.

export class StepModel {
  constructor(ort, session, meta) {
    this.ort = ort;
    this.session = session;
    this.V = meta.vocab_size;
    this.dims = [meta.n_layers, meta.n_heads, meta.head_dim];
    this.row = meta.n_layers * meta.n_heads * meta.head_dim; // floats per token
    this.sk = new Float32Array(meta.max_pos * this.row);
    this.sv = new Float32Array(meta.max_pos * this.row);
    this.P = 0;
    this.S = 0;
  }

  // modelData: a URL, or the .onnx bytes; options: ONNX Runtime session options
  static async load(ort, modelData, meta, options = {}) {
    return new StepModel(ort, await ort.InferenceSession.create(modelData, options), meta);
  }

  cache(data, n) {
    return new this.ort.Tensor("float32", data, [n, ...this.dims]);
  }

  run(ids, prefixK, prefixV) {
    const T = ids.length;
    const start = this.P + this.S;
    const int64 = (xs) => new this.ort.Tensor("int64", BigInt64Array.from(xs, BigInt), [1, T]);
    return this.session.run({
      ids: int64(ids),
      pos: int64(Array.from({ length: T }, (_, j) => start + j)),
      prefix_k: prefixK,
      prefix_v: prefixV,
      step_k: this.cache(this.sk.subarray(0, this.S * this.row), this.S),
      step_v: this.cache(this.sv.subarray(0, this.S * this.row), this.S),
    });
  }

  async prefill(ids) {
    this.P = this.S = 0;
    for (const t of [this.pk, this.pv]) t?.dispose?.();
    const empty = this.cache(new Float32Array(0), 0);
    const out = await this.run(Array.from(ids), empty, empty);
    out.logits.dispose?.();
    this.pk = out.k;
    this.pv = out.v;
    this.P = ids.length;
  }

  truncate(n) {
    this.S = n;
  }

  async forward(ids, masks, temperature = 0) {
    ids = Array.from(ids);
    const T = ids.length;
    const out = await this.run(ids, this.pk, this.pv);
    const [logits, k, v] = await Promise.all([out.logits.getData(), out.k.getData(), out.v.getData()]);
    for (const t of Object.values(out)) t.dispose?.();
    this.sk.set(k, this.S * this.row);
    this.sv.set(v, this.S * this.row);
    this.S += T;
    const res = [];
    for (let j = 0; j < T; j++) res.push(pick(logits, masks, j * this.V, this.V, temperature));
    return res;
  }
}

// Masked argmax (temperature 0) or a sample from softmax(logits / temperature)
// over the allowed tokens; -1 when nothing is allowed at this position.
function pick(logits, masks, at, V, temperature) {
  let best = -1;
  let max = -Infinity;
  for (let t = 0; t < V; t++) {
    if (masks[at + t] && logits[at + t] > max) {
      max = logits[at + t];
      best = t;
    }
  }
  if (best < 0 || temperature <= 0) return best;
  let total = 0;
  const p = new Float64Array(V);
  for (let t = 0; t < V; t++) {
    if (masks[at + t]) total += p[t] = Math.exp((logits[at + t] - max) / temperature);
  }
  let r = Math.random() * total;
  for (let t = 0; t < V; t++) {
    if (masks[at + t] && (r -= p[t]) <= 0) return t;
  }
  return best;
}
