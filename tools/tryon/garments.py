"""Garments as real, independent geometry, built around the body in the idle (standing) pose.

Recipe (per garment):
  1. cross-sections of the body along each part's axis (legs, torso, sleeves), convex hull + ease, so fabric bridges
     hollows instead of shrink-wrapping them; a 'hang' constraint lets fabric fall straight from the widest point
     (thigh, chest) with only a gentle taper, as relaxed fleece does;
  2. parts are lofted into closed tubes and fused with a voxel remesh (clean armpits / crotch / hood / pocket);
  3. openings are cut and covered by rib bands (separate thick tubes: waistband, cuffs, hem) so no paper-thin edge shows;
  4. folds are added where real garments fold: stacking above cuffs, overhang above the hem, behind the knee,
     inside the elbow, plus low-frequency irregularity;
  5. skin weights are transferred from the body (k-nearest, then smoothed over the garment surface), the bind-pose
     shape is recovered by exact inverse linear-blend skinning, and the body's morph targets are transferred so the
     clothes follow height / weight changes without clipping;
  6. UVs: cylindrical about each part's axis, in metres, so knit / twill normal maps tile at true scale.
"""
import math
import bpy, bmesh
import numpy as np
from mathutils import Vector, Matrix, kdtree
from mathutils.bvhtree import BVHTree

N = 72                    # samples around a section
VOXEL = 0.0065


# ------------------------------------------------------------------ geometry helpers
def smooth01(x):
    x = min(1.0, max(0.0, x)); return x * x * (3 - 2 * x)


def hull2d(P):
    P = np.unique(np.round(P, 6), axis=0)
    if len(P) < 3:
        return P
    P = P[np.lexsort((P[:, 1], P[:, 0]))]
    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, up = [], []
    for p in P:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0:
            lo.pop()
        lo.append(p)
    for p in P[::-1]:
        while len(up) >= 2 and cross(up[-2], up[-1], p) <= 0:
            up.pop()
        up.append(p)
    return np.array(lo[:-1] + up[:-1])


def radial(H, c, n=N):
    """distance from c to polygon H along n evenly spaced directions"""
    th = np.linspace(0, 2 * np.pi, n, endpoint=False)
    D = np.stack([np.cos(th), np.sin(th)], 1)
    r = np.zeros(n)
    A = H - c; B = np.roll(H, -1, 0) - c
    for k, d in enumerate(D):
        best = 0
        for a, b in zip(A, B):
            e = b - a
            den = d[0] * (-e[1]) - d[1] * (-e[0])
            if abs(den) < 1e-12:
                continue
            t = (a[0] * (-e[1]) - a[1] * (-e[0])) / den
            s = (d[0] * a[1] - d[1] * a[0]) / den
            if t > 0 and -1e-9 <= s <= 1 + 1e-9:
                best = max(best, t)
        r[k] = best
    return r


def clearance(Craw, Rraw, C):
    """raw section radii (about Craw) re-expressed about centres C: radius each ray from C needs to clear the raw
    outline (conservative: max over raw points falling within the angular bin)"""
    th = np.linspace(0, 2 * np.pi, N, endpoint=False)
    out = np.zeros_like(Rraw)
    for i in range(len(C)):
        x = Craw[i][0] + Rraw[i] * np.cos(th) - C[i][0]
        y = Craw[i][1] + Rraw[i] * np.sin(th) - C[i][1]
        a = np.arctan2(y, x) % (2 * np.pi); r = np.hypot(x, y)
        b = np.round(a / (2 * np.pi) * N).astype(int) % N
        o = np.zeros(N); np.maximum.at(o, b, r)
        for _ in range(2):
            o = np.maximum(o, np.maximum(np.roll(o, 1), np.roll(o, -1)) * (o == 0))
        out[i] = np.maximum(o, np.roll(o, 1) * 0.0)
        out[i] = np.maximum.reduce([o, np.roll(o, 1), np.roll(o, -1)])
    return out


def circ_smooth(r, sigma):
    """gaussian smoothing around the circle (sigma in samples), r: (..., n)"""
    n = r.shape[-1]
    k = np.arange(-n // 2, n // 2)
    g = np.exp(-0.5 * (k / max(sigma, 1e-3)) ** 2); g /= g.sum()
    G = np.fft.rfft(np.roll(g, -n // 2))
    return np.fft.irfft(np.fft.rfft(r, axis=-1) * G, n=n, axis=-1)


def lin_smooth(a, sigma):
    """gaussian smoothing along axis 0 with edge clamping"""
    if sigma <= 0:
        return a
    n = len(a); out = np.empty_like(a)
    idx = np.arange(n)
    for i in range(n):
        w = np.exp(-0.5 * ((idx - i) / sigma) ** 2); w /= w.sum()
        out[i] = np.tensordot(w, a, axes=(0, 0))
    return out


def polyline_frames(pts, n, ref=Vector((1, 0, 0))):
    """resample a polyline to n points -> positions, tangents, u, w (u ~ ref, w = t x u), arclength"""
    pts = [Vector(p) for p in pts]
    seg = [(pts[i + 1] - pts[i]).length for i in range(len(pts) - 1)]
    L = sum(seg); out = []
    for i in range(n):
        s = L * i / (n - 1); acc = 0
        for j, sl in enumerate(seg):
            if s <= acc + sl or j == len(seg) - 1:
                f = (s - acc) / sl if sl else 0
                p = pts[j].lerp(pts[j + 1], min(1, f)); out.append(p); break
            acc += sl
    P = np.array(out)
    T = np.gradient(P, axis=0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    T = lin_smooth(T, 2.0); T /= np.linalg.norm(T, axis=1, keepdims=True)
    r = np.array(ref)
    U = r - T * (T @ r)[:, None]; U /= np.linalg.norm(U, axis=1, keepdims=True)
    W = np.cross(T, U)
    return P, T, U, W, np.linspace(0, L, n)


def sections(V, mask, P, T, U, W, slab, fill=None):
    """body cross-sections along a frame path -> centre offsets (n,2), radii (n,N)"""
    Vm = V[mask]
    C = np.zeros((len(P), 2)); R = np.zeros((len(P), N)); ok = np.zeros(len(P), bool)
    for i in range(len(P)):
        d = Vm - P[i]
        m = np.abs(d @ T[i]) < slab
        if m.sum() < 6:
            continue
        q = np.stack([d[m] @ U[i], d[m] @ W[i]], 1)
        H = hull2d(q)
        if len(H) < 3:
            continue
        c = H.mean(0)
        C[i] = c; R[i] = radial(H, c); ok[i] = True
    # fill gaps by nearest valid section
    idx = np.where(ok)[0]
    for i in range(len(P)):
        if not ok[i]:
            j = idx[np.argmin(np.abs(idx - i))]; C[i] = C[j]; R[i] = R[j]
    return C, R


def rings_to_points(P, U, W, C, R):
    th = np.linspace(0, 2 * np.pi, N, endpoint=False)
    ct, st = np.cos(th), np.sin(th)
    out = np.zeros((len(P), N, 3))
    for i in range(len(P)):
        cu, cw = C[i]
        out[i] = P[i] + U[i] * (cu + R[i][:, None] * ct[:, None]) + W[i] * (cw + R[i][:, None] * st[:, None])
    return out


def tube_mesh(name, rings, cap=True):
    """rings (n, K, 3) -> closed bmesh tube object"""
    N = rings.shape[1]
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings)
    for i in range(n - 1):
        for k in range(N):
            k2 = (k + 1) % N
            bm.faces.new((vs[i][k], vs[i][k2], vs[i + 1][k2], vs[i + 1][k]))
    if cap:
        bm.faces.new(vs[0][::-1]); bm.faces.new(vs[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    return ob


def band_mesh(name, centers, U, W, r_out, r_in, axis_len_dir=None, ribs=0):
    """thick closed band: centers (m,3) along its axis, radii (m,N) outer & inner. UVs: u = around (metres), v = along."""
    m = len(centers)
    th = np.linspace(0, 2 * np.pi, N, endpoint=False)
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap")
    def ring(i, r):
        return [Vector(centers[i] + U[i] * r[k] * math.cos(th[k]) + W[i] * r[k] * math.sin(th[k])) for k in range(N)]
    outer = [[bm.verts.new(p) for p in ring(i, r_out[i])] for i in range(m)]
    inner = [[bm.verts.new(p) for p in ring(i, r_in[i])] for i in range(m)]
    circ = float(np.mean(r_out)) * 2 * math.pi
    along = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(centers, axis=0), axis=1))])
    def quad(a, b, c, d, uv):
        f = bm.faces.new((a, b, c, d))
        for l, t in zip(f.loops, uv):
            l[uvl].uv = t
    for i in range(m - 1):
        for k in range(N):
            k2 = (k + 1) % N; u0, u1 = circ * k / N, circ * (k + 1) / N
            quad(outer[i][k], outer[i][k2], outer[i + 1][k2], outer[i + 1][k], [(u0, along[i]), (u1, along[i]), (u1, along[i + 1]), (u0, along[i + 1])])
            quad(inner[i][k2], inner[i][k], inner[i + 1][k], inner[i + 1][k2], [(u1, along[i]), (u0, along[i]), (u0, along[i + 1]), (u1, along[i + 1])])
    for i, s in ((0, -1), (m - 1, 1)):
        for k in range(N):
            k2 = (k + 1) % N; u0, u1 = circ * k / N, circ * (k + 1) / N
            a, b, c, d = outer[i][k], outer[i][k2], inner[i][k2], inner[i][k]
            v0 = along[i]; v1 = v0 + 0.006 * s
            quad(*((a, b, c, d) if s > 0 else (d, c, b, a)), [(u0, v0), (u1, v0), (u1, v1), (u0, v1)] if s > 0 else [(u0, v1), (u1, v1), (u1, v0), (u0, v0)])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    return ob


def evaluated_copy(ob, name=None):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    new = bpy.data.objects.new(name or ob.name, me); bpy.context.scene.collection.objects.link(new)
    return new


def union_remesh(name, obs, voxel=VOXEL):
    """fuse closed meshes with a voxel remesh"""
    bm = bmesh.new()
    for ob in obs:
        bm.from_mesh(ob.data)
    me = bpy.data.meshes.new(name + "_u"); bm.to_mesh(me); bm.free()
    u = bpy.data.objects.new(name + "_u", me); bpy.context.scene.collection.objects.link(u)
    mod = u.modifiers.new("R", "REMESH"); mod.mode = "VOXEL"; mod.voxel_size = voxel; mod.use_smooth_shade = True
    out = evaluated_copy(u, name)
    for ob in obs + [u]:
        bpy.data.objects.remove(ob, do_unlink=True)
    return out


def mesh_arrays(ob):
    me = ob.data
    V = np.zeros(len(me.vertices) * 3); me.vertices.foreach_get("co", V)
    return V.reshape(-1, 3)


def set_coords(ob, V):
    ob.data.vertices.foreach_set("co", V.astype(np.float32).ravel()); ob.data.update()


def vertex_normals(ob):
    ob.data.update()
    Nn = np.zeros(len(ob.data.vertices) * 3); ob.data.vertices.foreach_get("normal", Nn)
    return Nn.reshape(-1, 3)


def delete_verts(ob, mask):
    bm = bmesh.new(); bm.from_mesh(ob.data); bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.where(mask)[0]], context="VERTS")
    bm.to_mesh(ob.data); bm.free(); ob.data.update()


