# Distortion evaluator fixtures

The GUI carries a TypeScript port of the driver's distortion pipeline in
`CustomHeadsetGUI/src/app/utilities/distortion/` (`radial-bezier-profile.ts` mirrors
`RadialBezierDistortionProfile.cpp` and `NoneDistortionProfile.h`, `distortion-evaluation.ts` mirrors the
profile setup in `BaseHeadset.cpp` / `DistortionProfileConstructor.cpp` and the sampling in
`FovVisualization.cpp`). It lets the GUI show the FOV and panel charts for any headset and profile
without the driver running that combination.

`distortion-evaluation.spec.ts` keeps the port honest by comparing it against what the driver itself
computes. The tools here produce that ground truth:

- `harness.cpp` compiles the driver's own profile and sampling code into a console program that runs the
  cases in `cases.json` and writes `.../distortion/fixtures/driver-harness-cases.json`. The cases cover
  every display rotation, horizontal offsets, FOV clamping off, the zooms, the chromatic aberration
  scales, the render resolution multipliers, a disabled eye, legacy smoothing and the none profile.
  `generate-harness-fixture.ps1` builds and runs it (needs the Visual Studio C++ toolset and a driver
  `info.json` for the built-in profile definitions, by default the installed driver's).
- `record-live-fixture.py` records a real driver session (`info.json`, `settings.json`,
  `fovVisualization.json` from `%APPDATA%\CustomHeadset`) into a fixture, for a headset that is
  actually running. `crystal-super-50ppd-default.json` was recorded this way.

Regenerate the harness fixture whenever the C++ distortion code changes, then run the spec:

```powershell
.\tools\distortion-fixtures\generate-harness-fixture.ps1
cd CustomHeadsetGUI
npx ng test --watch=false --browsers=ChromeHeadless --include=src/app/utilities/distortion/**/*.spec.ts
```

The driver computes in single precision and the port in double; the spec's tolerances (0.01 degrees,
1e-4 in projection tangents, 1e-3 in sampled UVs, one pixel) sit far above that noise and far below any
real porting error, see the comment at the top of the spec.
