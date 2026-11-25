"""Generic studio shoes used as placeholders on the try-on model until real YOLO product scans exist.

These are NOT YOLO products and the site labels them as such. They exist so the model is never barefoot and so the
fit pipeline (size, alignment, ground contact, trouser interaction) can be engineered and tested.

  python3 tools/tryon/build_shoes.py <out_dir>

Writes studio-sneaker.glb and studio-derby.glb: a RIGHT shoe, EU 42, toe towards glTF +z, heel at z = 0,
sole bottom at y = 0, centred on x.
"""
import math, os, sys
import bpy, bmesh
import numpy as np
from mathutils import Vector

OUT = sys.argv[-1] if len(sys.argv) > 1 else "."


def smooth01(x):
    x = np.clip(x, 0, 1); return x * x * (3 - 2 * x)


def mat(name, color, rough, metal=0.0, coat=0.0, sheen=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    b.inputs["Base Color"].default_value = (*color, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if coat:
        b.inputs["Coat Weight"].default_value = coat; b.inputs["Coat Roughness"].default_value = 0.08
    if sheen:
        b.inputs["Sheen Weight"].default_value = sheen
    return m


class Last:
    """foot-last outline and heights; t: 0 = heel .. 1 = toe; Blender coords, toe towards -Y, medial side +X"""
    def __init__(self, L, W, kind):
        self.L, self.W, self.kind = L, W, kind

    def edges(self, t):
        W = self.W
        t = np.asarray(t, float)
        heel = 0.69 * W / 2 * np.sqrt(np.clip(1 - ((0.16 - np.minimum(t, 0.16)) / 0.16) ** 2, 0, 1))
        body = np.interp(t, [0.16, 0.42, 0.62, 0.72, 0.80], [0.69, 0.74, 0.97, 1.0, 0.96]) * W / 2
        w = np.where(t < 0.16, heel, body)
        tipr = 0.20 if self.kind == "sneaker" else 0.24
        toe = np.sqrt(np.clip(1 - ((t - (1 - tipr)) / tipr) ** 2, 0, 1)) ** (0.85 if self.kind == "sneaker" else 1.15)
        w = np.where(t > 1 - tipr, 0.96 * W / 2 * toe, w)
        # asymmetry: medial ball bulge, toe point shifted medially, lateral waist fuller
        shift = 0.007 * smooth01((t - 0.55) / 0.4) - 0.002 * np.exp(-((t - 0.4) / 0.12) ** 2)
        xm = w * (1 + 0.04 * np.exp(-((t - 0.68) / 0.1) ** 2)) + shift
        xl = -w * (1 + 0.03 * np.exp(-((t - 0.42) / 0.12) ** 2)) + shift
        return xm, xl

    def y(self, t):
        return -np.asarray(t) * self.L


def grid_mesh(name, P, uv=None, closed_u=False):
    """P (n, m, 3) grid -> mesh"""
    n, m = P.shape[:2]
    bm = bmesh.new(); uvl = bm.loops.layers.uv.new("UVMap")
    V = [[bm.verts.new(P[i, j]) for j in range(m)] for i in range(n)]
    for i in range(n - 1):
        for j in range(m - 1 + (1 if closed_u else 0)):
            j2 = (j + 1) % m
            try:
                f = bm.faces.new((V[i][j], V[i][j2], V[i + 1][j2], V[i + 1][j]))
            except ValueError:
                continue
            if uv is not None:
                for l, (a, b) in zip(f.loops, ((i, j), (i, j2), (i + 1, j2), (i + 1, j))):
                    l[uvl].uv = uv[a, b]
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def apply_mods(ob):
    dg = bpy.context.evaluated_depsgraph_get()
    me = bpy.data.meshes.new_from_object(ob.evaluated_get(dg))
    ob.modifiers.clear(); old = ob.data; ob.data = me; bpy.data.meshes.remove(old)


def sole(last, P):
    """cupsole / leather sole: rounded-edge slab following the outline, toe spring, heel block for the derby"""
    K = 160
    tt = np.concatenate([np.linspace(0, 1, K // 2), np.linspace(1, 0, K // 2)])
    xm, xl = last.edges(tt)
    side = np.concatenate([np.ones(K // 2), -np.ones(K // 2)])
    x = np.where(side > 0, xm, xl); y = last.y(tt)
    # walk the outline as a closed loop (medial side heel->toe, lateral side toe->heel); dedupe the ends
    pts = np.stack([x, y], 1)
    keep = np.ones(K, bool); keep[K // 2] = False; keep[-1] = False
    pts = pts[keep]; tt = tt[keep]
    c = np.array([0.0, -last.L / 2])
    out = pts - c; nrm = out / np.linalg.norm(out, axis=1, keepdims=True)
    lift_f = lambda t: P.get("heel_block", 0.0) * (1 - smooth01((np.asarray(t) - 0.24) / 0.40))
    spring = P["spring"] * smooth01((tt - 0.78) / 0.22) ** 1.6 + lift_f(tt)
    th = np.interp(tt, [0, 0.3, 0.6, 1], P["sole_th"])
    rings = []
    for z_rel, inset in P["profile"]:            # (fraction of thickness, outward offset)
        z = spring + z_rel * th
        xy = pts + nrm * (P["flare"] + inset)
        rings.append(np.c_[xy, z])
    R = np.array(rings)                          # (levels, K-2, 3)
    bm = bmesh.new()
    V = [[bm.verts.new(p) for p in ring] for ring in R]
    n = len(V[0])
    for i in range(len(V) - 1):
        for j in range(n):
            bm.faces.new((V[i][j], V[i][(j + 1) % n], V[i + 1][(j + 1) % n], V[i + 1][j]))
    bm.faces.new(V[0][::-1]); bm.faces.new(V[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])
    me = bpy.data.meshes.new("Sole"); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new("Sole", me); bpy.context.scene.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = True
    ob.data.materials.append(P["m_sole"])
    if P.get("heel_block"):
        hb = P["heel_block"]
        m2 = tt < 0.25
        bm = bmesh.new()
        ring_lo = [bm.verts.new((p[0] * 0.98, p[1], 0.0)) for p in pts[m2]]
        ring_hi = [bm.verts.new((p[0] * 0.98, p[1], hb + 0.001)) for p in pts[m2]]
        k = len(ring_lo)
        for j in range(k - 1):
            bm.faces.new((ring_lo[j], ring_lo[j + 1], ring_hi[j + 1], ring_hi[j]))
        bm.faces.new((ring_lo[-1], ring_lo[0], ring_hi[0], ring_hi[-1]))
        bm.faces.new(ring_lo[::-1]); bm.faces.new(ring_hi)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        me = bpy.data.meshes.new("Heel"); bm.to_mesh(me); bm.free()
        h = bpy.data.objects.new("Heel", me); bpy.context.scene.collection.objects.link(h)
        h.data.materials.append(P["m_heel"])
        bev = h.modifiers.new("b", "BEVEL"); bev.width = 0.0015; bev.segments = 2
        apply_mods(h)
    sub = ob.modifiers.new("s", "SUBSURF"); sub.levels = 1; sub.render_levels = 1
    apply_mods(ob)
    return ob, (lambda t: np.interp(t, [0, 0.3, 0.6, 1], P["sole_th"]) + P["spring"] * smooth01((np.asarray(t) - 0.78) / 0.22) ** 1.6 + lift_f(t))


def upper(last, P, sole_top):
    n, m = 110, 64
    t = np.linspace(0.0, 1.0, n)
    phi = np.linspace(0, np.pi, m)
    xm, xl = last.edges(t)
    y = last.y(t)
    z0 = sole_top(t) - 0.004
    H = np.interp(t, P["H_t"], P["H_z"])
    Pts = np.zeros((n, m, 3)); UV = np.zeros((n, m, 2))
    for i in range(n):
        s = np.sin(phi) ** P["box"]
        x = xl[i] + (xm[i] - xl[i]) * (1 - np.cos(phi)) / 2
        # walls bulge a touch outward above the sole
        x = x + np.sign(x - (xm[i] + xl[i]) / 2) * 0.003 * np.sin(phi * 2) ** 2 * (xm[i] - xl[i] > 0.01)
        z = z0[i] + (H[i] - z0[i]) * s
        Pts[i, :, 0] = x; Pts[i, :, 1] = y[i]; Pts[i, :, 2] = z
        arc = np.concatenate([[0], np.cumsum(np.hypot(np.diff(x), np.diff(z)))])
        UV[i, :, 0] = arc; UV[i, :, 1] = -y[i]
    # close heel and toe: pull the end rings to their centre line
    for i, f in ((0, 1.0), (1, 0.55), (n - 1, 1.0), (n - 2, 0.6)):
        cx = (Pts[i, 0, 0] + Pts[i, -1, 0]) / 2
        Pts[i, :, 0] = cx + (Pts[i, :, 0] - cx) * (1 - f)
    ob = grid_mesh("Upper", Pts, UV)
    # collar opening: everything above the topline in the rear part goes
    V = np.array([v.co for v in ob.data.vertices])
    tv = -V[:, 1] / last.L
    topline = np.interp(tv, P["collar_t"], P["collar_z"])
    cx = np.interp(tv, t, (xm + xl) / 2)
    inside = (np.abs(V[:, 0] - cx) < np.interp(tv, t, (xm - xl) / 2) * 0.93)
    cut = (tv < P["throat_t"]) & (V[:, 2] > topline) & inside
    bm = bmesh.new(); bm.from_mesh(ob.data); bm.verts.ensure_lookup_table()
    bmesh.ops.delete(bm, geom=[bm.verts[i] for i in np.where(cut)[0]], context="VERTS")
    # relax the opening edge
    for _ in range(12):
        bnd = {v for e in bm.edges if e.is_boundary for v in e.verts}
        newco = {}
        for v in bnd:
            nb = [e.other_vert(v) for e in v.link_edges if e.is_boundary]
            if len(nb) == 2:
                newco[v] = (v.co * 0.5 + (nb[0].co + nb[1].co) * 0.25)
        for v, c in newco.items():
            v.co = c
    bmesh.ops.reverse_faces(bm, faces=bm.faces)       # outward normals: the leather is the outer shell
    bm.to_mesh(ob.data); bm.free()
    ob.data.materials.append(P["m_upper"]); ob.data.materials.append(P["m_lining"])
    sol = ob.modifiers.new("t", "SOLIDIFY"); sol.thickness = P["upper_th"]; sol.offset = -1
    sol.material_offset = 1; sol.material_offset_rim = 0; sol.use_rim = True
    sub = ob.modifiers.new("s", "SUBSURF"); sub.levels = 1
    apply_mods(ob)
    # padded collar: a soft roll along the opening edge
    bm = bmesh.new(); bm.from_mesh(ob.data)
    return ob


def collar_roll(ob_upper, last, P):
    """tube along the outer boundary of the opening (sneaker padding / derby rolled edge)"""
    me = ob_upper.data
    bm = bmesh.new(); bm.from_mesh(me)
    # the opening rim: boundary of the original surface is now a rim strip; take the highest ring of verts near the collar
    V = np.array([v.co for v in bm.verts]); bm.free()
    tv = -V[:, 1] / last.L
    sel = tv < P["throat_t"] + 0.02
    pts = V[sel]
    topline = np.interp(-pts[:, 1] / last.L, P["collar_t"], P["collar_z"])
    near = np.abs(pts[:, 2] - topline) < 0.004
    E = pts[near]
    if len(E) < 10:
        return None
    # order by angle around the opening centre
    c = E.mean(0)
    a = np.arctan2(E[:, 1] - c[1], E[:, 0] - c[0])
    E = E[np.argsort(a)]
    # resample to K points, smooth
    K = 90
    d = np.concatenate([[0], np.cumsum(np.linalg.norm(np.diff(np.vstack([E, E[:1]]), axis=0), axis=1))])
    s = np.linspace(0, d[-1], K, endpoint=False)
    Ec = np.vstack([E, E[:1]])
    R = np.stack([np.interp(s, d, Ec[:, k]) for k in range(3)], 1)
    for _ in range(30):
        R = 0.5 * R + 0.25 * (np.roll(R, 1, 0) + np.roll(R, -1, 0))
    m = 12
    bm = bmesh.new(); rings = []
    for i in range(K):
        tan = R[(i + 1) % K] - R[i - 1]; tan /= np.linalg.norm(tan)
        out = R[i] - c; out[2] = 0; out /= np.linalg.norm(out)
        up = np.cross(tan, out); up /= np.linalg.norm(up)
        if up[2] < 0:
            up = -up
        out = np.cross(up, tan)
        tv_ = -R[i][1] / last.L
        r = P["roll_r"] * (0.8 + 0.4 * smooth01((0.3 - tv_) / 0.3))
        a = np.linspace(0, 2 * np.pi, m, endpoint=False)
        rings.append([bm.verts.new(R[i] + r * (np.cos(q) * out * 0.8 + np.sin(q) * up)) for q in a])
    for i in range(K):
        for j in range(m):
            bm.faces.new((rings[i][j], rings[i][(j + 1) % m], rings[(i + 1) % K][(j + 1) % m], rings[(i + 1) % K][j]))
    me = bpy.data.meshes.new("Collar"); bm.to_mesh(me); bm.free()
    ob = bpy.data.objects.new("Collar", me); bpy.context.scene.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = True
    ob.data.materials.append(P["m_collar"])
    return ob


def surface_point(ob, x, y):
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new(); bm.from_mesh(ob.data); t = BVHTree.FromBMesh(bm); bm.free()
    hit = t.ray_cast(Vector((x, y, 0.3)), Vector((0, 0, -1)))
    return hit


def laces(ob_upper, last, P):
    from mathutils.bvhtree import BVHTree
    bm = bmesh.new(); bm.from_mesh(ob_upper.data); tree = BVHTree.FromBMesh(bm); bm.free()
    k = P["eyelets"]
    ts = np.linspace(P["lace_t"][0], P["lace_t"][1], k)
    pts = []
    for t in ts:
        xm, xl = last.edges(t); cx = (xm + xl) / 2
        half = P["lace_gap"] * (1 + 0.25 * (t - ts[0]) / (ts[-1] - ts[0]))
        row = []
        for sx in (1, -1):
            loc, nrm, _, _ = tree.ray_cast(Vector((cx + sx * half, last.y(t), 0.3)), Vector((0, 0, -1)))
            row.append((np.array(loc), np.array(nrm)))
        pts.append(row)
    objs = []
    bm = bmesh.new()
    def seg(a, b, r, lift):
        d = b - a; L = np.linalg.norm(d); d /= L
        ref = np.array([0, 0, 1.0]); u = np.cross(d, ref); u /= np.linalg.norm(u); w = np.cross(u, d)
        m = 8; nseg = 6; rings = []
        for i in range(nseg + 1):
            f = i / nseg
            p = a + (b - a) * f + w * lift * math.sin(math.pi * f)
            rings.append([bm.verts.new(p + r * (math.cos(q) * u + math.sin(q) * w * 0.55)) for q in np.linspace(0, 2 * np.pi, m, endpoint=False)])
        for i in range(nseg):
            for j in range(m):
                bm.faces.new((rings[i][j], rings[i][(j + 1) % m], rings[i + 1][(j + 1) % m], rings[i + 1][j]))
        bm.faces.new(rings[0][::-1]); bm.faces.new(rings[-1])
    lr = P["lace_r"]
    for i in range(k):
        a, b = pts[i][0][0] + pts[i][0][1] * 0.002, pts[i][1][0] + pts[i][1][1] * 0.002
        seg(a, b, lr, 0.0025)                                        # straight bar
        if i < k - 1:
            c = pts[i + 1][0][0] + pts[i + 1][0][1] * 0.0015
            d = pts[i + 1][1][0] + pts[i + 1][1][1] * 0.0015
            if P.get("criss"):
                seg(a, d, lr * 0.9, 0.0012); seg(b, c, lr * 0.9, 0.0012)
    me = bpy.data.meshes.new("Laces"); bm.to_mesh(me); bm.free()
    lo = bpy.data.objects.new("Laces", me); bpy.context.scene.collection.objects.link(lo)
    for p in me.polygons:
        p.use_smooth = True
    lo.data.materials.append(P["m_lace"]); objs.append(lo)
    # eyelets
    bm = bmesh.new()
    for row in pts:
        for p, nrm in row:
            r0 = bmesh.ops.create_circle(bm, segments=12, radius=P["eyelet_r"])
            q = Vector((0, 0, 1)).rotation_difference(Vector(nrm))
            vs = r0["verts"]
            for v in vs:
                v.co = q @ v.co + Vector(p) + Vector(nrm) * 0.0008
            ret = bmesh.ops.extrude_edge_only(bm, edges=list({e for v in vs for e in v.link_edges}))
            for v in ret["geom"]:
                if isinstance(v, bmesh.types.BMVert):
                    v.co = Vector(p) + (v.co - Vector(p)) * 0.55 + Vector(nrm) * 0.0012
    me = bpy.data.meshes.new("Eyelets"); bm.to_mesh(me); bm.free()
    eo = bpy.data.objects.new("Eyelets", me); bpy.context.scene.collection.objects.link(eo)
    eo.data.materials.append(P["m_eyelet"]); objs.append(eo)
    return objs


def build(kind, path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if kind == "sneaker":
        P = dict(
            L=0.288, W=0.103, sole_th=[0.030, 0.027, 0.022, 0.019], spring=0.010, flare=0.0035,
            profile=[(0.0, -0.0025), (0.06, 0.0), (0.5, 0.0012), (0.88, 0.0004), (1.0, -0.002)],
            H_t=[0.0, 0.08, 0.30, 0.45, 0.62, 0.76, 0.88, 0.97, 1.0], H_z=[0.080, 0.084, 0.088, 0.088, 0.078, 0.062, 0.052, 0.040, 0.03],
            collar_t=[0.0, 0.06, 0.18, 0.30, 0.40, 0.45], collar_z=[0.077, 0.074, 0.063, 0.066, 0.076, 0.082], throat_t=0.44,
            box=0.42, upper_th=0.0028, roll_r=0.0065, eyelets=6, lace_t=(0.46, 0.66), lace_gap=0.016, lace_r=0.0021, eyelet_r=0.0028,
            criss=True,
            m_upper=mat("Shoe_Upper", (0.86, 0.86, 0.84), 0.42, sheen=0.1),
            m_lining=mat("Shoe_Lining", (0.80, 0.79, 0.76), 0.8),
            m_collar=mat("Shoe_Collar", (0.86, 0.86, 0.84), 0.5),
            m_sole=mat("Shoe_Sole", (0.93, 0.92, 0.88), 0.55),
            m_lace=mat("Shoe_Lace", (0.92, 0.92, 0.9), 0.75),
            m_eyelet=mat("Shoe_Eyelet", (0.86, 0.86, 0.84), 0.45),
        )
    else:
        P = dict(
            L=0.296, W=0.098, sole_th=[0.012, 0.011, 0.010, 0.010], spring=0.008, flare=0.0025,
            profile=[(0.0, -0.0006), (0.15, 0.0), (0.85, 0.0), (1.0, -0.0005)], heel_block=0.024,
            H_t=[0.0, 0.08, 0.30, 0.45, 0.60, 0.74, 0.86, 0.96, 1.0], H_z=[0.096, 0.098, 0.096, 0.086, 0.066, 0.050, 0.041, 0.031, 0.021],
            collar_t=[0.0, 0.06, 0.18, 0.30, 0.40, 0.44], collar_z=[0.092, 0.088, 0.077, 0.074, 0.074, 0.078], throat_t=0.43,
            box=0.55, upper_th=0.0022, roll_r=0.0028, eyelets=5, lace_t=(0.45, 0.58), lace_gap=0.011, lace_r=0.0013, eyelet_r=0.0018,
            criss=False,
            m_upper=mat("Shoe_Upper", (0.012, 0.012, 0.012), 0.24, coat=0.6),
            m_lining=mat("Shoe_Lining", (0.42, 0.30, 0.2), 0.7),
            m_collar=mat("Shoe_Collar", (0.012, 0.012, 0.012), 0.3, coat=0.5),
            m_sole=mat("Shoe_Sole", (0.03, 0.025, 0.02), 0.5),
            m_heel=mat("Shoe_Heel", (0.035, 0.03, 0.025), 0.45),
            m_lace=mat("Shoe_Lace", (0.02, 0.02, 0.02), 0.6),
            m_eyelet=mat("Shoe_Eyelet", (0.02, 0.02, 0.02), 0.3, metal=0.0),
        )

    last = Last(P["L"], P["W"], kind)
    so, sole_top = sole(last, P)
    up = upper(last, P, sole_top)
    col = collar_roll(up, last, P)
    lc = laces(up, last, P)
    # center the shoe on x; heel at y = 0 (blender) already; sole bottom at z = 0
    objs = [o for o in bpy.data.objects if o.type == "MESH"]
    zmin = min(min(v.co.z for v in o.data.vertices) for o in objs)
    for o in objs:
        for v in o.data.vertices:
            v.co.z -= zmin
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", export_yup=True, export_apply=True, export_image_format="NONE")
    return P


if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for k, f in (("sneaker", "studio-sneaker.glb"), ("derby", "studio-derby.glb")):
        P = build(k, os.path.join(OUT, f))
        print("built", f, "length", P["L"])
