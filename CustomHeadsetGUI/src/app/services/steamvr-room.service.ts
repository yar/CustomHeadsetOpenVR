import { Injectable } from '@angular/core';
import { exists, readTextFile, stat } from '@tauri-apps/plugin-fs';
import { join } from '@tauri-apps/api/path';
import { SystemDiagnosticService } from './system-diagnostic.service';
import { get_platform, launch_process } from '../tauri_wrapper';
import { delay } from '../helpers';

/**
 * The origin of a SteamVR universe as stored in chaperone_info.vrchap: the raw tracking origin as seen from that
 * universe, standing = R(yaw) * raw + translation.
 */
export type StandingOrigin = {
  translation: number[];
  yaw: number;
};

export type RoomResetResult = {
  standing?: StandingOrigin;
  /** why no standing origin could be given, see the code that sets it */
  error?: 'noSteamVR' | 'noVrcmd' | 'launchFailed' | 'noChaperone' | 'notZeroed';
};

/**
 * Drives the room setup of the running SteamVR through vrcmd, the command line tool that ships with SteamVR.
 * vrcmd --resetroomheight sets the standing origin of the current universe to the headset (the floor a few cm below it,
 * as if it were resting on the floor) and the seated origin to the headset, vrcmd --recenter only the seated origin.
 * SteamVR writes the result to chaperone_info.vrchap in its config folder right away, where it can be read back.
 */
@Injectable({
  providedIn: 'root'
})
export class SteamVrRoomService {
  constructor(private sds: SystemDiagnosticService) {
  }

  private async vrcmdPath(): Promise<string | undefined> {
    const steamVrPath = this.sds.steamVRinstalled() ?? await this.sds.checkSteamVrInstalled();
    if (!steamVrPath) {
      return undefined;
    }
    const platform = await get_platform();
    const path = await join(steamVrPath, 'bin', platform === 'linux' ? 'linux64' : 'win64', platform === 'linux' ? 'vrcmd' : 'vrcmd.exe');
    return await exists(path) ? path : undefined;
  }

  private async chaperonePath(): Promise<string | undefined> {
    const configDir = await this.sds.getSteamVRConfigDirPath();
    return configDir ? await join(configDir, 'chaperone_info.vrchap') : undefined;
  }

  /** reads the standing origin of the given universe from chaperone_info.vrchap */
  private async readStandingOrigin(path: string, universeId: number): Promise<StandingOrigin | undefined> {
    try {
      const chaperone = JSON.parse(await readTextFile(path));
      const universe = (chaperone?.universes as any[] | undefined)?.find(u => Number(u?.universeID) === universeId);
      const standing = universe?.standing;
      if (Array.isArray(standing?.translation) && standing.translation.length === 3 && typeof standing.yaw === 'number') {
        return { translation: standing.translation.map((v: any) => Number(v)), yaw: standing.yaw };
      }
    } catch (e) {
      console.warn('could not read the chaperone file', path, e);
    }
    return undefined;
  }

  /**
   * Resets the SteamVR standing and seated origins to the headset. Meant to run while the driver holds the headset at
   * the origin of its raw space, so the room setup of the universe becomes the identity but for the small height SteamVR
   * keeps between the headset and the floor. Returns the standing origin as it ended up, read back from the chaperone
   * file, when it looks like that.
   */
  async resetOriginToHeadset(universeId: number): Promise<RoomResetResult> {
    const vrcmd = await this.vrcmdPath();
    if (!vrcmd) {
      return { error: this.sds.steamVRinstalled() ? 'noVrcmd' : 'noSteamVR' };
    }
    const chaperonePath = await this.chaperonePath();
    if (!chaperonePath) {
      return { error: 'noChaperone' };
    }
    const modifiedBefore = await this.modifiedTime(chaperonePath);
    if (!await launch_process(vrcmd, ['--resetroomheight'])) {
      return { error: 'launchFailed' };
    }
    // SteamVR rewrites the chaperone file when the origins are committed, give it a few seconds
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      await delay(100);
      const modified = await this.modifiedTime(chaperonePath);
      if (modified !== undefined && modified !== modifiedBefore) {
        // let the write complete
        await delay(100);
        break;
      }
    }
    const standing = await this.readStandingOrigin(chaperonePath, universeId);
    if (!standing) {
      return { error: 'noChaperone' };
    }
    // with the headset held at the raw origin the standing origin lands there too, anything else means the reset
    // caught the headset elsewhere and folding it in would not center the space either
    const [x, y, z] = standing.translation;
    if (Math.abs(x) > 0.15 || Math.abs(z) > 0.15 || Math.abs(y) > 0.25 || Math.abs(standing.yaw) > 0.1) {
      console.warn('the SteamVR standing origin did not land at the headset', standing);
      return { error: 'notZeroed' };
    }
    return { standing };
  }

  /** resets the SteamVR seated origin to the headset, as the dashboard's reset seated position does */
  async resetSeatedToHeadset(): Promise<boolean> {
    const vrcmd = await this.vrcmdPath();
    return !!vrcmd && await launch_process(vrcmd, ['--recenter']);
  }

  private async modifiedTime(path: string): Promise<number | undefined> {
    try {
      return (await stat(path)).mtime?.getTime();
    } catch {
      return undefined;
    }
  }
}