def neighbours(ob):
    me = ob.data
    E = np.zeros(len(me.edges) * 2, int); me.edges.foreach_get("vertices", E); E = E.reshape(-1, 2)
    return E


def laplacian(V, E, iters, lam=0.5, mask=None):
    n = len(V)
    deg = np.bincount(E.ravel(), minlength=n).astype(float); deg[deg == 0] = 1
    for _ in range(iters):
        S = np.zeros_like(V)
        np.add.at(S, E[:, 0], V[E[:, 1]]); np.add.at(S, E[:, 1], V[E[:, 0]])
        D = S / deg[:, None] - V
        if mask is not None:
            D *= mask[:, None]
        V = V + lam * D
    return V


def vnoise(P, scale, seed=0):
    """smooth value noise in 3D, ~[-1, 1]"""
    rng = np.random.default_rng(seed)
    g = rng.uniform(-1, 1, (64, 64, 64))
    Q = P / scale + 16.0
    i = np.floor(Q).astype(int); f = Q - i; f = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = (f[:, 0] if dx else 1 - f[:, 0]) * (f[:, 1] if dy else 1 - f[:, 1]) * (f[:, 2] if dz else 1 - f[:, 2])
                out = out + w * g[(i[:, 0] + dx) % 64, (i[:, 1] + dy) % 64, (i[:, 2] + dz) % 64]
    return out


def smooth_boundary(ob, iters=12):
    """cut edges come out jagged on a voxel mesh: relax each boundary loop along itself"""
    bm = bmesh.new(); bm.from_mesh(ob.data); bm.verts.ensure_lookup_table()
    bnd = [e for e in bm.edges if e.is_boundary]
    nb = {}
    for e in bnd:
        a, b = e.verts
        nb.setdefault(a.index, []).append(b.index); nb.setdefault(b.index, []).append(a.index)
    V = np.array([v.co for v in bm.verts])
    idx = np.array(list(nb.keys()))
    for _ in range(iters):
        V2 = V.copy()
        for i in idx:
            n = nb[i]
            V2[i] = 0.5 * V[i] + 0.5 * V[n].mean(0)
        V = V2
    # pull the ring just inside the boundary along, so the edge stays smooth and not pinched
    for v in bm.verts:
        v.co = V[v.index]
    bm.to_mesh(ob.data); bm.free(); ob.data.update()
    Vn = mesh_arrays(ob); E = neighbours(ob)
    near = np.zeros(len(Vn), bool); near[idx] = True
    for _ in range(2):
        nn = near.copy(); nn[E[near[E[:, 0]], 1]] = True; nn[E[near[E[:, 1]], 0]] = True; near = nn
    m = near.astype(float); m[idx] = 0.0
    set_coords(ob, laplacian(Vn, E, 4, 0.5, mask=m))


def relax_region(B, ob, mask_fn, iters=14, clear=0.008):
    """round off a region (shoulder seams etc.), then push anything that got too close back off the body"""
    V = mesh_arrays(ob); E = neighbours(ob)
    m = mask_fn(V).astype(float)
    V = laplacian(V, E, iters, 0.5, mask=m)
    for i in np.where(m > 0)[0]:
        loc, nrm, fi, d = B.bvh.find_nearest(Vector(V[i]))
        if loc is None:
            continue
        out = np.array(V[i]) - np.array(loc)
        side = out @ np.array(nrm)
        if side < clear:
            V[i] = np.array(loc) + np.array(nrm) * clear
    set_coords(ob, V)


# ------------------------------------------------------------------ the posed body
class Posed:
    def __init__(self, S):
        body, rig = S["body"], S["rig"]
        self.body, self.rig = body, rig
        dg = bpy.context.evaluated_depsgraph_get()
        ev = body.evaluated_get(dg); me = ev.to_mesh()
        self.V = np.array([v.co for v in me.vertices]); self.Nrm = np.array([v.normal for v in me.vertices])
        ev.to_mesh_clear()
        self.Vrest = mesh_arrays(body)
        names = [g.name for g in body.vertex_groups]
        W = np.zeros((len(self.V), len(names)))
        for v in body.data.vertices:
            for g in v.groups:
                W[v.index, g.group] = g.weight
        s = W.sum(1, keepdims=True); s[s == 0] = 1
        self.W = W / s; self.names = names
        dom = np.array(names)[W.argmax(1)]
        def part(n):
            if n.endswith((".L", ".R")):
                sd = n[-1]
                b = n[:-2]
                if b.startswith(("upperleg", "lowerleg", "foot", "toe")):
                    return "leg" + sd
                if b == "shoulder01":
                    return "torso"
                if b.startswith(("upperarm", "lowerarm")):
                    return "arm" + sd
                if b.startswith(("wrist", "finger", "metacarpal")):
                    return "hand" + sd
                if b.startswith("pelvis"):
                    return "pelvis"
                if b.startswith(("clavicle", "breast")):
                    return "torso"
                return "head"
            if n.startswith(("spine", "root")):
                return "torso"
            if n.startswith("neck"):
                return "neck"
            return "head"
        self.part = np.array([part(n) for n in dom])
        hipz = (rig.matrix_world @ rig.pose.bones["upperleg01.L"].head).z
        # crotch ~10 cm below the hip-joint centres (anthropometric; the mesh's centre line is unreliable here)
        self.crotch = float(hipz - 0.10)
        self.bone = {pb.name: (rig.matrix_world @ pb.head, rig.matrix_world @ pb.tail) for pb in rig.pose.bones}
        self.kd = kdtree.KDTree(len(self.V))
        for i, p in enumerate(self.V):
            self.kd.insert(p, i)
        self.kd.balance()
        bm = bmesh.new(); bm.from_mesh(me if False else body.data); bm.verts.ensure_lookup_table()
        for i, v in enumerate(bm.verts):
            v.co = self.V[i]
        self.bvh = BVHTree.FromBMesh(bm); bm.free()

    def h(self, n):
        return np.array(self.bone[n][0])

    def m(self, *parts):
        return np.isin(self.part, parts)


# ------------------------------------------------------------------ parts
def leg_tube(B, sd, z_top, z_cuff, ease_fn, hang=0.05, n=110, gap=0.004, gather=None, crotch_z=0.0, min_clear=0.007, z_floor=None):
    """one trouser leg from z_top down to the cuff, following hip->knee->ankle"""
    sg = 1 if sd == "L" else -1
    hip, knee, ank = B.h(f"upperleg01.{sd}"), B.h(f"lowerleg01.{sd}"), B.h(f"foot.{sd}")
    top = hip.copy(); top[2] = z_top
    # path from top (slightly outside the hip joint) down to the ankle, then to the cuff height
    bot = ank.copy(); bot[2] = z_cuff
    P, T, U, W, s = polyline_frames([top, knee, bot], n, ref=Vector((1, 0, 0)))
    mask = B.m("leg" + sd) | (B.m("pelvis", "torso") & (B.V[:, 0] * sg > -0.03))
    if z_floor is not None:
        mask &= B.V[:, 2] > z_floor
    C, R = sections(B.V, mask, P, T, U, W, slab=0.012)
    # anatomy out, fabric in: smooth strongly, add ease, let it hang from the widest point
    Craw = C.copy(); Rraw = R.copy()
    R = circ_smooth(R, 4.0); R = lin_smooth(R, 3.0); C = lin_smooth(C, 4.0)
    R0 = R.copy()
    t = s / s[-1]
    R = R + np.array([ease_fn(x) for x in t])[:, None]
    for i in range(1, n):
        R[i] = np.maximum(R[i], R[i - 1] - hang * (s[i] - s[i - 1]) * np.ones(N))
    R = circ_smooth(R, 6.0)
    if gather is not None:      # gather into the cuff: (z where fully gathered, blend height, ease over the body)
        zg, hb, eg = gather
        for i in range(n):
            f = smooth01((P[i][2] - zg) / hb)
            R[i] = R0[i] + eg + f * (R[i] - R0[i] - eg)
    R = np.maximum(R, clearance(Craw, Rraw, C) + min_clear)
    pts = rings_to_points(P, U, W, C, R)
    # inner leg flattened at the centre seam: apart below the crotch (legs never fuse), overlapping above it
    # so the two halves fuse into one seat
    x = pts[..., 0] * sg
    g = np.where(pts[..., 2] > crotch_z + 0.012, -0.012, gap)
    pts[..., 0] = np.where(x < g, sg * g, pts[..., 0])
    return pts, (P, T, U, W, s, C, R)


