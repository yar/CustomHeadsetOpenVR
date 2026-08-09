import { Injectable, signal } from '@angular/core';
import { JsonSettingServiceBase } from '../../services/JsonSettingServiceBase';
import { PathsService } from '../../services/paths.service';

export type FovVisualizationChannels = {
  red: number[];
  green: number[];
  blue: number[];
};

/**
 * Contents of fovVisualization.json written by the driver: a grid sampling of the
 * active distortion profile. Each channel array holds gridSize * gridSize (x, y)
 * pairs of render texture coordinates in [-1, 1] over the eye viewport.
 */
export type FovVisualizationData = {
  /** headset type the sampling was made for */
  headsetType?: number;
  /** distortion profile the sampling was made with */
  distortionProfile?: string;
  /** unix time in seconds when the sampling was written */
  writtenTime?: number;
  gridSize: number;
  displayRotation: number;
  viewportWidth: number;
  viewportHeight: number;
  /**
   * where the lens is centered, as tangents [x right, y up] in the frame of the projections; the view angles
   * of the panel map are measured from it. Zero (or absent, older drivers) unless the profile's frame is not
   * the eye's optical frame, like the Pimax PVR profile in parallel projection mode, where it is the cant.
   */
  opticalAxisLeft?: number[];
  opticalAxisRight?: number[];
  left: FovVisualizationChannels;
  right: FovVisualizationChannels;
};

@Injectable({
  providedIn: 'root'
})
export class FovVisualizationService extends JsonSettingServiceBase<FovVisualizationData> {
  constructor(pathService: PathsService) {
    super(pathService.fovVisualizationPath, pathService.appDataDirPath, signal(undefined), false, true);
  }
}
