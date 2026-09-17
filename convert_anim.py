#!/usr/bin/env python3
"""
Convert GLB animation (Mixamo skeleton) to HD_DATA.skater.clips format.
Reads skate_slide.glb, applies bone mapping, computes DELTAS from bind pose,
quantizes to int16, outputs JSON for insertion.

Key fix #1 (obsolete naive approach, kept here as a warning): GLTF animation
channels store LOCAL values already, so a per-bone delta = conj(bind)*animated
is well-formed *within Mixamo's own bind convention*. But it is WRONG here,
because HD_DATA's game skeleton uses an IDENTITY rest rotation for every bone
(restR = [0,0,0,1] for all 24 bones — an axis-aligned rig where only restT
defines the T-pose), while Mixamo's bind pose has large, per-bone-twisted
local rotations (e.g. neck ≈152°, thigh ≈171°). Composing the game's
identity restR with a delta computed relative to Mixamo's twisted bind frame
applies that delta around the wrong axes entirely — worse the larger the
bone's own (and its ancestors') Mixamo bind rotation, which is exactly why
extremities (head, hands, feet) looked worst and hips/spine looked fine.

Key fix #2 (this version): compute deltas in WORLD space by walking the
Mixamo hierarchy top-down, then convert to the per-bone local delta the
identity-rest game rig expects by dividing out the parent's world delta:

  Wm_i(bind) = Wm_parent(bind) ⊗ Lm_i(bind)      (accumulated Mixamo bind orientation)
  Wm_i(t)    = Wm_parent(t)    ⊗ Lm_i(t)         (accumulated Mixamo animated orientation)
  worldDelta_i(t) = Wm_i(t) ⊗ conj(Wm_i(bind))   (how much bone i rotated in world space)
  delta_i(t) = conj(worldDelta_parent(t)) ⊗ worldDelta_i(t)   (→ this is what we output)

This is standard retargeting between a source rig with twisted per-bone bind
axes and a target rig with identity/axis-aligned bind rotations.
"""

import pygltflib
import numpy as np
import base64
import json

# ─── Bone mapping: Mixamo name → HD_DATA skater bone name ───
BONE_MAP = {
    "mixamorig:Hips": "hips",
    "mixamorig:Spine": "spine1",
    "mixamorig:Spine1": "spine2",
    "mixamorig:Spine2": "chest",
    "mixamorig:Neck": "neck",
    "mixamorig:Head": "head",
    "mixamorig:LeftShoulder": "clav_l",
    "mixamorig:LeftArm": "uarm_l",
    "mixamorig:LeftForeArm": "farm_l",
    "mixamorig:LeftHand": "hand_l",
    "mixamorig:RightShoulder": "clav_r",
    "mixamorig:RightArm": "uarm_r",
    "mixamorig:RightForeArm": "farm_r",
    "mixamorig:RightHand": "hand_r",
    "mixamorig:LeftUpLeg": "thigh_l",
    "mixamorig:LeftLeg": "shin_l",
    "mixamorig:LeftFoot": "foot_l",
    "mixamorig:LeftToeBase": "toe_l",
    "mixamorig:RightUpLeg": "thigh_r",
    "mixamorig:RightLeg": "shin_r",
    "mixamorig:RightFoot": "foot_r",
    "mixamorig:RightToeBase": "toe_r",
}

# Target skeleton order (must match HD_DATA.skater.bones)
TARGET_BONES = [
    "root", "hips", "spine1", "spine2", "chest", "neck", "head",
    "clav_l", "uarm_l", "farm_l", "hand_l",
    "clav_r", "uarm_r", "farm_r", "hand_r", "stick",
    "thigh_l", "shin_l", "foot_l", "toe_l",
    "thigh_r", "shin_r", "foot_r", "toe_r"
]