def torso_tube(B, z_bot, z_top, ease_fn, hang=0.05, n=80, arm_cap=None, gather=None):
    top = (B.h("neck01") + B.h("spine01")) / 2; top[2] = z_top
    bot = B.h("root").copy(); bot[2] = z_bot
    mid = B.h("spine03").copy()
    P, T, U, W, s = polyline_frames([bot, mid, top], n)
    mask = B.m("torso", "pelvis") | (B.m("legL", "legR") & (B.V[:, 2] > z_bot - 0.02))
    if arm_cap is not None:
        mask |= B.m("armL", "armR") & (B.V[:, 2] > arm_cap)
    C, R = sections(B.V, mask, P, T, U, W, slab=0.012)
    Craw, Rraw = C.copy(), R.copy()
    R = circ_smooth(R, 3.0); R = lin_smooth(R, 2.0); C = lin_smooth(C, 3.0)
    R0 = R.copy()
    t = s / s[-1]
    R = R + np.array([ease_fn(x) for x in t])[:, None]
    # hang: from the chest down the fabric falls nearly straight
    thx = np.linspace(0, 2 * np.pi, N, endpoint=False)
    fb = np.abs(np.sin(thx)) ** 2           # 1 at front/back (w axis), 0 at the sides
    rate = hang * fb + 0.6 * (1 - fb)
    for i in range(n - 2, -1, -1):
        R[i] = np.maximum(R[i], R[i + 1] - rate * (s[i + 1] - s[i]))
    R = circ_smooth(R, 5.0)
    if gather is not None:      # gather into the hem rib: (z fully gathered, blend height, ease)
        zg, hb, eg = gather
        for i in range(n):
            f = smooth01((P[i][2] - zg) / hb)
            R[i] = R0[i] + eg + f * (R[i] - R0[i] - eg)
    R = np.maximum(R, clearance(Craw, Rraw, C) + 0.008)
    return rings_to_points(P, U, W, C, R), (P, T, U, W, s, C, R)


def sleeve_tube(B, sd, ease_fn, cuff_back=0.035, n=70, start_in=0.03, gather=None):
    sh, el, wr = B.h(f"upperarm01.{sd}"), B.h(f"lowerarm01.{sd}"), B.h(f"wrist.{sd}")
    d = wr - el; d /= np.linalg.norm(d)
    end = wr - d * cuff_back
    start = sh + np.array([-np.sign(sh[0]) * start_in, 0, 0.035])     # begins up under the shoulder seam
    P, T, U, W, s = polyline_frames([start, sh, el, end], n, ref=Vector((0, -1, 0)))
    mask = B.m("arm" + sd, "hand" + sd)
    C, R = sections(B.V, mask, P, T, U, W, slab=0.012)
    Craw, Rraw = C.copy(), R.copy()
    R = circ_smooth(R, 4.0); R = lin_smooth(R, 3.0); C = lin_smooth(C, 3.0)
    R0 = R.copy()
    t = s / s[-1]
    R = R + np.array([ease_fn(x) for x in t])[:, None]
    i0 = int(np.searchsorted(s, 0.12))
    for i in range(i0 + 1, n):    # sleeves hang loosely: no quick taper below the biceps
        R[i] = np.maximum(R[i], R[i - 1] - 0.06 * (s[i] - s[i - 1]))
    R = circ_smooth(R, 6.0)
    if gather is not None:
        hb, eg = gather
        for i in range(n):
            f = smooth01((s[-1] - s[i] - 0.03) / hb)
            R[i] = R0[i] + eg + f * (R[i] - R0[i] - eg)
    R = np.maximum(R, clearance(Craw, Rraw, C) + 0.006)
    return rings_to_points(P, U, W, C, R), (P, T, U, W, s, C, R)


# ------------------------------------------------------------------ skinning, bind pose, morphs, uvs
ALLOW = {
    # which body regions each garment region may take its skin weights from (never a hand, never the other limb)
    "torso": ("torso", "pelvis", "neck"),
    "sleeveL": ("armL", "torso"), "sleeveR": ("armR", "torso"),
    "legL": ("legL", "pelvis", "torso"), "legR": ("legR", "pelvis", "torso"),
    None: ("torso", "pelvis", "neck", "legL", "legR", "armL", "armR"),
}


def skin_from_body(B, ob, k=10, smooth_iters=12, labels=None, default=None):
    V = mesh_arrays(ob)
    Wg = np.zeros((len(V), B.W.shape[1]))
    if not hasattr(B, "_kds"):
        B._kds = {}
    def tree(parts):
        if parts not in B._kds:
            ids = np.where(np.isin(B.part, parts))[0]
            t = kdtree.KDTree(len(ids))
            for i in ids:
                t.insert(B.V[i], int(i))
            t.balance(); B._kds[parts] = t
        return B._kds[parts]
    for i, p in enumerate(V):
        lab = labels[i] if labels is not None else default
        near = tree(ALLOW.get(lab, ALLOW[None])).find_n(p, k)
        d = np.array([x[2] for x in near]); j = np.array([x[1] for x in near])
        w = 1 / (d + 0.004) ** 2; w /= w.sum()
        Wg[i] = w @ B.W[j]
    E = neighbours(ob)
    Wg = laplacian(Wg, E, smooth_iters, 0.5)
    # keep the 4 strongest influences
    idx = np.argsort(-Wg, 1)[:, :4]
    W4 = np.take_along_axis(Wg, idx, 1); W4 = np.clip(W4, 0, None)
    bad = W4.sum(1) < 1e-6
    if bad.any():                       # fall back to the single nearest body vertex
        for i in np.where(bad)[0]:
            j = B.kd.find(V[i])[1]; w = B.W[j]
            idx[i] = np.argsort(-w)[:4]; W4[i] = w[idx[i]]
    W4 /= W4.sum(1, keepdims=True)
    return idx, W4


def bind_pose(B, ob, idx, W4):
    """exact inverse of linear blend skinning: posed coords -> rest coords"""
    rig = B.rig
    M = {}
    for j, n in enumerate(B.names):
        pb = rig.pose.bones.get(n)
        M[j] = np.array(pb.matrix @ pb.bone.matrix_local.inverted()) if pb else np.eye(4)
    V = mesh_arrays(ob); out = np.zeros_like(V)
    for i, p in enumerate(V):
        A = sum(W4[i, c] * M[idx[i, c]] for c in range(4))
        out[i] = (np.linalg.inv(A) @ np.append(p, 1))[:3]
    return out


def apply_skin(B, ob, idx, W4):
    for n in B.names:
        ob.vertex_groups.new(name=n)
    for i in range(len(idx)):
        for c in range(4):
            if W4[i, c] > 1e-4:
                ob.vertex_groups[int(idx[i, c])].add([i], float(W4[i, c]), "REPLACE")
    ob.parent = B.rig
    mod = ob.modifiers.new("Armature", "ARMATURE"); mod.object = B.rig


def transfer_morphs(B, ob, k=8):
    """garment shape keys from the body's (in rest space), smoothly interpolated"""
    keys = B.body.data.shape_keys.key_blocks
    Vr = mesh_arrays(ob)
    kd = kdtree.KDTree(len(B.Vrest))
    for i, p in enumerate(B.Vrest):
        kd.insert(p, i)
    kd.balance()
    nb = []
    for p in Vr:
        near = kd.find_n(p, k)
        d = np.array([x[2] for x in near]); j = np.array([x[1] for x in near])
        w = 1 / (d + 0.01) ** 2; w /= w.sum(); nb.append((j, w))
    E = neighbours(ob)
    ob.shape_key_add(name="Basis", from_mix=False)
    base = np.array([v.co for v in keys["Basis"].data])
    for kb in keys:
        if kb.name == "Basis":
            continue
        D = np.array([v.co for v in kb.data]) - base
        G = np.array([w @ D[j] for j, w in nb])
        G = laplacian(G, E, 6, 0.5)
        sk = ob.shape_key_add(name=kb.name, from_mix=False)
        sk.data.foreach_set("co", (Vr + G).astype(np.float32).ravel()); sk.value = 0.0


