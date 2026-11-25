"""Idle (relaxed contrapposto stance + breathing) and Walk (heel-to-toe, foot-locked) for the MPFB default rig.

Everything is solved here, frame by frame, in armature space, and keyed as plain FK rotations (+ root location):
  * legs: analytic two-bone IK (hip -> knee -> ankle), knee pointing over the toes;
  * feet: rigid roll about the heel contact point (heel strike), flat, then about the ball (heel off -> toe off);
    the planted contact point moves backwards at exactly the walk speed, so on a floor that moves at that speed
    the foot is locked to the ground;
  * pelvis: vertical bob (low at double support), list, lateral shift over the stance foot, yaw with the swing leg;
  * spine / head: counter-rotation, head kept level;
  * arms: hang relaxed beside the body, swing opposite the legs, elbow flexing more on the forward swing;
  * fingers: relaxed natural curl, more towards the little finger.
"""
import math
import bpy
import numpy as np
from mathutils import Matrix, Vector, Quaternion

FPS = 30
UP, FWD = Vector((0, 0, 1)), Vector((0, -1, 0))   # model faces -Y; +X is the model's left


def _rot_about(point, q):
    return Matrix.Translation(point) @ q.to_matrix().to_4x4() @ Matrix.Translation(-point)


def _q(axis, deg):
    return Quaternion(Vector(axis).normalized(), math.radians(deg))


def smooth(x):
    x = min(1.0, max(0.0, x)); return x * x * (3 - 2 * x)


def minjerk(x):
    x = min(1.0, max(0.0, x)); return x ** 3 * (10 - 15 * x + 6 * x * x)


class Rig:
    def __init__(self, ao, body):
        self.ao = ao
        self.bones = ao.data.bones
        self.order = []
        def walk(b):
            self.order.append(b.name)
            for c in b.children:
                walk(c)
        for b in self.bones:
            if b.parent is None:
                walk(b)
        self.rest = {b.name: b.matrix_local.copy() for b in self.bones}
        self.parent = {b.name: (b.parent.name if b.parent else None) for b in self.bones}
        self.children = {b.name: [c.name for c in b.children] for b in self.bones}
        # foot geometry (rest), from the mesh: heel / ball / toe-tip contact points per side
        V = np.array([v.co for v in body.data.vertices])
        self.foot = {}
        for sd, sg in (("L", 1), ("R", -1)):
            a = Vector(self.rest[f"foot.{sd}"].translation)
            m = (V[:, 0] * sg > 0.04) & (V[:, 2] < 0.035)
            P = V[m]
            heel = Vector((a.x, P[:, 1].max() - 0.012, 0.0))
            ball = Vector(self.rest[f"toe1-1.{sd}"].translation); ball = Vector(((ball.x + a.x) / 2, ball.y + 0.012, 0.0))
            tip = Vector((a.x, P[:, 1].min(), 0.0))
            head = a.copy()
            dirv = (Vector(self.rest[f"foot.{sd}"].col[1][:3])); dirv.z = 0; dirv.normalize()
            self.foot[sd] = dict(ankle=head, heel=heel, ball=ball, tip=tip, dir=dirv)
        self.legl = {sd: ((self.head(f"lowerleg01.{sd}") - self.head(f"upperleg01.{sd}")).length,
                          (self.head(f"foot.{sd}") - self.head(f"lowerleg01.{sd}")).length) for sd in "LR"}

    def head(self, n):
        return Vector(self.rest[n].translation)

    def fk(self, extra_world, absolute=None):
        """extra_world: bone -> Quaternion rotation applied in world axes about the bone's (posed) head.
        absolute: bone -> armature-space 4x4 (overrides). -> dict of armature-space pose matrices."""
        absolute = absolute or {}
        P = {}
        for n in self.order:
            p = self.parent[n]
            base = (P[p] @ self.rest[p].inverted() @ self.rest[n]) if p else self.rest[n].copy()
            if n in absolute:
                P[n] = absolute[n]
                continue
            if n in extra_world:
                h = base.translation.copy()
                base = _rot_about(h, extra_world[n]) @ base
            P[n] = base
        return P

    def basis(self, P):
        out = {}
        for n in self.order:
            p = self.parent[n]
            if p:
                rel = self.rest[p].inverted() @ self.rest[n]
                out[n] = rel.inverted() @ P[p].inverted() @ P[n]
            else:
                out[n] = self.rest[n].inverted() @ P[n]
        return out