# Parent-by-name, mirrors HD_DATA.skater.parent exactly (verified against
# assets/hd_data_test.json). Every parent appears earlier in TARGET_BONES
# than its child, so a single left-to-right pass can accumulate world
# orientation without any extra sorting.
PARENT_NAME = {
    "hips": "root", "spine1": "hips", "spine2": "spine1", "chest": "spine2",
    "neck": "chest", "head": "neck",
    "clav_l": "chest", "uarm_l": "clav_l", "farm_l": "uarm_l", "hand_l": "farm_l",
    "clav_r": "chest", "uarm_r": "clav_r", "farm_r": "uarm_r", "hand_r": "farm_r",
    "stick": "hand_r",
    "thigh_l": "hips", "shin_l": "thigh_l", "foot_l": "shin_l", "toe_l": "foot_l",
    "thigh_r": "hips", "shin_r": "thigh_r", "foot_r": "shin_r", "toe_r": "foot_r",
}


def get_accessor_data(gltf, accessor_idx):
    """Read accessor data as numpy array."""
    acc = gltf.accessors[accessor_idx]
    bv = gltf.bufferViews[acc.bufferView]
    buf = gltf.buffers[bv.buffer]
    data = gltf.get_data_from_buffer_uri(buf.uri)

    # Calculate byte length from component type and count
    comp_sizes = {5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4}
    type_sizes = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}
    n_comp = type_sizes[acc.type]
    comp_size = comp_sizes[acc.componentType]
    byte_len = acc.count * n_comp * comp_size

    view = memoryview(data)[bv.byteOffset + acc.byteOffset : bv.byteOffset + acc.byteOffset + byte_len]

    if acc.componentType == 5126: dtype = np.float32
    elif acc.componentType == 5123: dtype = np.uint16
    elif acc.componentType == 5122: dtype = np.int16
    elif acc.componentType == 5125: dtype = np.uint32
    else: raise ValueError(f"Unsupported component type: {acc.componentType}")

    return np.frombuffer(view, dtype=dtype).reshape(acc.count, n_comp)


# ─── Quaternion math (numpy vectorized) ───

def q_conj(q):
    """Conjugate of quaternion(s). q = [x,y,z,w] → [-x,-y,-z,w]"""
    return np.concatenate([-q[..., :3], q[..., 3:4]], axis=-1)

def q_mul(a, b):
    """Hamilton product of quaternion(s). Both (...,4) arrays [x,y,z,w]."""
    ax, ay, az, aw = a[..., 0], a[..., 1], a[..., 2], a[..., 3]
    bx, by, bz, bw = b[..., 0], b[..., 1], b[..., 2], b[..., 3]
    return np.stack([
        aw*bx + ax*bw + ay*bz - az*by,
        aw*by - ax*bz + ay*bw + az*bx,
        aw*bz + ax*by - ay*bx + az*bw,
        aw*bw - ax*bx - ay*by - az*bz,
    ], axis=-1)

def qslerp_np(a, b, t):
    """Slerp between two single unit quaternions [x,y,z,w] (not vectorized
    over an array — used for one-off corrections, not full tracks)."""
    dot = np.dot(a, b)
    if dot < 0:
        b = -b
        dot = -dot
    if dot > 0.9995:
        return a + t * (b - a)
    theta = np.arccos(np.clip(dot, -1, 1))
    s0 = np.sin((1 - t) * theta) / np.sin(theta)
    s1 = np.sin(t * theta) / np.sin(theta)
    return s0 * a + s1 * b


def resample_track(times_src, data_src, times_dst):
    """Resample a (N, C) track from src times to dst times using linear interp."""
    out = np.zeros((len(times_dst), data_src.shape[1]), dtype=np.float32)
    for dim in range(data_src.shape[1]):
        out[:, dim] = np.interp(times_dst, times_src, data_src[:, dim])
    return out

