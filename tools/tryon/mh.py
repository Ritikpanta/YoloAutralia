"""MakeHuman base mesh + macro targets + default rig joints, in plain numpy (no Blender needed).

Data comes from MPFB2 (https://github.com/makehumancommunity/mpfb2, src/mpfb/data), released CC0.
Set MPFB_DATA to that folder.

Coordinates returned are Blender's: metres, Z up, the model faces -Y, feet on z = 0 (for the base shape).
"""
import gzip, json, os, re
from functools import lru_cache
import numpy as np

DATA = os.environ.get("MPFB_DATA", "")
MACRO_ORDER = ["gender", "age", "muscle", "weight", "proportions", "height", "cupsize", "firmness"]


def _p(*a):
    return os.path.join(DATA, *a)


@lru_cache(None)
def base():
    """-> dict(v (N,3) obj coords, uv (M,2), faces [ (vi[], ti[]) ], groups {name: set(face idx)})"""
    v, uv, faces, groups, cur = [], [], [], {}, None
    with open(_p("3dobjs", "base.obj")) as f:
        for line in f:
            if line.startswith("v "):
                v.append([float(x) for x in line.split()[1:4]])
            elif line.startswith("vt "):
                uv.append([float(x) for x in line.split()[1:3]])
            elif line.startswith("g "):
                cur = line.split(None, 1)[1].strip(); groups.setdefault(cur, [])
            elif line.startswith("f "):
                vi, ti = [], []
                for tok in line.split()[1:]:
                    a = tok.split("/"); vi.append(int(a[0]) - 1); ti.append(int(a[1]) - 1 if len(a) > 1 and a[1] else -1)
                groups[cur].append(len(faces)); faces.append((vi, ti))
    return dict(v=np.array(v), uv=np.array(uv), faces=faces, groups=groups)


@lru_cache(None)
def target(rel):
    """sparse target -> (idx, delta) in obj coords"""
    path = _p("targets", rel + ".target.gz")
    idx, d = [], []
    with gzip.open(path, "rt") as f:
        for line in f:
            if not line.strip() or line.startswith("#"):
                continue
            a = line.split(); idx.append(int(a[0])); d.append([float(a[1]), float(a[2]), float(a[3])])
    return np.array(idx, dtype=np.int64), np.array(d).reshape(-1, 3)


@lru_cache(None)
def _macro_cfg():
    return json.load(open(_p("targets", "macrodetails", "macro.json")))["macrotargets"]


def _components(name, value):
    out = []
    for p in _macro_cfg()[name]["parts"]:
        if p["lowest"] < value < p["highest"]:
            t = (value - p["lowest"]) / (p["highest"] - p["lowest"])
            if p["low"]:
                out.append((p["low"], round(1 - t, 4)))
            if p["high"]:
                out.append((p["high"], round(t, 4)))
    return out


def macro_stack(m, cutoff=1e-4):
    """MPFB's calculate_target_stack_from_macro_info_dict, re-implemented."""
    c = {k: _components(k, m[k]) for k in MACRO_ORDER}
    out = []
    for race, rw in m["race"].items():
        if rw > 1e-4:
            for a in c["age"]:
                for g in c["gender"]:
                    w = rw * g[1] * a[1]
                    if w > cutoff:
                        out.append((f"macrodetails/{race}-{g[0]}-{a[0]}", w))
    for g in c["gender"]:
        for a in c["age"]:
            for mu in c["muscle"]:
                for we in c["weight"]:
                    w = g[1] * a[1] * mu[1] * we[1]
                    if w > cutoff:
                        out.append((f"macrodetails/universal-{g[0]}-{a[0]}-{mu[0]}-{we[0]}", w))
                    for h in c["height"]:
                        wh = w * h[1]
                        if wh > cutoff:
                            out.append((f"macrodetails/height/{g[0]}-{a[0]}-{mu[0]}-{we[0]}-{h[0]}", wh))
                    for pr in c["proportions"]:
                        wp = w * pr[1]
                        if wp > cutoff and a[0] != "baby":
                            out.append((f"macrodetails/proportions/{g[0]}-{a[0]}-{mu[0]}-{we[0]}-{pr[0]}", wp))
                    if g[0] == "female":
                        for cs in c["cupsize"]:
                            for fi in c["firmness"]:
                                wc = w * cs[1] * fi[1]
                                if wc > cutoff:
                                    out.append((f"breast/female-{a[0]}-{mu[0]}-{we[0]}-{cs[0]}-{fi[0]}", wc))
    return out


def shape(m, extra=()):
    """obj-space vertex positions for macro dict m, plus extra [(target rel path, weight)]"""
    v = base()["v"].copy()
    for rel, w in list(macro_stack(m)) + list(extra):
        if not os.path.exists(_p("targets", rel + ".target.gz")):
            continue
        i, d = target(rel); v[i] += w * d
    return v


def to_blender(v):
    """obj (x, y-up, z-front) decimetres -> Blender metres (x, -z, y)"""
    v = np.asarray(v)
    return np.stack([v[..., 0], -v[..., 2], v[..., 1]], -1) * 0.1


@lru_cache(None)
def rig():
    return json.load(open(_p("rigs", "standard", "rig.default.json")))


@lru_cache(None)
def weights():
    return json.load(open(_p("rigs", "standard", "weights.default.json")))["weights"]


@lru_cache(None)
def group_verts(name):
    b = base(); s = set()
    for fi in b["groups"].get(name, []):
        s.update(b["faces"][fi][0])
    return np.array(sorted(s), dtype=np.int64)


def _joint(spec, v):
    s = spec["strategy"]
    if s == "CUBE":
        return v[group_verts(spec["cube_name"])].mean(0)
    if s == "VERTEX":
        return v[spec["vertex_index"]]
    if s == "MEAN":
        return v[np.array(spec["vertex_indices"])].mean(0)
    raise ValueError(s)


def joints(v):
    """bone name -> (head, tail) in obj coords for the shaped vertices v"""
    return {n: (_joint(b["head"], v), _joint(b["tail"], v)) for n, b in rig().items()}


def body_faces():
    """faces of the 'body' group only, re-indexed: -> (verts idx array into base v, faces as lists, face uv idx lists)"""
    b = base(); fids = b["groups"]["body"]
    used = sorted({i for fi in fids for i in b["faces"][fi][0]})
    remap = {o: n for n, o in enumerate(used)}
    faces = [[remap[i] for i in b["faces"][fi][0]] for fi in fids]
    fuv = [b["faces"][fi][1] for fi in fids]
    return np.array(used, dtype=np.int64), faces, fuv