def cyl_uvs(ob, axes, labels):
    """per-loop UVs, cylindrical about the axis of the part each vertex belongs to (metres)."""
    me = ob.data
    V = mesh_arrays(ob)
    uvl = me.uv_layers.new(name="UVMap")
    L = np.zeros(len(me.loops), int); me.loops.foreach_get("vertex_index", L)
    UV = np.zeros((len(V), 2)); ang = np.zeros(len(V)); rad = np.zeros(len(V))
    for lab, (P, T, U, W, s, Rm) in axes.items():
        m = labels == lab
        if not m.any():
            continue
        X = V[m]
        # nearest axis sample
        d2 = ((X[:, None, :] - P[None, :, :]) ** 2).sum(2); i = d2.argmin(1)
        D = X - P[i]
        a = np.arctan2((D * W[i]).sum(1), (D * U[i]).sum(1))
        ang[m] = a; rad[m] = Rm
        UV[m, 1] = s[i] + (D * T[i]).sum(1)
    out = np.zeros((len(L), 2))
    for poly in me.polygons:
        li = list(poly.loop_indices); vi = L[li]
        a = ang[vi].copy()
        if a.max() - a.min() > np.pi:        # wrap seam
            a[a < 0] += 2 * np.pi
        out[li, 0] = a * rad[vi]; out[li, 1] = UV[vi, 1]
    uvl.data.foreach_set("uv", out.ravel())


def finish(B, ob, mat_name, labels=None, axes=None, region=None, axes_for_labels=None):
    for p in ob.data.polygons:
        p.use_smooth = True
    if axes is not None:
        cyl_uvs(ob, axes, labels)
    if labels is None and axes_for_labels is not None:     # trims: each vertex follows its nearest garment part
        labels = label_by_axes(mesh_arrays(ob), axes_for_labels)
    idx, W4 = skin_from_body(B, ob, labels=labels, default=region)
    V0 = mesh_arrays(ob)
    assert np.isfinite(V0).all(), ("pre", ob.name, np.where(~np.isfinite(V0).all(1))[0][:10], len(V0))
    rest = bind_pose(B, ob, idx, W4)
    if not np.isfinite(rest).all():
        bad = ~np.isfinite(rest).all(1)
        print("BIND NAN", ob.name, bad.sum(), V0[bad][:3], W4[bad][:3], idx[bad][:3])
    assert np.isfinite(rest).all(), ob.name
    set_coords(ob, rest)
    apply_skin(B, ob, idx, W4)
    transfer_morphs(B, ob)
    mat = bpy.data.materials.get(mat_name) or bpy.data.materials.new(mat_name)
    ob.data.materials.clear(); ob.data.materials.append(mat)
    return ob


def decimate(ob, ratio):
    mod = ob.modifiers.new("D", "DECIMATE"); mod.ratio = ratio; mod.use_collapse_triangulate = False
    new = evaluated_copy(ob, ob.name + "_d")
    name = ob.name; bpy.data.objects.remove(ob, do_unlink=True); new.name = name
    return new


def label_by_axes(V, axes):
    labs = list(axes.keys()); best = np.full(len(V), np.inf); lab = np.empty(len(V), object)
    for l in labs:
        P = axes[l][0]
        d = np.sqrt(((V[:, None, :] - P[None, :, :]) ** 2).sum(2)).min(1)
        # bias: distance minus the part's radius
        d = d - axes[l][5]
        m = d < best; best[m] = d[m]; lab[m] = l
    return lab


# ------------------------------------------------------------------ garments
def joggers(B, sex, cfg):
    f = sex == "f"
    ank = B.h("foot.L")[2]
    z_cuff_bot = ank + 0.016           # bottom edge of the ankle cuff
    cuff_h = 0.07
    z_cuff_top = z_cuff_bot + cuff_h
    hipz = B.h("upperleg01.L")[2]
    crotch = B.crotch
    z_waist = hipz + (0.075 if not f else 0.06)
    legs, frames = {}, {}
    def ease(t):   # t: 0 = waist, 1 = cuff. Relaxed through the seat and thigh, gently tapering.
        return 0.012 + 0.022 * math.sin(math.pi * min(1, 0.15 + t * 1.4)) * (1 - 0.6 * t) + 0.004
    for sd in "LR":
        pts, fr = leg_tube(B, sd, z_waist + 0.03, z_cuff_top - 0.03, ease, hang=0.15,
                           gather=(z_cuff_top + 0.004, 0.07, 0.009), crotch_z=crotch)
        legs[sd] = pts; frames["leg" + sd] = fr
    obs = [tube_mesh("legL", legs["L"]), tube_mesh("legR", legs["R"])]
    J = union_remesh("Joggers", obs)
    V = mesh_arrays(J)
    # cut openings: waist top, ankle bottoms
    cut = (V[:, 2] > z_waist) | (V[:, 2] < z_cuff_top - 0.025)
    delete_verts(J, cut)
    smooth_boundary(J)
    V = mesh_arrays(J); Nn = vertex_normals(J); E = neighbours(J)
    axes = {k: (fr[0], fr[1], fr[2], fr[3], fr[4], float(np.mean(fr[6]))) for k, fr in frames.items()}
    lab = label_by_axes(V, axes)
    # ---- folds
    disp = np.zeros(len(V))
    for sd in "LR":
        sg = 1 if sd == "L" else -1
        P, T, U, W, s, C, R = frames["leg" + sd]
        m = lab == "leg" + sd
        X = V[m]
        d2 = ((X[:, None, :] - P[None, :, :]) ** 2).sum(2); i = d2.argmin(1)
        D = X - P[i]; ang = np.arctan2((D * W[i]).sum(1), (D * U[i]).sum(1))
        h = X[:, 2] - z_cuff_top                                    # height above the cuff
        nz = vnoise(X, 0.045, 3 + (sd == "R"))
        stack = np.clip(h / 0.02, 0, 1) * np.clip(1 - h / (0.15 + 0.03 * nz), 0, 1) ** 1.3
        # folds stack at a slight, varying diagonal; spacing and depth vary like real fleece
        ph = 2 * np.pi * (h / (0.036 + 0.006 * nz)) + 1.6 * np.sin(ang + 0.7 * sg) + 2.2 * vnoise(X, 0.06, 7)
        amp = 0.0045 * (0.6 + 0.4 * (1 + vnoise(X, 0.05, 9)))
        disp[m] += stack * (amp * np.sin(ph) + 0.004)
        knee = B.h(f"lowerleg01.{sd}")[2]
        Nl = Nn[m]
        back = np.clip(Nl[:, 1], 0, 1) ** 2                        # +Y = behind the model
        kz = np.exp(-((X[:, 2] - knee + 0.03) / 0.06) ** 2)
        disp[m] += kz * back * 0.003 * np.sin(2 * np.pi * (X[:, 2] - knee) / 0.03 + 2 * vnoise(X, 0.04, 5))
        # soft drag lines from the inner thigh towards the knee (front)
        front = np.clip(-Nl[:, 1], 0, 1)
        th = np.exp(-((X[:, 2] - (crotch - 0.12)) / 0.12) ** 2)
        disp[m] += th * front * 0.0018 * np.sin(2 * np.pi * (X[:, 2] + 0.5 * X[:, 0] * sg) / 0.07)
    disp += 0.0022 * vnoise(V, 0.09, 1) + 0.0012 * vnoise(V, 0.035, 2)
    V = V + Nn * disp[:, None]
    V = laplacian(V, E, 2, 0.35)
    set_coords(J, V)
    J = decimate(J, cfg.get("decimate", 0.45))
    V = mesh_arrays(J); lab = label_by_axes(V, axes)
    # ---- rib cuffs + waistband
    ribs = []
    for sd in "LR":
        P, T, U, W, s, C, R = frames["leg" + sd]
        m = 10
        zc = np.linspace(z_cuff_top, z_cuff_bot, m)
        cen, Us, Ws, ro, ri = [], [], [], [], []
        ankle_mask = B.m("leg" + sd) & (np.abs(B.V[:, 2] - (z_cuff_bot + cuff_h * 0.5)) < 0.03)
        acen = B.V[ankle_mask].mean(0)
        for j, z in enumerate(zc):
            sl = B.m("leg" + sd) & (np.abs(B.V[:, 2] - z) < 0.01)
            q = B.V[sl][:, :2]
            if len(q) < 8:
                sl = B.m("leg" + sd) & (np.abs(B.V[:, 2] - z) < 0.02); q = B.V[sl][:, :2]
            c2 = q.mean(0); H = hull2d(q); r = radial(H, c2)
            r = np.maximum(circ_smooth(r, 8), np.maximum.reduce([r, np.roll(r, 1), np.roll(r, -1)])) + 0.014 + 0.004 * math.sin(math.pi * j / (m - 1))
            cen.append(np.array([c2[0], c2[1], z])); Us.append(np.array([1, 0, 0])); Ws.append(np.array([0, 1, 0]))
            ro.append(r + 0.004); ri.append(r - 0.0005)
        ribs.append(band_mesh(f"Cuff{sd}", np.array(cen), np.array(Us), np.array(Ws), np.array(ro), np.array(ri)))
    # waistband (visible on the formal-free casual look when the hoodie rides up while walking)
    m = 8; zc = np.linspace(z_waist + 0.012, z_waist - 0.035, m)
    cen, Us, Ws, ro, ri = [], [], [], [], []
    for z in zc:
        sl = B.m("torso", "pelvis") & (np.abs(B.V[:, 2] - z) < 0.01)
        q = B.V[sl][:, :2]; c2 = q.mean(0); r0 = radial(hull2d(q), c2); r = np.maximum(circ_smooth(r0, 6), r0) + 0.006
        cen.append(np.array([c2[0], c2[1], z])); Us.append(np.array([1, 0, 0])); Ws.append(np.array([0, 1, 0]))
        ro.append(r + 0.004); ri.append(r - 0.002)
    wb = band_mesh("Waistband", np.array(cen), np.array(Us), np.array(Ws), np.array(ro), np.array(ri))
    rib = join(ribs + [wb], "JoggersRib")
    finish(B, J, "YOLO_Fleece", lab, axes)
    finish(B, rib, "YOLO_Rib", axes_for_labels=axes)
    return [J, rib], dict(z_cuff_bot=z_cuff_bot, z_cuff_top=z_cuff_top, z_waist=z_waist, crotch=crotch)


