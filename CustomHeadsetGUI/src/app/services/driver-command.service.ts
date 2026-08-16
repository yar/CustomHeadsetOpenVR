import { Injectable } from '@angular/core';
import { exists, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import { PathsService } from './paths.service';
import { cleanJsonComments } from '../helpers';
import type { StandingOrigin } from './steamvr-room.service';

/**
 * One shot requests to the running driver, written to commands.json in the driver's config folder which the driver
 * watches like settings.json. Every request carries the unix time in milliseconds it was made at, which is also its
 * identity: the driver acts on it once when the time changes and ignores requests older than a few seconds, so a file
 * left over from an earlier session does nothing on the next start. The driver answers through info.json.
 */
@Injectable({
  providedIn: 'root'
})
export class DriverCommandService {
  constructor(private paths: PathsService) {
  }

  /**
   * Asks the driver to recenter the tracking space on the headset. The driver holds the headset at the origin of its raw
   * space (info.recenter.state zeroed) until finishRecenter() lifts it to eye height, see PimaxSlam.cpp for the steps.
   * @param time the request time that identifies the request in the driver's answer, now by default
   */
  async requestRecenter(time: number = Date.now()): Promise<void> {
    await this.writeCommand('recenter', { time, phase: 'zero' });
  }

  /**
   * Finishes the recenter request of the given time: the headset is lifted to eye height, inside the SteamVR standing
   * space when its origin is given as it ended up in the driver's raw space.
   */
  async finishRecenter(time: number, standing?: StandingOrigin): Promise<void> {
    await this.writeCommand('recenter', { time, phase: 'finish', ...(standing ? { standing } : {}) });
  }

  /** sets one command in the file, keeping the others so their request times stay known to the driver */
  private async writeCommand(name: string, command: object) {
    let commands: any = {};
    try {
      if (await exists(this.paths.commandsPath)) {
        commands = JSON.parse(cleanJsonComments(await readTextFile(this.paths.commandsPath)));
        if (typeof commands !== 'object' || commands === null || Array.isArray(commands)) {
          commands = {};
        }
      }
    } catch (e) {
      // start over from an unreadable file
      commands = {};
    }
    commands[name] = command;
    await writeTextFile(this.paths.commandsPath, JSON.stringify(commands, undefined, 4));
  }
}
