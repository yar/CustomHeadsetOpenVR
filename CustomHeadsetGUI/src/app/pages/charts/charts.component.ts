import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatButtonToggleModule } from '@angular/material/button-toggle';
import { MatIconModule } from '@angular/material/icon';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChartCompareEntry, ChartCompareMode, ChartCompareService, ChartKind } from '../../services/chart-compare.service';
import { DriverInfoService } from '../../services/driver-info.service';
import { DriverSettingService } from '../../services/driver-setting.service';
import { BaseHeadsetConfig, HeadsetType } from '../../services/JsonFileDefines';
import { DistortionProfileLookupService } from '../../utilities/distortion/distortion-profile-lookup.service';
import { FovChartSourceService } from '../../utilities/distortion/fov-chart-source.service';
import { FovChartComponent } from '../../utilities/fov-chart/fov-chart.component';
import { settingsFieldByHeadsetType } from '../../utilities/fov-chart/headset-fields';
import { FovPanelChartComponent } from '../../utilities/fov-panel-chart/fov-panel-chart.component';
import { FovCaChartComponent } from '../../utilities/fov-ca-chart/fov-ca-chart.component';
import { CaOverlayChartComponent } from '../../utilities/chart-overlay/ca-overlay-chart.component';
import { FovOverlayChartComponent } from '../../utilities/chart-overlay/fov-overlay-chart.component';
import { OverlayEntry } from '../../utilities/chart-overlay/overlay-entry';
import { PanelOverlayChartComponent } from '../../utilities/chart-overlay/panel-overlay-chart.component';

/**
 * The Charts tab: the FOV charts of several headset and profile combinations next to each other or
 * overlaid, each drawn with the settings of that headset's tab, so profiles can be compared without
 * switching them on a headset, and headsets can be compared without owning them.
 */
@Component({
  selector: 'app-charts',
  imports: [
    CommonModule,
    MatButtonModule,
    MatButtonToggleModule,
    MatIconModule,
    MatSelectModule,
    MatTooltipModule,
    FovChartComponent,
    FovPanelChartComponent,
    FovCaChartComponent,
    FovOverlayChartComponent,
    PanelOverlayChartComponent,
    CaOverlayChartComponent,
  ],
  templateUrl: './charts.component.html',
  styleUrl: './charts.component.scss',
  // the chart components size themselves for the room they get here, see their :host-context rules
  host: { class: 'charts-page' }
})
export class ChartsComponent {
  svc = inject(ChartCompareService);
  private dis = inject(DriverInfoService);
  private dss = inject(DriverSettingService);
  private lookup = inject(DistortionProfileLookupService);
  private chartSource = inject(FovChartSourceService);

  showAdd = signal(false);
  /** the headset chosen in the add form, the connected one when it can be shown here, else the first */
  addHeadset = signal<HeadsetType | undefined>(undefined);
  addProfile = signal<string | undefined>(undefined);

  addProfiles = computed(() => {
    const headset = this.addHeadset();
    return headset === undefined ? [] : this.svc.profilesFor(headset);
  });

  /** whether there is anything to draw on one chart; what to overlay is the user's call */
  overlayAvailable = computed(() => this.svc.entries().length > 0);

  /** overlay when asked for and possible, else side by side */
  effectiveMode = computed<ChartCompareMode>(() => this.svc.mode() === 'overlay' && this.overlayAvailable() ? 'overlay' : 'tiles');

  /** the entries with the color and label they are drawn with */
  overlayEntries = computed<OverlayEntry[]>(() => this.svc.entries().map((e, i) => ({
    id: e.id, color: this.svc.colorOf(i), label: this.entryLabel(e), headsetType: e.headsetType, profile: e.profile,
  })));

  constructor() {
    const connected = this.dis.values()?.connectedHeadset as HeadsetType | undefined;
    const initial = this.svc.headsets.find(h => h.headsetType === connected) ?? this.svc.headsets[0];
    if (initial) {
      this.selectAddHeadset(initial.headsetType);
    }
  }

  setChartKind(kind: ChartKind): void {
    this.svc.chartKind.set(kind);
  }

  setMode(mode: ChartCompareMode): void {
    this.svc.mode.set(mode);
  }

  /** pick a headset in the add form and preselect the profile its tab uses */
  selectAddHeadset(headsetType: HeadsetType): void {
    this.addHeadset.set(headsetType);
    const tabProfile = this.tabConfig(headsetType)?.distortionProfile;
    const choices = this.svc.profilesFor(headsetType);
    const preselected = choices.find(c => c.name === tabProfile) ?? choices[0];
    this.addProfile.set(preselected?.name);
  }

  addEntry(): void {
    const headset = this.addHeadset();
    const profile = this.addProfile();
    if (headset !== undefined && profile) {
      this.svc.add(headset, profile);
    }
  }

  entryLabel(entry: ChartCompareEntry): string {
    return `${this.svc.headsetLabel(entry.headsetType)} · ${this.svc.profileLabel(entry.profile)}`;
  }

  /** the chromatic aberration correction strengths of the entry's headset tab, the CA chart draws them applied */
  caScale(entry: ChartCompareEntry, channel: 'red' | 'blue'): number | undefined {
    const config = this.tabConfig(entry.headsetType);
    return channel === 'red' ? config?.chromaticAberrationScaleRed : config?.chromaticAberrationScaleBlue;
  }

  /**
   * why a tile stays empty, empty when its chart can be drawn. The chromatic aberration chart explains
   * itself; the others draw whatever the source has, live, last known or simulated, and only when it has
   * nothing does the tile say why.
   */
  tileNote(entry: ChartCompareEntry): string {
    if (this.svc.chartKind() === 'ca' || this.chartSource.data(entry.headsetType, entry.profile)) {
      return '';
    }
    if (!this.lookup.resolve(entry.profile).computable) {
      return $localize`This profile can only be sampled by the driver while the headset runs it, and there is no such sampling for this headset yet.`;
    }
    return $localize`No data for this headset yet.`;
  }

  private tabConfig(headsetType: HeadsetType): BaseHeadsetConfig | undefined {
    const field = settingsFieldByHeadsetType[headsetType];
    return field ? this.dss.values()?.[field] as BaseHeadsetConfig | undefined : undefined;
  }
}
