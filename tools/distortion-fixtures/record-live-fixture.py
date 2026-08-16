#!/usr/bin/env python3
"""Record the ground truth of a live driver session for the GUI's distortion evaluator spec.

Reads info.json, settings.json and fovVisualization.json from the driver's config folder (what the running
driver computed for the connected headset and its active profile) and writes them, together with the exact
headset configuration they were made with (the headset's defaults with the settings.json overrides applied),
into one fixture. Run it while SteamVR runs the headset, or right after, before the settings change again.
The files are only read.

    python3 record-live-fixture.py <settings key of the headset, e.g. crystalSuper50PPD> [output path]

The default output is CustomHeadsetGUI/src/app/utilities/distortion/fixtures/<settings key>-live.json.
"""
import copy
import datetime
import json
import os
import re
import sys

CONFIG_KEYS = [
    'distortionProfile', 'distortionZoom', 'fovZoom', 'flatFovZoom', 'chromaticAberrationScaleRed',
    'chromaticAberrationScaleBlue', 'resolutionX', 'resolutionY', 'displayRotation', 'maxFovX', 'maxFovY',
    'fovBurnInPrevention', 'fovClamping', 'renderResolutionMultiplierX', 'renderResolutionMultiplierY',
    'eyeRotation', 'disableEye', 'disableEyeDecreaseFov',
]


def deep_merge(base, over):
    out = copy.deepcopy(base)
    for key, value in over.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    settings_key = sys.argv[1]
    folder = os.path.join(os.environ.get('APPDATA', ''), 'CustomHeadset')
    with open(os.path.join(folder, 'info.json'), encoding='utf-8') as f:
        info = json.load(f)
    with open(os.path.join(folder, 'settings.json'), encoding='utf-8') as f:
        settings = json.load(f)
    with open(os.path.join(folder, 'fovVisualization.json'), encoding='utf-8') as f:
        sampling = json.load(f)

    if sampling.get('headsetType') != info.get('connectedHeadset'):
        print('fovVisualization.json belongs to headset type %s but info.json reports %s connected, refusing to mix them'
              % (sampling.get('headsetType'), info.get('connectedHeadset')))
        return 1
    profile_name = sampling['distortionProfile']
    profile = info['builtInDistortionProfiles'].get(profile_name)
    if profile is None:
        # a custom profile, take its file
        with open(os.path.join(folder, 'Distortion', profile_name + '.json'), encoding='utf-8') as f:
            profile = json.loads(re.sub(r'^\s*//.*$', '', f.read(), flags=re.M))
    defaults = info['defaultSettings'][settings_key]
    merged = deep_merge(defaults, settings.get(settings_key, {}))
    config = {key: merged[key] for key in CONFIG_KEYS if key in merged}
    if config.get('distortionProfile') != profile_name:
        print('the settings select profile %r but the sampling was made with %r, refusing to mix them'
              % (config.get('distortionProfile'), profile_name))
        return 1
    if config.get('fovBurnInPrevention'):
        print('warning: fovBurnInPrevention is on, the driver shifted the max fov by a random amount this session; '
              'the evaluator can not reproduce that unless the profile is not clamped by the max fov')
    overrides = {key: value for key, value in settings.get(settings_key, {}).items() if key in CONFIG_KEYS}

    written = datetime.datetime.fromtimestamp(sampling['writtenTime']).isoformat(timespec='seconds')
    fixture = {
        'about': ('Ground truth for the TypeScript RadialBezier evaluator recorded from a real driver session: the '
                  'projections and render sizes are info.json resolution, the sampling is fovVisualization.json, '
                  'both written by driver %s on headset type %s, sampled %s. config is defaultSettings.%s from '
                  'info.json with the settings.json overrides listed in settingsOverrides applied.'
                  % (info.get('driverVersion'), sampling['headsetType'], written, settings_key)),
        'headsetType': sampling['headsetType'],
        'driverVersion': info.get('driverVersion'),
        'settingsOverrides': overrides,
        'config': config,
        'profileName': profile_name,
        'profile': profile,
        'expected': {
            'resolution': info['resolution'],
            'sampling': {key: sampling[key] for key in ['gridSize', 'displayRotation', 'viewportWidth', 'viewportHeight', 'left', 'right']},
        },
    }
    here = os.path.dirname(os.path.abspath(__file__))
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        here, '..', '..', 'CustomHeadsetGUI', 'src', 'app', 'utilities', 'distortion', 'fixtures', settings_key + '-live.json')
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(fixture, f, separators=(',', ':'))
    print('wrote', os.path.normpath(out), os.path.getsize(out), 'bytes; add it to distortion-evaluation.spec.ts')
    return 0


if __name__ == '__main__':
    sys.exit(main())
