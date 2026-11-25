"""Outfit body variants (skin hidden under clothes removed), socks, GLB export and the metadata the viewer needs."""
import json, math
import bpy, bmesh
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree
import garments as G
import body as BODY


def posed_bvh(obs):
    dg = bpy.context.evaluated_depsgraph_get(); bm = bmesh.new()
    for ob in obs:
        me = ob.evaluated_get(dg).to_mesh(); tmp = bmesh.new(); tmp.from_mesh(me)
        tmp.transform(ob.matrix_world); m2 = bpy.data.meshes.new("t"); tmp.to_mesh(m2); tmp.free()
        bm.from_mesh(m2); bpy.data.meshes.remove(m2); ob.evaluated_get(dg).to_mesh_clear()
    t = BVHTree.FromBMesh(bm); bm.free(); return t


def dup(ob, name):
    new = ob.copy(); new.data = ob.data.copy(); new.name = name; new.data.name = name
    bpy.context.scene.collection.objects.link(new); return new


def covered_mask(B, garments, erode=3):
    """body vertices hidden under the garments in the idle pose (rays along the normal and a cone around it)"""
    t = posed_bvh(garments)
    V, Nn = B.V, B.Nrm
    hid = np.ones(len(V), bool)
    rng = np.random.default_rng(1)
    dirs = [np.zeros(3)] + [rng.normal(size=3) * 0.45 for _ in range(6)]
    for i in range(len(V)):
        n = Nn[i]
        for d in dirs:
            r = n + d; r /= np.linalg.norm(r)
            if r @ n < 0.3:
                continue
            hit = t.ray_cast(Vector(V[i] + n * 0.001), Vector(r), 0.18)
            if hit[0] is None:
                hid[i] = False; break
    E = G.neighbours(B.body)
    for _ in range(erode):     # keep a margin of skin near every opening
        vis = ~hid; v2 = vis.copy(); v2[E[vis[E[:, 0]], 1]] = True; v2[E[vis[E[:, 1]], 0]] = True; hid = ~v2
    return hid


def delete_faces_all_hidden(ob, hid):
    bm = bmesh.new(); bm.from_mesh(ob.data); bm.faces.ensure_lookup_table()
    kill = [f for f in bm.faces if all(hid[v.index] for v in f.verts)]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(ob.data); bm.free(); ob.data.update()


