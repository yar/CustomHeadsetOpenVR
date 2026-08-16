import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatInputModule } from '@angular/material/input';
import { MatSliderModule } from '@angular/material/slider';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatTooltipModule } from '@angular/material/tooltip';
import { BaseHeadsetConfig } from '../../../services/JsonFileDefines';
import { DriverCommandService } from '../../../services/driver-command.service';
import { RoomResetResult, SteamVrRoomService } from '../../../services/steamvr-room.service';
import { DeviceConfigComponentBase } from '../DeviceConfigComponentBase';
import { FieldTipComponent } from '../../../utilities/field-tip/field-tip.component';
import { FieldNoteComponent } from '../../../utilities/field-note/field-note.component';
import { ResetButtonComponent } from '../../../utilities/reset-button/reset-button.component';

/**
 * What the recenter control is doing. countdown: the delay runs so the headset can be put on, sent: the request is
 * written and the driver has not answered yet, waiting: the driver waits for the headset to be tracked, resetting: the
 * driver holds the headset at its origin while SteamVR's room origin is reset to it, finishing: the driver was told to
 * lift the headset to eye height, then the driver's outcome (done, noTracking) or noAnswer when nothing answered in time.
 */
type RecenterPhase = 'idle' | 'countdown' | 'sent' | 'waiting' | 'resetting' | 'finishing' | 'done' | 'noTracking' | 'noAnswer';

@Component({
  selector: 'app-pimax-slam-settings',
  imports: [FormsModule, MatButtonModule, MatInputModule, MatSliderModule, MatSlideToggleModule, MatTooltipModule, FieldTipComponent, FieldNoteComponent, ResetButtonComponent],
  templateUrl: './pimax-slam-settings.component.html',
  styleUrl: './pimax-slam-settings.component.scss'
})
export class PimaxSlamSettingsComponent extends DeviceConfigComponentBase<BaseHeadsetConfig> {
  override settingField = input.required<string>();
  override driverName = input<string | string[]>([]);

  private commands = inject(DriverCommandService);
  private room = inject(SteamVrRoomService);

  recenterPhase = signal<RecenterPhase>('idle');
  /** seconds left of the countdown */
  countdownRemaining = signal(0);
  /** how the SteamVR room origin reset went for the last request, shown with the outcome */
  private roomReset = signal<RoomResetResult | undefined>(undefined);
  /** the request time of the recenter request in flight, the driver's answer names it */
  private requestTime = 0;
  private countdownTimer?: ReturnType<typeof setInterval>;
  private answerTimer?: ReturnType<typeof setTimeout>;
  /** how long to wait for the driver to answer a request before giving up on it */
  private static readonly answerTimeoutMs = 15000;

  /** the delay is a preference of the GUI, it is what makes time to put the headset on after pressing the button */
  delaySeconds = computed(() => this.ass.values()?.recenterDelaySeconds ?? 5);
  /** a request can only be acted on while SteamVR runs the headset through the driver's SLAM implementation */
  canRecenter = computed(() => this.steamVRRunning().running && (this.dis.values()?.pimaxSlamActive ?? false));
  recenterButtonText = computed(() => this.recenterPhase() === 'countdown' ? $localize`Cancel` : $localize`Recenter`);
  recenterStatusText = computed(() => {
    const phase = this.recenterPhase();
    // a request in flight is reported as it goes
    switch (phase) {
      case 'countdown':
        return $localize`Put the headset on and face forward, recentering in ${this.countdownRemaining()}:seconds: s.`;
      case 'sent':
        return $localize`Waiting for the driver...`;
      case 'waiting':
        return $localize`Waiting for the headset to be tracked...`;
      case 'resetting':
        return $localize`Resetting the SteamVR room origin...`;
      case 'finishing':
        return $localize`Placing the floor...`;
    }
    // otherwise say why the button is disabled, or how the last request went while it can be used again
    if (!this.steamVRRunning().running) {
      return $localize`SteamVR is not running.`;
    }
    if (!this.canRecenter()) {
      return $localize`No SLAM tracked headset is running in SteamVR.`;
    }
    switch (phase) {
      case 'done': {
        // a driver that finished without holding the headset at its origin first never had the room origin reset
        const roomReset = this.roomReset();
        return !roomReset || roomReset.standing ? $localize`Recentered.` : $localize`Recentered, but the SteamVR room origin could not be reset (${this.roomResetErrorText()}:reason:), so the space may still be off center.`;
      }
      case 'noTracking':
        return $localize`The headset was not tracked, put it on and try again.`;
      case 'noAnswer':
        return $localize`The driver did not answer. Is SteamVR running the headset with SLAM tracking?`;
    }
    return '';
  });

