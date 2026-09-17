#!/usr/bin/env python3
"""
Replace the existing 'skate_slide' clip bytes in a target file (either
assets/hd_data_test.json or index.html's embedded HD_DATA) with freshly
converted data from assets/skate_slide_clip.json — WITHOUT double-appending.

Since the clip's rot/hips byte lengths are unchanged (same frame count,
same bone count) between runs, the anim buffer offsets stay identical; we
just need to overwrite the trailing [q_skate_slide][hips_skate_slide]
bytes rather than re-append them.
"""
import json
import base64
import sys

with open('/Users/vadimbikmetov/Bvr_Hockey26/assets/skate_slide_clip.json') as f:
    clip = json.load(f)

new_q_bytes = base64.b64decode(clip['q_base64'])
new_hips_bytes = base64.b64decode(clip['hips_base64']) if clip['hips_base64'] else b""


def replace_in_skater(skater):
    c = skater['clips']['skate_slide']
    anim_bytes = bytearray(base64.b64decode(skater['anim']))

    old_q_len, old_h_len = c['len'], c['hlen']
    if old_q_len != len(new_q_bytes) or old_h_len != len(new_hips_bytes):
        raise ValueError(
            f"Byte length mismatch: old rot/hips=({old_q_len},{old_h_len}) "
            f"new=({len(new_q_bytes)},{len(new_hips_bytes)}). "
            "Offsets would shift — refusing to blindly overwrite."
        )

    anim_bytes[c['rot']:c['rot']+old_q_len] = new_q_bytes
    anim_bytes[c['hips']:c['hips']+old_h_len] = new_hips_bytes

    skater['anim'] = base64.b64encode(bytes(anim_bytes)).decode('ascii')
    # n/dur/offsets unchanged, but refresh n/dur in case they drifted
    c['n'] = clip['n']
    c['dur'] = clip['dur']
    return skater


def update_hd_data_test_json():
    path = '/Users/vadimbikmetov/Bvr_Hockey26/assets/hd_data_test.json'
    with open(path) as f:
        d = json.load(f)
    d['skater'] = replace_in_skater(d['skater'])
    with open(path, 'w') as f:
        json.dump(d, f, separators=(',', ':'))
    print(f"✓ Updated {path}")


def update_index_html():
    path = '/Users/vadimbikmetov/Bvr_Hockey26/index.html'
    with open(path) as f:
        content = f.read()

    hd_start = content.find('var HD_DATA=')
    if hd_start == -1:
        raise ValueError("HD_DATA not found")
    skater_field_start = content.find('"skater":', hd_start)
    if skater_field_start == -1:
        raise ValueError("skater not found")

    i = skater_field_start + 9
    while content[i] in ': \t\n\r':
        i += 1
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

    skater = json.loads(skater_json_str)
    if 'skate_slide' not in skater['clips']:
        print(f"  (index.html has no skate_slide clip yet — skipping; run insert_clip.py first)")
        return
    skater = replace_in_skater(skater)

    new_skater_json = json.dumps(skater, separators=(',', ':'))
    new_content = content[:skater_field_start+9] + new_skater_json + content[skater_obj_end:]
    with open(path, 'w') as f:
        f.write(new_content)
    print(f"✓ Updated {path}")


if __name__ == "__main__":
    update_hd_data_test_json()
    update_index_html()
