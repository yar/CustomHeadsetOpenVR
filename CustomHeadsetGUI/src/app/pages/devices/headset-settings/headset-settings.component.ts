import { Component, computed, effect, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatDividerModule } from '@angular/material/divider';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatSliderModule } from '@angular/material/slider';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FieldNoteComponent } from '../../../utilities/field-note/field-note.component';
import { FieldTipComponent } from '../../../utilities/field-tip/field-tip.component';
import { ResetButtonComponent } from '../../../utilities/reset-button/reset-button.component';
import { ColorPickerComponent } from '../../../utilities/color-picker/color-picker.component';
import { FovChartComponent } from '../../../utilities/fov-chart/fov-chart.component';
import { FovPanelChartComponent } from '../../../utilities/fov-panel-chart/fov-panel-chart.component';
import { DeviceConfigComponentBase } from '../DeviceConfigComponentBase';
import { BaseHeadsetConfig, HeadsetType } from '../../../services/JsonFileDefines';

export interface ResolutionOption {
  name: string;
  x: number;
  y: number;
}

export interface DisableEyeOption {
  name: string;
  value: number;
}

export interface HeadsetSettingsConfig {
  driverName: string | string[];
  settingField: string;
  enableText: string;
  enableInfo: string;
  resolutionInfo: string;
  resolutionOptions: ResolutionOption[];
  showResolutionSelector: boolean;
  showDisplayRotation: boolean;
  showDriverWarning: boolean;
  ipdInfo: string;
  defaultMaxFovX: number;
  defaultMaxFovY: number;
}

@Component({
  selector: 'app-headset-settings',
  imports: [
    MatSliderModule,
    MatSelectModule,
    FormsModule,
    MatDividerModule,
    MatButtonModule,
    MatIconModule,
    MatInputModule,
    MatSlideToggleModule,
    MatTooltipModule,
    ResetButtonComponent,
    FieldTipComponent,
    FieldNoteComponent,
    ColorPickerComponent,
    FovChartComponent,
    FovPanelChartComponent,
    CommonModule
  ],
  templateUrl: './headset-settings.component.html',
  styleUrl: './headset-settings.component.scss'
})
export class HeadsetSettingsComponent extends DeviceConfigComponentBase<BaseHeadsetConfig> {
  config = input.required<HeadsetSettingsConfig>();
  override settingField = input.required<string>();
  override driverName = input.required<string | string[]>();
  headsetType = input.required<HeadsetType>();
  navigateToGeneralTab = output<void>();
  headsetMatches = computed(() => {
    const connectedHeadset = this.dis.values()?.connectedHeadset;
    return connectedHeadset !== undefined && connectedHeadset === this.headsetType();
  });
  headsetMismatch = computed(() => {
    const current = this.dis.currentHeadsetType();
    return current !== undefined && current !== this.headsetType();
  });
  
  resolutionModel?: number; // index into resolutionOptions
  defaultResolutionIndex = computed(() => {
    if (!this.defaults) {
      return 0;
    }
    const idx = this.config().resolutionOptions.findIndex(r => r.x === this.defaults!.resolutionX && r.y === this.defaults!.resolutionY);
    return idx >= 0 ? idx : 0;
  });
  displayRotationOptions = [
    { name: $localize`0°`, value: 0 },
    { name: $localize`90°`, value: 1 },
    { name: $localize`180°`, value: 2 },
    { name: $localize`270°`, value: 3 },
  ];
  subpixelShiftOptions = [-1, 0, 1];
  disableEyeOptions: DisableEyeOption[] = [
    { name: $localize`None`, value: 0 },
    { name: $localize`Left`, value: 1 },
    { name: $localize`Right`, value: 2 },
    { name: $localize`Both`, value: 3 }
  ];
  proximitySensorTypeOptions = [
    { name: $localize`None`, value: 0 },
    { name: $localize`Hardware`, value: 1 },
    { name: $localize`Stationary Dimming`, value: 2 },
    { name: $localize`Always On`, value: 3 },
    { name: $localize`Always Off`, value: 4 },
  ];
  distortionMeshResolutionOptions = [63, 127, 255];
  distortionMeshResolutionOptionsText: { [key: number]: string } = {
    63: $localize`Low (${63})`,
    127: $localize`Normal (${127})`,
    255: $localize`High (${255})`
  };

  constructor() {
    super();
    effect(() => {
      this.dss.values();
      if (this.config().showResolutionSelector && this.settings) {
        const idx = this.config().resolutionOptions.findIndex(r => r.x === this.settings!.resolutionX && r.y === this.settings!.resolutionY);
        this.resolutionModel = idx >= 0 ? idx : 0;
      }
    });
    effect(() => {
      this.dss.values();
      if (this.config().showDisplayRotation && this.settings) {
        this.displayRotationModel = this.settings.displayRotation;
      }
    });
  }

  resetResolution() {
    const idx = this.config().resolutionOptions.findIndex(r => r.x === this.defaults!.resolutionX && r.y === this.defaults!.resolutionY);
    this.resolutionModel = idx >= 0 ? idx : 0;
    this.setResolution();
  }

