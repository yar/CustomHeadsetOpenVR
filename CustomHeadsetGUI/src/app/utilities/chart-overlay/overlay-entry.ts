import { HeadsetType } from '../../services/JsonFileDefines';

/** one line of an overlay chart: a profile on a headset with the color and label it is drawn with */
export type OverlayEntry = {
  id: number;
  color: string;
  label: string;
  headsetType: HeadsetType;
  /** the profile name as selected in the settings */
  profile: string;
};
