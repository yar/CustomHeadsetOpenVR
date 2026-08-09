import { Component, input } from '@angular/core';

/** the line styles of the panel angle map explained with samples, below the chart of a tab and below the overlay */
@Component({
  selector: 'app-panel-chart-legend',
  template: `
    <div class="legend">
      <span class="item"><svg viewBox="0 0 30 12"><line class="contour" x1="1" y1="6" x2="29" y2="6" /></svg><span i18n>angle from the optical axis, every 5°</span></span>
      <span class="item"><svg viewBox="0 0 30 12"><line class="center" x1="1" y1="6" x2="29" y2="6" /></svg><span i18n>panel center</span></span>
      <span class="item"><svg viewBox="0 0 30 12"><line class="boundary" x1="1" y1="6" x2="29" y2="6" /></svg><span i18n>edge of the rendered area</span></span>
      <span class="item"><svg viewBox="0 0 30 12"><path class="cross" d="M15 1.5V10.5M10 6H20" /></svg><span i18n>optical axis</span></span>
      @if(showForward()) {
        <span class="item"><svg viewBox="0 0 30 12"><path class="cross" d="M11.5 2.5L18.5 9.5M11.5 9.5L18.5 2.5" /></svg><span i18n>forward look direction</span></span>
      }
      @if(showHiddenArea()) {
        <span class="item"><svg viewBox="0 0 30 12"><line class="ham" x1="1" y1="6" x2="29" y2="6" /></svg><span i18n>hidden area mesh</span></span>
      }
      <ng-content />
    </div>
  `,
  styles: `
    :host { display: block; }
    .legend {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 16px;
      margin-top: 6px;
      font-size: 11px;
      line-height: 1.35;
      color: #444444;
    }
    .item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      white-space: nowrap;
    }
    svg {
      width: 30px;
      height: 12px;
      flex: none;
      overflow: visible;
    }
    // the samples match the chart's line styles
    .contour { stroke: #555555; stroke-width: 1; }
    .center { stroke: #bb00bb; stroke-width: 1.2; stroke-dasharray: 4 2.5; }
    .boundary { stroke: #000000; stroke-width: 3; }
    .cross { stroke: #000000; stroke-width: 1.5; fill: none; }
    .ham { stroke: #666666; stroke-width: 1.5; stroke-dasharray: 3 3; }
  `
})
export class PanelChartLegendComponent {
  /** the hidden area mesh cut is only drawn when the mesh is enabled, so its sample is optional */
  showHiddenArea = input(true);
  /** the forward look direction marker, listed by the charts that draw it */
  showForward = input(false);
}
