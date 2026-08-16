import { Injectable, signal } from '@angular/core';
import { JsonSettingServiceBase } from '../../services/JsonSettingServiceBase';
import { PathsService } from '../../services/paths.service';

/** a coordinate frame given in the object coordinate system of the sensor model */
export type LighthouseFrame = {
  /** origin of the frame in meters */
  position: number[];
  /** direction of the frame's +X axis */
  plusX: number[];
  /** direction of the frame's +Z axis */
  plusZ: number[];
};

export type LighthouseSensor = {
  /** center of the photodiode in meters */
  position: number[];
  /** unit vector the sensor faces, absent when the config has no normals */
  normal?: number[];
};

/**
 * Contents of lighthouseGeometry.json written by the driver from the lighthouse config of the
 * tracked headset. All positions are in meters in the object coordinate system of the sensor
 * model, the head frame is the one the tracked pose is reported in.
 */
export type LighthouseGeometryData = {
  /** unix time in seconds when the file was written */
  writtenTime?: number;
  /** headset type the geometry belongs to when the driver could tell, 0 otherwise */
  headsetType?: number;
  modelNumber?: string;
  manufacturer?: string;
  serial?: string;
  /** the frame the pose is reported in, its origin is meant to be between the user's pupils */
  head: LighthouseFrame | null;
  /** true when a lighthouse override in the settings changed the head frame */
  headOverridden?: boolean;
  /** the head frame as it came from the device when it was overridden */
  originalHead?: LighthouseFrame | null;
  sensors: LighthouseSensor[];
  /** 3x4 lens extrinsics of the left and right eye from the config when present */
  eyeExtrinsics?: number[][][] | null;
};

@Injectable({
  providedIn: 'root'
})
export class LighthouseGeometryService extends JsonSettingServiceBase<LighthouseGeometryData> {
  constructor(pathService: PathsService) {
    super(pathService.lighthouseGeometryPath, pathService.appDataDirPath, signal(undefined), false, true);
  }
}
