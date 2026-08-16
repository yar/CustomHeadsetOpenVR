import { inject, Injectable } from '@angular/core';
import { DriverInfoService } from '../../services/driver-info.service';
import { DriverSettingService } from '../../services/driver-setting.service';
import { DistortionProfileDisplayNames } from '../../pages/devices/DeviceConfigComponentBase';
import { DistortionProfileDefinition } from './radial-bezier-profile';

/** old names of built-in profiles the driver still accepts, builtInDistortionProfileAliases in DistortionProfileConstructor.cpp */
const BUILT_IN_ALIASES: { [name: string]: string } = {
  'MeganeX8K Original': 'MeganeX8K v0.3.0',
};

export type ResolvedDistortionProfile = {
  /** the name as selected in the settings */
  name: string;
  /** the built-in name after aliasing, or the file name without its extension */
  resolvedName: string;
  displayName: string;
  /**
   * builtIn: one of the driver's profiles, file: a profile file in the Distortion folder,
   * none: nothing selected or nothing found under that name, so the driver runs its none profile
   */
  kind: 'builtIn' | 'file' | 'none';
  definition: DistortionProfileDefinition | null;
  /** whether the GUI can evaluate the profile itself, everything but the driver's Pimax (PVR) type */
  computable: boolean;
};

/**
 * Resolves a profile name the way DistortionProfileConstructor::LoadDistortionProfile does: aliases first,
 * then the built-in profiles, then a profile file of that name. Reads the driver info and the profile
 * list signals, so a computed calling resolve tracks them.
 */
@Injectable({
  providedIn: 'root'
})
export class DistortionProfileLookupService {
  private dis = inject(DriverInfoService);
  private dss = inject(DriverSettingService);

  resolve(name: string | null | undefined): ResolvedDistortionProfile {
    const selected = name ?? '';
    const aliased = BUILT_IN_ALIASES[selected] ?? selected;
    const displayNameOf = (key: string) => DistortionProfileDisplayNames.get(key) ?? key;
    if (!selected || selected === 'None') {
      return { name: selected, resolvedName: 'None', displayName: displayNameOf(selected || 'None'), kind: 'none', definition: null, computable: true };
    }
    const builtIn = this.dis.values()?.builtInDistortionProfiles?.[aliased];
    if (builtIn) {
      return { name: selected, resolvedName: aliased, displayName: displayNameOf(aliased), kind: 'builtIn', definition: builtIn, computable: builtIn.type !== 'Pimax' };
    }
    const file = this.dss.distortionProfileList().find(p => p.name === selected + '.json' || p.name === selected);
    if (file) {
      const definition: DistortionProfileDefinition = {
        type: file.type,
        distortions: file.distortions,
        distortionsRed: file.distortionsRed,
        distortionsBlue: file.distortionsBlue,
        legacySmoothing: file.legacySmoothing,
        smoothAmount: file.smoothAmount,
        offsetX: file.offsetX,
        offsetY: file.offsetY,
        eyeRotationOffset: file.eyeRotationOffset,
      };
      return { name: selected, resolvedName: selected, displayName: displayNameOf(selected), kind: 'file', definition, computable: file.type !== 'Pimax' };
    }
    return { name: selected, resolvedName: selected, displayName: displayNameOf(selected), kind: 'none', definition: null, computable: true };
  }
}
