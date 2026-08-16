import { HeadsetType } from '../../services/JsonFileDefines';
import { vendorUi } from '../../../environment';

export type HeadsetCatalogEntry = {
  headsetType: HeadsetType;
  /** the device name profiles list in their device field and the settings carry as distortionProfileDeviceType */
  device: string;
  label: string;
};

/** the device name of a headset type: the key of the HeadsetType map, which is what profiles use */
export function deviceNameOf(headsetType: HeadsetType): string {
  const entry = Object.entries(HeadsetType).find(([, value]) => value === headsetType);
  return entry ? entry[0] : '';
}

/**
 * The headsets whose distortion the GUI can evaluate itself, in the order of the settings tabs and gated by
 * the vendor build like the tabs are. The Pimax lighthouse headsets are not here: their panel resolution and
 * distortion come from PVR while they run.
 */
export function simulatableHeadsets(): HeadsetCatalogEntry[] {
  const list: HeadsetCatalogEntry[] = [];
  if (!vendorUi || vendorUi === 'shiftall') {
    list.push({ headsetType: HeadsetType.MeganeX8K, device: 'MeganeX8K', label: $localize`MeganeX 8K` });
  }
  if (!vendorUi || vendorUi === 'pimax') {
    list.push({ headsetType: HeadsetType.DreamAir, device: 'DreamAir', label: $localize`Dream Air` });
    list.push({ headsetType: HeadsetType.DreamAirSE, device: 'DreamAirSE', label: $localize`Dream Air SE` });
    list.push({ headsetType: HeadsetType.CrystalSuperMicroOLED, device: 'CrystalSuperMicroOLED', label: $localize`Crystal Super Micro-OLED` });
    list.push({ headsetType: HeadsetType.CrystalSuper50PPD, device: 'CrystalSuper50PPD', label: $localize`Crystal Super 50PPD` });
    list.push({ headsetType: HeadsetType.CrystalSuper57PPD, device: 'CrystalSuper57PPD', label: $localize`Crystal Super 57PPD` });
    list.push({ headsetType: HeadsetType.CrystalSuperUltrawide, device: 'CrystalSuperUltrawide', label: $localize`Crystal Super Ultrawide` });
    list.push({ headsetType: HeadsetType.CrystalLight, device: 'CrystalLight', label: $localize`Crystal Light` });
    list.push({ headsetType: HeadsetType.CrystalOG, device: 'CrystalOG', label: $localize`Crystal OG` });
  }
  return list;
}

/** the label of a headset in the catalog, or its device name when it is not in it */
export function headsetLabel(headsetType: HeadsetType): string {
  return simulatableHeadsets().find(h => h.headsetType === headsetType)?.label ?? deviceNameOf(headsetType);
}
