/**
 * One exit path for the world, whoever asks: SIGINT, SIGTERM, or the
 * management route the kit's single player uses on Windows, where there is
 * no signal to send. The world stops through its own reboot timer so every
 * save is flushed; asking twice does nothing.
 */
let exiting = false;

export function requestShutdown(stop: () => void): boolean {
    if (exiting) return false;
    exiting = true;
    stop();
    return true;
}

export function resetShutdownForTests(): void {
    exiting = false;
}
