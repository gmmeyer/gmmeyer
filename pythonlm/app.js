// The demo page: sends the script to worker.js and draws each step it reports.
const params = new URLSearchParams(location.search);
const config = {
  pyodide: "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/",
  ort: "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/",
  // ?model=./model/ serves a local export while developing
  model: params.get("model") || "https://huggingface.co/gmmeyer/pythonlm/resolve/main/",
  runtime: new URL("pythonlm-runtime.zip", location.href).href,
  backend: params.get("backend") || "auto",
};

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL("worker.js", import.meta.url), { type: "module" });
let running = false, paused = false, rows = [], pending = null, printed = "", t0 = 0;

function setStatus(text) { $("status").textContent = text; }
function setRunning(on) {
  running = on;
  $("run").disabled = on;
  $("pause").disabled = $("stop").disabled = !on;
  $("pause").textContent = "Pause";
  paused = false;
}

function draw() {
  const s = pending;
  pending = null;
  $("model-out").textContent += printed;
  printed = "";
  if (!s) return;
  rows.forEach((r, i) => r.classList.toggle("now", i === s.ip));
  const row = rows[s.ip], box = $("listing");
  if (row && (row.offsetTop < box.scrollTop || row.offsetTop > box.scrollTop + box.clientHeight - 20)) {
    box.scrollTop = row.offsetTop - box.clientHeight / 3;
  }
  $("stack").textContent = s.stack.length ? [...s.stack].reverse().join("\n") : "(empty)";
  const vars = $("vars");
  vars.replaceChildren();
  const table = document.createElement("table");
  table.className = "vars";
  for (const [name, value] of s.vars) {
    const tr = table.insertRow();
    tr.insertCell().textContent = name;
    tr.insertCell().textContent = value;
  }
  vars.append(s.vars.length ? table : "(none yet)");
  setStatus(`Step ${s.i + 1}${s.steps ? ` of ${s.steps}` : ""} · ${((s.i + 1) / ((performance.now() - t0) / 1000)).toFixed(1)} steps/s`);
}

let expectSteps = 0;
worker.onmessage = ({ data: m }) => {
  if (m.type === "status") setStatus(m.text);
  else if (m.type === "ready") {
    $("backend").textContent = m.backend === "webgpu" ? "Model on your GPU (WebGPU)" : "Model on your CPU (WebAssembly)";
    $("backend").title = m.note || "";
    window.pythonlm = { backend: m.backend, note: m.note };
    setStatus("Ready. Pick an example or write a script, then Run.");
    $("run").disabled = false;
  } else if (m.type === "start") {
    expectSteps = m.steps;
    const box = $("listing");
    box.replaceChildren();
    rows = m.listing.map(([n, line, op, arg]) => {
      const r = document.createElement("div");
      r.className = "ins";
      for (const [cls, text] of [["n", n], ["line", line ?? ""], ["op", op], ["arg", arg]]) {
        const c = document.createElement("span");
        c.className = cls;
        c.textContent = text;
        r.append(c);
      }
      box.append(r);
      return r;
    });
    $("python-out").textContent = m.python;
    t0 = performance.now();
  } else if (m.type === "step") {
    printed += m.printed;
    pending = { ...m, steps: expectSteps };
    requestAnimationFrame(draw);
  } else if (m.type === "done") {
    draw();
    setRunning(false);
    const badge = $("badge");
    if (m.refused) {
      setStatus(`Not supported: ${m.refused}`);
    } else if (m.stopped) {
      setStatus("Stopped.");
    } else {
      badge.textContent = m.match ? "✓ same as Python" : "✗ differs from Python";
      badge.className = `badge ${m.match ? "ok" : "bad"}`;
      setStatus(`${m.error ? `Stopped: ${m.error}. ` : ""}${m.steps} steps in ${m.seconds.toFixed(1)}s, ` +
        `${(m.forwards / Math.max(1, m.steps)).toFixed(1)} forward passes per step`);
    }
  } else if (m.type === "error") {
    setRunning(false);
    setStatus(`Error: ${m.text}`);
  }
};

$("run").onclick = () => {
  for (const id of ["model-out", "python-out", "stack", "vars", "badge"]) $(id).textContent = "";
  setRunning(true);
  setStatus("Compiling…");
  worker.postMessage({ type: "delay", ms: Number($("speed").value) });
  worker.postMessage({ type: "run", src: $("src").value });
};
$("pause").onclick = () => {
  paused = !paused;
  worker.postMessage({ type: paused ? "pause" : "resume" });
  $("pause").textContent = paused ? "Resume" : "Pause";
};
$("stop").onclick = () => worker.postMessage({ type: "stop" });
$("speed").onchange = () => worker.postMessage({ type: "delay", ms: Number($("speed").value) });
$("src").addEventListener("keydown", (e) => {
  if (e.key === "Tab" && !e.shiftKey) {
    e.preventDefault();
    e.target.setRangeText("    ", e.target.selectionStart, e.target.selectionEnd, "end");
  }
});

fetch("examples.json").then((r) => r.json()).then((examples) => {
  for (const ex of examples) $("examples").add(new Option(ex.title, ex.src));
  $("src").value = examples[0]?.src ?? "";
});
$("examples").onchange = (e) => {
  if (e.target.value && !running) $("src").value = e.target.value;
  e.target.selectedIndex = 0;
};

worker.postMessage({ type: "init", config });