def frame_rot(a1, b1, a2, b2):
    """rotation taking orthonormal frame built from (a1, b1) to the one from (a2, b2); a = primary axis"""
    def fr(a, b):
        x = a.normalized(); z = x.cross(b).normalized(); y = z.cross(x)
        return Matrix((x, y, z)).transposed()
    return (fr(a2, b2) @ fr(a1, b1).inverted()).to_quaternion()


def leg_ik(R, P, sd, ankle_t, foot_q, pole_dir, toe_q=None):
    """Set thigh/shin/foot so the ankle sits at ankle_t, the knee points along pole_dir, foot rotated by foot_q (world)."""
    rel = lambda c, p: R.rest[p].inverted() @ R.rest[c]
    # hip head from posed pelvis
    hip_n = f"upperleg01.{sd}"
    hip_m = P[R.parent[hip_n]] @ rel(hip_n, R.parent[hip_n])
    H = hip_m.translation.copy()
    l1, l2 = R.legl[sd]
    d = ankle_t - H; dist = min(d.length, (l1 + l2) * 0.9995)
    dn = d.normalized()
    cosA = (l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist)
    A = math.acos(max(-1, min(1, cosA)))
    side = pole_dir - dn * pole_dir.dot(dn); side.normalize()
    K = H + (dn * math.cos(A) + side * math.sin(A)) * l1
    Aa = H + dn * dist
    # rest frames
    Hr, Kr, Ar = R.head(hip_n), R.head(f"lowerleg01.{sd}"), R.head(f"foot.{sd}")
    rest_pole = R.foot[sd]["dir"]
    q_th = frame_rot(Kr - Hr, rest_pole, K - H, pole_dir)
    q_sh = frame_rot(Ar - Kr, rest_pole, Aa - K, pole_dir)
    def setb(n, q, head):
        r = R.rest[n].to_3x3()
        M = (q.to_matrix() @ r).to_4x4(); M.translation = head; P[n] = M
    setb(hip_n, q_th, H)
    # upperleg02 rigidly follows
    n2 = f"upperleg02.{sd}"; P[n2] = P[hip_n] @ rel(n2, hip_n)
    setb(f"lowerleg01.{sd}", q_sh, K)
    n4 = f"lowerleg02.{sd}"; P[n4] = P[f"lowerleg01.{sd}"] @ rel(n4, f"lowerleg01.{sd}")
    fhead = (P[n4] @ rel(f"foot.{sd}", n4)).translation.copy()
    setb(f"foot.{sd}", foot_q, fhead)
    # toes follow the foot, optionally bent (world rotation about each toe's head)
    for c in R.order:
        if c.startswith("toe") and c.endswith("." + sd):
            p = R.parent[c]; M = P[p] @ rel(c, p)
            if toe_q is not None and c.split("-")[1].startswith("1"):
                M = _rot_about(M.translation.copy(), toe_q) @ M
            P[c] = M
    return P


# ------------------------------------------------------------------ poses
def upper_body(R, sex, t_breath=0.0, swing=0.0, walk=0.0, sway=0.0):
    """world-axis rotations for spine/arms/head. swing in [-1, 1]: +1 = left arm forward."""
    f = sex == "f"
    X, Y, Z = Vector((1, 0, 0)), Vector((0, 1, 0)), Vector((0, 0, 1))
    e = {}
    br = math.sin(t_breath * 2 * math.pi)
    # breathing: chest lifts and opens slightly; shoulders rise a touch
    e["spine02"] = _q(X, -0.5 * br - 1.0 * walk)
    e["spine01"] = _q(X, -0.4 * br)
    e["neck01"] = _q(X, 0.6 * br + 2.0)
    e["head"] = _q(X, -1.5)
    for sd, sg in (("L", 1), ("R", -1)):
        # relaxed, slightly dropped shoulders
        e[f"clavicle.{sd}"] = _q(Y, sg * (3.0 + 0.4 * br))
        arm_sw = swing * sg            # + = this arm forward
        # arm hangs: adduct from the A-pose, small forward flexion; swing about the lateral axis
        add = 47.0 if not f else 49.0
        e[f"upperarm01.{sd}"] = _q(X, -(6 + 15 * arm_sw)) @ _q(Y, sg * add)
        # elbow: relaxed flexion, more when the arm is forward; forearm turned so the palm faces the thigh
        e[f"lowerarm01.{sd}"] = _q(X, -(14 + 10 * max(0, arm_sw) + 4 * walk))
        e[f"wrist.{sd}"] = _q(Y, -sg * 4)
    return e


