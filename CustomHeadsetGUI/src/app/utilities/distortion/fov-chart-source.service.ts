import { inject, Injectable, signal } from '@angular/core';
import { DriverInfoService } from '../../services/driver-info.service';
import { DriverSettingService } from '../../services/driver-setting.service';
import { PathsService } from '../../services/paths.service';
import { BaseHeadsetConfig, HeadsetType, ResolutionInfo } from '../../services/JsonFileDefines';
import { DeviceConfigComponentBase } from '../../pages/devices/DeviceConfigComponentBase';
import { settingsFieldByHeadsetType } from '../fov-chart/headset-fields';
import { FovVisualizationData, FovVisualizationService } from '../fov-panel-chart/fov-visualization.service';
import { evaluateDistortion } from './distortion-evaluation';
import { DistortionProfileLookupService } from './distortion-profile-lookup.service';

/**
 * live: written by the driver while SteamVR runs this headset with the selected profile,
 * simulated: computed by the GUI from the settings of the tab, the same way the driver would,
 * lastKnown: the driver's last sampling, for profiles only the driver can sample (Pimax PVR)
 */
export type FovChartSourceKind = 'live' | 'simulated' | 'lastKnown';

export type FovChartData = {
  source: FovChartSourceKind;
  /** the projections, fovs and render sizes: info.json's resolution block when live, evaluated otherwise */
  resolution: ResolutionInfo;
  /** the panel sampling for the panel angle map, undefined only when the profile is not computable and never sampled */
  sampling?: FovVisualizationData;
  /** the tab's headset configuration the charts read the hidden area, disabled eyes and eye rotation from */
  config: BaseHeadsetConfig;
  /** display name of the profile the data belongs to */
  profileName: string;
};

type CacheEntry = {
  data: FovChartData;
  configKey: string;
  profileKey: string;
  resolution: ResolutionInfo | undefined;
  sampling: FovVisualizationData | undefined;
};

/** the settings a chart depends on, so a change of any of them makes the data object new */
function chartConfigKey(config: BaseHeadsetConfig): string {
  const ham = config.hiddenArea;
  return [
    config.distortionProfile, config.resolutionX, config.resolutionY, config.displayRotation, config.maxFovX, config.maxFovY,
    config.fovZoom, config.flatFovZoom, config.distortionZoom, config.chromaticAberrationScaleRed, config.chromaticAberrationScaleBlue,
    config.fovClamping, config.fovBurnInPrevention, config.disableEye, config.disableEyeDecreaseFov, config.eyeRotation,
    config.renderResolutionMultiplierX, config.renderResolutionMultiplierY,
    ham?.enable, ham?.testMode, ham?.radiusTopOuter, ham?.radiusTopInner, ham?.radiusBottomInner, ham?.radiusBottomOuter,
  ].join('|');
}

/**
 * Decides where the FOV charts of a headset tab take their data from and provides it: the driver's own
 * output while SteamVR runs that headset with the profile selected on the tab, otherwise an evaluation of
 * the profile with the tab's settings, otherwise the driver's last sampling for profiles the GUI can not
 * evaluate. Both charts of a tab ask this service so they always agree on the source.
 */
@Injectable({
  providedIn: 'root'
})
export class FovChartSourceService {
  private dis = inject(DriverInfoService);
  private dss = inject(DriverSettingService);
  private fvs = inject(FovVisualizationService);
  private lookup = inject(DistortionProfileLookupService);
  private ps = inject(PathsService);

  /** whether the driver is running under SteamVR right now, from the age of its diagnostic file */
  private steamVRRunning = signal(false);
  private pullingRef = DeviceConfigComponentBase.steamVRStatePulling.createRef(running => this.steamVRRunning.set(running));
  private cache = new Map<HeadsetType, CacheEntry>();

  constructor() {
    DeviceConfigComponentBase.ensureDiagnosticPath(this.ps.diagnosticPath);
    this.pullingRef.start();
  }

  /**
   * The chart data of a headset tab, or undefined when there is nothing to show. Reads the driver info,
   * settings and sampling signals, so a computed calling this tracks them; the returned object only
   * changes when something it depends on changed.
   */
  data(headsetType: HeadsetType): FovChartData | undefined {
    const info = this.dis.values();
    const settings = this.dss.values();
    const field = settingsFieldByHeadsetType[headsetType];
    const config = field ? settings?.[field] as BaseHeadsetConfig | undefined : undefined;
    if (!config) {
      return undefined;
    }
    const profile = this.lookup.resolve(config.distortionProfile);
    const configKey = chartConfigKey(config);
    const profileKey = JSON.stringify(profile.definition);
    const connected = info?.connectedHeadset === headsetType;
    const running = this.steamVRRunning();
    // the driver's sampling, when it belongs to this headset and the profile selected on the tab
    const written = this.fvs.values();
    const sampling = written && written.gridSize
      && (written.headsetType === undefined || written.headsetType === headsetType)
      && (written.distortionProfile === undefined || written.distortionProfile === config.distortionProfile)
      ? written : undefined;
    const resolution = info?.resolution;

    let source: FovChartSourceKind;
    if (connected && running && resolution && sampling) {
      source = 'live';
    } else if (profile.computable && config.resolutionX > 0 && config.resolutionY > 0) {
      source = 'simulated';
    } else if (connected && resolution && sampling) {
      source = 'lastKnown';
    } else {
      this.cache.delete(headsetType);
      return undefined;
    }

    const previous = this.cache.get(headsetType);
    if (source === 'simulated') {
      if (previous && previous.data.source === 'simulated' && previous.configKey === configKey && previous.profileKey === profileKey) {
        return previous.data;
      }
      const evaluation = evaluateDistortion(profile.definition, config, { headsetType, distortionProfile: config.distortionProfile });
      const data: FovChartData = { source, resolution: evaluation.resolution, sampling: evaluation.sampling, config, profileName: profile.displayName };
      this.cache.set(headsetType, { data, configKey, profileKey, resolution: undefined, sampling: undefined });
      return data;
    }
    if (previous && previous.data.source === source && previous.configKey === configKey && previous.profileKey === profileKey
      && previous.resolution === resolution && previous.sampling === sampling) {
      return previous.data;
    }
    const data: FovChartData = { source, resolution: resolution!, sampling, config, profileName: profile.displayName };
    this.cache.set(headsetType, { data, configKey, profileKey, resolution, sampling });
    return data;
  }
}