def socks(S, top=0.155):
    body = S["body"]
    so = dup(body, "Socks")
    bm = bmesh.new(); bm.from_mesh(so.data)
    kill = [f for f in bm.faces if any(v.co.z > top for v in f.verts)]
    bmesh.ops.delete(bm, geom=kill, context="FACES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context="VERTS")
    bm.to_mesh(so.data); bm.free()
    for m in list(so.modifiers):
        if m.type != "ARMATURE":
            so.modifiers.remove(m)
    # thicken outwards (every shape key) and soften toes into a sock shape
    so.data.update()
    Nn = G.vertex_normals(so); E = G.neighbours(so)
    for kb in so.data.shape_keys.key_blocks:
        V = np.array([v.co for v in kb.data])
        V = G.laplacian(V, E, 6, 0.5, mask=(V[:, 2] < 0.05).astype(float) * (np.abs(V[:, 1]) > -1))
        kb.data.foreach_set("co", (V + Nn * 0.0016).astype(np.float32).ravel())
    so.data.vertices.foreach_set("co", np.array([v.co for v in so.data.shape_keys.key_blocks["Basis"].data]).ravel())
    so.data.materials.clear()
    so.data.materials.append(bpy.data.materials.get("YOLO_Sock") or bpy.data.materials.new("YOLO_Sock"))
    so["yolo_outfit"] = "both"
    return so


def bake_ao(groups, samples=48, distance=0.18):
    """bake ambient occlusion into a vertex colour per mesh, each group with only its own outfit visible"""
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"; sc.cycles.device = "CPU"; sc.cycles.samples = samples
    w = sc.world or bpy.data.worlds.new("W"); sc.world = w
    w.light_settings.distance = distance
    allm = [o for o in bpy.data.objects if o.type == "MESH"]
    for visible, targets in groups:
        for o in allm:
            o.hide_render = o not in visible
        for o in targets:
            if "AO" not in o.data.color_attributes:
                o.data.color_attributes.new("AO", "BYTE_COLOR", "POINT")
            o.data.color_attributes.active_color = o.data.color_attributes["AO"]
            o.data.attributes.default_color_name = "AO"
        bpy.ops.object.select_all(action="DESELECT")
        for o in targets:
            o.select_set(True)
        bpy.context.view_layer.objects.active = targets[0]
        bpy.ops.object.bake(type="AO", target="VERTEX_COLORS", use_clear=True)
    for o in allm:
        o.hide_render = False


def run(S, out, meta_path):
    B = S["posed"]; body = S["body"]; rig = S["rig"]
    objs = S["garment_objs"]
    so = socks(S)
    for p in S["proxies"]:
        if not p.data.shape_keys:
            G.transfer_morphs(B, p, k=6)
    sock_hid = np.array([v.co.z < 0.150 for v in body.data.vertices])
    variants = []
    for outfit in ("casual", "formal"):
        gs = [o for o in objs if o.get("yolo_outfit") == outfit]
        hid = covered_mask(B, gs) | sock_hid
        bv = dup(body, f"Body_{outfit}"); bv["yolo_outfit"] = outfit
        delete_faces_all_hidden(bv, hid)
        variants.append(bv)
    bpy.data.objects.remove(body, do_unlink=True)
    for p in S["proxies"]:
        p["yolo_outfit"] = "both"
    # every mesh: no stray modifiers beyond the armature
    for o in bpy.data.objects:
        if o.type == "MESH":
            for m in list(o.modifiers):
                if m.type != "ARMATURE":
                    o.modifiers.remove(m)
    # ---- baked ambient occlusion, per outfit, in the bind pose (arms away from the body, so a hand resting by the
    # thigh in the idle doesn't leave a dark patch on the trousers once the arms swing)
    act = rig.animation_data.action; rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.location = (0, 0, 0); pb.rotation_quaternion = (1, 0, 0, 0); pb.scale = (1, 1, 1)
    bpy.context.view_layer.update()
    both = [o for o in bpy.data.objects if o.type == "MESH" and o.get("yolo_outfit") == "both"]
    groups = []
    for outfit in ("casual", "formal"):
        mine = [o for o in bpy.data.objects if o.type == "MESH" and o.get("yolo_outfit") == outfit]
        targets = mine + ([so] if outfit == "casual" else [])
        groups.append((mine + both, targets))
    groups.append(([o for o in bpy.data.objects if o.type == "MESH" and o.get("yolo_outfit") in ("casual", "both")],
                   [p for p in S["proxies"] if p.name.startswith(("Hair",))]))
    bake_ao(groups)
    import anim
    anim.use_action(rig, "Idle", 1)
    # ---- metadata (glTF coordinates: x, z, -y)
    info = S["info"]; J = info["joints"]
    g = lambda v: [round(v[0], 5), round(v[2], 5), round(-v[1], 5)]
    base = J["base"]
    heights = {}
    sh = BODY.shapes(S["sex"]); idx = info["base_index"]
    import mh
    for k, v in sh.items():
        vb = mh.to_blender(v)[idx]
        heights[k] = round(float(vb[:, 2].max() - vb[:, 2].min()), 4)
    joints = {}
    for k in J:
        if k == "base":
            continue
        joints[k] = {n: g(np.array(J[k][n][0]) - np.array(base[n][0])) for n in base}
    R = S["rigx"]
    foot = {sd: {k: g(list(v)) for k, v in R.foot[sd].items() if k != "dir"} for sd in "LR"}
    meta = {
        "height_m": heights["base"], "heights": heights,
        "morph_joints": joints,
        "foot": foot,
        "garments": {k: {a: round(float(b), 4) for a, b in v.items()} for k, v in S["garments"].items()},
        **S["anim_meta"],
    }
    if meta_path:
        allm = {}
        try:
            allm = json.load(open(meta_path))
        except Exception:
            pass
        allm[S["sex"].upper()] = meta
        json.dump(allm, open(meta_path, "w"), indent=1)
    for o in bpy.data.objects:
        if o.type == "MESH":
            V = G.mesh_arrays(o)
            if not np.isfinite(V).all():
                print("NAN in", o.name, (~np.isfinite(V)).sum())
            if o.data.shape_keys:
                for kb in o.data.shape_keys.key_blocks:
                    K = np.array([v.co for v in kb.data])
                    if not np.isfinite(K).all():
                        print("NAN key", o.name, kb.name)
    for o in bpy.data.objects:
        for k in list(o.keys()):
            v = o[k]
            if isinstance(v, float) and not math.isfinite(v):
                print("NAN prop", o.name, k); del o[k]
    for mname in ("YOLO_Hoodie",):          # old texture no longer matches the new garment UVs
        m = bpy.data.materials.get(mname)
        if m and m.use_nodes:
            for n in list(m.node_tree.nodes):
                if n.type == "TEX_IMAGE":
                    m.node_tree.nodes.remove(n)
    # ---- export
    bpy.ops.object.select_all(action="DESELECT")
    for a in list(bpy.data.actions):
        a.use_fake_user = True
    bpy.ops.export_scene.gltf(filepath=out, export_format="GLB", use_selection=False, export_apply=False,
                              export_skins=True, export_morph=True, export_morph_normal=False, export_animations=True,
                              export_animation_mode="ACTIONS", export_anim_single_armature=True, export_force_sampling=True,
                              export_frame_range=False, export_image_format="WEBP", export_extras=True,
                              export_influence_nb=4, export_def_bones=False, export_yup=True,
                              export_vertex_color="ACTIVE", export_active_vertex_color_when_no_material=True)