def resample_quat_track(times_src, quats_src, times_dst):
    """Resample quaternion keyframes using slerp."""
    out = np.zeros((len(times_dst), 4), dtype=np.float32)
    for i, t in enumerate(times_dst):
        # Find surrounding keyframes
        idx = np.searchsorted(times_src, t, side='right') - 1
        idx = np.clip(idx, 0, len(times_src) - 2)
        frac = (t - times_src[idx]) / max(times_src[idx+1] - times_src[idx], 1e-10)
        frac = np.clip(frac, 0.0, 1.0)
        q0, q1 = quats_src[idx], quats_src[idx+1]
        # Slerp
        dot = np.dot(q0, q1)
        if dot < 0:
            q1 = -q1
            dot = -dot
        if dot > 0.9995:
            out[i] = q0 + frac * (q1 - q0)
        else:
            theta = np.arccos(np.clip(dot, -1, 1))
            s0 = np.sin((1 - frac) * theta) / np.sin(theta)
            s1 = np.sin(frac * theta) / np.sin(theta)
            out[i] = s0 * q0 + s1 * q1
        out[i] /= np.linalg.norm(out[i])
    return out


def main():
    glb_path = '/Users/vadimbikmetov/Bvr_Hockey26/assets/skate_slide.glb'
    gltf = pygltflib.GLTF2().load(glb_path)
    anim = gltf.animations[0]

    # ─── Global time track (90 frames) ───
    times = get_accessor_data(gltf, anim.samplers[0].input).flatten()
    n_frames = len(times)
    duration = float(times[-1] - times[0])
    print(f"Frames: {n_frames}, Duration: {duration:.3f}s, FPS: {n_frames/duration:.1f}")

    # ─── Build channel lookup: (node_idx, path) → sampler ───
    channel_map = {}
    for ch in anim.channels:
        channel_map[(ch.target.node, ch.target.path)] = ch.sampler

    # ─── Read static node transforms (Mixamo bind pose) ───
    # These are the T-pose / rest-pose rotations and translations.
    # GLTF animation replaces these, so to get deltas we must subtract.
    mixamo_bind = {}  # target_name → { 'rot': (4,), 'trans': (3,) }
    for mixamo_name, target_name in BONE_MAP.items():
        for i, node in enumerate(gltf.nodes):
            if node.name == mixamo_name:
                bind = {}
                if node.rotation is not None:
                    bind['rot'] = np.array(node.rotation, dtype=np.float32)  # [x,y,z,w]
                else:
                    bind['rot'] = np.array([0, 0, 0, 1], dtype=np.float32)
                if node.translation is not None:
                    bind['trans'] = np.array(node.translation, dtype=np.float32)
                else:
                    bind['trans'] = np.array([0, 0, 0], dtype=np.float32)
                mixamo_bind[target_name] = bind
                break

    # Helper: find Mixamo node index for a mapped target-bone name
    def find_node_idx(target_name):
        mixamo_name = next((mn for mn, tn in BONE_MAP.items() if tn == target_name), None)
        if mixamo_name is None:
            return None
        return next((ni for ni, node in enumerate(gltf.nodes) if node.name == mixamo_name), None)

    # Helper: per-frame LOCAL rotation track Lm_i(t) for a mapped bone,
    # resampled to the global time track. Falls back to the constant bind
    # rotation when the bone has no rotation channel (rigid w.r.t. parent).
    def local_rot_track(target_name):
        bind_rot = mixamo_bind[target_name]['rot']
        node_idx = find_node_idx(target_name)
        rot_sampler = channel_map.get((node_idx, "rotation"))
        if rot_sampler is None:
            return np.tile(bind_rot, (n_frames, 1)).astype(np.float32)
        rot_acc = anim.samplers[rot_sampler].output
        raw_rot = get_accessor_data(gltf, rot_acc)  # (M, 4) float32
        t_acc = anim.samplers[rot_sampler].input
        src_times = get_accessor_data(gltf, t_acc).flatten()
        if len(src_times) == n_frames and np.allclose(src_times, times):
            return raw_rot.astype(np.float32)
        return resample_quat_track(src_times, raw_rot.astype(np.float32), times)

    def q_normalize(q):
        norms = np.linalg.norm(q, axis=-1, keepdims=True)
        return q / np.where(norms > 0, norms, 1)

    # ─── Walk the hierarchy top-down, accumulating WORLD orientation ───
    # (both at bind pose and per animated frame) using Mixamo's own local
    # tracks, then derive each bone's world-space rotation delta.
    IDENT = np.array([0, 0, 0, 1], dtype=np.float32)
    Wm_bind = {"root": IDENT.copy()}                          # name -> (4,)
    Wm_t = {"root": np.tile(IDENT, (n_frames, 1))}             # name -> (n,4)
    WD = {"root": np.tile(IDENT, (n_frames, 1))}                # world delta, name -> (n,4)

    nb = len(TARGET_BONES)
    all_quats = np.zeros((n_frames, nb, 4), dtype=np.float32)
    all_hips = np.zeros((n_frames, 3), dtype=np.float32)

    print("\n=== Computing world-space deltas (accumulated over Mixamo hierarchy) ===")
    for i, bone in enumerate(TARGET_BONES):
        if bone == "root":
            all_quats[:, i, :] = IDENT
            continue
        if bone == "stick" or bone not in mixamo_bind:
            # No Mixamo equivalent (game-only attachment) — identity local
            # delta; it still moves rigidly with its parent's world delta.
            all_quats[:, i, :] = IDENT
            WD[bone] = WD[PARENT_NAME[bone]].copy()
            continue

        parent = PARENT_NAME[bone]
        Lm_bind = mixamo_bind[bone]["rot"]
        Lm_t = local_rot_track(bone)  # (n_frames, 4)

        Wm_bind[bone] = q_normalize(q_mul(Wm_bind[parent], Lm_bind))
        Wm_t[bone] = q_normalize(q_mul(Wm_t[parent], Lm_t))

        world_delta = q_normalize(q_mul(Wm_t[bone], q_conj(np.tile(Wm_bind[bone], (n_frames, 1)))))
        WD[bone] = world_delta

        delta = q_normalize(q_mul(q_conj(WD[parent]), world_delta))
        all_quats[:, i, :] = delta

        w = min(1.0, max(-1.0, abs(delta[0, 3])))
        angle0 = np.degrees(2 * np.arccos(w))
        print(f"  {bone:<12}: local delta frame0 angle = {angle0:.1f}°")

        # ── Hips translation delta (unaffected by the rotation-space fix:
        # hips has no incoming rotation from the game's 'root' bone, so its
        # local translation space already equals world space) ──
        if bone == "hips":
            node_idx = find_node_idx(bone)
            trans_sampler = channel_map.get((node_idx, "translation"))
            if trans_sampler is not None:
                trans_acc = anim.samplers[trans_sampler].output
                raw_trans = get_accessor_data(gltf, trans_acc)  # (M, 3) float32
                t_acc = anim.samplers[trans_sampler].input
                src_times = get_accessor_data(gltf, t_acc).flatten()
                if len(src_times) == n_frames and np.allclose(src_times, times):
                    resampled_t = raw_trans.astype(np.float32)
                else:
                    resampled_t = resample_track(src_times, raw_trans.astype(np.float32), times)
                bind_trans = mixamo_bind[bone]["trans"]
                all_hips = resampled_t - bind_trans
                print(f"  hips trans: bind={bind_trans}, animated range: {resampled_t.min(axis=0)} to {resampled_t.max(axis=0)}")
                print(f"  hips delta range: {all_hips.min(axis=0)} to {all_hips.max(axis=0)}")

    all_hips = np.nan_to_num(all_hips, nan=0.0)

    # ─── Post-process setup: load HD_DATA's own rig + the 'ready' reference
    # clip, needed by the corrections below. All three corrections here use
    # only SLERP toward an already-consistent, continuous target (either a
    # fixed reference quaternion, or another bone's own already-computed
    # world orientation) — never cross products / geometric IK, which is
    # what caused the earlier regression (unstable near-180° corrections).
    with open('/Users/vadimbikmetov/Bvr_Hockey26/assets/hd_data_test.json') as f:
        hd_ref = json.load(f)['skater']
    assert hd_ref['bones'] == TARGET_BONES, "HD_DATA bone order drifted from TARGET_BONES"
    idx = {name: i for i, name in enumerate(TARGET_BONES)}

    ready = hd_ref['clips']['ready']
    anim_bytes_ref = base64.b64decode(hd_ref['anim'])
    rq = (np.frombuffer(anim_bytes_ref[ready['rot']:ready['rot']+ready['len']], dtype=np.int16)
          .astype(np.float64).reshape(ready['n'], nb, 4) / 32767.0)

    restT_ref = np.array(hd_ref['restT'], dtype=np.float64)
    parent_ref = hd_ref['parent']
    hip_idx_ref = hd_ref['hip']

    def quat_to_mat64(qq):
        x, y, z, w = qq
        return np.array([
            [1 - 2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
            [2*(x*y+z*w), 1 - 2*(x*x+z*z), 2*(y*z-x*w)],
            [2*(x*z-y*w), 2*(y*z+x*w), 1 - 2*(x*x+y*y)],
        ])

    def fk_world_pos(quats_frame, hips_trans_frame, bone_name):
        """Position-only FK (bisection search below only needs positions,
        never builds a new orientation from directions — no cross products,
        no pole vectors; every value fed in is itself a plain SLERP output,
        so it stays smooth by construction)."""
        world = [None] * nb
        for b in range(nb):
            R = quat_to_mat64(quats_frame[b])
            t = restT_ref[b].copy()
            if b == hip_idx_ref:
                t = t + hips_trans_frame
            M = np.eye(4); M[:3, :3] = R; M[:3, 3] = t
            p = parent_ref[b]
            world[b] = M if p < 0 else world[p] @ M
        return world[idx[bone_name]][:3, 3]

    def clamp_local_delta(bone, parent_bone, max_deg, label):
        """Slerp bone's own local delta toward identity whenever its
        magnitude exceeds max_deg, calibrated against the game's existing
        'ready'/'skate_forward' clips (kept below threshold unchanged)."""
        bi_ = idx[bone]
        angles = np.degrees(2*np.arccos(np.clip(np.abs(all_quats[:, bi_, 3]), -1, 1)))
        n_clamped = 0
        for f in range(n_frames):
            if angles[f] > max_deg:
                frac = max_deg / angles[f]
                all_quats[f, bi_, :] = q_normalize(
                    qslerp_np(np.array([0.0, 0.0, 0.0, 1.0]), all_quats[f, bi_, :], frac))
                n_clamped += 1
        print(f"  {label}: clamped {n_clamped}/{n_frames} frames to <= {max_deg:.0f}° "
              f"(was up to {angles.max():.1f}°)")

    # ─── Correction #1: ankle clamp (foot_l / foot_r) ───
    # skate_slide's source mocap has a genuinely extreme ankle roll (a
    # hockey-stop/slide edge dig) — verified NOT a retargeting bug: the
    # deviation-from-bind matches Mixamo's own source data almost exactly
    # (~52-58° either way). But the game mesh's ankle skinning isn't built
    # for that range (up to 88° local delta), which visually folds the
    # boot up into the shin. Cap it, calibrated against 'ready' (10°) and
    # 'skate_forward' (max 20.6°) with headroom for the slide's character.
    print("\n=== Correction: ankle clamp (foot_l/foot_r) ===")
    clamp_local_delta("foot_l", "shin_l", 30.0, "foot_l")
    clamp_local_delta("foot_r", "shin_r", 30.0, "foot_r")

    # ─── Correction #1b: keep the right arm from crossing the torso ───
    # hand_r's rotation is now fixed (#2 below), but nothing here has
    # touched its POSITION — that's set entirely by uarm_r/farm_r, which
    # still carry generic-mocap motion that swings the hand across the
    # body midline (measured hand_r.x going positive = character's LEFT
    # side; it should stay negative/right, per clav_r/clav_l's own sign).
    # Per-frame BISECTION search (not a geometric reconstruction): slerp
    # uarm_r and farm_r toward their 'ready' reference values by the
    # smallest fraction that brings hand_r back to a safe margin right of
    # the chest. Every candidate tried is itself a plain SLERP output, so
    # this can't produce the near-180°, axis-unstable rotations that broke
    # things before — the search just picks how far along that one smooth
    # path to go.
    print("\n=== Correction: keep right arm off the torso midline ===")
    uarm_r_ready = rq[0, idx['uarm_r']]
    farm_r_ready = rq[0, idx['farm_r']]
    X_MARGIN = -0.12  # hand_r.x must end up at least this far right of chest.x
    n_damped = 0
    max_blend = 0.0
    for f in range(n_frames):
        hips_frame = all_hips[f]
        cur_uarm = all_quats[f, idx['uarm_r']].copy()
        cur_farm = all_quats[f, idx['farm_r']].copy()
        test_quats = all_quats[f].copy()
        chest_x = fk_world_pos(test_quats, hips_frame, 'chest')[0]
        x = fk_world_pos(test_quats, hips_frame, 'hand_r')[0]
        if x - chest_x <= X_MARGIN:
            continue
        n_damped += 1
        lo, hi = 0.0, 1.8
        for _ in range(24):
            mid = (lo + hi) / 2
            test_quats[idx['uarm_r']] = q_normalize(qslerp_np(cur_uarm, uarm_r_ready, mid))
            test_quats[idx['farm_r']] = q_normalize(qslerp_np(cur_farm, farm_r_ready, mid))
            x = fk_world_pos(test_quats, hips_frame, 'hand_r')[0]
            if x - chest_x > X_MARGIN:
                lo = mid
            else:
                hi = mid
        max_blend = max(max_blend, hi)
        all_quats[f, idx['uarm_r']] = q_normalize(qslerp_np(cur_uarm, uarm_r_ready, hi))
        all_quats[f, idx['farm_r']] = q_normalize(qslerp_np(cur_farm, farm_r_ready, hi))
    # refresh world orientations downstream of uarm_r/farm_r for the
    # hand_r correction that follows
    for f in range(n_frames):
        WD['uarm_r'][f] = q_normalize(q_mul(WD['clav_r'][f], all_quats[f, idx['uarm_r']]))
        WD['farm_r'][f] = q_normalize(q_mul(WD['uarm_r'][f], all_quats[f, idx['farm_r']]))
    print(f"  damped {n_damped}/{n_frames} frames toward 'ready' shoulder/elbow "
          f"(max blend {max_blend:.2f}) to keep hand_r off the body")

    # ─── Correction #2: lock hand_r's grip orientation RELATIVE TO hand_l ───
    # Locking hand_r to identity (relative to farm_r) wasn't enough: farm_r/
    # uarm_r's own raw-mocap rotation still leaves the forearm+hand itself
    # unnaturally oriented, and hand_r just inherited that. hand_l is
    # already confirmed correct, so anchor hand_r's WORLD orientation to
    # hand_l's instead, using the fixed hand_l-to-hand_r relative rotation
    # from the game's own known-good 'ready' grip (both hands sharing a
    # consistent roll around the shaft) — not to farm_r, so this only
    # changes how hand_r is twisted, never its (already-correct) position.
    def world_quat_chain(local_deltas_frame, bone_name):
        chain = []
        b = bone_name
        while b is not None:
            chain.append(b)
            b = PARENT_NAME.get(b)
        chain.reverse()
        wq = np.array([0.0, 0.0, 0.0, 1.0])
        for b in chain:
            wq = q_mul(wq, local_deltas_frame[idx[b]])
        return q_normalize(wq)

    print("\n=== Correction: lock hand_r grip orientation relative to hand_l ===")
    Wg_hand_l_ready = world_quat_chain(rq[0], 'hand_l')
    Wg_hand_r_ready = world_quat_chain(rq[0], 'hand_r')
    rel_r_to_l = q_normalize(q_mul(q_conj(Wg_hand_l_ready), Wg_hand_r_ready))

    Wg_hand_r_target = q_normalize(q_mul(WD['hand_l'], np.tile(rel_r_to_l, (n_frames, 1))))
    all_quats[:, idx['hand_r'], :] = q_normalize(q_mul(q_conj(WD['farm_r']), Wg_hand_r_target))
    print(f"  hand_r world orientation now locked to hand_l's world orientation ⊗ 'ready' grip offset")

    # ─── Correction #3: lock neck to identity ───
    # Verified: in BOTH 'ready' and 'skate_forward', chest-to-head distance
    # is EXACTLY 0.232m at every single frame — the fully-extended reach
    # (|restT[neck]| + |restT[head]|). This rig's neck bone never bends in
    # any existing clip; all visible head motion is carried by 'head'
    # alone. Our retargeted neck had its own 25-39° local delta (correctly
    # retargeted from Mixamo, but a kind of motion this mesh/rig has never
    # been asked to show), which is what reads as "no visible neck" even
    # at moderate magnitude. Zero it out and fold its contribution into
    # head's own delta so the total visible head orientation is unchanged.
    print("\n=== Correction: lock neck to identity (rig never articulates it) ===")
    neck_angles_before = np.degrees(2*np.arccos(np.clip(np.abs(all_quats[:, idx['neck'], 3]), -1, 1)))
    print(f"  neck: was {neck_angles_before.min():.1f}-{neck_angles_before.max():.1f}°, now locked to 0°")
    all_quats[:, idx['neck'], :] = np.tile([0.0, 0.0, 0.0, 1.0], (n_frames, 1))
    WD['neck'] = WD['chest'].copy()
    all_quats[:, idx['head'], :] = q_normalize(q_mul(q_conj(WD['neck']), WD['head']))

    # ─── Correction #4: lock head to identity too ───
    # Checked every clip that has one: 'ready', 'skate_forward',
    # 'skate_fast', 'stickhandle', 'wrist_shot' all show head's own local
    # delta at EXACTLY 0.0° — this rig never independently rotates head
    # either, not just neck. All "looking around" in this game happens by
    # turning the body, never the neck or head. My previous 20°-deviation
    # clamp still introduced motion this rig has literally never shown in
    # any clip, which is what still read as "no neck". Zero it out too.
    print("\n=== Correction: lock head to identity (rig never articulates it either) ===")
    head_angles_before = np.degrees(2*np.arccos(np.clip(np.abs(all_quats[:, idx['head'], 3]), -1, 1)))
    print(f"  head: was {head_angles_before.min():.1f}-{head_angles_before.max():.1f}°, now locked to 0°")
    all_quats[:, idx['head'], :] = np.tile([0.0, 0.0, 0.0, 1.0], (n_frames, 1))

    # ─── Quantize ───
    quats_int16 = np.clip(np.round(all_quats * 32767), -32767, 32767).astype(np.int16)
    hips_int16 = np.clip(np.round(all_hips * 4096), -32767, 32767).astype(np.int16)

    quat_bytes = quats_int16.tobytes()
    hips_bytes = hips_int16.tobytes()

    q_b64 = base64.b64encode(quat_bytes).decode('ascii')
    h_b64 = base64.b64encode(hips_bytes).decode('ascii')

    # ─── Save ───
    output = {
        "clip_name": "skate_slide",
        "n": n_frames,
        "dur": duration,
        "num_bones": nb,
        "bone_order": TARGET_BONES,
        "q_base64": q_b64,
        "hips_base64": h_b64,
        "q_byte_length": len(quat_bytes),
        "hips_byte_length": len(hips_bytes)
    }

    with open('/Users/vadimbikmetov/Bvr_Hockey26/assets/skate_slide_clip.json', 'w') as f:
        json.dump(output, f, indent=2)

    print(f"\n✓ Output: assets/skate_slide_clip.json")
    print(f"  {n_frames} frames, {duration:.3f}s")
    print(f"  Quat: {len(quat_bytes)} bytes, Hips: {len(hips_bytes)} bytes")


if __name__ == "__main__":
    main()