def finger_curl(R, P, sd, amt=1.0):
    """relaxed hand: curl each finger joint about its own flex axis (bone local X)."""
    rel = lambda c, p: R.rest[p].inverted() @ R.rest[c]
    curl = {2: (18, 30, 18), 3: (24, 36, 20), 4: (30, 40, 22), 5: (34, 44, 24)}
    for c in R.order:
        if not c.endswith("." + sd):
            continue
        if c.startswith("finger") or c.startswith("metacarpal"):
            p = R.parent[c]
            M = P[p] @ rel(c, p)
            if c.startswith("finger") and c[8] == "1" and c[6] in "245":
                # close the spread: turn the proximal phalanx part of the way towards the middle finger
                mid = R.rest[f"finger3-1.{sd}"]; me_ = R.rest[c]
                d_m = (P[R.parent[f"finger3-1.{sd}"]] @ R.rest[R.parent[f"finger3-1.{sd}"]].inverted() @ mid).to_3x3() @ Vector((0, 1, 0))
                d_f = M.to_3x3() @ Vector((0, 1, 0))
                ax = d_f.cross(d_m)
                if ax.length > 1e-6:
                    ang = d_f.angle(d_m) * 0.7
                    M = _rot_about(M.translation.copy(), Quaternion(ax.normalized(), ang)) @ M
            if c.startswith("finger"):
                fi, j = int(c[6]), int(c[8])
                if fi == 1:
                    ang = (4, 14, 16)[j - 1]
                else:
                    ang = curl[fi][j - 1]
                axis = M.to_3x3() @ Vector((1, 0, 0))
                M = _rot_about(M.translation.copy(), Quaternion(axis, math.radians(ang * amt))) @ M
            P[c] = M
    return P


def reproject(R, P, names):
    """after editing some bones' matrices, re-propagate their unchanged descendants"""
    rel = lambda c, p: R.rest[p].inverted() @ R.rest[c]
    return P


def solve_pose(R, sex, root_off, root_q, ub, legs, fingers=1.0):
    extra = dict(ub)
    extra["root"] = root_q
    P = R.fk(extra)
    # root translation
    T = Matrix.Translation(root_off)
    for n in R.order:
        P[n] = T @ P[n]
    for sd, (ank, fq, pole, tq) in legs.items():
        P = leg_ik(R, P, sd, ank, fq, pole, tq)
    for sd in "LR":
        P = finger_curl(R, P, sd, fingers)
    return P


def stance(R, sex):
    """idle foot placement: ankles a natural width apart, toes out a little."""
    f = sex == "f"
    half = 0.085 if f else 0.105
    yaw = 6.0 if f else 8.0
    out = {}
    for sd, sg in (("L", 1), ("R", -1)):
        ft = R.foot[sd]
        a = ft["ankle"].copy(); a.x = sg * half
        q = _q((0, 0, 1), sg * yaw) @ ft["dir"].rotation_difference(FWD)
        out[sd] = (a, q)
    return out


def key_action(R, name, frames):
    ao = R.ao
    act = bpy.data.actions.new(name)
    ao.animation_data_create(); ao.animation_data.action = act
    for pb in ao.pose.bones:
        pb.rotation_mode = "QUATERNION"
    for fi, P in enumerate(frames):
        B = R.basis(P)
        for n, M in B.items():
            pb = ao.pose.bones[n]
            loc, rot, _ = M.decompose()
            pb.rotation_quaternion = rot
            pb.keyframe_insert("rotation_quaternion", frame=fi + 1)
            if n == "root":
                pb.location = loc
                pb.keyframe_insert("location", frame=fi + 1)
    # keep quaternion continuity + linear-ish interpolation for cyclic playback
    return act


