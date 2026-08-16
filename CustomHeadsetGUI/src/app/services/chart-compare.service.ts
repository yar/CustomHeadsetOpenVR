import { effect, inject, Injectable, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { AppSettingService } from './app-setting.service';
import { DriverInfoService } from './driver-info.service';
import { DriverSettingService } from './driver-setting.service';
import { ChartCompareSetting, HeadsetType } from './JsonFileDefines';
import { DistortionProfileLookupService } from '../utilities/distortion/distortion-profile-lookup.service';
import { deviceNameOf, headsetLabel, simulatableHeadsets } from '../utilities/distortion/headset-catalog';

export type ChartKind = 'fov' | 'panel' | 'ca';
export type ChartCompareMode = 'tiles' | 'overlay';

/** one thing being compared: a profile on a headset, drawn with that headset tab's settings */
export type ChartCompareEntry = {
  id: number;
  headsetType: HeadsetType;
  /** the profile name as it would be selected in the settings */
  profile: string;
};

export type ChartCompareProfileChoice = {
  name: string;
  displayName: string;
  /** whether the profile lists the headset's device, incompatible ones are offered only when the app setting allows */
  compatible: boolean;
};

/** distinguishable on the light chart background and in the dark UI, one per entry */
export const CHART_COMPARE_COLORS = ['#e8590c', '#1c7ed6', '#2f9e44', '#9c36b5', '#e67700', '#0c8599', '#d6336c', '#5c940d'];

/**
 * The comparison the Charts tab shows: which headset and profile combinations, which chart and how.
 * Lives in a service so the compare buttons on the settings tabs and the profile page can add to it.
 */
@Injectable({
  providedIn: 'root'
})
export class ChartCompareService {
  private dis = inject(DriverInfoService);
  private dss = inject(DriverSettingService);
  private ass = inject(AppSettingService);
  private lookup = inject(DistortionProfileLookupService);
  private router = inject(Router);

  readonly headsets = simulatableHeadsets();
  entries = signal<ChartCompareEntry[]>([]);
  chartKind = signal<ChartKind>('fov');
  mode = signal<ChartCompareMode>('tiles');
  private nextId = 1;
  /** whether the comparison saved in the app settings has been read, changes are only written after that */
  private restored = false;

  constructor() {
    // restore the comparison of the last session once the app settings are available
    effect(() => {
      const settings = this.ass.values();
      if (!settings || this.restored) {
        return;
      }
      this.restored = true;
      const saved = settings.chartCompare;
      if (saved) {
        untracked(() => {
          const entries = (saved.entries ?? []).filter(e => typeof e.headsetType === 'number' && typeof e.profile === 'string')
            .map(e => ({ id: this.nextId++, headsetType: e.headsetType as HeadsetType, profile: e.profile }));
          this.entries.set(entries);
          if (saved.chartKind === 'fov' || saved.chartKind === 'panel' || saved.chartKind === 'ca') {
            this.chartKind.set(saved.chartKind);
          }
          if (saved.mode === 'tiles' || saved.mode === 'overlay') {
            this.mode.set(saved.mode);
          }
        });
      }
    });
    // and keep it saved
    effect(() => {
      const state: ChartCompareSetting = {
        entries: this.entries().map(e => ({ headsetType: e.headsetType, profile: e.profile })),
        chartKind: this.chartKind(),
        mode: this.mode(),
      };
      if (!this.restored) {
        return;
      }
      untracked(() => {
        const current = this.ass.values();
        if (!current || JSON.stringify(current.chartCompare) === JSON.stringify(state)) {
          return;
        }
        this.ass.save({ ...current, chartCompare: state });
      });
    });
  }

  /** add a combination, or return the entry that already has it */
  add(headsetType: HeadsetType, profile: string): ChartCompareEntry {
    const existing = this.entries().find(e => e.headsetType === headsetType && e.profile === profile);
    if (existing) {
      return existing;
    }
    const entry: ChartCompareEntry = { id: this.nextId++, headsetType, profile };
    this.entries.update(list => [...list, entry]);
    return entry;
  }

  /** the compare buttons: add a combination, show that chart kind and go to the Charts tab */
  open(headsetType: HeadsetType, profile: string, kind: ChartKind): void {
    this.add(headsetType, profile);
    this.chartKind.set(kind);
    this.router.navigateByUrl('/charts');
  }

  remove(id: number): void {
    this.entries.update(list => list.filter(e => e.id !== id));
  }

  clear(): void {
    this.entries.set([]);
  }

  colorOf(index: number): string {
    return CHART_COMPARE_COLORS[index % CHART_COMPARE_COLORS.length];
  }

  headsetLabel(headsetType: HeadsetType): string {
    return headsetLabel(headsetType);
  }

  profileLabel(profile: string): string {
    return this.lookup.resolve(profile).displayName;
  }

  /** the profiles that can be chosen for a headset: those made for it first, the others when the app setting shows them */
  profilesFor(headsetType: HeadsetType): ChartCompareProfileChoice[] {
    const device = deviceNameOf(headsetType);
    const showIncompatible = this.ass.values()?.showIncompatibleProfiles ?? false;
    // profiles without a device are for every headset, like the settings tabs treat them
    const matches = (profileDevice: string | string[] | undefined) =>
      profileDevice === undefined || (Array.isArray(profileDevice) ? profileDevice.includes(device) : profileDevice === device);
    const choices: ChartCompareProfileChoice[] = [];
    const builtIn = this.dis.values()?.builtInDistortionProfiles ?? {};
    for (const [name, profile] of Object.entries(builtIn)) {
      choices.push({ name, displayName: this.lookup.resolve(name).displayName, compatible: matches(profile.device) });
    }
    for (const file of this.dss.distortionProfileList()) {
      const name = file.name.replace(/\.json$/i, '');
      if (!builtIn[name]) {
        choices.push({ name, displayName: this.lookup.resolve(name).displayName, compatible: matches(file.device) });
      }
    }
    const compatible = choices.filter(c => c.compatible);
    const incompatible = choices.filter(c => !c.compatible);
    return showIncompatible ? [...compatible, ...incompatible] : compatible;
  }
}
