import type Corestore from 'corestore';
import type SecretStream from '@hyperswarm/secret-stream';

export interface Emitter {
  on(event: 'close', listener: (...args: any[]) => void): this;
  on(event: 'connection', listener: (connection: SecretStream) => void): this;
  on(event: string | symbol, listener: (...args: any[]) => void): this;
}

export interface HypercoreLike {
  discoveryKey?: Uint8Array;
  findingPeers: Corestore['findingPeers'];
}