def use_action(ao, name, frame=1):
    act = bpy.data.actions[name]
    ao.animation_data.action = act
    if hasattr(ao.animation_data, "action_slot") and act.slots:
        ao.animation_data.action_slot = act.slots[0]
    bpy.context.scene.frame_set(frame)


def build(S):
    R = Rig(S["rig"], S["body"])
    sex = S["sex"]; f = sex == "f"
    st = stance(R, sex)
    meta = {}
    root_h = R.head("root")
    # ---------------- Idle: 9 s, two breaths, one slow weight sway
    n = 9 * FPS
    frames = []
    for i in range(n):
        t = i / n
        sway = math.sin(2 * math.pi * t)
        br = (2 * t) % 1.0
        # weight mostly on the right leg; hips shift over it, the free (left) knee softens
        shift = -0.014 + 0.003 * sway
        root_off = Vector((shift, 0.0, -0.012 - 0.002 * math.sin(4 * math.pi * t)))
        root_q = _q((0, 1, 0), 1.6 + 0.4 * sway) @ _q((0, 0, 1), 1.2)
        ub = upper_body(R, sex, t_breath=br)
        ub["spine03"] = _q((0, 1, 0), -2.4 - 0.5 * sway)     # shoulders counter-tilt over the hips
        ub["neck02"] = _q((0, 1, 0), -0.8)
        legs = {}
        for sd, sg in (("L", 1), ("R", -1)):
            a, q = st[sd]
            pole = (q @ FWD); pole.z = 0; pole.normalize()
            a2 = a.copy()
            if sd == "L":   # free leg: heel a little forward and the foot slightly turned out
                a2.y -= 0.02; q = _q((0, 0, 1), 3) @ q
            legs[sd] = (a2, q, pole, None)
        frames.append(solve_pose(R, sex, root_off, root_q, ub, legs))
    key_action(R, "Idle", frames)
    S["idle_rest_frame"] = frames[0]
    # ---------------- Walk
    nW = 32
    T = nW / FPS
    leg_len = sum(R.legl["L"])
    stride = (1.30 if not f else 1.18) * leg_len / 0.9     # one full cycle per foot
    v = stride / T
    width = 0.085 if not f else 0.05
    yaw0 = 6.0 if not f else 4.0
    # phases (fraction of the cycle, measured from this foot's heel strike)
    FF, HO, TO = 0.10, 0.40, 0.62
    PIT_HS, PIT_TO = 18.0, -38.0
    frames = []
    hs_heel_y = -0.36 * stride / 1.3       # heel lands this far in front of the hip
    def foot_state(sd, ph):
        ft = R.foot[sd]; sg = 1 if sd == "L" else -1
        yawq = _q((0, 0, 1), sg * yaw0) @ ft["dir"].rotation_difference(FWD)
        lat = (yawq @ Vector((1, 0, 0)))  # pitch axis (model's left)
        rel_heel = yawq @ (ft["heel"] - ft["ankle"])
        rel_ball = yawq @ (ft["ball"] - ft["ankle"])
        rel_tip = yawq @ (ft["tip"] - ft["ankle"])
        heel_hs = Vector((sg * width, hs_heel_y, 0))
        def at_heel(hp, pit):
            q = _q(lat, pit) @ yawq; return hp - (_q(lat, pit) @ rel_heel), q
        def at_ball(bp, pit):
            q = _q(lat, pit) @ yawq; return bp - (_q(lat, pit) @ rel_ball), q
        toe_q = None
        if ph < TO:
            heel_now = heel_hs + Vector((0, v * ph * T, 0))
            if ph < FF:
                pit = PIT_HS * (1 - smooth(ph / FF)); ank, q = at_heel(heel_now, pit)
            elif ph < HO:
                ank, q = at_heel(heel_now, 0.0)
            else:
                heel_ho = heel_hs + Vector((0, v * HO * T, 0))
                ball_fixed = heel_ho - rel_heel + rel_ball
                ball_now = ball_fixed + Vector((0, v * (ph - HO) * T, 0))
                s = (ph - HO) / (TO - HO)
                pit = PIT_TO * (s ** 1.4)
                ank, q = at_ball(ball_now, pit)
                toe_q = _q(lat, -pit)          # toes stay flat on the floor while the heel lifts
            return ank, q, toe_q
        # swing: from toe-off to the next heel strike
        s = (ph - TO) / (1 - TO)
        heel_ho = heel_hs + Vector((0, v * HO * T, 0))
        ball_to = heel_ho - rel_heel + rel_ball + Vector((0, v * (TO - HO) * T, 0))
        a0, q0 = at_ball(ball_to, PIT_TO)
        a1, q1 = at_heel(heel_hs, PIT_HS)
        e = minjerk(s)
        ank = a0.lerp(a1, e)
        lift = (0.075 if not f else 0.065) * math.sin(math.pi * min(1, s * 1.15)) ** 1.3
        ank.z += lift
        pit = PIT_TO + (PIT_HS - PIT_TO) * smooth(s * 1.1)
        q = _q(lat, pit) @ yawq
        # toe clearance
        tz = (ank + _q(lat, pit) @ rel_tip).z
        if tz < 0.012 and 0.15 < s < 0.9:
            ank.z += 0.012 - tz
        toe_q = _q(lat, -PIT_TO * (1 - smooth(s * 3)))
        return ank, q, toe_q
    raw = []
    for i in range(nW):
        ph = i / nW
        L = foot_state("L", ph); Rr = foot_state("R", (ph + 0.5) % 1)
        raw.append((L, Rr))
    # pelvis height: bob (low at double support), clamped so both legs can reach
    zs = []
    for i in range(nW):
        ph = i / nW
        z = -0.018 - 0.016 * math.cos(4 * math.pi * (ph - 0.25))  # high at mid-stance
        zs.append(z)
    def reach_ok(i, z):
        P0 = R.fk({}); off = Vector((0, 0, z))
        for sd, st_ in zip("LR", raw[i]):
            H = R.head(f"upperleg01.{sd}") + off
            if (st_[0] - H).length > sum(R.legl[sd]) * 0.996:
                return False
        return True
    for i in range(nW):
        while not reach_ok(i, zs[i]):
            zs[i] -= 0.002
    for _ in range(3):   # smooth, then re-clamp
        zs = [min(zs[i], (zs[i - 1] + 2 * zs[i] + zs[(i + 1) % nW]) / 4) for i in range(nW)]
    for i in range(nW):
        ph = i / nW
        c = math.cos(2 * math.pi * ph)          # +1 at left heel strike
        sl = math.sin(2 * math.pi * ph)         # + while left foot is in stance (first half)
        root_off = Vector((0.016 * sl if not f else 0.02 * sl, 0, zs[i]))
        list_deg = -(2.5 if not f else 4.0) * sl          # swing-side hip drops
        yaw = (4.0 if not f else 3.0) * c               # left hip forward at left heel strike
        root_q = _q((0, 0, 1), -yaw) @ _q((0, 1, 0), list_deg) @ _q((1, 0, 0), 2.0)
        ub = upper_body(R, sex, t_breath=0.0, swing=-c, walk=1.0)
        ub["spine03"] = _q((0, 0, 1), 1.8 * yaw) @ _q((0, 1, 0), -0.8 * list_deg)
        ub["neck02"] = _q((0, 0, 1), -0.6 * yaw) @ _q((0, 1, 0), -0.3 * list_deg)
        legs = {}
        for sd, (ank, q, tq) in zip("LR", raw[i]):
            pole = q @ FWD; pole.z = 0; pole.normalize()
            legs[sd] = (ank, q, pole, tq)
        frames.append(solve_pose(R, sex, root_off, root_q, ub, legs))
    frames.append(frames[0])   # closed loop: last key == first
    key_action(R, "Walk", frames)
    meta["walk"] = {"speed": round(v, 4), "stride": round(stride, 4), "frames": nW, "fps": FPS}
    meta["leg_m"] = round(leg_len, 4)
    S["anim_meta"] = meta
    S["rigx"] = R
    # leave the rig showing the idle's first frame for garment fitting
    use_action(R.ao, "Idle")
