"""Build /assets/models/walker/walker-{m,f}.glb.

  MPFB_DATA=.../mpfb2/src/mpfb/data python3 tools/tryon/build_walker.py m [--preview out.png] [--out file.glb]

Inputs: the previous walker-{m,f}.glb decoded to plain glTF (for the skin / eye / hair textures and the hair,
brow, lash and eye meshes), the MakeHuman base mesh and targets, and the generators in this folder.
"""
import os, sys, json, argparse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy
import numpy as np
import body

ap = argparse.ArgumentParser()
ap.add_argument("sex", choices=["m", "f"])
ap.add_argument("--src", required=True, help="decoded old walker GLB (materials + head proxies)")
ap.add_argument("--out", default=None)
ap.add_argument("--meta", default=None)
ap.add_argument("--preview", default=None)
ap.add_argument("--stage", default="all")
a = ap.parse_args(sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:])

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=a.src)
old = {o.name.split(".")[0]: o for o in bpy.data.objects}
old_rig = next(o for o in bpy.data.objects if o.type == "ARMATURE")
# old meshes in bind pose
for o in bpy.data.objects:
    if o.type == "MESH":
        for m in o.modifiers:
            m.show_viewport = False
old_rig.animation_data_clear() if old_rig.animation_data else None

new_body, rig, info = body.build_body(a.sex, "Body")
skin_mat = old["Body_casual"].material_slots[0].material
new_body.data.materials.append(skin_mat)
proxies = [old[n] for n in ("Hair", "Brows", "Lashes", "Eyes") if n in old]
body.refit_proxies(old["Body_casual"], new_body, info, proxies)
for p in proxies:
    mw = p.matrix_world.copy()
    p.parent = rig; p.matrix_world = mw
    for m in list(p.modifiers):
        p.modifiers.remove(m)
    mod = p.modifiers.new("Armature", "ARMATURE"); mod.object = rig
# drop everything old except the proxies
for o in list(bpy.data.objects):
    if o not in proxies and o not in (new_body, rig):
        bpy.data.objects.remove(o, do_unlink=True)

STATE = dict(body=new_body, rig=rig, info=info, proxies=proxies, sex=a.sex, args=a)

if a.stage in ("all", "anim", "garments"):
    import anim
    anim.build(STATE)
if a.stage in ("all", "garments"):
    import garments
    garments.build(STATE)

if a.preview:
    sys.path.insert(0, os.environ.get("PREVIEW_HELPER", "."))
    from brender import preview
    base = a.preview[:-4]
    fr = int(os.environ.get("PREVIEW_FRAME", "1"))
    show = os.environ.get("PREVIEW_OUTFIT")
    if show:
        for o in bpy.data.objects:
            if "yolo_outfit" in o.keys():
                o.hide_render = o["yolo_outfit"] not in (show, "both")
    if os.environ.get("PREVIEW_ACTION"):
        import anim; anim.use_action(rig, os.environ["PREVIEW_ACTION"], fr)
    preview(base + "-front.png", target=(0, 0, 0.9), dist=4.6, az=0, el=6, frame=fr)
    preview(base + "-side.png", target=(0, 0, 0.9), dist=4.6, az=90, el=6, frame=fr)
    preview(base + "-34.png", target=(0, 0, 0.9), dist=4.6, az=35, el=6, frame=fr)
    if os.environ.get("PREVIEW_FEET"):
        preview(base + "-feet.png", target=(0, -0.05, 0.15), dist=1.4, az=30, el=12, frame=fr)
    import json as _j
    for v in _j.loads(os.environ.get("PREVIEW_EXTRA", "[]")):
        if "action" in v:
            import anim; anim.use_action(rig, v["action"], v.get("frame", 1))
        preview(base + "-" + v["name"] + ".png", target=tuple(v.get("target", (0, 0, 0.9))), dist=v.get("dist", 4.6),
                az=v.get("az", 0), el=v.get("el", 6), frame=v.get("frame", 1), res=tuple(v.get("res", (520, 720))))
    if os.environ.get("PREVIEW_FACE"):
        preview(base + "-face.png", target=(0, 0, 1.6), dist=1.0, az=15, el=2, frame=fr)

if a.out:
    import export
    export.run(STATE, a.out, a.meta)
