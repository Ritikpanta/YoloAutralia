// Builds the try-on figure off the main thread (see fit3d-geom.js).
import { buildFigure } from "./fit3d-geom.js?v=10";

self.onmessage = (e) => {
  const { id, opts } = e.data;
  try {
    const r = buildFigure(opts);
    const buffers = [];
    for (const m of [r.body, r.tee, r.pants]) for (const k of ["P", "N", "I", "col", "uv"]) if (m[k]) buffers.push(m[k].buffer);
    self.postMessage({ id, r }, buffers);
  } catch (err) {
    self.postMessage({ id, error: String(err?.message || err) });
  }
};
