import { Component, computed, input } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { FovChartSourceKind } from './fov-chart-source.service';

/** the small badge in a chart header saying where its data comes from */
@Component({
  selector: 'app-chart-source-badge',
  imports: [MatTooltipModule],
  template: `
    <span class="source-badge" [class.source-live]="source() === 'live'" [class.source-simulated]="source() === 'simulated'"
        [class.source-last-known]="source() === 'lastKnown'" [matTooltip]="tooltip()" matTooltipPosition="above">
      @switch(source()) {
        @case('live') { <span i18n>SteamVR</span> }
        @case('simulated') { <span i18n>simulated</span> }
        @default { <span i18n>not live — last known data</span> }
      }
    </span>
  `,
  styles: `
    .source-badge {
      display: inline-block;
      color: #ffffff;
      border-radius: 10px;
      padding: 1px 10px;
      font-size: 11px;
      font-weight: 600;
      line-height: 16px;
      white-space: nowrap;
      cursor: default;
    }
    .source-live { background: #2e7d32; }
    .source-simulated { background: #546e7a; }
    .source-last-known { background: #c77700; }
  `
})
export class ChartSourceBadgeComponent {
  source = input.required<FovChartSourceKind>();

  tooltip = computed(() => {
    switch (this.source()) {
      case 'live':
        return $localize`Sampled by the driver while SteamVR runs this headset with this profile. Changes take a moment to arrive.`;
      case 'simulated':
        return $localize`Computed by this app from the settings on this page, the same way the driver does. Shown while SteamVR is not running this headset with this profile.`;
      default:
        return $localize`This profile can only be sampled by the driver. Showing the last sampling made while the headset was running.`;
    }
  });
}
