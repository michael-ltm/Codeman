import { execSync } from 'node:child_process';
import { cpus, freemem, loadavg, totalmem } from 'node:os';

export interface SystemStats {
  cpu: number;
  memory: { usedMB: number; totalMB: number; percent: number };
}

/** Cached CPU count - does not change at runtime. */
const CPU_COUNT = cpus().length;

/** Get this process host's CPU and memory usage. */
export function getSystemStats(): SystemStats {
  try {
    const totalMem = totalmem();

    // macOS: os.freemem() only returns truly free pages, not cached/purgeable memory.
    // Use vm_stat to get accurate used memory (wired + active + compressed).
    let usedMem: number;
    if (process.platform === 'darwin') {
      try {
        const vmstat = execSync('vm_stat', { encoding: 'utf-8', timeout: 2000 });
        const pageSize = parseInt(vmstat.match(/page size of (\d+)/)?.[1] || '4096', 10);
        const wired = parseInt(vmstat.match(/Pages wired down:\s+(\d+)/)?.[1] || '0', 10);
        const active = parseInt(vmstat.match(/Pages active:\s+(\d+)/)?.[1] || '0', 10);
        const compressed = parseInt(vmstat.match(/Pages occupied by compressor:\s+(\d+)/)?.[1] || '0', 10);
        usedMem = (wired + active + compressed) * pageSize;
      } catch {
        usedMem = totalMem - freemem();
      }
    } else {
      usedMem = totalMem - freemem();
    }

    // CPU load average (1 min) as percentage (rough approximation)
    const load = loadavg()[0];
    const cpuPercent = Math.min(100, Math.round((load / CPU_COUNT) * 100));

    return {
      cpu: cpuPercent,
      memory: {
        usedMB: Math.round(usedMem / (1024 * 1024)),
        totalMB: Math.round(totalMem / (1024 * 1024)),
        percent: Math.round((usedMem / totalMem) * 100),
      },
    };
  } catch {
    return {
      cpu: 0,
      memory: { usedMB: 0, totalMB: 0, percent: 0 },
    };
  }
}
