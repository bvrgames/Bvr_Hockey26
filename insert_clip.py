#!/usr/bin/env python3
"""
Insert the new skate_slide clip into HD_DATA.skater in index.html
- The anim buffer is interleaved: [q_clip1][h_clip1][q_clip2][h_clip2]...
- We need to append [q_skate_slide][h_skate_slide] at the end
"""

import json
import base64
import struct

# ─── Load generated clip data ───
with open('/Users/vadimbikmetov/Bvr_Hockey26/assets/skate_slide_clip.json', 'r') as f:
    clip_data = json.load(f)

new_q_b64 = clip_data['q_base64']
new_hips_b64 = clip_data['hips_base64']
n_frames = clip_data['n']
duration = clip_data['dur']
num_bones = clip_data['num_bones']

# Decode new clip data
new_q_bytes = base64.b64decode(new_q_b64)
new_hips_bytes = base64.b64decode(new_hips_b64) if new_hips_b64 else b""

print(f"New clip: {n_frames} frames, {duration:.3f}s, {num_bones} bones")
print(f"  Quaternion bytes: {len(new_q_bytes)}")
print(f"  Hips bytes: {len(new_hips_bytes)}")

# ─── Read index.html ───
with open('/Users/vadimbikmetov/Bvr_Hockey26/index.html', 'r') as f:
    content = f.read()

# Find HD_DATA
hd_start = content.find('var HD_DATA=')
if hd_start == -1:
    raise ValueError("HD_DATA not found")

# Find the skater object start
skater_field_start = content.find('"skater":', hd_start)
if skater_field_start == -1:
    raise ValueError("skater not found")

# Find the full skater object (matching braces)
i = skater_field_start + 8  # after '"skater":'
while content[i] in ': \t\n\r':
    i += 1
skater_obj_start = i
depth = 0
skater_json_str = ''
while i < len(content):
    skater_json_str += content[i]
    if content[i] == '{':
        depth += 1
    elif content[i] == '}':
        depth -= 1
        if depth == 0:
            skater_obj_end = i + 1
            break
    i += 1

print(f"Skater object length: {len(skater_json_str)}")

# Parse skater JSON
skater = json.loads(skater_json_str)

# ─── Current clips and offsets ───
clips = skater['clips']
print("\nCurrent clips:")
total_q_bytes = 0
total_hips_bytes = 0
for name, c in clips.items():
    q_end = c['rot'] + c['len']
    h_end = c['hips'] + c['hlen']
    print(f"  {name}: n={c['n']}, dur={c['dur']}, rot={c['rot']}, len={c['len']}, hips={c['hips']}, hlen={c['hlen']} (q_end={q_end}, h_end={h_end})")
    total_q_bytes = max(total_q_bytes, q_end)
    total_hips_bytes = max(total_hips_bytes, h_end)

total_buffer = max(total_q_bytes, total_hips_bytes)
print(f"\nTotal anim buffer: {total_buffer} bytes (max of q_end={total_q_bytes}, h_end={total_hips_bytes})")

# ─── Decode current anim buffer ───
anim_field_start = content.find('"anim":', hd_start)
anim_value_start = content.find('"', anim_field_start + 7) + 1
anim_value_end = content.find(',', anim_value_start)
anim_b64 = content[anim_value_start:anim_value_end]
anim_bytes = base64.b64decode(anim_b64)
print(f"Anim buffer actual size: {len(anim_bytes)} bytes")

# Verify
if len(anim_bytes) != total_buffer:
    print(f"WARNING: anim buffer size ({len(anim_bytes)}) != expected ({total_buffer})")

# ─── The buffer is interleaved: [q0][h0][q1][h1]...
# New clip goes at the end: [old_data][q_new][h_new]
new_anim_bytes = anim_bytes + new_q_bytes + new_hips_bytes
new_anim_b64 = base64.b64encode(new_anim_bytes).decode('ascii')

print(f"\nNew anim buffer size: {len(new_anim_bytes)} bytes")
print(f"New anim base64 length: {len(new_anim_b64)}")

# ─── Calculate new clip offsets (interleaved) ───
# Last clip is 'celebrate' with hips=53682, hlen=174
# So new clip starts at 53856 (which is total_buffer)
new_rot_offset = total_buffer
new_hips_offset = total_buffer + len(new_q_bytes)

new_q_len = len(new_q_bytes)
new_hips_len = len(new_hips_bytes)

print(f"\nNew clip offsets (interleaved):")
print(f"  rot: {new_rot_offset}, len: {new_q_len}")
print(f"  hips: {new_hips_offset}, hlen: {new_hips_len}")

# Verify: hips should equal rot + len
assert new_hips_offset == new_rot_offset + new_q_len, "hips != rot + len"

# ─── Add new clip to clips ───
clips['skate_slide'] = {
    'n': n_frames,
    'dur': duration,
    'rot': new_rot_offset,
    'len': new_q_len,
    'hips': new_hips_offset,
    'hlen': new_hips_len
}

print(f"\nNew clip entry: {json.dumps({'skate_slide': clips['skate_slide']}, indent=2)}")

# ─── Update skater object ───
skater['clips'] = clips
skater['anim'] = new_anim_b64

# ─── Reconstruct index.html ───
# Replace the skater object in the content
new_skater_json = json.dumps(skater, separators=(',', ':'))
new_content = content[:skater_field_start+9] + new_skater_json + content[skater_obj_end:]

# Write updated index.html
with open('/Users/vadimbikmetov/Bvr_Hockey26/index.html', 'w') as f:
    f.write(new_content)

print("\n✓ index.html updated successfully!")
print(f"  Added clip 'skate_slide' with {n_frames} frames ({duration:.3f}s)")
print(f"  New anim buffer: {len(new_anim_bytes)} bytes")