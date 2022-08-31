import { keyPair } from 'hypercore-crypto'
import Corestore from 'corestore'
import RAM from 'random-access-memory'
import { format, encode, parse, decode } from '@synonymdev/slashtags-url'
import EventEmitter from 'events'
import DHT from '@hyperswarm/dht'
import HashMap from 'turbo-hash-map'

// @ts-ignore
export class Slashtag extends EventEmitter {
  /**
   *
   * @param {object} [opts]
   * @param {import('@hyperswarm/dht').KeyPair} [opts.keyPair]
   * @param {import('@hyperswarm/dht').Node[]} [opts.bootstrap]
   * @param {import('@hyperswarm/dht')} [opts.dht]
   */
  constructor (opts = {}) {
    super()
    this.keyPair = opts.keyPair || keyPair()
    this.key = this.keyPair.publicKey

    this.id = encode(this.key)
    this.url = format(this.key)

    this._shouldDestroyDHT = !opts.dht
    this.dht = opts.dht || new DHT({ bootstrap: opts.bootstrap })
    this.server = this.dht.createServer(this._handleConnection.bind(this))
    /** @type {HashMap<SecretStream>} */
    this.sockets = new HashMap()

    this.corestore = new Corestore(RAM)
    /** @type {Hypercore} */
    this.core = this.corestore.get({ keyPair: this.keyPair })

    /** @type {Emitter['on']} */ this.on = super.on
    /** @type {Emitter['on']} */ this.once = super.once
    /** @type {Emitter['on']} */ this.off = super.off
  }

  listen () {
    if (!this.listening) this.listening = this.server.listen(this.keyPair)
    return this.listening
  }

  unlisten () {
    this.listening = false
    return this.server.close()
  }

  /**
   * Connect to a remote Slashtag.
   * @param {Uint8Array | string} key
   * @returns {SecretStream}
   */
  connect (key) {
    /** @type {Uint8Array} */
    const _key =
      typeof key === 'string'
        ? key.startsWith('slash')
          ? parse(key).key
          : decode(key)
        : key

    const existing = this.sockets.get(_key)
    if (existing) return existing

    const socket = this.dht.connect(_key, { keyPair: this.keyPair })
    return this._handleConnection(socket)
  }

  // /** @param {string} name */
  // drive (name) {
  //   const ns = this.corestore.namespace('drive::' + name)
  //   const encryptionKey = hash(ns._namespace)
  //   const drive = new HyperDrive(ns, { encryptionKey })

  //   drive.ready().then(() => this.join(drive))

  //   return drive
  // }

  close () {
    if (this._closing) return this._closing
    this._closing = this._close()

    this.removeAllListeners()
    return this._closing
  }

  async _close () {
    await this.corestore.close()

    await this.unlisten()

    for (const socket of this.sockets.values()) {
      await socket.destroy()
    }

    await (this._shouldDestroyDHT && this.dht.destroy())

    this.closed = true
    this.emit('close')
  }

  /**
   * @param {SecretStream} socket
   */
  _handleConnection (socket) {
    this.corestore.replicate(socket)

    socket.on('error', noop)
    socket.on('close', () => {
      this.sockets.delete(socket.remotePublicKey)
    })
    socket.once('open', () => {
      socket.removeListener('error', noop)
    })

    this.sockets.set(socket.remotePublicKey, socket)
    this.emit('connection', socket)

    // @ts-ignore
    return socket
  }
}

function noop () {}

/**
 * @typedef {import('./lib/interfaces').Emitter} Emitter
 * @typedef {import('./lib/interfaces').HypercoreLike} HypercoreLike
 * @typedef {import('hypercore')} Hypercore
 * @typedef {import('@hyperswarm/secret-stream')} SecretStream
 */

export default Slashtag
