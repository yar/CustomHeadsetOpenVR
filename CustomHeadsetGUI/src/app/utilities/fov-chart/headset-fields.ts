import { HeadsetType, Settings } from '../../services/JsonFileDefines';

/** maps a connected headset type to its field in the settings file */
export const settingsFieldByHeadsetType: { [type: number]: keyof Settings } = {
  [HeadsetType.MeganeX8K]: 'meganeX8K',
  [HeadsetType.DreamAir]: 'dreamAir',
  [HeadsetType.DreamAirSE]: 'dreamAirSE',
  [HeadsetType.CrystalSuper50PPD]: 'crystalSuper50PPD',
  [HeadsetType.CrystalSuper57PPD]: 'crystalSuper57PPD',
  [HeadsetType.CrystalSuperUltrawide]: 'crystalSuperUltrawide',
  [HeadsetType.CrystalSuperMicroOLED]: 'crystalSuperMicroOLED',
  [HeadsetType.CrystalLight]: 'crystalLight',
  [HeadsetType.CrystalOG]: 'crystalOG',
  [HeadsetType.Pimax5KSuper]: 'pimax5KSuper',
  [HeadsetType.Pimax5KPlus]: 'pimax5KPlus',
  [HeadsetType.Pimax8KX]: 'pimax8KX',
  [HeadsetType.Pimax8KPlus]: 'pimax8KPlus',
  [HeadsetType.PimaxArtisan]: 'pimaxArtisan',
};
