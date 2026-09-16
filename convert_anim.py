#!/usr/bin/env python3
"""
Convert GLB animation (Mixamo skeleton) to HD_DATA.skater.clips format.
Reads skate_slide.glb, applies bone mapping, computes DELTAS from bind pose,
quantizes to int16, outputs JSON for insertion.

Key fix: GLTF animation channels store ABSOLUTE values (replacing node static
transform). The game expects DELTAS from the bind pose. We must subtract the
static translation and conjugate-multiply the static rotation.
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

    # ─── Read animation tracks and compute deltas ───
    nb = len(TARGET_BONES)
    all_quats = np.zeros((n_frames, nb, 4), dtype=np.float32)
    all_hips = np.zeros((n_frames, 3), dtype=np.float32)
    all_hips[:] = np.nan  # detect if not filled

    print("\n=== Computing deltas from bind pose ===")
    for i, bone in enumerate(TARGET_BONES):
        if bone == 'root' or bone == 'stick':
            # No Mixamo equivalent — stays identity / zero
            all_quats[:, i, :] = [0, 0, 0, 1]
            continue

        bind = mixamo_bind.get(bone)
        if bind is None:
            all_quats[:, i, :] = [0, 0, 0, 1]
            continue

        # Find Mixamo node index
        mixamo_name = None
        for mn, tn in BONE_MAP.items():
            if tn == bone:
                mixamo_name = mn
                break
        node_idx = None
        for ni, node in enumerate(gltf.nodes):
            if node.name == mixamo_name:
                node_idx = ni
                break

        # ── Rotation delta ──
        rot_sampler = channel_map.get((node_idx, "rotation"))
        if rot_sampler is not None:
            rot_acc = anim.samplers[rot_sampler].output
            raw_rot = get_accessor_data(gltf, rot_acc)  # (M, 4) float32

            # Get source times for this sampler
            t_acc = anim.samplers[rot_sampler].input
            src_times = get_accessor_data(gltf, t_acc).flatten()

            # Resample to global time track
            if len(src_times) == n_frames and np.allclose(src_times, times):
                resampled = raw_rot.astype(np.float32)
            else:
                resampled = resample_quat_track(src_times, raw_rot.astype(np.float32), times)

            # Delta = conjugate(bind_rot) * animated_rot
            bind_rot = bind['rot']
            bind_rot_4d = np.tile(bind_rot, (n_frames, 1))  # (n, 4)
            deltas = q_mul(q_conj(bind_rot_4d), resampled)

            # Normalize
            norms = np.linalg.norm(deltas, axis=-1, keepdims=True)
            norms = np.where(norms > 0, norms, 1)
            deltas /= norms

            all_quats[:, i, :] = deltas

            # Sanity check: frame 0 angle
            w = min(1.0, max(-1.0, abs(deltas[0, 3])))
            angle0 = np.degrees(2 * np.arccos(w))
            print(f"  {bone:<12}: rot delta frame0 angle = {angle0:.1f}°")
        else:
            # No animation — use identity (no delta from bind)
            all_quats[:, i, :] = [0, 0, 0, 1]

        # ── Hips translation delta ──
        if bone == 'hips':
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

                # Delta = animated - bind
                bind_trans = bind['trans']
                all_hips = resampled_t - bind_trans

                print(f"  hips trans: bind={bind_trans}, animated range: {resampled_t.min(axis=0)} to {resampled_t.max(axis=0)}")
                print(f"  hips delta range: {all_hips.min(axis=0)} to {all_hips.max(axis=0)}")

    # Fill any remaining NaN with zero
    all_hips = np.nan_to_num(all_hips, nan=0.0)

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
