// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Hands one contact's inbound messages to the pipeline in the order they
 * arrived, even when one needs slow preparation first.
 *
 * A voice note is downloaded and transcribed (seconds) before it can join the
 * burst, while a text sent right after it is ready at once: handed off as each
 * became ready, the turn read the text before the transcript, or the late
 * transcript cancelled and restarted a turn already running. Preparation still
 * runs concurrently; only the hand-off waits for the contact's previous
 * message to be handed off (or dropped). Other contacts never wait.
 */
export class InboundOrder {
  /** Per contact: settles once the latest message has been handed off. */
  private readonly tails = new Map<string, Promise<void>>();

  /**
   * Prepare a message, then hand it off after the contact's previous one.
   * `handOff` is called in arrival order; the next message is released as soon
   * as it has been called, not when it resolves, so a turn in progress never
   * holds the contact's next message back.
   */
  async run<P, T>(contact: string, prepare: () => Promise<P>, handOff: (prepared: P) => Promise<T>): Promise<T> {
    const previous = this.tails.get(contact) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => (release = resolve));
    // Settles after the previous one too: a message that failed to prepare
    // must not let the next overtake the one before it.
    const tail = previous.then(() => mine);
    this.tails.set(contact, tail);
    void tail.then(() => {
      if (this.tails.get(contact) === tail) this.tails.delete(contact);
    });

    let handedOff: Promise<T>;
    try {
      const prepared = await prepare();
      await previous;
      handedOff = handOff(prepared);
    } finally {
      release();
    }
    return handedOff;
  }
}
