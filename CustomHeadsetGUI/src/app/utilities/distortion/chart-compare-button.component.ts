import { Component, inject, input } from '@angular/core';
import { MatTooltipModule } from '@angular/material/tooltip';
import { ChartCompareService, ChartKind } from '../../services/chart-compare.service';
import { HeadsetType } from '../../services/JsonFileDefines';

/** the small button in a chart header that takes the chart's headset and profile to the Charts tab */
@Component({
  selector: 'app-chart-compare-button',
  imports: [MatTooltipModule],
  template: `
    <button type="button" class="compare-button" (click)="open()" [matTooltip]="tooltip" matTooltipPosition="above">
      <span i18n>compare</span>
    </button>
  `,
  styles: `
    :host { display: inline-flex; }
    .compare-button {
      display: inline-flex;
      align-items: center;
      padding: 1px 10px;
      border: 1px solid rgba(0, 0, 0, 0.35);
      border-radius: 10px;
      background: transparent;
      color: #1a1a1a;
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      line-height: 16px;
      white-space: nowrap;
      cursor: pointer;
      &:hover { background: #333333; color: #ffffe0; border-color: #333333; }
    }
  `
})
export class ChartCompareButtonComponent {
  headsetType = input.required<HeadsetType>();
  /** the profile name as selected in the settings */
  profile = input.required<string>();
  kind = input.required<ChartKind>();

  private compare = inject(ChartCompareService);
  tooltip = $localize`Compare with other headsets and profiles on the Charts tab`;

  open(): void {
    this.compare.open(this.headsetType(), this.profile(), this.kind());
  }
}
