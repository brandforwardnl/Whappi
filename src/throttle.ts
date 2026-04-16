import { settings } from './settings';

const lastByRecipient = new Map<string, number>();
const burstWindow: number[] = [];

function sleep(ms: number) {
  return new Promise<void>((res) => setTimeout(res, ms));
}

export async function waitForSlot(toNumber: string): Promise<void> {
  while (true) {
    const now = Date.now();
    const burstLimit = settings.getBurstPerMinute();
    const throttleSec = settings.getRecipientThrottleSec();

    while (burstWindow.length > 0 && now - burstWindow[0] > 60_000) {
      burstWindow.shift();
    }

    let waitMs = 0;

    if (burstLimit > 0 && burstWindow.length >= burstLimit) {
      waitMs = Math.max(waitMs, 60_000 - (now - burstWindow[0]));
    }

    if (throttleSec > 0) {
      const last = lastByRecipient.get(toNumber);
      if (last) {
        const elapsed = now - last;
        const need = throttleSec * 1000 - elapsed;
        if (need > 0) waitMs = Math.max(waitMs, need);
      }
    }

    if (waitMs <= 0) {
      burstWindow.push(now);
      lastByRecipient.set(toNumber, now);
      return;
    }
    await sleep(Math.min(waitMs + 50, 5_000));
  }
}