  resetIpd() {
    if (this.settings && this.defaults) {
      this.settings.hardwareIpd = this.defaults.hardwareIpd;
      this.settings.ipd = this.defaults.ipd;
      this.saveConfigSettings();
    }
  }

  resetEyeRotation() {
    if (this.settings && this.defaults) {
      this.settings.autoEyeRotation = this.defaults.autoEyeRotation;
      this.settings.eyeRotation = this.defaults.eyeRotation;
      this.saveConfigSettings();
    }
  }

  /** recommended settings declared by the currently selected distortion profile, null when it declares none */
  profileRecommendation(): { maxFovX?: number; maxFovY?: number; eyeRotation?: number } | null {
    const name = this.settings?.distortionProfile;
    if (!name) {
      return null;
    }
    // built in profiles take precedence over profile files with the same name, like in the driver
    const source = this.dis.values()?.builtInDistortionProfiles?.[name]
      ?? this.dss.distortionProfileList().find(f => f.name.split('.').slice(0, -1).join('.') === name);
    if (!source) {
      return null;
    }
    if (source.recommendedMaxFovX === undefined && source.recommendedMaxFovY === undefined
      && source.recommendedEyeRotation === undefined) {
      return null;
    }
    return {
      maxFovX: source.recommendedMaxFovX,
      maxFovY: source.recommendedMaxFovY,
      eyeRotation: source.recommendedEyeRotation,
    };
  }

  /**
   * the recommended settings of the selected profile that the current settings deviate from,
   * empty when the profile has no recommendations or they are all met
   */
  profileRecommendationDeviations(): { name: string; recommended: number; current: string }[] {
    const rec = this.profileRecommendation();
    if (!rec || !this.settings) {
      return [];
    }
    const differs = (value: number, recommended?: number) => recommended !== undefined && Math.abs(value - recommended) > 0.01;
    const deviations: { name: string; recommended: number; current: string }[] = [];
    if (differs(this.settings.maxFovX, rec.maxFovX)) {
      deviations.push({ name: 'MaxFovH', recommended: rec.maxFovX!, current: `${this.settings.maxFovX}` });
    }
    if (differs(this.settings.maxFovY, rec.maxFovY)) {
      deviations.push({ name: 'MaxFovV', recommended: rec.maxFovY!, current: `${this.settings.maxFovY}` });
    }
    // a recommended eye rotation is an explicit value, auto eye rotation would override it
    if (rec.eyeRotation !== undefined && (this.settings.autoEyeRotation || differs(this.settings.eyeRotation, rec.eyeRotation))) {
      deviations.push({
        name: $localize`eye rotation`,
        recommended: rec.eyeRotation,
        current: this.settings.autoEyeRotation ? $localize`auto` : `${this.settings.eyeRotation}`,
      });
    }
    return deviations;
  }

  applyProfileRecommendation() {
    const rec = this.profileRecommendation();
    if (!rec || !this.settings) {
      return;
    }
    if (rec.maxFovX !== undefined) {
      this.settings.maxFovX = rec.maxFovX;
    }
    if (rec.maxFovY !== undefined) {
      this.settings.maxFovY = rec.maxFovY;
    }
    if (rec.eyeRotation !== undefined) {
      this.settings.autoEyeRotation = false;
      this.settings.eyeRotation = rec.eyeRotation;
    }
    this.saveConfigSettings();
  }

  setResolution() {
    if (this.settings && this.resolutionModel != null) {
      const res = this.config().resolutionOptions[this.resolutionModel];
      if (res) {
        this.settings.resolutionX = res.x;
        this.settings.resolutionY = res.y;
        this.saveConfigSettings();
      }
    }
  }

  displayRotationModel?: number;

  setDisplayRotation() {
    if (this.settings && this.displayRotationModel != null) {
      this.settings.displayRotation = this.displayRotationModel;
      this.saveConfigSettings();
    }
  }

  // Computed keys to force slider re-render when max changes
  sliderMaxFovX = computed(() => Math.ceil(this.headsetMatches() ? this.dis.values()?.resolution?.fovMaxX || this.config().defaultMaxFovX : this.config().defaultMaxFovX));
  sliderMaxFovY = computed(() => Math.ceil(this.headsetMatches() ? this.dis.values()?.resolution?.fovMaxY || this.config().defaultMaxFovY : this.config().defaultMaxFovY));

  trackBySliderMax(index: number, value: number): number {
    return value;
  }

  scaledMaxFOV(originalFOV: number) {
    return Math.ceil(originalFOV / (this.settings?.fovZoom || 1));
  }

  binocularOverlap(horizontalFov: number) {
    return Math.max(0, horizontalFov - (this.settings?.eyeRotation || 0) * 2);
  }

  showBurnInDeviationNote(maxPossibleFovX: number, maxPossibleFovY: number) {
    if (!this.settings?.fovBurnInPrevention) {
      return false;
    }
    return this.settings.maxFovX < maxPossibleFovX || this.settings.maxFovY < maxPossibleFovY;
  }
}