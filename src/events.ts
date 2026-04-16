import { EventEmitter } from 'events';

export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function emitUpdate(): void {
  bus.emit('update');
}
