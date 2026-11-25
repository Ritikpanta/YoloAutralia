"""Blender side of the body build: mesh + rig + weights + morph shape keys + head proxies.

Run inside Blender's Python (bpy). See tools/tryon/README.md.
"""
import math
import bpy, bmesh
import numpy as np
from mathutils import Vector, kdtree
import mh

GROUND = 0.0  # set after the base shape is built (feet on z = 0)

PARAMS = {
    # A young adult with fashion-model proportions; the 'race' mix only nudges the face shape.
    "m": dict(gender=1.0, age=0.5, muscle=0.62, weight=0.5, proportions=1.0, height=0.5, cupsize=0.5, firmness=0.5,
              race=dict(caucasian=0.7, asian=0.15, african=0.15)),
    "f": dict(gender=0.0, age=0.5, muscle=0.5, weight=0.46, proportions=1.0, height=0.5, cupsize=0.48, firmness=0.6,
              race=dict(caucasian=0.7, asian=0.15, african=0.15)),
}
# morph extremes exported as shape keys (blender metres), each = shape(param) - shape(base)
MORPHS = {"weight_lo": ("weight", 0.0), "weight_hi": ("weight", 1.0), "height_lo": ("height", 0.0), "height_hi": ("height", 1.0),
          "muscle_hi": ("muscle", 1.0)}


def shapes(sex):
    p = PARAMS[sex]
    out = {"base": mh.shape(p)}
    for k, (name, val) in MORPHS.items():
        out[k] = mh.shape(dict(p, **{name: val}))
    return out


def build_body(sex, name="Body"):
    """-> (mesh object, armature object, info dict)"""
    sh = shapes(sex)
    idx, faces, fuv = mh.body_faces()
    vb = {k: mh.to_blender(v) for k, v in sh.items()}
    off = -vb["base"][idx][:, 2].min()
    for k in vb:
        vb[k][:, 2] += off
    me = bpy.data.meshes.new(name)
    me.from_pydata(vb["base"][idx].tolist(), [], faces)
    uvl = me.uv_layers.new(name="UVMap")
    buv = mh.base()["uv"]
    li = 0
    for f, tuv in zip(me.polygons, fuv):
        for k, li2 in enumerate(f.loop_indices):
            uvl.data[li2].uv = buv[tuv[k]]
    me.validate(); me.update()
    for p in me.polygons:
        p.use_smooth = True
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    # shape keys
    ob.shape_key_add(name="Basis", from_mix=False)
    for k in MORPHS:
        sk = ob.shape_key_add(name=k, from_mix=False)
        sk.data.foreach_set("co", vb[k][idx].astype(np.float32).ravel())
        sk.slider_min, sk.slider_max = 0, 1.5
        sk.value = 0.0
    # armature
    J = {k: {n: (mh.to_blender(h) + [0, 0, off], mh.to_blender(t) + [0, 0, off]) for n, (h, t) in mh.joints(v).items()} for k, v in sh.items()}
    arm = bpy.data.armatures.new(name + "_rig")
    ao = bpy.data.objects.new(name + "_rig", arm)
    bpy.context.scene.collection.objects.link(ao)
    bpy.context.view_layer.objects.active = ao
    bpy.ops.object.mode_set(mode="EDIT")
    R = mh.rig()
    for n, b in R.items():
        eb = arm.edit_bones.new(n)
        eb.head, eb.tail = Vector(J["base"][n][0]), Vector(J["base"][n][1])
        if (eb.tail - eb.head).length < 1e-4:
            eb.tail = eb.head + Vector((0, 0, 0.01))
        eb.roll = b.get("roll", 0.0)
    for n, b in R.items():
        if b["parent"]:
            arm.edit_bones[n].parent = arm.edit_bones[b["parent"]]
            arm.edit_bones[n].use_connect = False
    bpy.ops.object.mode_set(mode="OBJECT")
    # weights (base-mesh vertex indices -> our compact indices)
    remap = {int(o): i for i, o in enumerate(idx)}
    for bone, lst in mh.weights().items():
        vg = ob.vertex_groups.new(name=bone)
        for vi, w in lst:
            j = remap.get(int(vi))
            if j is not None and w > 1e-4:
                vg.add([j], float(w), "REPLACE")
    ob.parent = ao
    mod = ob.modifiers.new("Armature", "ARMATURE"); mod.object = ao
    info = {
        "ground_offset": off,
        "joints": {k: {n: [list(map(float, h)), list(map(float, t))] for n, (h, t) in d.items()} for k, d in J.items()},
        "base_index": idx,
    }
    return ob, ao, info


def body_correspondence(old_body, new_body, info):
    """Old GLB body (base-mesh topology, partly culled) -> per-old-vertex index into new body, matched by UV."""
    idx = info["base_index"]
    # new: uv -> compact vertex
    me = new_body.data
    kd = kdtree.KDTree(len(me.loops))
    lv = []
    for i, l in enumerate(me.loops):
        uv = me.uv_layers[0].data[i].uv
        kd.insert((uv[0], uv[1], 0), i); lv.append(l.vertex_index)
    kd.balance()
    om = old_body.data
    m = np.full(len(om.vertices), -1)
    for i, l in enumerate(om.loops):
        uv = om.uv_layers[0].data[i].uv
        co, j, d = kd.find((uv[0], uv[1], 0))
        if d < 1e-4:
            m[l.vertex_index] = lv[j]
    return m


def refit_proxies(old_body, new_body, info, proxies):
    """Move head proxies (hair, brows, lashes, eyes) by the smooth displacement old body -> new body."""
    m = body_correspondence(old_body, new_body, info)
    ov = np.array([v.co for v in old_body.data.vertices])
    nv = np.array([v.co for v in new_body.data.vertices])
    ok = m >= 0
    src = ov[ok]; disp = nv[m[ok]] - src
    kd = kdtree.KDTree(len(src))
    for i, p in enumerate(src):
        kd.insert(p, i)
    kd.balance()
    for ob in proxies:
        rigid = ob.name.lower().startswith("eyes")
        pts = [ob.matrix_world @ v.co for v in ob.data.vertices]
        if rigid:   # eyes: one rigid shift per eye (left/right by x)
            for side in (1, -1):
                sel = [i for i, p in enumerate(pts) if p.x * side > 0]
                if not sel:
                    continue
                c = sum((pts[i] for i in sel), Vector()) / len(sel)
                d = np.mean([disp[j] for (_, j, _) in kd.find_n(c, 12)], 0)
                for i in sel:
                    ob.data.vertices[i].co += Vector(d)
            continue
        for i, p in enumerate(pts):
            near = kd.find_n(p, 8)
            w = np.array([1 / (d + 1e-3) for (_, _, d) in near]); w /= w.sum()
            d = (disp[[j for (_, j, _) in near]] * w[:, None]).sum(0)
            ob.data.vertices[i].co += Vector(d)
    return m