  constructor() {
    super();
    // follow the driver's answers to the request in flight from info.json
    effect(() => {
      const answer = this.dis.values()?.recenter;
      const phase = this.recenterPhase();
      const inFlight = phase === 'sent' || phase === 'waiting' || phase === 'resetting' || phase === 'finishing';
      if (!inFlight || !answer || answer.requestTime !== this.requestTime) {
        return;
      }
      if (answer.state === 'done' || answer.state === 'noTracking') {
        this.clearAnswerTimeout();
        this.recenterPhase.set(answer.state);
        if (answer.state === 'done' && this.roomReset()?.standing) {
          // the head is at eye height now, put the seated origin there too so seated apps start where the player is
          this.room.resetSeatedToHeadset();
        }
      } else if (answer.state === 'waiting' && phase === 'sent') {
        // the driver has the request and waits for tracking, give it the time it allows itself for that
        this.recenterPhase.set('waiting');
        this.startAnswerTimeout();
      } else if (answer.state === 'zeroed' && (phase === 'sent' || phase === 'waiting')) {
        this.clearAnswerTimeout();
        this.recenterPhase.set('resetting');
        this.resetRoomAndFinish(answer.requestTime, answer.universeId);
      }
    });
  }

  setDelaySeconds(value: number) {
    const settings = this.ass.values();
    if (settings && Number.isFinite(value)) {
      settings.recenterDelaySeconds = Math.min(60, Math.max(0, Math.round(value)));
      this.ass.save(settings);
    }
  }

  /** the button starts the countdown, or cancels it while it runs */
  toggleRecenter() {
    if (this.recenterPhase() === 'countdown') {
      this.stopCountdown();
      this.recenterPhase.set('idle');
      return;
    }
    this.clearAnswerTimeout();
    const delay = this.delaySeconds();
    if (delay <= 0) {
      this.sendRecenter();
      return;
    }
    this.countdownRemaining.set(delay);
    this.recenterPhase.set('countdown');
    this.countdownTimer = setInterval(() => {
      const remaining = this.countdownRemaining() - 1;
      this.countdownRemaining.set(remaining);
      if (remaining <= 0) {
        this.stopCountdown();
        this.sendRecenter();
      }
    }, 1000);
  }

  private async sendRecenter() {
    // the time is set before the phase so the answer to an earlier request is not taken for this one
    this.requestTime = Date.now();
    this.roomReset.set(undefined);
    this.recenterPhase.set('sent');
    try {
      await this.commands.requestRecenter(this.requestTime);
    } catch (e) {
      console.error('failed to write the recenter request', e);
      this.recenterPhase.set('noAnswer');
      return;
    }
    this.startAnswerTimeout();
  }

  /**
   * The driver holds the headset at its origin: have SteamVR reset its room origin to it, then finish the request with
   * the origin as it ended up so the driver lifts the headset to eye height inside the SteamVR space.
   */
  private async resetRoomAndFinish(requestTime: number, universeId: number | undefined) {
    let result: RoomResetResult;
    if (universeId === undefined) {
      result = { error: 'noChaperone' };
    } else {
      try {
        result = await this.room.resetOriginToHeadset(universeId);
      } catch (e) {
        console.error('failed to reset the SteamVR room origin', e);
        result = { error: 'launchFailed' };
      }
    }
    if (this.recenterPhase() !== 'resetting' || this.requestTime !== requestTime) {
      // the request was cancelled or replaced meanwhile
      return;
    }
    this.roomReset.set(result);
    this.recenterPhase.set('finishing');
    try {
      await this.commands.finishRecenter(requestTime, result.standing);
    } catch (e) {
      console.error('failed to write the recenter finish', e);
      this.recenterPhase.set('noAnswer');
      return;
    }
    this.startAnswerTimeout();
  }

  private roomResetErrorText(): string {
    switch (this.roomReset()?.error) {
      case 'noSteamVR':
      case 'noVrcmd':
        return $localize`vrcmd was not found in the SteamVR installation`;
      case 'launchFailed':
        return $localize`vrcmd could not be run`;
      case 'noChaperone':
        return $localize`the SteamVR chaperone file could not be read`;
      case 'notZeroed':
        return $localize`SteamVR did not place its origin at the headset`;
    }
    return '';
  }

  private startAnswerTimeout() {
    this.clearAnswerTimeout();
    this.answerTimer = setTimeout(() => {
      this.answerTimer = undefined;
      const phase = this.recenterPhase();
      if (phase === 'sent' || phase === 'waiting' || phase === 'finishing') {
        this.recenterPhase.set('noAnswer');
      }
    }, PimaxSlamSettingsComponent.answerTimeoutMs);
  }

  private clearAnswerTimeout() {
    if (this.answerTimer !== undefined) {
      clearTimeout(this.answerTimer);
      this.answerTimer = undefined;
    }
  }

  private stopCountdown() {
    if (this.countdownTimer !== undefined) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = undefined;
    }
  }

  override ngOnDestroy(): void {
    this.stopCountdown();
    this.clearAnswerTimeout();
    super.ngOnDestroy();
  }
}