def join(obs, name):
    bm = bmesh.new()
    for ob in obs:
        bm.from_mesh(ob.data)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    for p in me.polygons:
        p.use_smooth = True
    new = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(new)
    for ob in obs:
        bpy.data.objects.remove(ob, do_unlink=True)
    return new


def bvh_of(ob):
    bm = bmesh.new(); bm.from_mesh(ob.data); t = BVHTree.FromBMesh(bm); bm.free(); return t


def sweep_torus(name, loop, radii, up=Vector((0, 0, 1)), m=18):
    """closed tube swept along a closed loop (n,3) with per-point radius; circle in the (radial-out, up) plane"""
    n = len(loop); c = loop.mean(0)
    bm = bmesh.new(); rings = []
    for i in range(n):
        out = loop[i] - c; out[2] = 0; out /= np.linalg.norm(out)
        tan = loop[(i + 1) % n] - loop[i - 1]; tan /= np.linalg.norm(tan)
        upv = np.cross(tan, out); upv /= np.linalg.norm(upv)
        if upv[2] < 0:
            upv = -upv
        a = np.linspace(0, 2 * np.pi, m, endpoint=False)
        rings.append([bm.verts.new(loop[i] + radii[i][0] * np.cos(t) * out + radii[i][1] * np.sin(t) * upv) for t in a])
    for i in range(n):
        for k in range(m):
            bm.faces.new((rings[i][k], rings[i][(k + 1) % m], rings[(i + 1) % n][(k + 1) % m], rings[(i + 1) % n][k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob); return ob


def pad_solid(name, front_pts, normals, thick):
    """closed slab from a grid of surface points (a, b, 3) + outward normals and thickness (a, b)"""
    A, Bn = front_pts.shape[:2]
    bm = bmesh.new()
    lo = [[bm.verts.new(front_pts[i, j] - normals[i, j] * 0.004) for j in range(Bn)] for i in range(A)]
    hi = [[bm.verts.new(front_pts[i, j] + normals[i, j] * thick[i, j]) for j in range(Bn)] for i in range(A)]
    for i in range(A - 1):
        for j in range(Bn - 1):
            bm.faces.new((hi[i][j], hi[i + 1][j], hi[i + 1][j + 1], hi[i][j + 1]))
            bm.faces.new((lo[i][j], lo[i][j + 1], lo[i + 1][j + 1], lo[i + 1][j]))
    for i in range(A - 1):
        for j in (0, Bn - 1):
            bm.faces.new((lo[i][j], lo[i + 1][j], hi[i + 1][j], hi[i][j]))
    for j in range(Bn - 1):
        for i in (0, A - 1):
            bm.faces.new((lo[i][j], hi[i][j], hi[i][j + 1], lo[i][j + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob); return ob


def cast(bvh, origin, direction, maxd=1.0):
    hit = bvh.ray_cast(Vector(origin), Vector(direction), maxd)
    return (np.array(hit[0]), np.array(hit[1])) if hit[0] is not None else (None, None)


def ring_band(B, mask, centers_axis, ease, height, m=9, thick=0.004, along=None):
    """rib band around the body (mask) at horizontal slices from z0 down to z1"""
    z0, z1 = centers_axis
    cen, Us, Ws, ro, ri = [], [], [], [], []
    for j, z in enumerate(np.linspace(z0, z1, m)):
        sl = mask & (np.abs(B.V[:, 2] - z) < 0.012)
        q = B.V[sl][:, :2]; c2 = q.mean(0); r0 = radial(hull2d(q), c2)
        r = np.maximum(circ_smooth(r0, 8), r0) + ease + 0.003 * math.sin(math.pi * j / (m - 1))
        r = circ_smooth(r, 3)
        cen.append(np.array([c2[0], c2[1], z])); Us.append(np.array([1., 0, 0])); Ws.append(np.array([0., 1, 0]))
        ro.append(r + thick); ri.append(r - 0.0015)
    return np.array(cen), np.array(Us), np.array(Ws), np.array(ro), np.array(ri)


def hoodie(B, sex, cfg):
    f = sex == "f"
    crotch = B.crotch
    hem_bot = crotch + (0.05 if not f else 0.07)
    hem_h = 0.06
    hem_top = hem_bot + hem_h
    neck = B.h("neck01"); zN = neck[2] - 0.015
    sh = {sd: B.h(f"upperarm01.{sd}") for sd in "LR"}
    arm_z = min(sh["L"][2], sh["R"][2]) - 0.11            # armpit height
    frames = {}
    # ---- torso: boxy, hanging from the chest, gathered into the hem rib
    def te(t):   # t: 0 = hem, 1 = neck
        return (0.034 if not f else 0.030) - 0.018 * smooth01((t - 0.7) / 0.3)
    T_pts, fr = torso_tube(B, hem_top - 0.03, zN + 0.01, te, hang=0.03, arm_cap=arm_z + 0.04,
                           gather=(hem_top + 0.004, 0.09, 0.036))
    frames["torso"] = fr
    # ---- sleeves
    sleeves = {}
    for sd in "LR":
        def se(t):
            return 0.016 - 0.006 * t
        pts, frs = sleeve_tube(B, sd, se, cuff_back=0.045, gather=(0.08, 0.008), start_in=0.025)
        sleeves[sd] = pts; frames["sleeve" + sd] = frs
    # ---- the torso gives way where the arm presses against it (below the armpit)
    P = T_pts.reshape(-1, 3)
    for sd in "LR":
        Ps, Ts, Us_, Ws_, ss, Cs, Rs = frames["sleeve" + sd]
        rmean = Rs.mean(1)
        for it in range(3):
            d2 = ((P[:, None, :] - Ps[None, :, :]) ** 2).sum(2); j = d2.argmin(1)
            D = P - Ps[j]; D -= Ts[j] * (D * Ts[j]).sum(1)[:, None]
            dist = np.linalg.norm(D, axis=1)
            need = rmean[j] + 0.006 - dist
            m = (need > 0) & (P[:, 2] < arm_z) & (np.sign(P[:, 0]) == np.sign(Ps[0][0]))
            P[m, 0] -= np.sign(Ps[0][0]) * need[m]
    # shoulders slope from the neck to the shoulder point: no flat shelf on top of the torso tube
    sm = B.m("torso", "armL", "armR", "neck") & (B.V[:, 2] < zN + 0.005)
    xs = np.linspace(-0.35, 0.35, 141); prof = np.full(len(xs), -1.0)
    bi = np.clip(np.round((B.V[sm][:, 0] + 0.35) / 0.005).astype(int), 0, len(xs) - 1)
    np.maximum.at(prof, bi, B.V[sm][:, 2])
    good = prof > 0; prof = np.interp(xs, xs[good], prof[good])
    prof = lin_smooth(prof, 3.0) + 0.016
    prof = np.minimum(prof, zN + 0.04)
    lim = np.interp(P[:, 0], xs, prof)
    hi = P[:, 2] > lim
    P[hi, 2] = lim[hi]
    T_pts = P.reshape(T_pts.shape)
    obs = [tube_mesh("torso", T_pts), tube_mesh("sleeveL", sleeves["L"]), tube_mesh("sleeveR", sleeves["R"])]
    torso_bvh = bvh_of(obs[0])
    # ---- hood, down: a soft roll around the neckline crossing in a V at the front + the hood lying on the back
    nm = B.m("neck", "torso") & (np.abs(B.V[:, 2] - zN) < 0.012)
    q = B.V[nm][:, :2]; cN = q.mean(0); rN = circ_smooth(radial(hull2d(q), cN), 4)
    th = np.linspace(0, 2 * np.pi, N, endpoint=False)          # th = -pi/2 -> front (-Y)
    frontness = np.clip(np.cos(th + np.pi / 2), 0, 1)
    backness = np.clip(-np.cos(th + np.pi / 2), 0, 1)
    rr_out = 0.012 + 0.024 * backness + 0.010 * (1 - frontness)
    rr_up = 0.012 + 0.036 * backness + 0.008 * (1 - frontness)
    reach = rN + 0.010 + rr_out + 0.006 * backness
    loop = np.stack([cN[0] + reach * np.cos(th), cN[1] + reach * np.sin(th),
                     zN - 0.004 + 0.012 * backness - 0.05 * frontness ** 5], 1)
    roll = sweep_torus("hoodroll", loop, np.stack([rr_out, rr_up], 1))
    # collapsed hood on the upper back
    A, Bn = 22, 26
    pts = np.zeros((A, Bn, 3)); nrm = np.zeros((A, Bn, 3)); thick = np.zeros((A, Bn))
    depth = 0.30 if not f else 0.27
    for i in range(A):
        z = zN - 0.03 - depth * i / (A - 1)
        u = i / (A - 1)
        w = (0.17 if not f else 0.15) * math.sqrt(max(0.02, 1 - u ** 2.2))
        for j in range(Bn):
            x = cN[0] + w * (2 * j / (Bn - 1) - 1)
            hpt, hn = cast(torso_bvh, (x, cN[1] + 0.6, z), (0, -1, 0))
            if hpt is None:
                hpt, hn = np.array([x, cN[1] + 0.12, z]), np.array([0, 1, 0])
            pts[i, j] = hpt; nrm[i, j] = hn
            e = 1 - abs(2 * j / (Bn - 1) - 1) ** 2
            thick[i, j] = 0.004 + 0.032 * math.sqrt(max(0, e)) * (1 - u ** 3) * (0.55 + 0.45 * math.sin(math.pi * min(1, u * 1.6 + 0.2)))
    hood = pad_solid("hood", pts, nrm, thick)
    # kangaroo pocket: a raised, slightly padded panel
    A, Bn = 16, 30
    pts = np.zeros((A, Bn, 3)); nrm = np.zeros((A, Bn, 3)); thick = np.zeros((A, Bn))
    for i in range(A):
        u = i / (A - 1)
        z = hem_top + 0.004 + 0.19 * u
        w = (0.165 - 0.035 * u) if not f else (0.15 - 0.03 * u)
        for j in range(Bn):
            x = w * (2 * j / (Bn - 1) - 1)
            hpt, hn = cast(torso_bvh, (x, -0.6, z), (0, 1, 0))
            if hpt is None:
                continue
            pts[i, j] = hpt; nrm[i, j] = hn
            thick[i, j] = 0.0035 + 0.0025 * (1 - abs(2 * j / (Bn - 1) - 1) ** 4) * (1 - u)
    pocket = pad_solid("pocket", pts, nrm, thick)
    H = union_remesh("Hoodie", obs + [roll, hood, pocket])
    # ---- openings
    V = mesh_arrays(H)
    cut = V[:, 2] < hem_top - 0.022
    dxy = V[:, :2] - cN; ang = np.arctan2(dxy[:, 1], dxy[:, 0]) % (2 * np.pi)
    rin = np.interp(ang, np.append(th, 2 * np.pi), np.append(rN, rN[0]))
    cut |= (np.linalg.norm(dxy, axis=1) < rin + 0.004) & (V[:, 2] > zN - 0.07)
    for sd in "LR":
        Ps, Ts = frames["sleeve" + sd][0], frames["sleeve" + sd][1]
        end, d = Ps[-1], Ts[-1]
        cut |= ((V - end) @ d > 0.012) & (np.linalg.norm(V - end, axis=1) < 0.2)
    delete_verts(H, cut)
    smooth_boundary(H)
    relax_region(B, H, lambda V: (V[:, 2] > arm_z - 0.02) & (np.abs(V[:, 0]) > 0.10), iters=16, clear=0.012)
    V = mesh_arrays(H); Nn = vertex_normals(H); E = neighbours(H)
    axes = {k: (fr[0], fr[1], fr[2], fr[3], fr[4], float(np.mean(fr[6]))) for k, fr in frames.items()}
    lab = label_by_axes(V, axes)
    # ---- folds
    disp = np.zeros(len(V))
    m = lab == "torso"; X = V[m]
    h = X[:, 2] - hem_top
    over = np.clip(h / 0.02, 0, 1) * np.clip(1 - h / 0.11, 0, 1) ** 1.2      # blouses over the hem rib
    ang = np.arctan2(X[:, 1], X[:, 0])
    disp[m] += over * (0.008 + 0.0035 * np.sin(ang * 11 + 2.5 * vnoise(X, 0.05, 11)))
    for sd in "LR":
        Ps, Ts, Us_, Ws_, ss, Cs, Rs = frames["sleeve" + sd]
        m = lab == "sleeve" + sd; X = V[m]
        d2 = ((X[:, None, :] - Ps[None, :, :]) ** 2).sum(2); j = d2.argmin(1)
        sl = ss[j] + ((X - Ps[j]) * Ts[j]).sum(1)
        h = ss[-1] - 0.03 - sl                                               # distance up the arm from the cuff
        nz = vnoise(X, 0.04, 21)
        stack = np.clip(h / 0.02, 0, 1) * np.clip(1 - h / (0.15 + 0.03 * nz), 0, 1) ** 1.3
        D = X - Ps[j]; a = np.arctan2((D * Ws_[j]).sum(1), (D * Us_[j]).sum(1))
        ph = 2 * np.pi * h / (0.032 + 0.005 * nz) + 1.4 * np.sin(a + 1.0) + 2.0 * vnoise(X, 0.05, 23)
        disp[m] += stack * (0.0042 * np.sin(ph) + 0.005)
        # inner elbow
        el = B.h(f"lowerarm01.{sd}")
        inner = np.clip(-Nn[m][:, 1], 0, 1)
        ez = np.exp(-(np.linalg.norm(X - el, axis=1) / 0.07) ** 2)
        disp[m] += ez * inner * 0.003 * np.sin(2 * np.pi * (X[:, 2] - el[2]) / 0.028)
        # armpit drape
        ap = np.exp(-((X[:, 2] - arm_z) / 0.06) ** 2) * np.clip(-np.sign(sh[sd][0]) * Nn[m][:, 0], 0, 1)
        disp[m] += ap * 0.003 * np.sin(2 * np.pi * (X[:, 2] + 0.6 * X[:, 1]) / 0.04)
    disp += 0.0024 * vnoise(V, 0.10, 31) + 0.0012 * vnoise(V, 0.04, 32)
    V = V + Nn * disp[:, None]
    V = laplacian(V, E, 2, 0.35)
    set_coords(H, V)
    H = decimate(H, cfg.get("decimate", 0.42))
    V = mesh_arrays(H); lab = label_by_axes(V, axes)
    # ---- ribs: hem + cuffs
    mask = B.m("torso", "pelvis") | (B.m("legL", "legR") & (B.V[:, 2] > crotch))
    hem = band_mesh("Hem", *ring_band(B, mask, (hem_top, hem_bot), 0.042 if not f else 0.038, hem_h))
    cuffs = []
    for sd in "LR":
        Ps, Ts, Us_, Ws_, ss, Cs, Rs = frames["sleeve" + sd]
        end, d = Ps[-1], Ts[-1]
        cen = np.array([end - d * 0.012 + d * 0.062 * k / 7 for k in range(8)])
        Pc, Tc, Uc, Wc, sc = polyline_frames([cen[0], cen[-1]], 8, ref=Vector((0, -1, 0)))
        Cc, Rc = sections(B.V, B.m("arm" + sd, "hand" + sd), Pc, Tc, Uc, Wc, slab=0.01)
        Rc = np.maximum(circ_smooth(Rc, 6), Rc) + 0.0135
        Rc = circ_smooth(Rc, 3)
        cc = Pc + Uc * Cc[:, :1] + Wc * Cc[:, 1:]
        cuffs.append(band_mesh(f"SleeveCuff{sd}", cc, Uc, Wc, Rc + 0.004, Rc - 0.0015))
    rib = join([hem] + cuffs, "HoodieRib")
    # ---- drawcords
    hb = bvh_of(H)
    cords = []
    for sg in (1, -1):
        x0 = cN[0] + sg * 0.035
        top = loop[np.argmin(np.abs(th - (3 * np.pi / 2 + sg * 0.32)))]
        path = []
        L = 0.25 if not f else 0.22
        for k in range(26):
            z = top[2] - 0.01 - L * k / 25
            x = x0 + sg * 0.008 * k / 25
            hpt, hn = cast(hb, (x, -0.6, z), (0, 1, 0))
            if hpt is None:
                break
            path.append(hpt - np.array([0, 0.0045, 0]))
        path = np.array(path)
        Pp, Tp, Up, Wp, sp = polyline_frames(path, 40, ref=Vector((1, 0, 0)))
        rad = np.full((40, N), 0.0032); rad[-6:] = 0.0042
        ring = rings_to_points(Pp, Up, Wp, np.zeros((40, 2)), rad)[:, ::6]
        cords.append(tube_mesh("cord", ring))
    cord = join(cords, "Drawcords")
    # ---- chest print: a decal that follows the knit surface
    import os
    logo_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "chest_logo.png")
    decal = None
    if os.path.exists(logo_path):
        w, h = (0.115, 0.026) if not f else (0.10, 0.023)
        zc = zN - (0.175 if not f else 0.16)
        A_, Bn_ = 6, 24
        bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap"); vs = {}
        for i in range(A_):
            for j in range(Bn_):
                x = cN[0] + w * (j / (Bn_ - 1) - 0.5); z = zc + h * (i / (A_ - 1) - 0.5)
                hpt, hn = cast(hb, (x, -0.6, z), (0, 1, 0))
                vs[i, j] = bm.verts.new(Vector(hpt) + Vector(hn) * 0.0015)
        for i in range(A_ - 1):
            for j in range(Bn_ - 1):
                fc = bm.faces.new((vs[i, j], vs[i, j + 1], vs[i + 1, j + 1], vs[i + 1, j]))
                for l, (a_, b_) in zip(fc.loops, ((i, j), (i, j + 1), (i + 1, j + 1), (i + 1, j))):
                    l[uvl].uv = (b_ / (Bn_ - 1), a_ / (A_ - 1))
        me = bpy.data.meshes.new("ChestPrint"); bm.to_mesh(me); bm.free()
        decal = bpy.data.objects.new("ChestPrint", me); bpy.context.scene.collection.objects.link(decal)
        mat = bpy.data.materials.get("YOLO_Print") or bpy.data.materials.new("YOLO_Print")
        mat.use_nodes = True; nt = mat.node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = bpy.data.images.load(logo_path)
        nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"]); nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
        bsdf.inputs["Roughness"].default_value = 0.7
        try:
            mat.surface_render_method = "BLENDED"
        except Exception:
            mat.blend_method = "BLEND"
    finish(B, H, "YOLO_Hoodie", lab, axes)
    finish(B, rib, "YOLO_Rib", axes_for_labels=axes)
    finish(B, cord, "YOLO_Cord", region="torso")
    extra = []
    if decal is not None:
        finish(B, decal, "YOLO_Print", region="torso"); extra.append(decal)
    return [H, rib, cord] + extra, dict(hem_bot=hem_bot, hem_top=hem_top)


def trousers(B, sex, cfg):
    f = sex == "f"
    ank = B.h("foot.L")[2]
    crotch = B.crotch
    hipz = B.h("upperleg01.L")[2]
    z_waist = hipz + (0.07 if not f else 0.075)
    z_hem = ank - 0.012                          # rests on the shoe's instep with a slight break
    legs, frames = {}, {}
    def ease(t):     # tailored: neat seat, straight leg
        return 0.008 + 0.012 * math.sin(math.pi * min(1, 0.15 + t * 1.3)) + 0.004 + 0.003 * t
    for sd in "LR":
        pts, fr = leg_tube(B, sd, z_waist + 0.03, z_hem - 0.01, ease, hang=0.075, crotch_z=crotch, min_clear=0.006,
                           z_floor=ank + 0.035)
        # the hem sits lower at the back than the front (follows the shoe), and rests on the instep
        P0 = pts[-1]
        legs[sd] = pts; frames["leg" + sd] = fr
    obs = [tube_mesh("legL", legs["L"]), tube_mesh("legR", legs["R"])]
    Tz = union_remesh("Trousers", obs)
    V = mesh_arrays(Tz)
    cut = (V[:, 2] > z_waist) | (V[:, 2] < z_hem + 0.004)
    delete_verts(Tz, cut)
    smooth_boundary(Tz)
    V = mesh_arrays(Tz); Nn = vertex_normals(Tz); E = neighbours(Tz)
    axes = {k: (fr[0], fr[1], fr[2], fr[3], fr[4], float(np.mean(fr[6]))) for k, fr in frames.items()}
    lab = label_by_axes(V, axes)
    disp = np.zeros(len(V))
    for sd in "LR":
        m = lab == "leg" + sd; X = V[m]; Nl = Nn[m]
        knee = B.h(f"lowerleg01.{sd}")[2]
        # pressed front crease: a soft ridge down the front centre of the leg, below the seat
        P, T, U, W, sS, C, R = frames["leg" + sd]
        d2 = ((X[:, None, :] - P[None, :, :]) ** 2).sum(2); j = d2.argmin(1)
        D = X - P[j]; a = np.arctan2((D * W[j]).sum(1), (D * U[j]).sum(1))
        front = np.exp(-((np.angle(np.exp(1j * (a + np.pi / 2)))) / 0.12) ** 2)
        below = np.clip((crotch - 0.05 - X[:, 2]) / 0.1, 0, 1)
        disp[m] += front * below * 0.0028
        # break: a soft horizontal fold where the hem rests on the shoe
        h = X[:, 2] - z_hem
        brk = np.clip(1 - h / 0.09, 0, 1) ** 2 * np.clip(-Nl[:, 1], 0, 1)
        disp[m] += brk * 0.004 * (0.5 + 0.5 * np.sin(2 * np.pi * h / 0.05 + 1.0))
        # behind the knee: light horizontal drape
        back = np.clip(Nl[:, 1], 0, 1) ** 2
        kz = np.exp(-((X[:, 2] - knee + 0.02) / 0.06) ** 2)
        disp[m] += kz * back * 0.0018 * np.sin(2 * np.pi * (X[:, 2] - knee) / 0.04)
    disp += 0.0010 * vnoise(V, 0.12, 41)
    V = V + Nn * disp[:, None]
    V = laplacian(V, E, 2, 0.35)
    set_coords(Tz, V)
    Tz = decimate(Tz, cfg.get("decimate", 0.45))
    V = mesh_arrays(Tz); lab = label_by_axes(V, axes)
    # turned-up hems (same cloth, gives the edge real thickness) and the waistband
    bands = []
    for sd in "LR":
        P, T, U, W, sS, C, R = frames["leg" + sd]
        k = len(P) - 1
        cen, Us, Ws, ro, ri = [], [], [], [], []
        for jj, z in enumerate(np.linspace(z_hem + 0.035, z_hem, 5)):
            c = P[k] + U[k] * C[k][0] + W[k] * C[k][1]; c = np.array([c[0], c[1], z])
            cen.append(c); Us.append(U[k]); Ws.append(W[k]); ro.append(R[k] + 0.0035); ri.append(R[k] - 0.001)
        bands.append(band_mesh(f"TrouserHem{sd}", np.array(cen), np.array(Us), np.array(Ws), np.array(ro), np.array(ri)))
    mask = B.m("torso", "pelvis") | (B.m("legL", "legR") & (B.V[:, 2] > crotch))
    wb = band_mesh("TrouserWaist", *ring_band(B, mask, (z_waist + 0.004, z_waist - 0.036), 0.014, 0.04, m=6, thick=0.004))
    belt = band_mesh("Belt", *ring_band(B, mask, (z_waist - 0.006, z_waist - 0.035), 0.020, 0.03, m=5, thick=0.0035))
    hems = join(bands + [wb], "TrouserBands")
    finish(B, Tz, "YOLO_Trouser", lab, axes)
    finish(B, hems, "YOLO_Trouser", axes_for_labels=axes)
    finish(B, belt, "YOLO_Belt", axes_for_labels=axes)
    return [Tz, hems, belt], dict(z_waist=z_waist, z_hem=z_hem)


def shirt(B, sex, cfg, z_tuck):
    f = sex == "f"
    neck = B.h("neck01"); zN = neck[2] - 0.012
    sh = {sd: B.h(f"upperarm01.{sd}") for sd in "LR"}
    arm_z = min(sh["L"][2], sh["R"][2]) - 0.11
    frames = {}
    def te(t):
        return (0.022 if not f else 0.018) - 0.012 * smooth01((t - 0.75) / 0.25)
    T_pts, fr = torso_tube(B, z_tuck - 0.05, zN + 0.008, te, hang=0.05, arm_cap=arm_z + 0.05,
                           gather=(z_tuck - 0.012, 0.05, 0.006))
    frames["torso"] = fr
    sleeves = {}
    for sd in "LR":
        pts, frs = sleeve_tube(B, sd, lambda t: 0.017 - 0.004 * t, cuff_back=0.02, gather=(0.06, 0.007), start_in=0.025)
        sleeves[sd] = pts; frames["sleeve" + sd] = frs
    P = T_pts.reshape(-1, 3)
    for sd in "LR":
        Ps, Ts, Us_, Ws_, ss, Cs, Rs = frames["sleeve" + sd]
        rmean = Rs.mean(1)
        for it in range(3):
            d2 = ((P[:, None, :] - Ps[None, :, :]) ** 2).sum(2); j = d2.argmin(1)
            D = P - Ps[j]; D -= Ts[j] * (D * Ts[j]).sum(1)[:, None]
            need = rmean[j] + 0.005 - np.linalg.norm(D, axis=1)
            m = (need > 0) & (P[:, 2] < arm_z) & (np.sign(P[:, 0]) == np.sign(Ps[0][0]))
            P[m, 0] -= np.sign(Ps[0][0]) * need[m]
    sm = B.m("torso", "armL", "armR", "neck") & (B.V[:, 2] < zN + 0.005)
    xs = np.linspace(-0.35, 0.35, 141); prof = np.full(len(xs), -1.0)
    bi = np.clip(np.round((B.V[sm][:, 0] + 0.35) / 0.005).astype(int), 0, len(xs) - 1)
    np.maximum.at(prof, bi, B.V[sm][:, 2])
    good = prof > 0; prof = np.interp(xs, xs[good], prof[good]); prof = np.minimum(lin_smooth(prof, 3.0) + 0.012, zN + 0.04)
    lim = np.interp(P[:, 0], xs, prof); hi = P[:, 2] > lim; P[hi, 2] = lim[hi]
    T_pts = P.reshape(T_pts.shape)
    obs = [tube_mesh("torso", T_pts), tube_mesh("sleeveL", sleeves["L"]), tube_mesh("sleeveR", sleeves["R"])]
    tb = bvh_of(obs[0])
    # button placket: a narrow raised strip down the centre front
    A, Bn = 40, 6
    pts = np.zeros((A, Bn, 3)); nrm = np.zeros((A, Bn, 3)); thick = np.zeros((A, Bn))
    z_top_pl = zN - 0.07
    for i in range(A):
        z = z_tuck - 0.04 + (z_top_pl - z_tuck + 0.04) * i / (A - 1)
        for j in range(Bn):
            x = 0.0175 * (2 * j / (Bn - 1) - 1)
            hpt, hn = cast(tb, (x, -0.6, z), (0, 1, 0))
            if hpt is None:
                hpt, hn = pts[i - 1, j], nrm[i - 1, j]
            pts[i, j] = hpt; nrm[i, j] = hn; thick[i, j] = 0.0022
    placket = pad_solid("placket", pts, nrm, thick)
    S_ = union_remesh("Shirt", obs + [placket], voxel=0.006)
    V = mesh_arrays(S_)
    nm = B.m("neck", "torso") & (np.abs(B.V[:, 2] - zN) < 0.012)
    q = B.V[nm][:, :2]; cN = q.mean(0); rN = circ_smooth(radial(hull2d(q), cN), 4)
    th = np.linspace(0, 2 * np.pi, N, endpoint=False)
    cut = V[:, 2] < z_tuck - 0.04
    dxy = V[:, :2] - cN; ang = np.arctan2(dxy[:, 1], dxy[:, 0]) % (2 * np.pi)
    rin = np.interp(ang, np.append(th, 2 * np.pi), np.append(rN, rN[0]))
    cut |= (np.linalg.norm(dxy, axis=1) < rin + 0.006) & (V[:, 2] > zN - 0.05)
    # open collar: a shallow V at the front
    vdepth = 0.075
    xv = np.abs(V[:, 0] - cN[0]); front = V[:, 1] < cN[1] - 0.02
    cut |= front & (V[:, 2] > zN - vdepth + xv * 1.6) & (xv < 0.06)
    for sd in "LR":
        Ps, Ts = frames["sleeve" + sd][0], frames["sleeve" + sd][1]
        end, d = Ps[-1], Ts[-1]
        cut |= ((V - end) @ d > -0.01) & (np.linalg.norm(V - end, axis=1) < 0.2)
    delete_verts(S_, cut)
    smooth_boundary(S_)
    relax_region(B, S_, lambda V: (V[:, 2] > arm_z - 0.02) & (np.abs(V[:, 0]) > 0.09), iters=16, clear=0.007)
    V = mesh_arrays(S_); Nn = vertex_normals(S_); E = neighbours(S_)
    axes = {k: (fr[0], fr[1], fr[2], fr[3], fr[4], float(np.mean(fr[6]))) for k, fr in frames.items()}
    lab = label_by_axes(V, axes)
    disp = np.zeros(len(V))
    m = lab == "torso"; X = V[m]
    h = X[:, 2] - z_tuck
    blouse = np.clip(h / 0.015, 0, 1) * np.clip(1 - h / 0.08, 0, 1)
    a = np.arctan2(X[:, 1], X[:, 0])
    disp[m] += blouse * (0.006 + 0.0025 * np.sin(a * 13 + 2 * vnoise(X, 0.05, 51)))
    # soft diagonal drape lines from the chest to the tuck at the sides
    side = np.abs(Nn[m][:, 0])
    disp[m] += side * np.clip(1 - h / 0.3, 0, 1) * 0.0018 * np.sin(2 * np.pi * (X[:, 2] + 0.8 * np.abs(X[:, 0])) / 0.06)
    for sd in "LR":
        Ps, Ts, Us_, Ws_, ss, Cs, Rs = frames["sleeve" + sd]
        m = lab == "sleeve" + sd; X = V[m]
        d2 = ((X[:, None, :] - Ps[None, :, :]) ** 2).sum(2); j = d2.argmin(1)
        sl = ss[j] + ((X - Ps[j]) * Ts[j]).sum(1); h = ss[-1] - sl
        st = np.clip(h / 0.015, 0, 1) * np.clip(1 - h / 0.1, 0, 1)
        disp[m] += st * (0.0025 * np.sin(2 * np.pi * h / 0.03 + 2 * vnoise(X, 0.05, 53)) + 0.003)
        el = B.h(f"lowerarm01.{sd}")
        ez = np.exp(-(np.linalg.norm(X - el, axis=1) / 0.06) ** 2) * np.clip(-Nn[m][:, 1], 0, 1)
        disp[m] += ez * 0.0022 * np.sin(2 * np.pi * (X[:, 2] - el[2]) / 0.025)
    disp += 0.0010 * vnoise(V, 0.09, 55)
    V = V + Nn * disp[:, None]; V = laplacian(V, E, 2, 0.35); set_coords(S_, V)
    S_ = decimate(S_, cfg.get("decimate", 0.45))
    V = mesh_arrays(S_); lab = label_by_axes(V, axes)
    # collar: stand + fall, open at the front
    Pc = np.array([[cN[0], cN[1], zN - 0.008 + 0.042 * k / 5] for k in range(6)])
    U6 = np.tile([1., 0, 0], (6, 1)); W6 = np.tile([0., 1, 0], (6, 1))
    Rst = np.array([rN + 0.009 + 0.002 * k / 5 for k in range(6)])
    stand = band_mesh("CollarStand", Pc, U6, W6, Rst + 0.0025, Rst - 0.0005)
    Pf = np.array([[cN[0], cN[1], zN + 0.036 - 0.05 * k / 5] for k in range(6)])
    Rfa = np.array([rN + 0.013 + 0.022 * (k / 5) ** 1.3 for k in range(6)])
    fall = band_mesh("CollarFall", Pf, U6, W6, Rfa + 0.0022, Rfa - 0.0002)
    collar = join([stand, fall], "Collar")
    Vc = mesh_arrays(collar)
    dxy = Vc[:, :2] - cN; ac = np.arctan2(dxy[:, 1], dxy[:, 0])
    # open front: remove a wedge that widens towards the collar points
    gap = 0.20 + 0.25 * np.clip((zN + 0.04 - Vc[:, 2]) / 0.05, 0, 1)
    delete_verts(collar, np.abs(np.angle(np.exp(1j * (ac + np.pi / 2)))) < gap)
    # barrel cuffs
    cuffs = []
    for sd in "LR":
        Ps, Ts, Us_, Ws_, ss, Cs, Rs = frames["sleeve" + sd]
        end, d = Ps[-1], Ts[-1]
        cen = np.array([end - d * 0.01 + d * 0.065 * k / 6 for k in range(7)])
        Pq, Tq, Uq, Wq, sq = polyline_frames([cen[0], cen[-1]], 7, ref=Vector((0, -1, 0)))
        Cq, Rq = sections(B.V, B.m("arm" + sd, "hand" + sd), Pq, Tq, Uq, Wq, slab=0.01)
        Rq = circ_smooth(np.maximum(circ_smooth(Rq, 6), Rq) + 0.009, 3)
        cc = Pq + Uq * Cq[:, :1] + Wq * Cq[:, 1:]
        cuffs.append(band_mesh(f"ShirtCuff{sd}", cc, Uq, Wq, Rq + 0.0028, Rq - 0.0008))
    smooth_boundary(collar, 20)
    trims = join([collar] + cuffs, "ShirtTrim")
    # buttons
    sb = bvh_of(S_); btn = []
    for z in np.arange(z_top_pl - 0.005, z_tuck, -0.085):
        hpt, hn = cast(sb, (cN[0], -0.6, z), (0, 1, 0))
        if hpt is None:
            continue
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=14, radius1=0.0055, radius2=0.005, depth=0.0022)
        me = bpy.data.meshes.new("btn"); bm.to_mesh(me); bm.free()
        o = bpy.data.objects.new("btn", me); bpy.context.scene.collection.objects.link(o)
        q = Vector((0, 0, 1)).rotation_difference(Vector(hn))
        o.matrix_world = Matrix.Translation(Vector(hpt) + Vector(hn) * 0.0012) @ q.to_matrix().to_4x4()
        btn.append(evaluated_copy(o, "b")); bpy.data.objects.remove(o, do_unlink=True)
        V_ = mesh_arrays(btn[-1]); mw = np.array(btn[-1].matrix_world)
        btn[-1].matrix_world = Matrix.Identity(4)
        set_coords(btn[-1], (np.c_[V_, np.ones(len(V_))] @ mw.T)[:, :3])
    buttons = join(btn, "Buttons")
    finish(B, S_, "YOLO_Shirt", lab, axes)
    finish(B, trims, "YOLO_Shirt", axes_for_labels=axes)
    finish(B, buttons, "YOLO_Button", region="torso")
    return [S_, trims, buttons], dict(zN=zN)


def build(S):
    B = Posed(S)
    S["posed"] = B
    sex = S["sex"]
    out = {}
    objs, info = joggers(B, sex, {})
    for o in objs:
        o["yolo_outfit"] = "casual"
    out["joggers"] = info
    objs2, info2 = hoodie(B, sex, {})
    for o in objs2:
        o["yolo_outfit"] = "casual"
    objs += objs2
    out["hoodie"] = info2
    objs3, info3 = trousers(B, sex, {})
    objs4, info4 = shirt(B, sex, {}, info3["z_waist"] - 0.01)
    for o in objs3 + objs4:
        o["yolo_outfit"] = "formal"
    objs += objs3 + objs4
    out["trousers"] = info3; out["shirt"] = info4
    S["garments"] = out
    S["garment_objs"] = objs
